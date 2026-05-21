import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextCompiler } from '../read/compiler.js';
import { type AegisDatabase, createInMemoryDatabase, Repository } from '../store/index.js';
import { shareExport } from './export.js';
import { shareMaterialize } from './materialize.js';

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function bootstrap(
  repo: Repository,
  data: {
    documents: {
      doc_id: string;
      title: string;
      kind: string;
      content: string;
      ownership?: string;
    }[];
    edges: {
      edge_id: string;
      source_type: string;
      source_value: string;
      target_doc_id: string;
      edge_type: string;
      priority: number;
      specificity?: number;
    }[];
    layer_rules?: {
      rule_id: string;
      path_pattern: string;
      layer_name: string;
      priority: number;
      specificity?: number;
    }[];
  },
) {
  repo.insertProposal({
    proposal_id: 'boot',
    proposal_type: 'bootstrap',
    payload: JSON.stringify({
      documents: data.documents.map((d) => ({
        ...d,
        content_hash: hash(d.content),
      })),
      edges: data.edges.map((e) => ({
        ...e,
        specificity: e.specificity ?? 0,
      })),
      layer_rules: (data.layer_rules ?? []).map((r) => ({
        ...r,
        specificity: r.specificity ?? 0,
      })),
    }),
    status: 'pending',
    review_comment: null,
  });
  return repo.approveProposal('boot');
}

// -- Source helpers -------------------------------------------------------

let sourceDir: string;

function writeDoc(docId: string, frontmatter: Record<string, string | null>, body: string): void {
  mkdirSync(join(sourceDir, 'documents'), { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v === null ? 'null' : v}`)
    .join('\n');
  writeFileSync(join(sourceDir, 'documents', `${docId}.md`), `---\n${fm}\n---\n${body}`);
}

function writeEdgeFile(filename: string, edges: unknown[]): void {
  mkdirSync(join(sourceDir, 'edges'), { recursive: true });
  writeFileSync(join(sourceDir, 'edges', filename), JSON.stringify(edges, null, 2));
}

function writeLayerRules(rules: unknown[]): void {
  writeFileSync(join(sourceDir, 'layer-rules.json'), JSON.stringify(rules, null, 2));
}

function writeTagMappings(mappings: unknown[]): void {
  writeFileSync(join(sourceDir, 'tag-mappings.json'), JSON.stringify(mappings, null, 2));
}

// -- Tests ---------------------------------------------------------------

describe('shareMaterialize', () => {
  let db: AegisDatabase;
  let repo: Repository;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    sourceDir = mkdtempSync(join(tmpdir(), 'aegis-materialize-'));
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
  });

  describe('valid source → DB progression', () => {
    it('adds new documents and edges from source into an initialized DB', () => {
      // Bootstrap with one doc
      bootstrap(repo, {
        documents: [{ doc_id: 'existing', title: 'Existing', kind: 'guideline', content: 'old' }],
        edges: [],
      });

      // Source has existing + new doc + edge
      writeDoc(
        'existing',
        { doc_id: 'existing', title: 'Existing', kind: 'guideline', ownership: 'standalone' },
        'old',
      );
      writeDoc('new-doc', { doc_id: 'new-doc', title: 'New', kind: 'pattern', ownership: 'standalone' }, 'new body');
      writeEdgeFile('path-requires.json', [
        { edge_id: 'e1', source_value: 'src/**', target_doc_id: 'new-doc', priority: 1, specificity: 10 },
      ]);

      const result = shareMaterialize({ sourceDir, repo });

      expect(result.dry_run).toBe(false);
      expect(result.changes.documents.added).toBe(1);
      expect(result.changes.documents.updated).toBe(0);
      expect(result.changes.edges.added).toBe(1);
      expect(result.knowledge_version).toBeGreaterThan(1);
      expect(result.snapshot_id).toBeTruthy();

      // Verify DB state
      const docs = repo.getApprovedDocuments();
      expect(docs.map((d) => d.doc_id).sort()).toEqual(['existing', 'new-doc']);
      const edges = repo.getApprovedEdges();
      expect(edges).toHaveLength(1);
      expect(edges[0].edge_id).toBe('e1');
    });

    it('updates document content and title', () => {
      bootstrap(repo, {
        documents: [{ doc_id: 'doc1', title: 'Old Title', kind: 'guideline', content: 'old content' }],
        edges: [],
      });

      writeDoc(
        'doc1',
        { doc_id: 'doc1', title: 'New Title', kind: 'guideline', ownership: 'standalone' },
        'new content',
      );

      const result = shareMaterialize({ sourceDir, repo });

      expect(result.changes.documents.updated).toBe(1);
      expect(result.changes.documents.added).toBe(0);

      const doc = repo.getApprovedDocuments().find((d) => d.doc_id === 'doc1');
      expect(doc?.title).toBe('New Title');
      expect(doc?.content).toBe('new content');
      expect(doc?.content_hash).toBe(hash('new content'));
    });

    it('updates document kind', () => {
      bootstrap(repo, {
        documents: [{ doc_id: 'doc1', title: 'D1', kind: 'guideline', content: 'c' }],
        edges: [],
      });

      writeDoc('doc1', { doc_id: 'doc1', title: 'D1', kind: 'pattern', ownership: 'standalone' }, 'c');

      const result = shareMaterialize({ sourceDir, repo });

      expect(result.changes.documents.updated).toBe(1);
      const doc = repo.getApprovedDocuments().find((d) => d.doc_id === 'doc1');
      expect(doc?.kind).toBe('pattern');
    });

    it('updates template_origin and converges on second run', () => {
      bootstrap(repo, {
        documents: [{ doc_id: 'doc1', title: 'D1', kind: 'guideline', content: 'c' }],
        edges: [],
      });

      writeDoc(
        'doc1',
        { doc_id: 'doc1', title: 'D1', kind: 'guideline', ownership: 'standalone', template_origin: 'my-template' },
        'c',
      );

      const result1 = shareMaterialize({ sourceDir, repo });
      expect(result1.changes.documents.updated).toBe(1);

      const doc = repo.getApprovedDocuments().find((d) => d.doc_id === 'doc1');
      expect(doc?.template_origin).toBe('my-template');

      // Second run should converge (no changes)
      const result2 = shareMaterialize({ sourceDir, repo });
      expect(result2.changes.documents.updated).toBe(0);
      expect(result2.warnings).toContain('No changes detected — database is already in sync with shared source.');
    });

    it('deprecates documents not in source', () => {
      bootstrap(repo, {
        documents: [
          { doc_id: 'keep', title: 'Keep', kind: 'guideline', content: 'keep' },
          { doc_id: 'remove', title: 'Remove', kind: 'guideline', content: 'remove' },
        ],
        edges: [],
      });

      // Source only has "keep"
      writeDoc('keep', { doc_id: 'keep', title: 'Keep', kind: 'guideline', ownership: 'standalone' }, 'keep');

      const result = shareMaterialize({ sourceDir, repo });

      expect(result.changes.documents.removed).toBe(1);

      const approved = repo.getApprovedDocuments();
      expect(approved.map((d) => d.doc_id)).toEqual(['keep']);
    });

    it('handles edge updates (remove + re-add)', () => {
      bootstrap(repo, {
        documents: [
          { doc_id: 'doc1', title: 'D1', kind: 'guideline', content: 'c1' },
          { doc_id: 'doc2', title: 'D2', kind: 'guideline', content: 'c2' },
        ],
        edges: [
          {
            edge_id: 'e1',
            source_type: 'path',
            source_value: 'src/**',
            target_doc_id: 'doc1',
            edge_type: 'path_requires',
            priority: 1,
          },
        ],
      });

      writeDoc('doc1', { doc_id: 'doc1', title: 'D1', kind: 'guideline', ownership: 'standalone' }, 'c1');
      writeDoc('doc2', { doc_id: 'doc2', title: 'D2', kind: 'guideline', ownership: 'standalone' }, 'c2');
      // Edge retargeted: target changed from doc1 to doc2
      writeEdgeFile('path-requires.json', [
        { edge_id: 'e1', source_value: 'src/**', target_doc_id: 'doc2', priority: 1, specificity: 0 },
      ]);

      const result = shareMaterialize({ sourceDir, repo });

      expect(result.changes.edges.updated).toBe(1);

      const edges = repo.getApprovedEdges();
      expect(edges).toHaveLength(1);
      expect(edges[0].target_doc_id).toBe('doc2');
    });

    it('removes edges not in source', () => {
      bootstrap(repo, {
        documents: [{ doc_id: 'doc1', title: 'D1', kind: 'guideline', content: 'c' }],
        edges: [
          {
            edge_id: 'e1',
            source_type: 'path',
            source_value: 'src/**',
            target_doc_id: 'doc1',
            edge_type: 'path_requires',
            priority: 1,
          },
        ],
      });

      writeDoc('doc1', { doc_id: 'doc1', title: 'D1', kind: 'guideline', ownership: 'standalone' }, 'c');
      // No edges in source

      const result = shareMaterialize({ sourceDir, repo });

      expect(result.changes.edges.removed).toBe(1);
      expect(repo.getApprovedEdges()).toHaveLength(0);
    });

    it('adds, updates, and removes layer rules', () => {
      bootstrap(repo, {
        documents: [{ doc_id: 'doc1', title: 'D1', kind: 'guideline', content: 'c' }],
        edges: [],
        layer_rules: [
          { rule_id: 'r-keep', path_pattern: 'src/**', layer_name: 'domain', priority: 1 },
          { rule_id: 'r-update', path_pattern: 'lib/**', layer_name: 'infra', priority: 2 },
          { rule_id: 'r-remove', path_pattern: 'test/**', layer_name: 'test', priority: 3 },
        ],
      });

      writeDoc('doc1', { doc_id: 'doc1', title: 'D1', kind: 'guideline', ownership: 'standalone' }, 'c');
      writeLayerRules([
        { rule_id: 'r-keep', path_pattern: 'src/**', layer_name: 'domain', priority: 1, specificity: 0 },
        { rule_id: 'r-update', path_pattern: 'lib/**', layer_name: 'application', priority: 5, specificity: 0 },
        { rule_id: 'r-new', path_pattern: 'api/**', layer_name: 'api', priority: 1, specificity: 0 },
      ]);

      const result = shareMaterialize({ sourceDir, repo });

      expect(result.changes.layer_rules.added).toBe(1);
      expect(result.changes.layer_rules.updated).toBe(1);
      expect(result.changes.layer_rules.removed).toBe(1);

      const rules = repo.getApprovedLayerRules();
      const ruleIds = rules.map((r) => r.rule_id).sort();
      expect(ruleIds).toEqual(['r-keep', 'r-new', 'r-update']);

      const updated = rules.find((r) => r.rule_id === 'r-update');
      expect(updated?.layer_name).toBe('application');
      expect(updated?.priority).toBe(5);
    });

    it('adds and removes tag mappings', () => {
      bootstrap(repo, {
        documents: [{ doc_id: 'doc1', title: 'D1', kind: 'guideline', content: 'c' }],
        edges: [],
      });

      // Pre-seed a tag mapping
      repo.upsertTagMapping({ tag: 'old-tag', doc_id: 'doc1', confidence: 0.8, source: 'manual' });

      writeDoc('doc1', { doc_id: 'doc1', title: 'D1', kind: 'guideline', ownership: 'standalone' }, 'c');
      writeTagMappings([{ tag: 'new-tag', doc_id: 'doc1', confidence: 0.9, source: 'manual' }]);

      const result = shareMaterialize({ sourceDir, repo });

      expect(result.changes.tag_mappings.added).toBe(1);
      expect(result.changes.tag_mappings.removed).toBe(1);

      const tags = repo.getTagsForDocument('doc1');
      expect(tags).toHaveLength(1);
      expect(tags[0].tag).toBe('new-tag');
    });

    it('content_hash is recomputed from body', () => {
      bootstrap(repo, {
        documents: [{ doc_id: 'doc1', title: 'D1', kind: 'guideline', content: 'original' }],
        edges: [],
      });

      writeDoc('doc1', { doc_id: 'doc1', title: 'D1', kind: 'guideline', ownership: 'standalone' }, 'updated body');

      shareMaterialize({ sourceDir, repo });

      const doc = repo.getApprovedDocuments().find((d) => d.doc_id === 'doc1');
      expect(doc?.content_hash).toBe(hash('updated body'));
    });
  });

  describe('knowledge_version semantics', () => {
    it('increments knowledge_version on apply', () => {
      const { knowledge_version: v0 } = bootstrap(repo, {
        documents: [{ doc_id: 'doc1', title: 'D1', kind: 'guideline', content: 'c' }],
        edges: [],
      });

      writeDoc('doc1', { doc_id: 'doc1', title: 'D1', kind: 'guideline', ownership: 'standalone' }, 'new content');

      const result = shareMaterialize({ sourceDir, repo });
      expect(result.knowledge_version).toBeGreaterThan(v0);
    });
  });

  describe('dry-run', () => {
    it('reports changes without modifying DB', () => {
      bootstrap(repo, {
        documents: [{ doc_id: 'doc1', title: 'D1', kind: 'guideline', content: 'c' }],
        edges: [],
      });

      const vBefore = repo.getKnowledgeMeta().current_version;

      writeDoc('doc1', { doc_id: 'doc1', title: 'D1', kind: 'guideline', ownership: 'standalone' }, 'changed');
      writeDoc('new-doc', { doc_id: 'new-doc', title: 'New', kind: 'pattern', ownership: 'standalone' }, 'body');

      const result = shareMaterialize({ sourceDir, repo, dryRun: true });

      expect(result.dry_run).toBe(true);
      expect(result.changes.documents.added).toBe(1);
      expect(result.changes.documents.updated).toBe(1);
      expect(result.snapshot_id).toBeNull();

      // DB unchanged
      expect(repo.getKnowledgeMeta().current_version).toBe(vBefore);
      expect(repo.getApprovedDocuments()).toHaveLength(1);
    });
  });

  describe('malformed source', () => {
    it('throws on parse/lint errors without modifying DB', () => {
      bootstrap(repo, {
        documents: [{ doc_id: 'doc1', title: 'D1', kind: 'guideline', content: 'c' }],
        edges: [],
      });

      const vBefore = repo.getKnowledgeMeta().current_version;

      // Write an invalid document (missing required fields)
      mkdirSync(join(sourceDir, 'documents'), { recursive: true });
      writeFileSync(join(sourceDir, 'documents', 'bad.md'), '---\ndoc_id: bad\n---\nno title or kind');

      expect(() => shareMaterialize({ sourceDir, repo })).toThrow('validation failed');

      // DB unchanged
      expect(repo.getKnowledgeMeta().current_version).toBe(vBefore);
    });

    it('throws on referential integrity error', () => {
      bootstrap(repo, {
        documents: [{ doc_id: 'doc1', title: 'D1', kind: 'guideline', content: 'c' }],
        edges: [],
      });

      writeDoc('doc1', { doc_id: 'doc1', title: 'D1', kind: 'guideline', ownership: 'standalone' }, 'c');
      // Edge referencing non-existent document
      writeEdgeFile('path-requires.json', [
        { edge_id: 'e1', source_value: 'src/**', target_doc_id: 'ghost', priority: 1, specificity: 1 },
      ]);

      expect(() => shareMaterialize({ sourceDir, repo })).toThrow('validation failed');
    });
  });

  describe('uninitialized DB', () => {
    it('throws when DB is not initialized', () => {
      writeDoc('doc1', { doc_id: 'doc1', title: 'D1', kind: 'guideline', ownership: 'standalone' }, 'body');

      expect(() => shareMaterialize({ sourceDir, repo })).toThrow('not initialized');
    });
  });

  describe('no changes', () => {
    it('returns no-change warning when source matches DB', () => {
      bootstrap(repo, {
        documents: [{ doc_id: 'doc1', title: 'D1', kind: 'guideline', content: 'c' }],
        edges: [
          {
            edge_id: 'e1',
            source_type: 'path',
            source_value: 'src/**',
            target_doc_id: 'doc1',
            edge_type: 'path_requires',
            priority: 1,
          },
        ],
      });

      writeDoc('doc1', { doc_id: 'doc1', title: 'D1', kind: 'guideline', ownership: 'standalone' }, 'c');
      writeEdgeFile('path-requires.json', [
        { edge_id: 'e1', source_value: 'src/**', target_doc_id: 'doc1', priority: 1, specificity: 0 },
      ]);

      const result = shareMaterialize({ sourceDir, repo });

      expect(result.warnings).toContain('No changes detected — database is already in sync with shared source.');
    });
  });

  describe('empty source guardrail', () => {
    it('throws when source has no documents but DB has approved documents', () => {
      bootstrap(repo, {
        documents: [{ doc_id: 'doc1', title: 'D1', kind: 'guideline', content: 'c' }],
        edges: [],
      });

      // Empty source dir (no documents)
      expect(() => shareMaterialize({ sourceDir, repo })).toThrow('no documents');
    });
  });

  describe('deprecated doc re-activation', () => {
    it('re-activates a previously deprecated document without PK collision', () => {
      bootstrap(repo, {
        documents: [
          { doc_id: 'doc1', title: 'D1', kind: 'guideline', content: 'c1' },
          { doc_id: 'keep', title: 'Keep', kind: 'guideline', content: 'keep' },
        ],
        edges: [],
      });

      // First materialize: remove doc1
      writeDoc('keep', { doc_id: 'keep', title: 'Keep', kind: 'guideline', ownership: 'standalone' }, 'keep');
      shareMaterialize({ sourceDir, repo });
      expect(repo.getApprovedDocuments().map((d) => d.doc_id)).toEqual(['keep']);

      // Second materialize: bring doc1 back
      writeDoc('doc1', { doc_id: 'doc1', title: 'D1 v2', kind: 'guideline', ownership: 'standalone' }, 'new content');
      const result = shareMaterialize({ sourceDir, repo });

      expect(result.changes.documents.updated).toBe(1); // re-activation counted as update
      const doc = repo.getApprovedDocuments().find((d) => d.doc_id === 'doc1');
      expect(doc?.title).toBe('D1 v2');
      expect(doc?.content).toBe('new content');
    });
  });

  describe('pending proposal guard', () => {
    it('throws when pending proposals exist', () => {
      bootstrap(repo, {
        documents: [{ doc_id: 'doc1', title: 'D1', kind: 'guideline', content: 'c' }],
        edges: [],
      });

      // Create a pending proposal
      repo.insertProposal({
        proposal_id: 'pending-1',
        proposal_type: 'update_doc',
        payload: JSON.stringify({ doc_id: 'doc1', content: 'pending change', content_hash: hash('pending change') }),
        status: 'pending',
        review_comment: 'test',
        bundle_id: null,
      });

      writeDoc('doc1', { doc_id: 'doc1', title: 'D1', kind: 'guideline', ownership: 'standalone' }, 'c');

      expect(() => shareMaterialize({ sourceDir, repo })).toThrow('pending proposal');
    });
  });

  describe('single knowledge_version bump', () => {
    it('produces exactly one version bump for multiple changes', () => {
      const { knowledge_version: v0 } = bootstrap(repo, {
        documents: [
          { doc_id: 'doc1', title: 'D1', kind: 'guideline', content: 'c1' },
          { doc_id: 'doc2', title: 'D2', kind: 'guideline', content: 'c2' },
        ],
        edges: [],
      });

      writeDoc('doc1', { doc_id: 'doc1', title: 'D1', kind: 'guideline', ownership: 'standalone' }, 'updated1');
      writeDoc('doc2', { doc_id: 'doc2', title: 'D2', kind: 'guideline', ownership: 'standalone' }, 'updated2');
      writeDoc('doc3', { doc_id: 'doc3', title: 'D3', kind: 'pattern', ownership: 'standalone' }, 'new');

      const result = shareMaterialize({ sourceDir, repo });

      // Should be exactly v0 + 1 (one bundle approve = one version bump)
      expect(result.knowledge_version).toBe(v0 + 1);
    });
  });

  describe('compile parity after materialize', () => {
    it('share-export after materialize produces source-aligned bundle', () => {
      // Bootstrap with minimal state
      bootstrap(repo, {
        documents: [{ doc_id: 'seed', title: 'Seed', kind: 'guideline', content: 'seed' }],
        edges: [],
      });

      // Source defines a complete knowledge set
      writeDoc(
        'arch',
        { doc_id: 'arch', title: 'Architecture', kind: 'guideline', ownership: 'standalone' },
        'arch body',
      );
      writeDoc(
        'patterns',
        { doc_id: 'patterns', title: 'Patterns', kind: 'pattern', ownership: 'standalone' },
        'patterns body',
      );
      writeEdgeFile('path-requires.json', [
        { edge_id: 'e-arch', source_value: 'src/**', target_doc_id: 'arch', priority: 1, specificity: 10 },
        {
          edge_id: 'e-patterns',
          source_value: 'src/domain/**',
          target_doc_id: 'patterns',
          priority: 2,
          specificity: 20,
        },
      ]);
      writeLayerRules([
        { rule_id: 'lr1', path_pattern: 'src/domain/**', layer_name: 'domain', priority: 1, specificity: 0 },
      ]);
      writeTagMappings([{ tag: 'architecture', doc_id: 'arch', confidence: 1.0, source: 'manual' }]);

      // Materialize
      shareMaterialize({ sourceDir, repo });

      // Export to bundle
      const exportDir = mkdtempSync(join(tmpdir(), 'aegis-export-'));
      try {
        const exportResult = shareExport(repo, exportDir);

        // Verify bundle contains the materialized docs (minus the seed which was deprecated)
        expect(exportResult.counts.documents).toBe(2); // arch + patterns (seed is deprecated)
        expect(exportResult.counts.edges).toBe(2);
        expect(exportResult.counts.layer_rules).toBe(1);
        expect(exportResult.counts.tag_mappings).toBe(1);
      } finally {
        rmSync(exportDir, { recursive: true, force: true });
      }
    });

    it('compile_context resolves materialized documents from DB (not source)', async () => {
      bootstrap(repo, {
        documents: [{ doc_id: 'seed', title: 'Seed', kind: 'guideline', content: 'seed' }],
        edges: [],
      });

      writeDoc(
        'guide',
        { doc_id: 'guide', title: 'Guide', kind: 'guideline', ownership: 'standalone' },
        'guide content',
      );
      writeEdgeFile('path-requires.json', [
        { edge_id: 'e-guide', source_value: 'src/**', target_doc_id: 'guide', priority: 1, specificity: 10 },
      ]);

      shareMaterialize({ sourceDir, repo });

      // Delete source dir to prove compile reads from DB, not source
      rmSync(sourceDir, { recursive: true, force: true });

      const compiler = new ContextCompiler(repo);
      const compiled = await compiler.compile({
        target_files: ['src/app.ts'],
        intent_tags: [],
      });

      // Verify the materialized document is returned from DB (source deleted)
      const docIds = compiled.base.documents.map((d) => d.doc_id);
      expect(docIds).toContain('guide');

      const guideDoc = compiled.base.documents.find((d) => d.doc_id === 'guide');
      expect(guideDoc?.content).toBe('guide content');
    });
  });
});
