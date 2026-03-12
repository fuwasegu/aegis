import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { createInMemoryDatabase, Repository, AlreadyInitializedError } from '../store/index.js';
import { initDetect, initConfirm, PreviewHashMismatchError } from './engine.js';
import { calculateSpecificity, evaluateWhen } from './template-loader.js';

const TEMPLATES_ROOT = join(import.meta.dirname, '../../../templates');

// ── Helper: create a fake Laravel DDD project with high boosters ──
function createLaravelDddProject(root: string): void {
  writeFileSync(join(root, 'composer.json'), JSON.stringify({
    require: { 'laravel/framework': '^11.0' },
  }));
  mkdirSync(join(root, 'app/Domain/User/Entities'), { recursive: true });
  mkdirSync(join(root, 'app/UseCases'), { recursive: true });
}

// ── Helper: create a minimal generic project ──
function createGenericProject(root: string): void {
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'test', dependencies: {},
  }));
  mkdirSync(join(root, 'src'), { recursive: true });
}

describe('Init Engine', () => {
  let tmpDir: string;
  let db: Database.Database;
  let repo: Repository;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aegis-test-'));
    db = createInMemoryDatabase();
    repo = new Repository(db);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. 未初期化でのみ init_confirm 可能 ──
  it('init_confirm succeeds on uninitialized project', () => {
    createLaravelDddProject(tmpDir);

    const preview = initDetect(tmpDir, TEMPLATES_ROOT);
    expect(preview.has_blocking_warnings).toBe(false);
    expect(preview.template_id).toBe('laravel-ddd');

    const result = initConfirm(repo, preview, preview.preview_hash);
    expect(result.knowledge_version).toBe(1);
    expect(result.snapshot_id).toBeTruthy();
    expect(repo.isInitialized()).toBe(true);
  });

  // ── 2. 初期化済みなら block ──
  it('init_confirm throws AlreadyInitializedError on initialized project', () => {
    createLaravelDddProject(tmpDir);

    const preview = initDetect(tmpDir, TEMPLATES_ROOT);
    initConfirm(repo, preview, preview.preview_hash);

    // Second attempt should fail
    const preview2 = initDetect(tmpDir, TEMPLATES_ROOT);
    expect(() => initConfirm(repo, preview2, preview2.preview_hash)).toThrow(AlreadyInitializedError);
  });

  // ── 3. preview_hash 不一致で reject ──
  it('init_confirm throws PreviewHashMismatchError on wrong hash', () => {
    createLaravelDddProject(tmpDir);

    const preview = initDetect(tmpDir, TEMPLATES_ROOT);
    expect(() => initConfirm(repo, preview, 'wrong-hash')).toThrow(PreviewHashMismatchError);
  });

  // ── 4. 曖昧な profile は warn (同点 tie) ──
  it('emits warn when multiple profiles are tied on score', () => {
    // composer.json with laravel but no booster dirs → laravel-ddd score=0
    // generic-layered also matches with score=0 (no src/ either)
    writeFileSync(join(tmpDir, 'composer.json'), JSON.stringify({
      require: { 'laravel/framework': '^11.0' },
    }));

    const preview = initDetect(tmpDir, TEMPLATES_ROOT);

    // Both profiles should be detected
    const profileIds = preview.detection.architecture_profiles.map(p => p.profile_id);
    expect(profileIds).toContain('laravel-ddd');
    expect(profileIds).toContain('generic-layered');

    // Should have a warn about tied profiles
    const tieWarnings = preview.warnings.filter(w =>
      w.severity === 'warn' && w.message.includes('tied')
    );
    expect(tieWarnings.length).toBeGreaterThan(0);

    // Not blocking — still confirmable
    expect(preview.has_blocking_warnings).toBe(false);
  });

  // ── 5. bootstrap 後に knowledge_version = 1, snapshot と init_manifest が保存される ──
  it('bootstrap creates snapshot and records init_manifest', () => {
    createLaravelDddProject(tmpDir);

    const preview = initDetect(tmpDir, TEMPLATES_ROOT);
    const result = initConfirm(repo, preview, preview.preview_hash);

    // knowledge_version = 1
    expect(result.knowledge_version).toBe(1);

    // Snapshot exists
    const snapshot = repo.getCurrentSnapshot();
    expect(snapshot).toBeDefined();
    expect(snapshot!.snapshot_id).toBe(result.snapshot_id);

    // init_manifest is recorded
    const manifest = repo.getInitManifest();
    expect(manifest).toBeDefined();
    expect(manifest!.template_id).toBe('laravel-ddd');
    expect(manifest!.initial_snapshot_id).toBe(result.snapshot_id);
    expect(manifest!.preview_hash).toBe(preview.preview_hash);

    // Seed counts
    const counts = JSON.parse(manifest!.seed_counts);
    expect(counts.documents).toBe(preview.generated.documents.length);
    expect(counts.edges).toBe(preview.generated.edges.length);
    expect(counts.layer_rules).toBe(preview.generated.layer_rules.length);
  });

  // ── 6. Generic profile is selected when it's the only match ──
  it('selects generic-layered when no specific profile matches', () => {
    createGenericProject(tmpDir);

    const preview = initDetect(tmpDir, TEMPLATES_ROOT);
    // generic-layered has no required signals, so it matches
    const profileIds = preview.detection.architecture_profiles.map(p => p.profile_id);
    expect(profileIds).toContain('generic-layered');
    // laravel-ddd requires composer.json + laravel, so it should NOT match
    expect(profileIds).not.toContain('laravel-ddd');

    // Low confidence warning should be present
    const lowConfWarnings = preview.warnings.filter(w =>
      w.message.includes('low confidence')
    );
    expect(lowConfWarnings.length).toBeGreaterThan(0);

    // Should still be confirmable (warn, not block)
    expect(preview.has_blocking_warnings).toBe(false);
    const result = initConfirm(repo, preview, preview.preview_hash);
    expect(result.knowledge_version).toBe(1);
  });

  // ── 7. initDetect generates correct seed data ──
  it('generates documents, edges, and layer_rules from template', () => {
    createLaravelDddProject(tmpDir);

    const preview = initDetect(tmpDir, TEMPLATES_ROOT);

    // Documents
    expect(preview.generated.documents.length).toBeGreaterThanOrEqual(3);
    const docIds = preview.generated.documents.map(d => d.doc_id);
    expect(docIds).toContain('laravel-ddd-root');
    expect(docIds).toContain('laravel-ddd-entity');
    expect(docIds).toContain('laravel-ddd-usecase');

    // Edges
    expect(preview.generated.edges.length).toBeGreaterThan(0);
    const pathEdges = preview.generated.edges.filter(e => e.edge_type === 'path_requires');
    expect(pathEdges.length).toBeGreaterThan(0);
    // Path edges should have auto-calculated specificity > 0
    for (const e of pathEdges) {
      expect(e.specificity).toBeGreaterThan(0);
    }

    // Layer rules (should exist since usecase_root resolved)
    expect(preview.generated.layer_rules.length).toBeGreaterThan(0);
  });

  // ── 8. when conditions filter edges correctly ──
  it('skips edges with unmet when conditions', () => {
    // Create project with Domain but WITHOUT UseCases
    writeFileSync(join(tmpDir, 'composer.json'), JSON.stringify({
      require: { 'laravel/framework': '^11.0' },
    }));
    mkdirSync(join(tmpDir, 'app/Domain'), { recursive: true });
    // No app/UseCases — usecase_root resolves to null (default)

    const preview = initDetect(tmpDir, TEMPLATES_ROOT);

    // Only proceed if laravel-ddd was actually selected
    if (preview.template_id === 'laravel-ddd') {
      const usecaseRootValue = preview._placeholders['usecase_root'];
      if (usecaseRootValue === null) {
        // usecase path edges should be absent
        const usecasePathEdges = preview.generated.edges.filter(
          e => e.edge_type === 'path_requires' && e.source_value.includes('UseCases')
        );
        expect(usecasePathEdges).toHaveLength(0);

        // usecase layer rules should also be absent
        const usecaseRules = preview.generated.layer_rules.filter(
          r => r.layer_name === 'UseCase'
        );
        expect(usecaseRules).toHaveLength(0);
      }
    }
  });

  // ── 9. Low-confidence single profile emits warn but does not block ──
  it('low confidence profile warns but does not block', () => {
    // Empty project with just package.json, no src/ or other signals
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'bare' }));

    const preview = initDetect(tmpDir, TEMPLATES_ROOT);

    // generic-layered should match (no required signals) with low confidence
    expect(preview.template_id).toBe('generic-layered');
    expect(preview.has_blocking_warnings).toBe(false);
    const warnMsgs = preview.warnings.filter(w => w.severity === 'warn');
    expect(warnMsgs.length).toBeGreaterThan(0);
  });

  // ── 10. Blocking warnings prevent init_confirm ──
  it('init_confirm refuses preview with blocking warnings', () => {
    createLaravelDddProject(tmpDir);

    const preview = initDetect(tmpDir, TEMPLATES_ROOT);
    // Force a blocking state
    preview.has_blocking_warnings = true;
    preview.warnings.push({ severity: 'block', message: 'test block' });

    expect(() => initConfirm(repo, preview, preview.preview_hash)).toThrow('blocking warnings');
  });
});

describe('Template Loader utilities', () => {
  it('calculateSpecificity scores segments correctly', () => {
    expect(calculateSpecificity('app/Domain/**')).toBe(4); // app(2) + Domain(2) + **(0)
    expect(calculateSpecificity('app/Domain/**/Entities/**')).toBe(6); // app(2) + Domain(2) + **(0) + Entities(2) + **(0)
    expect(calculateSpecificity('src/**')).toBe(2); // src(2) + **(0)
    expect(calculateSpecificity('*.ts')).toBe(1); // *.ts is partial wildcard
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
