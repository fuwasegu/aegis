import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AegisDatabase, createInMemoryDatabase, Repository } from '../store/index.js';
import { shareExport } from './export.js';
import type { SharedCanonicalBundleV1, SharedCanonicalManifestV1 } from './types.js';

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
      source_path?: string;
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

describe('shareExport', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let outDir: string;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    outDir = mkdtempSync(join(tmpdir(), 'aegis-share-test-'));
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('throws on uninitialized DB', () => {
    expect(() => shareExport(repo, outDir)).toThrow('not initialized');
  });

  it('exports approved canonical data', () => {
    bootstrap(repo, {
      documents: [
        { doc_id: 'doc-a', title: 'Doc A', kind: 'guideline', content: 'content-a' },
        { doc_id: 'doc-b', title: 'Doc B', kind: 'pattern', content: 'content-b' },
      ],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'doc-a',
          edge_type: 'path_requires',
          priority: 1,
        },
      ],
      layer_rules: [{ rule_id: 'lr1', path_pattern: 'src/**', layer_name: 'core', priority: 1, specificity: 10 }],
    });

    const result = shareExport(repo, outDir);

    expect(result.knowledge_version).toBe(1);
    expect(result.snapshot_id).toBeTruthy();
    expect(result.bundle_sha256).toBeTruthy();
    expect(result.counts.documents).toBe(2);
    expect(result.counts.edges).toBe(1);
    expect(result.counts.layer_rules).toBe(1);

    // Verify files exist
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(true);
    expect(existsSync(join(outDir, 'canonical.json'))).toBe(true);

    // Verify manifest structure
    const manifest: SharedCanonicalManifestV1 = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8'));
    expect(manifest.format_version).toBe(1);
    expect(manifest.bundle_file).toBe('canonical.json');
    expect(manifest.snapshot_id).toBe(result.snapshot_id);
    expect(manifest.knowledge_version).toBe(1);
    expect(manifest.bundle_sha256).toBe(result.bundle_sha256);

    // Verify bundle structure
    const bundle: SharedCanonicalBundleV1 = JSON.parse(readFileSync(join(outDir, 'canonical.json'), 'utf-8'));
    expect(bundle.format_version).toBe(1);
    expect(bundle.snapshot_id).toBe(result.snapshot_id);
    expect(bundle.knowledge_version).toBe(1);
    expect(bundle.documents).toHaveLength(2);
    expect(bundle.edges).toHaveLength(1);
    expect(bundle.layer_rules).toHaveLength(1);

    // Verify bundle_sha256 matches actual file hash
    const canonicalContent = readFileSync(join(outDir, 'canonical.json'), 'utf-8');
    const expectedHash = createHash('sha256').update(canonicalContent, 'utf-8').digest('hex');
    expect(manifest.bundle_sha256).toBe(expectedHash);
  });

  it('produces byte-identical output from same snapshot (deterministic)', () => {
    bootstrap(repo, {
      documents: [
        { doc_id: 'doc-z', title: 'Z', kind: 'guideline', content: 'z-content' },
        { doc_id: 'doc-a', title: 'A', kind: 'pattern', content: 'a-content' },
      ],
      edges: [
        {
          edge_id: 'e2',
          source_type: 'path',
          source_value: 'lib/**',
          target_doc_id: 'doc-z',
          edge_type: 'path_requires',
          priority: 1,
        },
        {
          edge_id: 'e1',
          source_type: 'command',
          source_value: 'review',
          target_doc_id: 'doc-a',
          edge_type: 'command_requires',
          priority: 2,
        },
      ],
    });

    const dir1 = mkdtempSync(join(tmpdir(), 'aegis-share-det1-'));
    const dir2 = mkdtempSync(join(tmpdir(), 'aegis-share-det2-'));

    try {
      shareExport(repo, dir1);
      shareExport(repo, dir2);

      const canonical1 = readFileSync(join(dir1, 'canonical.json'), 'utf-8');
      const canonical2 = readFileSync(join(dir2, 'canonical.json'), 'utf-8');
      expect(canonical1).toBe(canonical2);

      const manifest1 = readFileSync(join(dir1, 'manifest.json'), 'utf-8');
      const manifest2 = readFileSync(join(dir2, 'manifest.json'), 'utf-8');
      expect(manifest1).toBe(manifest2);
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('bundle is unchanged when compile_log or observations are added', () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'doc-1', title: 'D1', kind: 'guideline', content: 'content-1' }],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'doc-1',
          edge_type: 'path_requires',
          priority: 1,
        },
      ],
    });

    // First export
    const dir1 = mkdtempSync(join(tmpdir(), 'aegis-share-obs1-'));

    try {
      shareExport(repo, dir1);
      const canonical1 = readFileSync(join(dir1, 'canonical.json'), 'utf-8');

      // Add observations (should not affect bundle)
      const snapshot = repo.getCurrentSnapshot()!;
      repo.insertObservation({
        observation_id: 'obs-1',
        event_type: 'compile_miss',
        payload: JSON.stringify({
          target_files: ['src/foo.ts'],
          review_comment: 'missing doc',
        }),
        related_compile_id: null,
        related_snapshot_id: snapshot.snapshot_id,
      });

      // Add compile_log (should not affect bundle)
      repo.insertCompileLog({
        compile_id: 'clog-1',
        snapshot_id: snapshot.snapshot_id,
        request: '{}',
        base_doc_ids: JSON.stringify([]),
        expanded_doc_ids: null,
        audit_meta: null,
        agent_id: null,
      });

      // Second export to different dir
      const dir2 = mkdtempSync(join(tmpdir(), 'aegis-share-obs2-'));
      try {
        shareExport(repo, dir2);
        const canonical2 = readFileSync(join(dir2, 'canonical.json'), 'utf-8');
        expect(canonical1).toBe(canonical2);
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir1, { recursive: true, force: true });
    }
  });

  it('excludes deprecated / draft / proposed documents', () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'doc-approved', title: 'Approved', kind: 'guideline', content: 'approved-content' }],
      edges: [],
    });

    // Add a proposed document via proposal (not approved)
    repo.insertProposal({
      proposal_id: 'p-new',
      proposal_type: 'new_doc',
      payload: JSON.stringify({
        doc_id: 'doc-proposed',
        title: 'Proposed',
        kind: 'guideline',
        content: 'proposed-content',
        content_hash: hash('proposed-content'),
      }),
      status: 'pending',
      review_comment: null,
    });

    const _result = shareExport(repo, outDir);
    const bundle: SharedCanonicalBundleV1 = JSON.parse(readFileSync(join(outDir, 'canonical.json'), 'utf-8'));

    expect(bundle.documents).toHaveLength(1);
    expect(bundle.documents[0].doc_id).toBe('doc-approved');
  });

  it('excludes tag mappings not linked to approved documents', () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'doc-ok', title: 'OK', kind: 'guideline', content: 'ok-content' }],
      edges: [],
    });

    // Add tag mapping for approved doc
    repo.upsertTagMapping({
      tag: 'tag-valid',
      doc_id: 'doc-ok',
      confidence: 0.9,
      source: 'manual',
    });

    // Approve a second doc, then deprecate it → tag mapping becomes orphaned
    repo.insertProposal({
      proposal_id: 'p-extra',
      proposal_type: 'new_doc',
      payload: JSON.stringify({
        doc_id: 'doc-deprecated',
        title: 'Will Deprecate',
        kind: 'guideline',
        content: 'deprecated-content',
        content_hash: hash('deprecated-content'),
      }),
      status: 'pending',
      review_comment: null,
    });
    repo.approveProposal('p-extra');
    // Add tag mapping while doc is still approved
    repo.upsertTagMapping({
      tag: 'tag-orphan',
      doc_id: 'doc-deprecated',
      confidence: 0.8,
      source: 'slm',
    });
    // Now deprecate the doc
    repo.insertProposal({
      proposal_id: 'p-deprecate',
      proposal_type: 'deprecate',
      payload: JSON.stringify({ entity_type: 'document', entity_id: 'doc-deprecated' }),
      status: 'pending',
      review_comment: null,
    });
    repo.approveProposal('p-deprecate');

    const result = shareExport(repo, outDir);
    const bundle: SharedCanonicalBundleV1 = JSON.parse(readFileSync(join(outDir, 'canonical.json'), 'utf-8'));

    expect(result.counts.tag_mappings).toBe(1);
    expect(bundle.tag_mappings).toHaveLength(1);
    expect(bundle.tag_mappings[0].tag).toBe('tag-valid');
    expect(bundle.tag_mappings[0].doc_id).toBe('doc-ok');
  });

  it('includes tag mappings in export and sets includes_tag_mappings flag', () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'doc-1', title: 'D1', kind: 'guideline', content: 'content-1' }],
      edges: [],
    });

    repo.upsertTagMapping({
      tag: 'my-tag',
      doc_id: 'doc-1',
      confidence: 0.95,
      source: 'manual',
    });

    shareExport(repo, outDir);
    const manifest: SharedCanonicalManifestV1 = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8'));
    expect(manifest.includes_tag_mappings).toBe(true);

    const bundle: SharedCanonicalBundleV1 = JSON.parse(readFileSync(join(outDir, 'canonical.json'), 'utf-8'));
    expect(bundle.tag_mappings).toHaveLength(1);
    expect(bundle.tag_mappings[0]).toEqual({
      tag: 'my-tag',
      doc_id: 'doc-1',
      confidence: 0.95,
      source: 'manual',
    });
  });

  it('sets includes_tag_mappings to false when no tag mappings exist', () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'doc-1', title: 'D1', kind: 'guideline', content: 'c' }],
      edges: [],
    });

    shareExport(repo, outDir);
    const manifest: SharedCanonicalManifestV1 = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8'));
    expect(manifest.includes_tag_mappings).toBe(false);
  });

  it('documents are sorted by doc_id ASC', () => {
    bootstrap(repo, {
      documents: [
        { doc_id: 'z-doc', title: 'Z', kind: 'guideline', content: 'z' },
        { doc_id: 'a-doc', title: 'A', kind: 'pattern', content: 'a' },
        { doc_id: 'm-doc', title: 'M', kind: 'constraint', content: 'm' },
      ],
      edges: [],
    });

    shareExport(repo, outDir);
    const bundle: SharedCanonicalBundleV1 = JSON.parse(readFileSync(join(outDir, 'canonical.json'), 'utf-8'));
    const ids = bundle.documents.map((d) => d.doc_id);
    expect(ids).toEqual(['a-doc', 'm-doc', 'z-doc']);
  });

  it('edges are sorted by edge_id ASC', () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'doc-1', title: 'D1', kind: 'guideline', content: 'c' }],
      edges: [
        {
          edge_id: 'e-z',
          source_type: 'path',
          source_value: 'z/**',
          target_doc_id: 'doc-1',
          edge_type: 'path_requires',
          priority: 1,
        },
        {
          edge_id: 'e-a',
          source_type: 'path',
          source_value: 'a/**',
          target_doc_id: 'doc-1',
          edge_type: 'path_requires',
          priority: 2,
        },
      ],
    });

    shareExport(repo, outDir);
    const bundle: SharedCanonicalBundleV1 = JSON.parse(readFileSync(join(outDir, 'canonical.json'), 'utf-8'));
    const ids = bundle.edges.map((e) => e.edge_id);
    expect(ids).toEqual(['e-a', 'e-z']);
  });

  it('tag_mappings are sorted by tag ASC then doc_id ASC', () => {
    bootstrap(repo, {
      documents: [
        { doc_id: 'doc-a', title: 'A', kind: 'guideline', content: 'a' },
        { doc_id: 'doc-b', title: 'B', kind: 'guideline', content: 'b' },
      ],
      edges: [],
    });

    repo.upsertTagMapping({ tag: 'z-tag', doc_id: 'doc-a', confidence: 0.9, source: 'manual' });
    repo.upsertTagMapping({ tag: 'a-tag', doc_id: 'doc-b', confidence: 0.8, source: 'manual' });
    repo.upsertTagMapping({ tag: 'a-tag', doc_id: 'doc-a', confidence: 0.7, source: 'slm' });

    shareExport(repo, outDir);
    const bundle: SharedCanonicalBundleV1 = JSON.parse(readFileSync(join(outDir, 'canonical.json'), 'utf-8'));
    const pairs = bundle.tag_mappings.map((tm) => `${tm.tag}:${tm.doc_id}`);
    expect(pairs).toEqual(['a-tag:doc-a', 'a-tag:doc-b', 'z-tag:doc-a']);
  });

  it('bundle does not contain status, created_at, updated_at fields', () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'doc-1', title: 'D1', kind: 'guideline', content: 'c' }],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'doc-1',
          edge_type: 'path_requires',
          priority: 1,
        },
      ],
      layer_rules: [{ rule_id: 'lr1', path_pattern: 'src/**', layer_name: 'core', priority: 1 }],
    });

    shareExport(repo, outDir);
    const rawJson = readFileSync(join(outDir, 'canonical.json'), 'utf-8');

    // These operational fields should not be in the bundle
    expect(rawJson).not.toContain('"status"');
    expect(rawJson).not.toContain('"created_at"');
    expect(rawJson).not.toContain('"updated_at"');
    expect(rawJson).not.toContain('"source_synced_at"');
    expect(rawJson).not.toContain('"replaced_by_doc_id"');
  });

  it('returns advisory warning when pending proposals exist', () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'doc-1', title: 'D1', kind: 'guideline', content: 'c' }],
      edges: [],
    });

    // Add a pending proposal
    repo.insertProposal({
      proposal_id: 'p-pending',
      proposal_type: 'new_doc',
      payload: JSON.stringify({
        doc_id: 'doc-new',
        title: 'New',
        kind: 'guideline',
        content: 'new-content',
        content_hash: hash('new-content'),
      }),
      status: 'pending',
      review_comment: null,
    });

    const result = shareExport(repo, outDir);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('pending proposal');
  });

  it('returns no warnings when no pending proposals', () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'doc-1', title: 'D1', kind: 'guideline', content: 'c' }],
      edges: [],
    });

    const result = shareExport(repo, outDir);
    expect(result.warnings).toHaveLength(0);
  });

  it('JSON ends with newline', () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'doc-1', title: 'D1', kind: 'guideline', content: 'c' }],
      edges: [],
    });

    shareExport(repo, outDir);
    const canonical = readFileSync(join(outDir, 'canonical.json'), 'utf-8');
    const manifest = readFileSync(join(outDir, 'manifest.json'), 'utf-8');
    expect(canonical.endsWith('\n')).toBe(true);
    expect(manifest.endsWith('\n')).toBe(true);
  });
});
