import { describe, expect, it } from 'vitest';
import type { Observation } from '../types.js';
import {
  buildCoverageOptimizationContext,
  buildMissClustersFromObservations,
  buildPathClustersFromFiles,
  derivePathPattern,
} from './edge-candidate-builder.js';

describe('edge-candidate-builder', () => {
  it('derivePathPattern matches RuleBasedAnalyzer directory glob', () => {
    expect(derivePathPattern('app/Domain/User/UserEntity.php')).toBe('app/Domain/User/**');
    expect(derivePathPattern('index.ts')).toBe('**');
  });

  it('buildPathClustersFromFiles groups by pattern', () => {
    const c = buildPathClustersFromFiles(['src/a.ts', 'src/b.ts', 'other/x.ts']);
    expect(c).toHaveLength(2);
    const by = new Map(c.map((x) => [x.pattern, x]));
    expect(by.get('src/**')!.exposure_count).toBe(2);
    expect(by.get('other/**')!.exposure_count).toBe(1);
  });

  it('buildMissClustersFromObservations groups by pattern + missing_doc', () => {
    const obs: Observation[] = [
      {
        observation_id: 'o1',
        event_type: 'compile_miss',
        payload: JSON.stringify({
          target_files: ['src/a.ts'],
          missing_doc: 'doc-a',
          review_comment: 'r',
        }),
        related_compile_id: 'c1',
        related_snapshot_id: 's1',
        created_at: '2026-01-01T00:00:00.000Z',
        archived_at: null,
        analyzed_at: null,
      },
      {
        observation_id: 'o2',
        event_type: 'compile_miss',
        payload: JSON.stringify({
          target_files: ['src/b.ts'],
          missing_doc: 'doc-a',
          review_comment: 'r',
        }),
        related_compile_id: 'c2',
        related_snapshot_id: 's1',
        created_at: '2026-01-02T00:00:00.000Z',
        archived_at: null,
        analyzed_at: null,
      },
      {
        observation_id: 'o3',
        event_type: 'compile_miss',
        payload: JSON.stringify({
          target_files: ['pkg/x.ts'],
          missing_doc: 'doc-b',
          review_comment: 'r',
        }),
        related_compile_id: null,
        related_snapshot_id: 's1',
        created_at: '2026-01-03T00:00:00.000Z',
        archived_at: null,
        analyzed_at: null,
      },
    ];
    const clusters = buildMissClustersFromObservations(obs);
    expect(clusters).toHaveLength(2);
    const a = clusters.find((c) => c.missing_doc === 'doc-a');
    expect(a!.miss_count).toBe(2);
    expect(a!.related_compile_ids).toEqual(['c1', 'c2']);
  });

  it('buildCoverageOptimizationContext attaches empty coChangePatterns without repo', () => {
    const ctx = buildCoverageOptimizationContext([], []);
    expect(ctx.coChangePatterns).toEqual([]);
  });

  it('buildMissClustersFromObservations splits multi-directory target_files into multiple clusters', () => {
    const obs: Observation[] = [
      {
        observation_id: 'om',
        event_type: 'compile_miss',
        payload: JSON.stringify({
          target_files: ['src/a.ts', 'other/b.ts'],
          missing_doc: 'doc-x',
          review_comment: 'r',
        }),
        related_compile_id: 'cx',
        related_snapshot_id: 's1',
        created_at: '2026-01-01T00:00:00.000Z',
        archived_at: null,
        analyzed_at: null,
      },
    ];
    const clusters = buildMissClustersFromObservations(obs);
    expect(clusters).toHaveLength(2);
    expect(clusters.every((c) => c.observation_ids.includes('om'))).toBe(true);
  });
});
