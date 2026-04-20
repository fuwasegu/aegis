import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createInMemoryDatabase } from '../store/database.js';
import { Repository } from '../store/repository.js';
import {
  analyzeDocumentForImportPlan,
  analyzeImportBatch,
  IMPORT_PLAN_ALGORITHM_VERSION,
  jaccardSimilarity,
  parseImportPlanJson,
  splitMarkdownSections,
} from './import-plan.js';

function digest(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

describe('import-plan', () => {
  it('analyzeDocumentForImportPlan throws on whitespace-only input', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    expect(() => analyzeDocumentForImportPlan(repo, '  \n\t  ', null)).toThrow(/whitespace-only/);
  });

  it('splitMarkdownSections splits on ## and keeps preamble with first section', () => {
    const md = `# Title\n\nIntro line.\n\n## First\n\nBody one.\n\n## Second\n\nBody two.\n`;
    const parts = splitMarkdownSections(md);
    expect(parts.length).toBe(2);
    expect(parts[0].title).toBe('First');
    expect(parts[0].body).toContain('Intro line');
    expect(parts[0].body).toContain('Body one');
    expect(parts[1].title).toBe('Second');
    expect(parts[1].body).toContain('Body two');
  });

  it('splitMarkdownSections returns single section when no ##', () => {
    const md = '# Only\n\nHello `src/foo.ts`.\n';
    const parts = splitMarkdownSections(md);
    expect(parts.length).toBe(1);
    expect(parts[0].title).toBe('Only');
    expect(parts[0].body).toContain('src/foo.ts');
  });

  it('jaccardSimilarity is symmetric', () => {
    const a = new Set(['alpha', 'beta', 'gamma']);
    const b = new Set(['beta', 'gamma', 'delta']);
    expect(jaccardSimilarity(a, b)).toBe(jaccardSimilarity(b, a));
  });

  it('coverage_delta counts narrower globs as covered when a wider approved edge exists', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    repo.insertDocument({
      doc_id: 'wide-target',
      title: 'Wide',
      kind: 'guideline',
      content: 'x',
      content_hash: digest('x'),
      status: 'approved',
      ownership: 'standalone',
      template_origin: null,
      source_path: null,
      source_synced_at: null,
    });
    repo.insertEdge({
      edge_id: 'e-src-wide',
      source_type: 'path',
      source_value: 'src/**',
      target_doc_id: 'wide-target',
      edge_type: 'path_requires',
      priority: 100,
      specificity: 0,
      status: 'approved',
    });
    const md = '## Section\n\nSee `src/auth/login.ts`.\n';
    const plan = analyzeDocumentForImportPlan(repo, md, null);
    expect(plan.coverage_delta.proposed_path_globs).toContain('src/auth/**');
    expect(plan.coverage_delta.existing_pattern_matches).toBeGreaterThanOrEqual(1);
    expect(plan.coverage_delta.estimated_new_coverage_globs).toBe(0);
  });

  it('analyzeDocumentForImportPlan proposes units and coverage_delta', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    const md = `## Auth\n\nSee \`src/auth/login.ts\` for flow.\n`;
    const plan = analyzeDocumentForImportPlan(repo, md, 'docs/auth.md');
    expect(plan.algorithm_version).toBe(IMPORT_PLAN_ALGORITHM_VERSION);
    expect(plan.suggested_units.length).toBe(1);
    expect(plan.suggested_units[0].doc_id).toMatch(/^auth-0$/);
    expect(plan.resolved_source_path).toBeNull();
    expect(plan.coverage_delta.proposed_path_globs.length).toBeGreaterThan(0);
    expect(plan.source_label).toBe('docs/auth.md');
  });

  it('parseImportPlanJson accepts analyzer-shaped JSON', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    const plan = analyzeDocumentForImportPlan(repo, '## A\n\nx\n', null);
    const roundTrip = parseImportPlanJson(repo, JSON.parse(JSON.stringify(plan)) as unknown);
    expect(roundTrip.suggested_units.length).toBe(plan.suggested_units.length);
    expect(roundTrip.suggested_units[0].doc_id).toBe(plan.suggested_units[0].doc_id);
  });

  it('analyzeImportBatch reports cross_doc_overlap when similar', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    const body = '## Shared\n\nThe quick brown fox jumps over the lazy dog. Pattern alpha beta gamma delta epsilon.';
    const batch = analyzeImportBatch(repo, [
      { content: body, source_label: 'a.md' },
      { content: body, source_label: 'b.md' },
    ]);
    expect(batch.cross_doc_overlap.length).toBeGreaterThan(0);
    expect(batch.plans.length).toBe(2);
  });

  it('analyzeImportBatch disambiguates doc_ids when headings match across files', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    const batch = analyzeImportBatch(repo, [
      { content: '## Overview\n\nfirst file', source_label: 'a.md' },
      { content: '## Overview\n\nsecond file', source_label: 'b.md' },
    ]);
    const da = batch.plans[0].suggested_units[0].doc_id;
    const dbId = batch.plans[1].suggested_units[0].doc_id;
    expect(da).not.toBe(dbId);
    expect(da).toContain('-b0');
    expect(dbId).toContain('-b1');
  });

  it('analyzeImportBatch reports cross_doc_overlap for identical Japanese bodies', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    const body =
      '## 概要\n\nこれは同一の日本語本文です。ルーティングと不変条件について述べます。禁止事項に注意する。\n';
    const batch = analyzeImportBatch(repo, [
      { content: body, source_label: 'ja-a.md' },
      { content: body, source_label: 'ja-b.md' },
    ]);
    expect(batch.cross_doc_overlap.length).toBeGreaterThan(0);
    expect(batch.cross_doc_overlap[0].similarity).toBeGreaterThanOrEqual(0.18);
  });

  it('analyzeDocumentForImportPlan sets hashed doc_id, constraint kind, and tags for Japanese headings', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    const md = '## 制約\n\n禁止事項をまとめる。不変条件は変更しない。\n';
    const plan = analyzeDocumentForImportPlan(repo, md, null);
    expect(plan.suggested_units.length).toBe(1);
    expect(plan.suggested_units[0].doc_id).toMatch(/^u[0-9a-f]{12}-0$/);
    expect(plan.suggested_units[0].kind).toBe('constraint');
    expect(plan.suggested_units[0].tags.length).toBeGreaterThan(0);
    expect(plan.suggested_units[0].tags.some((t) => /制約/.test(t))).toBe(true);
  });

  it('overlap_warnings compares Japanese import text to approved docs via token overlap', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    repo.insertDocument({
      doc_id: 'approved-ja',
      title: '既存',
      kind: 'guideline',
      content: '## X\n\nこれは承認済みドキュメントです。アーキテクチャのルールを説明しています。同じ文章の続きです。',
      content_hash: digest(
        '## X\n\nこれは承認済みドキュメントです。アーキテクチャのルールを説明しています。同じ文章の続きです。',
      ),
      status: 'approved',
      ownership: 'standalone',
      template_origin: null,
      source_path: null,
      source_synced_at: null,
    });
    const md =
      '## 取り込み\n\nこれは承認済みドキュメントです。アーキテクチャのルールを説明しています。同じ文章の続きです。\n';
    const plan = analyzeDocumentForImportPlan(repo, md, null);
    expect(plan.overlap_warnings.some((w) => w.existing_doc_id === 'approved-ja')).toBe(true);
  });
});
