import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AegisDatabase, createInMemoryDatabase, Repository } from '../store/index.js';
import { shareFormat } from './format.js';
import { shareLint } from './lint.js';
import { shareMaterialize } from './materialize.js';
import { shareSourceExport } from './source-export.js';

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
      source_path?: string;
      template_origin?: string;
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

describe('shareSourceExport', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let outDir: string;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    outDir = mkdtempSync(join(tmpdir(), 'aegis-source-export-'));
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('exports documents as frontmatter + body markdown files', () => {
    bootstrap(repo, {
      documents: [
        { doc_id: 'arch-guide', title: 'Architecture Guide', kind: 'guideline', content: 'Guide body here.' },
        { doc_id: 'patterns', title: 'Patterns', kind: 'pattern', content: 'Pattern body.' },
      ],
      edges: [],
    });

    const result = shareSourceExport(repo, outDir);

    expect(result.counts.documents).toBe(2);
    expect(existsSync(join(outDir, 'documents', 'arch-guide.md'))).toBe(true);
    expect(existsSync(join(outDir, 'documents', 'patterns.md'))).toBe(true);

    const content = readFileSync(join(outDir, 'documents', 'arch-guide.md'), 'utf-8');
    expect(content).toContain('doc_id: arch-guide');
    expect(content).toContain('title: Architecture Guide');
    expect(content).toContain('kind: guideline');
    expect(content).toContain('Guide body here.');
  });

  it('exports edges grouped by source_type into correct files', () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'doc1', title: 'D1', kind: 'guideline', content: 'c' }],
      edges: [
        {
          edge_id: 'e-path',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'doc1',
          edge_type: 'path_requires',
          priority: 1,
        },
        {
          edge_id: 'e-layer',
          source_type: 'layer',
          source_value: 'domain',
          target_doc_id: 'doc1',
          edge_type: 'layer_requires',
          priority: 2,
        },
      ],
    });

    const result = shareSourceExport(repo, outDir);

    expect(result.counts.edges).toBe(2);
    expect(existsSync(join(outDir, 'edges', 'path-requires.json'))).toBe(true);
    expect(existsSync(join(outDir, 'edges', 'layer-requires.json'))).toBe(true);

    const pathEdges = JSON.parse(readFileSync(join(outDir, 'edges', 'path-requires.json'), 'utf-8'));
    expect(pathEdges).toHaveLength(1);
    expect(pathEdges[0].edge_id).toBe('e-path');
    // source_type and edge_type should NOT be in the JSON (file-derived)
    expect(pathEdges[0].source_type).toBeUndefined();
    expect(pathEdges[0].edge_type).toBeUndefined();
  });

  it('exports layer rules and tag mappings', () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'doc1', title: 'D1', kind: 'guideline', content: 'c' }],
      edges: [],
      layer_rules: [{ rule_id: 'lr1', path_pattern: 'src/**', layer_name: 'domain', priority: 1 }],
    });
    repo.upsertTagMapping({ tag: 'architecture', doc_id: 'doc1', confidence: 0.9, source: 'manual' });

    const result = shareSourceExport(repo, outDir);

    expect(result.counts.layer_rules).toBe(1);
    expect(result.counts.tag_mappings).toBe(1);

    const rules = JSON.parse(readFileSync(join(outDir, 'layer-rules.json'), 'utf-8'));
    expect(rules[0].rule_id).toBe('lr1');

    const mappings = JSON.parse(readFileSync(join(outDir, 'tag-mappings.json'), 'utf-8'));
    expect(mappings[0].tag).toBe('architecture');
  });

  it('produces deterministic output from same DB state', () => {
    bootstrap(repo, {
      documents: [
        { doc_id: 'z-doc', title: 'Z', kind: 'guideline', content: 'z' },
        { doc_id: 'a-doc', title: 'A', kind: 'pattern', content: 'a' },
      ],
      edges: [
        {
          edge_id: 'e2',
          source_type: 'path',
          source_value: 'lib/**',
          target_doc_id: 'z-doc',
          edge_type: 'path_requires',
          priority: 2,
        },
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'a-doc',
          edge_type: 'path_requires',
          priority: 1,
        },
      ],
    });

    // First export
    const dir1 = mkdtempSync(join(tmpdir(), 'aegis-det-1-'));
    shareSourceExport(repo, dir1);

    // Second export
    const dir2 = mkdtempSync(join(tmpdir(), 'aegis-det-2-'));
    shareSourceExport(repo, dir2);

    // Compare all files
    const aDoc1 = readFileSync(join(dir1, 'documents', 'a-doc.md'), 'utf-8');
    const aDoc2 = readFileSync(join(dir2, 'documents', 'a-doc.md'), 'utf-8');
    expect(aDoc1).toBe(aDoc2);

    const edges1 = readFileSync(join(dir1, 'edges', 'path-requires.json'), 'utf-8');
    const edges2 = readFileSync(join(dir2, 'edges', 'path-requires.json'), 'utf-8');
    expect(edges1).toBe(edges2);

    // Verify sorting: e1 before e2
    const parsed = JSON.parse(edges1);
    expect(parsed[0].edge_id).toBe('e1');
    expect(parsed[1].edge_id).toBe('e2');

    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  });

  it('passes share-lint after export', () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'guide', title: 'Guide', kind: 'guideline', content: 'Body.' }],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'guide',
          edge_type: 'path_requires',
          priority: 1,
        },
      ],
      layer_rules: [{ rule_id: 'lr1', path_pattern: 'src/**', layer_name: 'domain', priority: 1 }],
    });
    repo.upsertTagMapping({ tag: 'arch', doc_id: 'guide', confidence: 1.0, source: 'manual' });

    shareSourceExport(repo, outDir);
    const lintResult = shareLint(outDir);

    expect(lintResult.ok).toBe(true);
    expect(lintResult.counts.documents).toBe(1);
    expect(lintResult.counts.edges).toBe(1);
  });

  it('share-format second run is no-op after export', () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'guide', title: 'Guide', kind: 'guideline', content: 'Body.' }],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'guide',
          edge_type: 'path_requires',
          priority: 1,
        },
      ],
    });

    shareSourceExport(repo, outDir);

    // First format run
    shareFormat(outDir);

    // Second format run should be no-op
    const result = shareFormat(outDir);
    expect(result.files_changed).toBe(0);
  });

  it('only exports approved documents (not deprecated)', () => {
    bootstrap(repo, {
      documents: [
        { doc_id: 'keep', title: 'Keep', kind: 'guideline', content: 'keep' },
        { doc_id: 'gone', title: 'Gone', kind: 'guideline', content: 'gone' },
      ],
      edges: [],
    });

    // Deprecate one document
    repo.insertProposal({
      proposal_id: 'dep1',
      proposal_type: 'deprecate',
      payload: JSON.stringify({ entity_type: 'document', entity_id: 'gone' }),
      status: 'pending',
      review_comment: null,
      bundle_id: null,
    });
    repo.approveProposal('dep1');

    const result = shareSourceExport(repo, outDir);

    expect(result.counts.documents).toBe(1);
    expect(existsSync(join(outDir, 'documents', 'keep.md'))).toBe(true);
    expect(existsSync(join(outDir, 'documents', 'gone.md'))).toBe(false);
  });

  it('skips edges referencing deprecated documents and lint still passes', () => {
    bootstrap(repo, {
      documents: [
        { doc_id: 'alive', title: 'Alive', kind: 'guideline', content: 'alive' },
        { doc_id: 'dead', title: 'Dead', kind: 'guideline', content: 'dead' },
      ],
      edges: [
        {
          edge_id: 'e-alive',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'alive',
          edge_type: 'path_requires',
          priority: 1,
        },
        {
          edge_id: 'e-dead',
          source_type: 'path',
          source_value: 'lib/**',
          target_doc_id: 'dead',
          edge_type: 'path_requires',
          priority: 1,
        },
      ],
    });

    // Deprecate 'dead' but its edge remains approved in DB
    repo.insertProposal({
      proposal_id: 'dep-dead',
      proposal_type: 'deprecate',
      payload: JSON.stringify({ entity_type: 'document', entity_id: 'dead' }),
      status: 'pending',
      review_comment: null,
      bundle_id: null,
    });
    repo.approveProposal('dep-dead');

    const result = shareSourceExport(repo, outDir);

    // Only edge to alive should be exported
    expect(result.counts.edges).toBe(1);
    expect(result.warnings.some((w) => w.includes('e-dead'))).toBe(true);

    // lint should pass
    const lintResult = shareLint(outDir);
    expect(lintResult.ok).toBe(true);
  });

  it('throws when DB is not initialized', () => {
    expect(() => shareSourceExport(repo, outDir)).toThrow('not initialized');
  });

  it('includes optional fields (source_path, template_origin) when present', () => {
    bootstrap(repo, {
      documents: [
        {
          doc_id: 'anchored',
          title: 'Anchored',
          kind: 'guideline',
          content: 'body',
          ownership: 'file-anchored',
          source_path: 'docs/arch.md',
          template_origin: 'my-template',
        },
      ],
      edges: [],
    });

    shareSourceExport(repo, outDir);

    const content = readFileSync(join(outDir, 'documents', 'anchored.md'), 'utf-8');
    expect(content).toContain('source_path: docs/arch.md');
    expect(content).toContain('template_origin: my-template');
    expect(content).toContain('ownership: file-anchored');
  });

  it('prunes stale files when re-exporting to same directory', () => {
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
      layer_rules: [{ rule_id: 'lr1', path_pattern: 'src/**', layer_name: 'domain', priority: 1 }],
    });
    repo.upsertTagMapping({ tag: 't1', doc_id: 'doc1', confidence: 1.0, source: 'manual' });

    // First export
    shareSourceExport(repo, outDir);
    expect(existsSync(join(outDir, 'documents', 'doc2.md'))).toBe(true);
    expect(existsSync(join(outDir, 'edges', 'path-requires.json'))).toBe(true);
    expect(existsSync(join(outDir, 'layer-rules.json'))).toBe(true);
    expect(existsSync(join(outDir, 'tag-mappings.json'))).toBe(true);

    // Deprecate doc2, remove edge, remove layer rule, remove tag mapping
    repo.insertProposal({
      proposal_id: 'dep1',
      proposal_type: 'deprecate',
      payload: JSON.stringify({ entity_type: 'document', entity_id: 'doc2' }),
      status: 'pending',
      review_comment: null,
      bundle_id: null,
    });
    repo.approveProposal('dep1');
    repo.insertProposal({
      proposal_id: 'rem-e1',
      proposal_type: 'remove_edge',
      payload: JSON.stringify({ edge_id: 'e1' }),
      status: 'pending',
      review_comment: null,
      bundle_id: null,
    });
    repo.approveProposal('rem-e1');
    repo.insertProposal({
      proposal_id: 'dep-lr1',
      proposal_type: 'deprecate',
      payload: JSON.stringify({ entity_type: 'layer_rule', entity_id: 'lr1' }),
      status: 'pending',
      review_comment: null,
      bundle_id: null,
    });
    repo.approveProposal('dep-lr1');
    repo.deleteTagMapping('t1', 'doc1');

    // Re-export to same directory
    const result = shareSourceExport(repo, outDir);

    expect(result.counts.documents).toBe(1);
    expect(existsSync(join(outDir, 'documents', 'doc1.md'))).toBe(true);
    expect(existsSync(join(outDir, 'documents', 'doc2.md'))).toBe(false); // pruned
    expect(existsSync(join(outDir, 'edges', 'path-requires.json'))).toBe(false); // pruned
    expect(existsSync(join(outDir, 'layer-rules.json'))).toBe(false); // pruned
    expect(existsSync(join(outDir, 'tag-mappings.json'))).toBe(false); // pruned
  });

  it('cleans unknown files from dirty output directory', () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'guide', title: 'Guide', kind: 'guideline', content: 'Body.' }],
      edges: [],
    });

    // Pre-populate outDir with junk
    mkdirSync(join(outDir, 'documents'), { recursive: true });
    writeFileSync(join(outDir, 'documents', 'junk.txt'), 'trash');
    writeFileSync(join(outDir, 'unknown-file.json'), '{}');

    shareSourceExport(repo, outDir);

    // Junk should be gone, lint should pass
    expect(existsSync(join(outDir, 'documents', 'junk.txt'))).toBe(false);
    expect(existsSync(join(outDir, 'unknown-file.json'))).toBe(false);

    const lintResult = shareLint(outDir);
    expect(lintResult.ok).toBe(true);
  });

  it('export → materialize round-trip preserves compile parity', async () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'guide', title: 'Guide', kind: 'guideline', content: 'Body.' }],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'guide',
          edge_type: 'path_requires',
          priority: 1,
        },
      ],
    });
    repo.upsertTagMapping({ tag: 'arch', doc_id: 'guide', confidence: 1.0, source: 'manual' });

    // Export
    shareSourceExport(repo, outDir);

    // Lint should pass
    const lintResult = shareLint(outDir);
    expect(lintResult.ok).toBe(true);

    // Materialize into a fresh DB and compare
    const db2 = await createInMemoryDatabase();
    const repo2 = new Repository(db2);
    // Bootstrap with a seed so DB is initialized
    repo2.insertProposal({
      proposal_id: 'boot2',
      proposal_type: 'bootstrap',
      payload: JSON.stringify({
        documents: [{ doc_id: '_seed', title: 'Seed', kind: 'guideline', content: 's', content_hash: hash('s') }],
        edges: [],
        layer_rules: [],
      }),
      status: 'pending',
      review_comment: null,
    });
    repo2.approveProposal('boot2');

    // Import the exported source into repo2 via materialize
    shareMaterialize({ sourceDir: outDir, repo: repo2 });

    // Compare approved state
    const docs2 = repo2
      .getApprovedDocuments()
      .map((d) => d.doc_id)
      .sort();
    expect(docs2).toEqual(['guide']); // _seed is deprecated by materialize
    const edges2 = repo2.getApprovedEdges();
    expect(edges2).toHaveLength(1);
    expect(edges2[0].edge_id).toBe('e1');
    const tags2 = repo2.getTagsForDocument('guide');
    expect(tags2).toHaveLength(1);
    expect(tags2[0].tag).toBe('arch');
  });

  it('export → materialize → export → dry-run materialize converges', () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'guide', title: 'Guide', kind: 'guideline', content: 'Body.\n' }],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'guide',
          edge_type: 'path_requires',
          priority: 1,
        },
      ],
      layer_rules: [{ rule_id: 'lr1', path_pattern: 'src/**', layer_name: 'domain', priority: 1 }],
    });
    repo.upsertTagMapping({ tag: 'arch', doc_id: 'guide', confidence: 1.0, source: 'manual' });

    // Export, then materialize to sync content format, then re-export
    shareSourceExport(repo, outDir);
    shareMaterialize({ sourceDir: outDir, repo });
    shareSourceExport(repo, outDir);

    // Dry-run materialize should now show zero changes (converged)
    const result = shareMaterialize({ sourceDir: outDir, repo, dryRun: true });

    expect(result.changes.documents.added).toBe(0);
    expect(result.changes.documents.updated).toBe(0);
    expect(result.changes.documents.removed).toBe(0);
    expect(result.changes.edges.added).toBe(0);
    expect(result.changes.edges.updated).toBe(0);
    expect(result.changes.edges.removed).toBe(0);
  });
});
