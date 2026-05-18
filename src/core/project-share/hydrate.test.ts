import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AegisDatabase, createDatabase, createInMemoryDatabase, Repository } from '../store/index.js';
import { shareExport } from './export.js';
import { shareHydrate } from './hydrate.js';
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

describe('shareHydrate', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let tmpRoot: string;
  let bundleDir: string;
  let targetDbPath: string;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    tmpRoot = mkdtempSync(join(tmpdir(), 'aegis-hydrate-test-'));
    bundleDir = join(tmpRoot, 'aegis-share');
    targetDbPath = join(tmpRoot, 'replica.db');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** Check that no hydrate temp files remain in the target directory. */
  function expectNoHydrateTempFiles(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) return;
    const leaked = readdirSync(dir).filter((f) => f.includes('.hydrate-') && f.endsWith('.tmp'));
    expect(leaked, `Leaked hydrate temp files: ${leaked.join(', ')}`).toHaveLength(0);
  }

  /** Export from source DB into bundleDir for hydration tests. */
  function exportBundle() {
    return shareExport(repo, bundleDir);
  }

  it('round-trips share-export -> share-hydrate with matching snapshot', async () => {
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
      layer_rules: [{ rule_id: 'lr1', path_pattern: 'src/**', layer_name: 'core', priority: 1 }],
    });

    const exportResult = exportBundle();

    const result = await shareHydrate({
      bundleDir,
      targetDbPath,
      replace: false,
    });

    expect(result.snapshot_id).toBe(exportResult.snapshot_id);
    expect(result.knowledge_version).toBe(exportResult.knowledge_version);
    expect(result.counts.documents).toBe(2);
    expect(result.counts.edges).toBe(1);
    expect(result.counts.layer_rules).toBe(1);

    // Verify the hydrated DB is initialized
    const replicaDb = await createDatabase(targetDbPath);
    const replicaRepo = new Repository(replicaDb);
    expect(replicaRepo.isInitialized()).toBe(true);

    // Verify snapshot exists
    const snap = replicaRepo.getCurrentSnapshot();
    expect(snap).toBeDefined();
    expect(snap!.snapshot_id).toBe(exportResult.snapshot_id);
    expect(snap!.knowledge_version).toBe(exportResult.knowledge_version);

    // Verify approved documents
    const docs = replicaRepo.getApprovedDocuments();
    expect(docs).toHaveLength(2);

    // Verify approved edges
    const edges = replicaRepo.getApprovedEdges();
    expect(edges).toHaveLength(1);

    // Verify approved layer rules
    const rules = replicaRepo.getApprovedLayerRules();
    expect(rules).toHaveLength(1);

    replicaDb.close();
  });

  it('hydrate after export preserves repo.isInitialized() === true', async () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'd1', title: 'D1', kind: 'guideline', content: 'c1' }],
      edges: [],
    });
    exportBundle();

    await shareHydrate({ bundleDir, targetDbPath, replace: false });

    const replicaDb = await createDatabase(targetDbPath);
    const replicaRepo = new Repository(replicaDb);
    expect(replicaRepo.isInitialized()).toBe(true);
    expect(replicaRepo.getKnowledgeMeta().current_version).toBeGreaterThanOrEqual(1);
    replicaDb.close();
  });

  it('fails without --replace when target DB is initialized', async () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'd1', title: 'D1', kind: 'guideline', content: 'c1' }],
      edges: [],
    });
    exportBundle();

    // Create an *initialized* target DB (bootstrap it)
    const existingDb = await createDatabase(targetDbPath);
    const existingRepo = new Repository(existingDb);
    bootstrap(existingRepo, {
      documents: [{ doc_id: 'old', title: 'Old', kind: 'guideline', content: 'old' }],
      edges: [],
    });
    existingDb.close();

    await expect(shareHydrate({ bundleDir, targetDbPath, replace: false })).rejects.toThrow('--replace');
  });

  it('overwrites uninitialized target DB without --replace', async () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'd1', title: 'D1', kind: 'guideline', content: 'c1' }],
      edges: [],
    });
    exportBundle();

    // Create an *uninitialized* DB (schema only, knowledge_version = 0)
    const uninitDb = await createDatabase(targetDbPath);
    uninitDb.close();
    expect(existsSync(targetDbPath)).toBe(true);

    // Should succeed without --replace since target is not initialized
    const result = await shareHydrate({ bundleDir, targetDbPath, replace: false });
    expect(result.counts.documents).toBe(1);
  });

  it('succeeds with --replace when target DB is initialized', async () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'd1', title: 'D1', kind: 'guideline', content: 'c1' }],
      edges: [],
    });
    exportBundle();

    // Create an initialized target DB
    const existingDb = await createDatabase(targetDbPath);
    const existingRepo = new Repository(existingDb);
    bootstrap(existingRepo, {
      documents: [{ doc_id: 'old', title: 'Old', kind: 'guideline', content: 'old' }],
      edges: [],
    });
    existingDb.close();

    const result = await shareHydrate({ bundleDir, targetDbPath, replace: true });
    expect(result.counts.documents).toBe(1);
  });

  it('rejects bundle with SHA-256 mismatch', async () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'd1', title: 'D1', kind: 'guideline', content: 'c1' }],
      edges: [],
    });
    exportBundle();

    // Tamper with the bundle file
    const bundlePath = join(bundleDir, 'canonical.json');
    writeFileSync(bundlePath, '{"tampered": true}\n', 'utf-8');

    await expect(shareHydrate({ bundleDir, targetDbPath, replace: false })).rejects.toThrow('SHA-256 mismatch');
  });

  it('rejects document with content_hash mismatch', async () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'd1', title: 'D1', kind: 'guideline', content: 'c1' }],
      edges: [],
    });
    exportBundle();

    // Tamper with the bundle content but fix the bundle hash in manifest
    const bundlePath = join(bundleDir, 'canonical.json');
    const bundle: SharedCanonicalBundleV1 = JSON.parse(readFileSync(bundlePath, 'utf-8'));
    bundle.documents[0].content = 'tampered-content';
    // Keep original content_hash (wrong) — should be detected
    const tamperedJson = JSON.stringify(bundle, null, 2) + '\n';
    writeFileSync(bundlePath, tamperedJson, 'utf-8');

    // Fix manifest hash so it passes bundle integrity check
    const manifestPath = join(bundleDir, 'manifest.json');
    const manifest: SharedCanonicalManifestV1 = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.bundle_sha256 = createHash('sha256').update(tamperedJson, 'utf-8').digest('hex');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

    await expect(shareHydrate({ bundleDir, targetDbPath, replace: false })).rejects.toThrow('Content hash mismatch');
  });

  it('does not leave partial temp DB on failure', async () => {
    // No bundle files — should fail
    mkdirSync(bundleDir, { recursive: true });

    await expect(shareHydrate({ bundleDir, targetDbPath, replace: false })).rejects.toThrow('Manifest not found');

    expectNoHydrateTempFiles(targetDbPath);
    expect(existsSync(targetDbPath)).toBe(false);
  });

  it('includes tag_mappings in hydrated DB', async () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'd1', title: 'D1', kind: 'guideline', content: 'c1' }],
      edges: [],
    });

    // Add tag mappings
    repo.upsertTagMapping({ tag: 'error-handling', doc_id: 'd1', confidence: 0.9, source: 'slm' });
    repo.upsertTagMapping({ tag: 'testing', doc_id: 'd1', confidence: 0.8, source: 'manual' });

    exportBundle();

    const result = await shareHydrate({ bundleDir, targetDbPath, replace: false });
    expect(result.counts.tag_mappings).toBe(2);

    // Verify tag mappings exist in replica
    const replicaDb = await createDatabase(targetDbPath);
    const replicaRepo = new Repository(replicaDb);
    const mappings = replicaRepo.getApprovedTagMappings();
    expect(mappings).toHaveLength(2);
    replicaDb.close();
  });

  it('hydrates when target parent directory does not exist (fresh clone)', async () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'd1', title: 'D1', kind: 'guideline', content: 'c1' }],
      edges: [],
    });
    exportBundle();

    // Target path with non-existent parent dir
    const deepTarget = join(tmpRoot, 'non-existent', 'sub', 'replica.db');

    const result = await shareHydrate({ bundleDir, targetDbPath: deepTarget, replace: false });
    expect(result.counts.documents).toBe(1);
    expect(existsSync(deepTarget)).toBe(true);
  });

  it('fails when manifest is missing', async () => {
    mkdirSync(bundleDir, { recursive: true });

    await expect(shareHydrate({ bundleDir, targetDbPath, replace: false })).rejects.toThrow('Manifest not found');
  });

  it('fails when bundle file is missing', async () => {
    mkdirSync(bundleDir, { recursive: true });
    const manifest: SharedCanonicalManifestV1 = {
      format_version: 1,
      bundle_file: 'canonical.json',
      snapshot_id: 'snap-1',
      knowledge_version: 1,
      bundle_sha256: 'abc',
      includes_tag_mappings: false,
    };
    writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');

    await expect(shareHydrate({ bundleDir, targetDbPath, replace: false })).rejects.toThrow('Bundle file not found');
  });

  it('cleans up temp DB when build fails mid-transaction', async () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'd1', title: 'D1', kind: 'guideline', content: 'c1' }],
      edges: [],
    });
    exportBundle();

    // Tamper bundle to have an invalid edge (references non-existent doc)
    const bundlePath = join(bundleDir, 'canonical.json');
    const bundle: SharedCanonicalBundleV1 = JSON.parse(readFileSync(bundlePath, 'utf-8'));
    bundle.edges.push({
      edge_id: 'bad-edge',
      source_type: 'path',
      source_value: 'foo/**',
      target_doc_id: 'non-existent-doc',
      edge_type: 'path_requires',
      priority: 1,
      specificity: 0,
    });
    const tamperedJson = JSON.stringify(bundle, null, 2) + '\n';
    writeFileSync(bundlePath, tamperedJson, 'utf-8');

    // Fix manifest hash
    const manifestPath = join(bundleDir, 'manifest.json');
    const manifest: SharedCanonicalManifestV1 = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.bundle_sha256 = createHash('sha256').update(tamperedJson, 'utf-8').digest('hex');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

    await expect(shareHydrate({ bundleDir, targetDbPath, replace: false })).rejects.toThrow(); // FK violation

    expectNoHydrateTempFiles(targetDbPath);
  });

  it('hydrated DB does not contain observations, proposals, or compile_log', async () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'd1', title: 'D1', kind: 'guideline', content: 'c1' }],
      edges: [],
    });
    exportBundle();

    await shareHydrate({ bundleDir, targetDbPath, replace: false });

    const replicaDb = await createDatabase(targetDbPath);
    // Verify operational tables are empty
    const obs = replicaDb.prepare('SELECT COUNT(*) as cnt FROM observations').get() as { cnt: number };
    const props = replicaDb.prepare('SELECT COUNT(*) as cnt FROM proposals').get() as { cnt: number };
    const logs = replicaDb.prepare('SELECT COUNT(*) as cnt FROM compile_log').get() as { cnt: number };
    expect(obs.cnt).toBe(0);
    expect(props.cnt).toBe(0);
    expect(logs.cnt).toBe(0);
    replicaDb.close();
  });
});
