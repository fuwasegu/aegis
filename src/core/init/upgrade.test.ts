import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createInMemoryDatabase, Repository } from '../store/index.js';
import { loadManifest, resolveTemplate } from './template-loader.js';
import { detectUpgrade, generateUpgradeProposals, type UpgradePreview } from './upgrade.js';

function rmDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

const TEMPLATE_ID = 'upgrade-test-tpl';

interface WriteTplOpts {
  version: string;
  /** extra seed doc ut-extra */
  includeExtraDoc?: boolean;
  /** seed_layer_rules with one rule */
  includeLayerRule?: boolean;
  /** root.md body */
  rootContent?: string;
}

function writeUpgradeTemplate(baseDir: string, opts: WriteTplOpts): string {
  const templateDir = join(baseDir, TEMPLATE_ID);
  mkdirSync(join(templateDir, 'documents'), { recursive: true });
  const rootContent = opts.rootContent ?? '# Root\n';
  writeFileSync(join(templateDir, 'documents', 'root.md'), rootContent);

  let seedDocs = `  - doc_id: ut-root
    title: "R"
    kind: guideline
    file: root.md`;
  if (opts.includeExtraDoc) {
    seedDocs += `
  - doc_id: ut-extra
    title: "E"
    kind: guideline
    file: extra.md`;
    writeFileSync(join(templateDir, 'documents', 'extra.md'), '# Extra doc\n');
  }

  let layerBlock = 'seed_layer_rules: []';
  if (opts.includeLayerRule) {
    layerBlock = `seed_layer_rules:
  - path_pattern: "src/**"
    layer_name: Core
    priority: 1`;
  }

  writeFileSync(
    join(templateDir, 'manifest.yaml'),
    `template_id: ${TEMPLATE_ID}
version: "${opts.version}"
display_name: "UT"
description: "Unit test template"

detect_signals:
  required:
    - type: file_exists
      path: marker.txt
  boosters: []
  confidence_thresholds:
    high: 1
    medium: 0

placeholders:
  src_root:
    description: "src"
    required: true
    detect_strategy: first_match
    candidates:
      - src
    ambiguity_policy: first
    default: src

seed_documents:
${seedDocs}

seed_edges:
  - source_type: path
    source_value: "{{src_root}}/**"
    target_doc_id: ut-root
    edge_type: path_requires
    priority: 10

${layerBlock}
`,
  );
  return templateDir;
}

function seedInit(repo: Repository, templateVersion: string): void {
  const snapshot = repo.createSnapshot();
  repo.insertInitManifest({
    template_id: TEMPLATE_ID,
    template_version: templateVersion,
    preview_hash: 'unit-test-preview',
    stack_detection: '{}',
    selected_profile: TEMPLATE_ID,
    placeholders: JSON.stringify({ src_root: 'src' }),
    initial_snapshot_id: snapshot.snapshot_id,
    seed_counts: JSON.stringify({ documents: 1, edges: 1, layer_rules: 0 }),
  });
}

describe('detectUpgrade', () => {
  let tmpBase: string;

  afterEach(() => {
    if (tmpBase) rmDir(tmpBase);
  });

  it('returns null when init manifest is missing', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    tmpBase = mkdtempSync(join(tmpdir(), 'aegis-upg-'));
    writeUpgradeTemplate(tmpBase, { version: '2.0.0' });
    expect(detectUpgrade(repo, tmpBase)).toBeNull();
  });

  it('returns null when template_id is not found under templatesRoot', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    tmpBase = mkdtempSync(join(tmpdir(), 'aegis-upg-'));
    const snapshot = repo.createSnapshot();
    repo.insertInitManifest({
      template_id: 'missing-template',
      template_version: '1.0.0',
      preview_hash: 'x',
      stack_detection: '{}',
      selected_profile: '',
      placeholders: '{}',
      initial_snapshot_id: snapshot.snapshot_id,
      seed_counts: '{}',
    });
    writeUpgradeTemplate(tmpBase, { version: '2.0.0' });
    expect(detectUpgrade(repo, tmpBase)).toBeNull();
  });

  it('reports no changes when on-disk template version is not newer than stored', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    tmpBase = mkdtempSync(join(tmpdir(), 'aegis-upg-'));
    writeUpgradeTemplate(tmpBase, { version: '1.0.0' });
    seedInit(repo, '2.0.0');
    const preview = detectUpgrade(repo, tmpBase);
    expect(preview).not.toBeNull();
    expect(preview!.has_changes).toBe(false);
    expect(preview!.changes).toHaveLength(0);
  });

  it('detects update_doc when canonical hash differs from resolved seed', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    tmpBase = mkdtempSync(join(tmpdir(), 'aegis-upg-'));
    writeUpgradeTemplate(tmpBase, { version: '2.0.0', rootContent: '# Root v2\n' });
    seedInit(repo, '1.0.0');

    const templateDir = join(tmpBase, TEMPLATE_ID);
    const manifest = loadManifest(templateDir);
    const generated = resolveTemplate(templateDir, manifest, { src_root: 'src' });
    const utRoot = generated.documents.find((d) => d.doc_id === 'ut-root');
    expect(utRoot).toBeDefined();

    repo.insertDocument({
      doc_id: 'ut-root',
      title: 'R',
      kind: 'guideline',
      content: 'stale content',
      content_hash: 'deadbeef',
      status: 'approved',
      ownership: 'standalone',
      template_origin: `${TEMPLATE_ID}:1.0.0`,
      source_path: null,
      source_synced_at: null,
    });

    const preview = detectUpgrade(repo, tmpBase);
    expect(preview?.has_changes).toBe(true);
    const upd = preview?.changes.find((c) => c.type === 'update_doc');
    expect(upd).toMatchObject({
      type: 'update_doc',
      doc_id: 'ut-root',
      old_hash: 'deadbeef',
      new_hash: utRoot!.content_hash,
    });
  });

  it('detects new_doc when seed adds a document', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    tmpBase = mkdtempSync(join(tmpdir(), 'aegis-upg-'));
    writeUpgradeTemplate(tmpBase, { version: '2.0.0', includeExtraDoc: true });
    seedInit(repo, '1.0.0');

    repo.insertDocument({
      doc_id: 'ut-root',
      title: 'R',
      kind: 'guideline',
      content: '# Root v2\n',
      content_hash: 'ignored-for-new-doc-test',
      status: 'approved',
      ownership: 'standalone',
      template_origin: `${TEMPLATE_ID}:1.0.0`,
      source_path: null,
      source_synced_at: null,
    });

    const preview = detectUpgrade(repo, tmpBase);
    expect(preview?.changes.some((c) => c.type === 'new_doc' && c.doc_id === 'ut-extra')).toBe(true);
  });

  it('detects removed_doc for template-owned docs absent from new seed', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    tmpBase = mkdtempSync(join(tmpdir(), 'aegis-upg-'));
    writeUpgradeTemplate(tmpBase, { version: '2.0.0', rootContent: '# Root v2\n' });
    seedInit(repo, '1.0.0');

    const templateDir = join(tmpBase, TEMPLATE_ID);
    const manifest = loadManifest(templateDir);
    const generated = resolveTemplate(templateDir, manifest, { src_root: 'src' });
    const utRoot = generated.documents.find((d) => d.doc_id === 'ut-root')!;

    repo.insertDocument({
      doc_id: 'ut-root',
      title: 'R',
      kind: 'guideline',
      content: utRoot.content,
      content_hash: utRoot.content_hash,
      status: 'approved',
      ownership: 'standalone',
      template_origin: `${TEMPLATE_ID}:1.0.0`,
      source_path: null,
      source_synced_at: null,
    });

    repo.insertDocument({
      doc_id: 'ut-legacy',
      title: 'Legacy',
      kind: 'guideline',
      content: 'legacy',
      content_hash: 'legacy-hash',
      status: 'approved',
      ownership: 'standalone',
      template_origin: `${TEMPLATE_ID}:1.0.0`,
      source_path: null,
      source_synced_at: null,
    });

    const preview = detectUpgrade(repo, tmpBase);
    expect(preview?.changes.some((c) => c.type === 'removed_doc' && c.doc_id === 'ut-legacy')).toBe(true);
  });

  it('detects new_edge and new_layer_rule when missing from canonical', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    tmpBase = mkdtempSync(join(tmpdir(), 'aegis-upg-'));
    writeUpgradeTemplate(tmpBase, { version: '2.0.0', includeLayerRule: true });
    seedInit(repo, '1.0.0');

    const templateDir = join(tmpBase, TEMPLATE_ID);
    const manifest = loadManifest(templateDir);
    const generated = resolveTemplate(templateDir, manifest, { src_root: 'src' });
    const utRoot = generated.documents.find((d) => d.doc_id === 'ut-root')!;

    repo.insertDocument({
      doc_id: 'ut-root',
      title: 'R',
      kind: 'guideline',
      content: utRoot.content,
      content_hash: utRoot.content_hash,
      status: 'approved',
      ownership: 'standalone',
      template_origin: `${TEMPLATE_ID}:1.0.0`,
      source_path: null,
      source_synced_at: null,
    });

    const preview = detectUpgrade(repo, tmpBase);
    expect(preview?.changes.some((c) => c.type === 'new_edge')).toBe(true);
    expect(preview?.changes.some((c) => c.type === 'new_layer_rule')).toBe(true);
  });

  it('throws when resolved template references a missing seed document file', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    tmpBase = mkdtempSync(join(tmpdir(), 'aegis-upg-'));
    const brokenId = 'broken-missing-seed';
    const templateDir = join(tmpBase, brokenId);
    mkdirSync(join(templateDir, 'documents'), { recursive: true });
    writeFileSync(
      join(templateDir, 'manifest.yaml'),
      `template_id: ${brokenId}
version: "2.0.0"
display_name: "Broken"
description: "Missing seed file"

detect_signals:
  required: []
  boosters: []
  confidence_thresholds:
    high: 1
    medium: 0

placeholders: {}

seed_documents:
  - doc_id: missing-doc
    title: "Missing"
    kind: guideline
    file: does-not-exist.md

seed_edges: []
seed_layer_rules: []
`,
    );
    const snapshot = repo.createSnapshot();
    repo.insertInitManifest({
      template_id: brokenId,
      template_version: '1.0.0',
      preview_hash: 'x',
      stack_detection: '{}',
      selected_profile: brokenId,
      placeholders: '{}',
      initial_snapshot_id: snapshot.snapshot_id,
      seed_counts: '{}',
    });
    expect(() => detectUpgrade(repo, tmpBase)).toThrow();
  });
});

describe('generateUpgradeProposals', () => {
  let tmpBase: string;

  afterEach(() => {
    if (tmpBase) rmDir(tmpBase);
  });

  it('returns empty list when preview has no changes', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    tmpBase = mkdtempSync(join(tmpdir(), 'aegis-upg-'));
    writeUpgradeTemplate(tmpBase, { version: '1.0.0' });
    seedInit(repo, '2.0.0');
    const preview = detectUpgrade(repo, tmpBase);
    expect(preview!.has_changes).toBe(false);
    expect(generateUpgradeProposals(preview!, repo, tmpBase)).toHaveLength(0);
  });

  it('maps update_doc changes to update_doc proposals', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    tmpBase = mkdtempSync(join(tmpdir(), 'aegis-upg-'));
    writeUpgradeTemplate(tmpBase, { version: '2.0.0', rootContent: '# bumped\n' });
    seedInit(repo, '1.0.0');

    const templateDir = join(tmpBase, TEMPLATE_ID);
    const manifest = loadManifest(templateDir);
    const generated = resolveTemplate(templateDir, manifest, { src_root: 'src' });
    const utRoot = generated.documents.find((d) => d.doc_id === 'ut-root')!;

    repo.insertDocument({
      doc_id: 'ut-root',
      title: 'R',
      kind: 'guideline',
      content: 'old',
      content_hash: 'oldhash',
      status: 'approved',
      ownership: 'standalone',
      template_origin: null,
      source_path: null,
      source_synced_at: null,
    });

    const preview = detectUpgrade(repo, tmpBase);
    const drafts = generateUpgradeProposals(preview!, repo, tmpBase);
    const upd = drafts.find((d) => d.proposal_type === 'update_doc');
    expect(upd?.payload).toMatchObject({
      doc_id: 'ut-root',
      content: utRoot.content,
      content_hash: utRoot.content_hash,
    });
  });

  it('does not emit proposals for new_layer_rule changes (no proposal_type yet)', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    tmpBase = mkdtempSync(join(tmpdir(), 'aegis-upg-'));
    writeUpgradeTemplate(tmpBase, { version: '2.0.0', includeLayerRule: true });
    seedInit(repo, '1.0.0');

    const preview: UpgradePreview = {
      template_id: TEMPLATE_ID,
      from_version: '1.0.0',
      to_version: '2.0.0',
      has_changes: true,
      changes: [
        {
          type: 'new_layer_rule',
          rule_id: `${TEMPLATE_ID}-rule-1`,
          path_pattern: 'src/**',
          layer_name: 'Core',
        },
      ],
    };

    expect(generateUpgradeProposals(preview, repo, tmpBase)).toHaveLength(0);
  });

  it('maps removed_doc to deprecate proposals', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    tmpBase = mkdtempSync(join(tmpdir(), 'aegis-upg-'));
    writeUpgradeTemplate(tmpBase, { version: '2.0.0' });
    seedInit(repo, '1.0.0');

    const templateDir = join(tmpBase, TEMPLATE_ID);
    const manifest = loadManifest(templateDir);
    const generated = resolveTemplate(templateDir, manifest, { src_root: 'src' });
    const utRoot = generated.documents.find((d) => d.doc_id === 'ut-root')!;

    repo.insertDocument({
      doc_id: 'ut-root',
      title: 'R',
      kind: 'guideline',
      content: utRoot.content,
      content_hash: utRoot.content_hash,
      status: 'approved',
      ownership: 'standalone',
      template_origin: `${TEMPLATE_ID}:1.0.0`,
      source_path: null,
      source_synced_at: null,
    });
    repo.insertDocument({
      doc_id: 'ut-legacy',
      title: 'Legacy',
      kind: 'guideline',
      content: 'x',
      content_hash: 'h',
      status: 'approved',
      ownership: 'standalone',
      template_origin: `${TEMPLATE_ID}:1.0.0`,
      source_path: null,
      source_synced_at: null,
    });

    const preview = detectUpgrade(repo, tmpBase);
    const drafts = generateUpgradeProposals(preview!, repo, tmpBase);
    const dep = drafts.find((d) => d.proposal_type === 'deprecate');
    expect(dep?.payload).toMatchObject({ entity_type: 'document', entity_id: 'ut-legacy' });
  });

  it('returns empty when template cannot be resolved (missing manifest)', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    tmpBase = mkdtempSync(join(tmpdir(), 'aegis-upg-'));
    writeUpgradeTemplate(tmpBase, { version: '2.0.0', rootContent: '# x\n' });
    seedInit(repo, '1.0.0');
    repo.insertDocument({
      doc_id: 'ut-root',
      title: 'R',
      kind: 'guideline',
      content: 'old',
      content_hash: 'oldhash',
      status: 'approved',
      ownership: 'standalone',
      template_origin: null,
      source_path: null,
      source_synced_at: null,
    });
    const preview = detectUpgrade(repo, tmpBase);
    expect(preview!.has_changes).toBe(true);
    const emptyRoot = mkdtempSync(join(tmpdir(), 'aegis-empty-'));
    try {
      expect(generateUpgradeProposals(preview!, repo, emptyRoot)).toHaveLength(0);
    } finally {
      rmDir(emptyRoot);
    }
  });
});
