import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createInMemoryDatabase } from '../store/database.js';
import { Repository } from '../store/repository.js';
import type { SourceRef } from '../types.js';
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

  /* ── ADR-016 Task 016-01: compile unit contract advisory fields ── */

  describe('016-01: advisory fields', () => {
    it('multi-section markdown produces markdown-section materialization_kind', async () => {
      const db = await createInMemoryDatabase();
      const repo = new Repository(db);
      const md = '## Auth\n\nAuth body.\n\n## DB\n\nDB body.\n';
      const plan = analyzeDocumentForImportPlan(repo, md, 'docs/arch.md', {
        resolved_source_path: 'docs/arch.md',
      });
      expect(plan.suggested_units.length).toBe(2);
      for (const u of plan.suggested_units) {
        expect(u.materialization_kind).toBe('markdown-section');
        expect(u.reconcile_mode).toBe('anchor-sync');
      }
    });

    it('single-section whole-file import produces whole-file materialization_kind', async () => {
      const db = await createInMemoryDatabase();
      const repo = new Repository(db);
      const md = '# Title\n\nEntire file content here.';
      const plan = analyzeDocumentForImportPlan(repo, md, 'docs/single.md', {
        resolved_source_path: 'docs/single.md',
      });
      expect(plan.suggested_units.length).toBe(1);
      expect(plan.suggested_units[0].materialization_kind).toBe('whole-file');
      expect(plan.suggested_units[0].reconcile_mode).toBe('hash-sync');
    });

    it('single source_ref with anchor_type lines produces line-range', async () => {
      const db = await createInMemoryDatabase();
      const repo = new Repository(db);
      const refs: SourceRef[] = [{ asset_path: 'src/foo.ts', anchor_type: 'lines', anchor_value: '10-20' }];
      const md = '## Snippet\n\nSome code.\n';
      const plan = analyzeDocumentForImportPlan(repo, md, null, { source_refs: refs });
      expect(plan.suggested_units[0].materialization_kind).toBe('line-range');
      // With source_refs but no resolved_source_path, reconcile_mode depends on materialization_kind
      expect(plan.suggested_units[0].reconcile_mode).toBe('anchor-sync');
    });

    it('single section source_ref produces markdown-section / anchor-sync', async () => {
      const db = await createInMemoryDatabase();
      const repo = new Repository(db);
      const refs: SourceRef[] = [{ asset_path: 'docs/arch.md', anchor_type: 'section', anchor_value: '## Auth' }];
      const md = '## Auth\n\nAuth flow description.\n';
      const plan = analyzeDocumentForImportPlan(repo, md, null, { source_refs: refs });
      expect(plan.suggested_units[0].materialization_kind).toBe('markdown-section');
      expect(plan.suggested_units[0].reconcile_mode).toBe('anchor-sync');
    });

    it('no source path and no source_refs produces untracked reconcile_mode', async () => {
      const db = await createInMemoryDatabase();
      const repo = new Repository(db);
      const md = '## Notes\n\nSome notes.\n';
      const plan = analyzeDocumentForImportPlan(repo, md, null);
      expect(plan.suggested_units[0].reconcile_mode).toBe('untracked');
    });

    it('content_bytes is stable for UTF-8 including Japanese', async () => {
      const db = await createInMemoryDatabase();
      const repo = new Repository(db);
      const japaneseContent = '## 概要\n\n日本語テスト。';
      const plan = analyzeDocumentForImportPlan(repo, japaneseContent, null);
      const unit = plan.suggested_units[0];
      expect(unit.content_bytes).toBe(Buffer.byteLength(unit.content_slice, 'utf8'));
      // Japanese chars are 3 bytes each in UTF-8 — content_bytes > string length
      expect(unit.content_bytes).toBeGreaterThan(unit.content_slice.length);
    });

    it('oversize_unit diagnostic fires when content exceeds 4096 bytes', async () => {
      const db = await createInMemoryDatabase();
      const repo = new Repository(db);
      const bigBody = 'x'.repeat(5000);
      const md = `## Big\n\n${bigBody}\n`;
      const plan = analyzeDocumentForImportPlan(repo, md, null);
      const unit = plan.suggested_units[0];
      expect(unit.content_bytes).toBeGreaterThan(4096);
      expect(unit.diagnostics.some((d) => d.code === 'oversize_unit')).toBe(true);
    });

    it('weak_routing_signal diagnostic fires when no edge_hints and no tags', async () => {
      const db = await createInMemoryDatabase();
      const repo = new Repository(db);
      // Content with no path-like strings; title with no extractable tags (single char)
      const md = '# X\n\n.\n';
      const plan = analyzeDocumentForImportPlan(repo, md, null);
      const unit = plan.suggested_units[0];
      expect(unit.edge_hints.length).toBe(0);
      // headingTags extracts tokens of length ≥2 from title; single char 'X' yields nothing
      expect(unit.tags.length).toBe(0);
      expect(unit.diagnostics.some((d) => d.code === 'weak_routing_signal')).toBe(true);
    });

    it('semantic_review_only diagnostic fires for composed units', async () => {
      const db = await createInMemoryDatabase();
      const repo = new Repository(db);
      // Single section with resolved_source_path but content doesn't match full file (trimmed differently)
      // → composed → semantic-review
      const md = '# Preamble\n\nPre.\n';
      const plan = analyzeDocumentForImportPlan(repo, md, null, {
        resolved_source_path: 'docs/x.md',
        source_refs: [
          { asset_path: 'docs/a.md', anchor_type: 'file', anchor_value: '' },
          { asset_path: 'docs/b.md', anchor_type: 'file', anchor_value: '' },
        ],
      });
      // Multiple source_refs but single section — composed, semantic-review
      const unit = plan.suggested_units[0];
      expect(unit.materialization_kind).toBe('composed');
      expect(unit.reconcile_mode).toBe('semantic-review');
      expect(unit.diagnostics.some((d) => d.code === 'semantic_review_only')).toBe(true);
    });

    it('batch analysis applies advisory fields to all units', async () => {
      const db = await createInMemoryDatabase();
      const repo = new Repository(db);
      const batch = analyzeImportBatch(repo, [
        { content: '## A\n\nBody A.\n', source_label: 'a.md', resolved_source_path: 'a.md' },
        { content: '## B\n\nBody B.\n', source_label: 'b.md' },
      ]);
      for (const plan of batch.plans) {
        for (const unit of plan.suggested_units) {
          expect(unit.content_bytes).toBeGreaterThan(0);
          expect(unit.materialization_kind).toBeDefined();
          expect(unit.reconcile_mode).toBeDefined();
          expect(Array.isArray(unit.diagnostics)).toBe(true);
        }
      }
    });

    it('parseImportPlanJson round-trips advisory fields', async () => {
      const db = await createInMemoryDatabase();
      const repo = new Repository(db);
      const md = '## Auth\n\nAuth body.\n\n## DB\n\nDB body.\n';
      const plan = analyzeDocumentForImportPlan(repo, md, 'docs/arch.md', {
        resolved_source_path: 'docs/arch.md',
      });
      const roundTrip = parseImportPlanJson(repo, JSON.parse(JSON.stringify(plan)) as unknown);
      for (let i = 0; i < plan.suggested_units.length; i++) {
        expect(roundTrip.suggested_units[i].content_bytes).toBe(plan.suggested_units[i].content_bytes);
        expect(roundTrip.suggested_units[i].materialization_kind).toBe(plan.suggested_units[i].materialization_kind);
        expect(roundTrip.suggested_units[i].reconcile_mode).toBe(plan.suggested_units[i].reconcile_mode);
        expect(roundTrip.suggested_units[i].diagnostics).toEqual(plan.suggested_units[i].diagnostics);
      }
    });

    it('parseImportPlanJson tolerates missing advisory fields (forward compat)', async () => {
      const db = await createInMemoryDatabase();
      const repo = new Repository(db);
      // Minimal plan JSON without advisory fields
      const raw = {
        algorithm_version: IMPORT_PLAN_ALGORITHM_VERSION,
        source_label: null,
        resolved_source_path: null,
        suggested_units: [
          {
            unit_index: 0,
            doc_id: 'test-0',
            title: 'Test',
            kind: 'guideline',
            content_slice: 'hello world',
            edge_hints: [],
            tags: [],
            // No content_bytes, materialization_kind, reconcile_mode, diagnostics
          },
        ],
        overlap_warnings: [],
        coverage_delta: {
          proposed_path_globs: [],
          existing_pattern_matches: 0,
          estimated_new_coverage_globs: 0,
          summary: 'none',
        },
      };
      const parsed = parseImportPlanJson(repo, raw);
      const unit = parsed.suggested_units[0];
      expect(unit.content_bytes).toBe(Buffer.byteLength('hello world', 'utf8'));
      expect(unit.materialization_kind).toBe('composed');
      expect(unit.reconcile_mode).toBe('untracked');
      expect(unit.diagnostics).toEqual([]);
    });

    it('parseImportPlanJson accepts mutated advisory fields without error', async () => {
      const db = await createInMemoryDatabase();
      const repo = new Repository(db);
      const md = '## Test\n\nSome `src/app/main.ts` content.\n';
      const plan = analyzeDocumentForImportPlan(repo, md, null);

      // Mutate advisory fields to extreme values — execute should not care
      const modifiedPlan = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
      const units = modifiedPlan.suggested_units as Record<string, unknown>[];
      units[0].materialization_kind = 'whole-file';
      units[0].reconcile_mode = 'hash-sync';
      units[0].content_bytes = 999999;
      units[0].diagnostics = [{ code: 'oversize_unit', message: 'fake' }];

      // Parse should accept the modified advisory values
      const parsed = parseImportPlanJson(repo, modifiedPlan);
      expect(parsed.suggested_units[0].materialization_kind).toBe('whole-file');
      expect(parsed.suggested_units[0].reconcile_mode).toBe('hash-sync');
      // The key point: parseImportPlanJson doesn't reject modified advisory fields,
      // and executeImportPlan uses only doc_id/title/kind/content_slice/edge_hints/tags
    });
  });
});
