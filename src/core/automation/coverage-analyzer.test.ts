import { beforeEach, describe, expect, it } from 'vitest';
import { type AegisDatabase, createInMemoryDatabase, Repository } from '../store/index.js';
import type { AnalysisContext, Observation } from '../types.js';
import { CoverageAnalyzer } from './coverage-analyzer.js';

describe('CoverageAnalyzer', () => {
  let db: AegisDatabase;
  let repo: Repository;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
  });

  function makeCtx(
    id: string,
    payload: { target_files: string[]; missing_doc?: string; review_comment: string },
  ): AnalysisContext {
    const obs: Observation = {
      observation_id: id,
      event_type: 'compile_miss',
      payload: JSON.stringify(payload),
      related_compile_id: 'c1',
      related_snapshot_id: 's1',
      created_at: '2026-01-01T00:00:00.000Z',
      archived_at: null,
      analyzed_at: null,
    };
    return { observation: obs, compile_audit: null };
  }

  it('drops add_edge when target doc is not approved', async () => {
    repo.insertDocument({
      doc_id: 'missing-target',
      title: 'T',
      kind: 'guideline',
      content: 'x',
      content_hash: 'abc',
      status: 'proposed',
      ownership: 'standalone',
      template_origin: null,
      source_path: null,
      source_synced_at: null,
    });

    const analyzer = new CoverageAnalyzer(repo);
    const result = await analyzer.analyze([
      makeCtx('obs-1', {
        target_files: ['src/a.ts'],
        missing_doc: 'missing-target',
        review_comment: 'need edge',
      }),
    ]);

    expect(result.drafts).toHaveLength(0);
    expect(result.skipped_observation_ids).toEqual(['obs-1']);
  });

  it('keeps add_edge when target is approved and no duplicate / subsuming edge', async () => {
    repo.insertDocument({
      doc_id: 'guide-1',
      title: 'G',
      kind: 'guideline',
      content: 'x',
      content_hash: 'abc',
      status: 'approved',
      ownership: 'standalone',
      template_origin: null,
      source_path: null,
      source_synced_at: null,
    });

    const analyzer = new CoverageAnalyzer(repo);
    const result = await analyzer.analyze([
      makeCtx('obs-2', {
        target_files: ['src/a.ts'],
        missing_doc: 'guide-1',
        review_comment: 'need edge',
      }),
    ]);

    expect(result.drafts).toHaveLength(1);
    expect(result.skipped_observation_ids).toHaveLength(0);
    expect(result.drafts[0].payload.target_doc_id).toBe('guide-1');
  });
});
