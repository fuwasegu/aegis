import { describe, expect, it } from 'vitest';
import type { Document, Observation } from '../types.js';
import {
  aggregateRefactorSignals,
  cohortMedianGapRateForKind,
  DEFAULT_REFACTOR_TRIGGER,
  effectiveGapRateThreshold,
  finiteMedian,
  gapRate,
  shouldEmitSplitCandidate,
} from './doc-refactor.js';

describe('doc-refactor', () => {
  it('finiteMedian handles empty and odd/even lengths', () => {
    expect(finiteMedian([])).toBe(0);
    expect(finiteMedian([2])).toBe(2);
    expect(finiteMedian([3, 1, 2])).toBe(2);
    expect(finiteMedian([1, 2, 3, 4])).toBe(2.5);
  });

  it('effectiveGapRateThreshold uses floor and multiplier', () => {
    expect(effectiveGapRateThreshold(0.05, DEFAULT_REFACTOR_TRIGGER)).toBeCloseTo(
      DEFAULT_REFACTOR_TRIGGER.gap_rate_threshold_floor,
    );
    expect(effectiveGapRateThreshold(0.1, DEFAULT_REFACTOR_TRIGGER)).toBeCloseTo(0.3);
  });

  it('aggregateRefactorSignals counts exposure and gaps per approved doc', () => {
    const docs: Document[] = [
      {
        doc_id: 'd1',
        title: 'a',
        kind: 'guideline',
        content: 'x',
        content_hash: 'h',
        status: 'approved',
        ownership: 'standalone',
        template_origin: null,
        source_path: null,
        source_synced_at: null,
        created_at: 't',
        updated_at: 't',
      },
      {
        doc_id: 'd2',
        title: 'b',
        kind: 'guideline',
        content: 'x',
        content_hash: 'h',
        status: 'approved',
        ownership: 'standalone',
        template_origin: null,
        source_path: null,
        source_synced_at: null,
        created_at: 't',
        updated_at: 't',
      },
      {
        doc_id: 'd3',
        title: 'c',
        kind: 'guideline',
        content: 'x',
        content_hash: 'h',
        status: 'approved',
        ownership: 'standalone',
        template_origin: null,
        source_path: null,
        source_synced_at: null,
        created_at: 't',
        updated_at: 't',
      },
    ];

    const compileRows = Array.from({ length: 10 }, (_, i) => ({
      compile_id: `c${i}`,
      base_doc_ids: JSON.stringify(['d1', 'd2', 'd3']),
    }));

    const misses: Observation[] = [
      {
        observation_id: 'm1',
        event_type: 'compile_miss',
        payload: JSON.stringify({
          target_files: ['src/a/x.ts'],
          target_doc_id: 'd1',
          review_comment: 'r',
        }),
        related_compile_id: 'c0',
        related_snapshot_id: 's',
        created_at: 't',
        archived_at: null,
        analyzed_at: null,
      },
      {
        observation_id: 'm2',
        event_type: 'compile_miss',
        payload: JSON.stringify({
          target_files: ['src/b/y.ts'],
          target_doc_id: 'd1',
          review_comment: 'r',
        }),
        related_compile_id: 'c1',
        related_snapshot_id: 's',
        created_at: 't',
        archived_at: null,
        analyzed_at: null,
      },
      {
        observation_id: 'm3',
        event_type: 'compile_miss',
        payload: JSON.stringify({
          target_files: ['src/a/z.ts'],
          target_doc_id: 'd1',
          review_comment: 'r',
        }),
        related_compile_id: 'c2',
        related_snapshot_id: 's',
        created_at: 't',
        archived_at: null,
        analyzed_at: null,
      },
    ];

    const agg = aggregateRefactorSignals(docs, compileRows, misses);
    const a1 = agg.get('d1')!;
    expect(a1.exposure_count).toBe(10);
    expect(a1.content_gap_count).toBe(3);
    expect(a1.cluster_patterns.has('src/a/**')).toBe(true);
    expect(a1.cluster_patterns.has('src/b/**')).toBe(true);

    const med = cohortMedianGapRateForKind(agg, 'guideline');
    expect(med).toBeGreaterThanOrEqual(0);
    expect(shouldEmitSplitCandidate(a1, med, DEFAULT_REFACTOR_TRIGGER)).toBe(true);
    expect(gapRate(a1)).toBeGreaterThanOrEqual(effectiveGapRateThreshold(med, DEFAULT_REFACTOR_TRIGGER));
  });

  it('does not count routing-only misses (missing_doc without target_doc_id) toward split signals', () => {
    const docs: Document[] = [
      {
        doc_id: 'd1',
        title: 'a',
        kind: 'guideline',
        content: 'x',
        content_hash: 'h',
        status: 'approved',
        ownership: 'standalone',
        template_origin: null,
        source_path: null,
        source_synced_at: null,
        created_at: 't',
        updated_at: 't',
      },
    ];
    const compileRows = Array.from({ length: 20 }, (_, i) => ({
      compile_id: `c${i}`,
      base_doc_ids: JSON.stringify(['d1']),
    }));
    const misses: Observation[] = [
      {
        observation_id: 'o1',
        event_type: 'compile_miss',
        payload: JSON.stringify({
          target_files: ['src/a/x.ts'],
          missing_doc: 'd1',
          review_comment: 'r',
        }),
        related_compile_id: 'c0',
        related_snapshot_id: 's',
        created_at: 't',
        archived_at: null,
        analyzed_at: null,
      },
    ];
    const agg = aggregateRefactorSignals(docs, compileRows, misses).get('d1');
    expect(agg?.content_gap_count).toBe(0);
  });

  it('ignores target_doc_id when compile_log base set does not include that doc', () => {
    const docs: Document[] = [
      {
        doc_id: 'd1',
        title: 'a',
        kind: 'guideline',
        content: 'x',
        content_hash: 'h',
        status: 'approved',
        ownership: 'standalone',
        template_origin: null,
        source_path: null,
        source_synced_at: null,
        created_at: 't',
        updated_at: 't',
      },
    ];
    const compileRows = [{ compile_id: 'c0', base_doc_ids: JSON.stringify(['d-other']) }];
    const misses: Observation[] = [
      {
        observation_id: 'bad',
        event_type: 'compile_miss',
        payload: JSON.stringify({
          target_files: ['src/a/x.ts'],
          target_doc_id: 'd1',
          review_comment: 'r',
        }),
        related_compile_id: 'c0',
        related_snapshot_id: 's',
        created_at: 't',
        archived_at: null,
        analyzed_at: null,
      },
    ];
    const agg = aggregateRefactorSignals(docs, compileRows, misses).get('d1');
    expect(agg?.content_gap_count ?? 0).toBe(0);
  });
});
