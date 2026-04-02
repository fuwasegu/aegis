import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AegisDatabase, AlreadyInitializedError, createInMemoryDatabase, Repository } from '../store/index.js';
import { initConfirm, initDetect, PreviewHashMismatchError } from './engine.js';
import { calculateSpecificity, evaluateWhen } from './template-loader.js';

function createTestTemplate(dir: string): void {
  const templateDir = join(dir, 'test-template');
  mkdirSync(join(templateDir, 'documents'), { recursive: true });

  writeFileSync(
    join(templateDir, 'manifest.yaml'),
    `template_id: test-template
version: "0.1.0"
display_name: "Test Template"
description: "Template for testing"

detect_signals:
  required:
    - type: file_exists
      path: marker.txt
  boosters:
    - type: dir_exists
      path: src
      weight: 50
  confidence_thresholds:
    high: 50
    medium: 10

placeholders:
  src_root:
    description: "Source root"
    required: true
    detect_strategy: first_match
    candidates:
      - src
    ambiguity_policy: first
    default: src

seed_documents:
  - doc_id: test-root
    title: "Test Root"
    kind: guideline
    file: root.md

seed_edges:
  - source_type: path
    source_value: "{{src_root}}/**"
    target_doc_id: test-root
    edge_type: path_requires
    priority: 100

seed_layer_rules: []
`,
  );

  writeFileSync(join(templateDir, 'documents', 'root.md'), '# Test Architecture Root\n\nGuideline content.');
}

function createSecondTestTemplate(dir: string): void {
  const templateDir = join(dir, 'test-template-b');
  mkdirSync(join(templateDir, 'documents'), { recursive: true });

  writeFileSync(
    join(templateDir, 'manifest.yaml'),
    `template_id: test-template-b
version: "0.1.0"
display_name: "Test Template B"
description: "Second template for ambiguity testing"

detect_signals:
  required:
    - type: file_exists
      path: marker.txt
  boosters:
    - type: dir_exists
      path: src
      weight: 50
  confidence_thresholds:
    high: 50
    medium: 10

placeholders:
  src_root:
    description: "Source root"
    required: true
    detect_strategy: first_match
    candidates:
      - src
    ambiguity_policy: first
    default: src

seed_documents:
  - doc_id: test-b-root
    title: "Test B Root"
    kind: guideline
    file: root.md

seed_edges: []
seed_layer_rules: []
`,
  );

  writeFileSync(join(templateDir, 'documents', 'root.md'), '# Test B Root\n\nContent.');
}

describe('Init Engine', () => {
  let tmpDir: string;
  let templatesDir: string;
  let db: AegisDatabase;
  let repo: Repository;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aegis-test-'));
    templatesDir = mkdtempSync(join(tmpdir(), 'aegis-templates-'));
    db = await createInMemoryDatabase();
    repo = new Repository(db);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(templatesDir, { recursive: true, force: true });
  });

  // ── Template-based init ──

  it('init_confirm succeeds with matching template', () => {
    createTestTemplate(templatesDir);
    writeFileSync(join(tmpDir, 'marker.txt'), '');
    mkdirSync(join(tmpDir, 'src'), { recursive: true });

    const preview = initDetect(tmpDir, templatesDir);
    expect(preview.has_blocking_warnings).toBe(false);
    expect(preview.template_id).toBe('test-template');

    const result = initConfirm(repo, preview, preview.preview_hash, tmpDir);
    expect(result.knowledge_version).toBe(1);
    expect(repo.isInitialized()).toBe(true);
  });

  it('init_confirm throws AlreadyInitializedError on initialized project', () => {
    createTestTemplate(templatesDir);
    writeFileSync(join(tmpDir, 'marker.txt'), '');
    mkdirSync(join(tmpDir, 'src'), { recursive: true });

    const preview = initDetect(tmpDir, templatesDir);
    initConfirm(repo, preview, preview.preview_hash, tmpDir);

    const preview2 = initDetect(tmpDir, templatesDir);
    expect(() => initConfirm(repo, preview2, preview2.preview_hash, tmpDir)).toThrow(AlreadyInitializedError);
  });

  it('init_confirm throws PreviewHashMismatchError on wrong hash', () => {
    createTestTemplate(templatesDir);
    writeFileSync(join(tmpDir, 'marker.txt'), '');
    mkdirSync(join(tmpDir, 'src'), { recursive: true });

    const preview = initDetect(tmpDir, templatesDir);
    expect(() => initConfirm(repo, preview, 'wrong-hash', tmpDir)).toThrow(PreviewHashMismatchError);
  });

  it('generates documents, edges from template', () => {
    createTestTemplate(templatesDir);
    writeFileSync(join(tmpDir, 'marker.txt'), '');
    mkdirSync(join(tmpDir, 'src'), { recursive: true });

    const preview = initDetect(tmpDir, templatesDir);

    expect(preview.generated.documents.length).toBe(1);
    expect(preview.generated.documents[0].doc_id).toBe('test-root');
    expect(preview.generated.edges.length).toBe(1);
    expect(preview.generated.edges[0].edge_type).toBe('path_requires');
  });

  it('bootstrap creates snapshot and records init_manifest', () => {
    createTestTemplate(templatesDir);
    writeFileSync(join(tmpDir, 'marker.txt'), '');
    mkdirSync(join(tmpDir, 'src'), { recursive: true });

    const preview = initDetect(tmpDir, templatesDir);
    const result = initConfirm(repo, preview, preview.preview_hash, tmpDir);

    expect(result.knowledge_version).toBe(1);
    const snapshot = repo.getCurrentSnapshot();
    expect(snapshot).toBeDefined();

    const manifest = repo.getInitManifest();
    expect(manifest).toBeDefined();
    expect(manifest!.template_id).toBe('test-template');
    expect(manifest!.initial_snapshot_id).toBe(result.snapshot_id);
  });

  it('init_confirm refuses preview with blocking warnings', () => {
    createTestTemplate(templatesDir);
    writeFileSync(join(tmpDir, 'marker.txt'), '');
    mkdirSync(join(tmpDir, 'src'), { recursive: true });

    const preview = initDetect(tmpDir, templatesDir);
    preview.has_blocking_warnings = true;
    preview.warnings.push({ severity: 'block', message: 'test block' });

    expect(() => initConfirm(repo, preview, preview.preview_hash, tmpDir)).toThrow('blocking warnings');
  });

  // ── skip_template (empty init) ──

  it('skip_template creates confirmable empty preview', () => {
    const preview = initDetect(tmpDir, templatesDir, undefined, { skip_template: true });

    expect(preview.has_blocking_warnings).toBe(false);
    expect(preview.template_id).toBe('none');
    expect(preview.template_version).toBe('0.0.0');
    expect(preview.preview_hash).toBeTruthy();
    expect(preview.generated.documents).toHaveLength(0);
    expect(preview.generated.edges).toHaveLength(0);
    expect(preview.generated.layer_rules).toHaveLength(0);

    const warnMsgs = preview.warnings.filter((w) => w.severity === 'warn');
    expect(warnMsgs.length).toBeGreaterThan(0);
    expect(warnMsgs[0].message).toContain('Template skipped');
  });

  it('skip_template → init_confirm succeeds with empty snapshot', () => {
    const preview = initDetect(tmpDir, templatesDir, undefined, { skip_template: true });
    const result = initConfirm(repo, preview, preview.preview_hash, tmpDir);

    expect(result.knowledge_version).toBe(1);
    expect(repo.isInitialized()).toBe(true);

    const manifest = repo.getInitManifest();
    expect(manifest).toBeDefined();
    expect(manifest!.template_id).toBe('none');

    const counts = JSON.parse(manifest!.seed_counts);
    expect(counts.documents).toBe(0);
    expect(counts.edges).toBe(0);
    expect(counts.layer_rules).toBe(0);
  });

  // ── No profiles matched (non-skip) ──

  it('returns confirmable preview when no profiles match (no templates)', () => {
    // templatesDir is empty — no templates
    const preview = initDetect(tmpDir, templatesDir);

    expect(preview.has_blocking_warnings).toBe(false);
    expect(preview.template_id).toBe('none');
    expect(preview.preview_hash).toBeTruthy();
    expect(preview.generated.documents).toHaveLength(0);

    const warnMsgs = preview.warnings.filter((w) => w.message.includes('No matching'));
    expect(warnMsgs.length).toBeGreaterThan(0);
    expect(warnMsgs[0].severity).toBe('warn');
  });

  it('no profiles matched → init_confirm succeeds', () => {
    const preview = initDetect(tmpDir, templatesDir);
    const result = initConfirm(repo, preview, preview.preview_hash, tmpDir);

    expect(result.knowledge_version).toBe(1);
    expect(repo.isInitialized()).toBe(true);
  });

  // ── Ambiguous tie remains blocked ──

  it('ambiguous high-confidence tie still blocks', () => {
    createTestTemplate(templatesDir);
    createSecondTestTemplate(templatesDir);
    writeFileSync(join(tmpDir, 'marker.txt'), '');
    mkdirSync(join(tmpDir, 'src'), { recursive: true });

    const preview = initDetect(tmpDir, templatesDir);

    const blockWarns = preview.warnings.filter((w) => w.severity === 'block' && w.message.includes('Ambiguous'));
    expect(blockWarns.length).toBeGreaterThan(0);
    expect(preview.has_blocking_warnings).toBe(true);

    expect(() => initConfirm(repo, preview, preview.preview_hash, tmpDir)).toThrow('blocking warnings');
  });
});

describe('Template Loader utilities', () => {
  it('calculateSpecificity scores segments correctly', () => {
    expect(calculateSpecificity('app/Domain/**')).toBe(4);
    expect(calculateSpecificity('app/Domain/**/Entities/**')).toBe(6);
    expect(calculateSpecificity('src/**')).toBe(2);
    expect(calculateSpecificity('*.ts')).toBe(1);
  });

  it('evaluateWhen handles all operators', () => {
    const placeholders = { foo: 'bar', empty: null as string | null };

    expect(evaluateWhen(undefined, placeholders)).toBe(true);
    expect(evaluateWhen({ placeholder: 'foo', operator: 'is_not_null' }, placeholders)).toBe(true);
    expect(evaluateWhen({ placeholder: 'empty', operator: 'is_not_null' }, placeholders)).toBe(false);
    expect(evaluateWhen({ placeholder: 'empty', operator: 'is_null' }, placeholders)).toBe(true);
    expect(evaluateWhen({ placeholder: 'foo', operator: 'equals', value: 'bar' }, placeholders)).toBe(true);
    expect(evaluateWhen({ placeholder: 'foo', operator: 'equals', value: 'baz' }, placeholders)).toBe(false);
  });
});
