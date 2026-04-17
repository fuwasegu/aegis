import { describe, expect, it } from 'vitest';
import type { Edge, Observation } from '../types.js';
import { pathGlobSubsumes, validatePathRequiresEdge } from './edge-validation.js';

describe('edge-validation', () => {
  it('pathGlobSubsumes: wider directory glob covers narrower', () => {
    expect(pathGlobSubsumes('src/**', 'src/core/**')).toBe(true);
    expect(pathGlobSubsumes('src/core/**', 'src/**')).toBe(false);
    expect(pathGlobSubsumes('pkg/**', 'pkg/nested/**')).toBe(true);
    expect(pathGlobSubsumes('pkg/nested/**', 'pkg/**')).toBe(false);
    expect(pathGlobSubsumes('{a,b}/**', 'src/**')).toBe(false);
  });

  it('validatePathRequiresEdge: duplicate same source + target', () => {
    const edges: Edge[] = [
      {
        edge_id: 'e1',
        source_type: 'path',
        source_value: 'src/core/**',
        target_doc_id: 'doc-1',
        edge_type: 'path_requires',
        priority: 1,
        specificity: 1,
        status: 'approved',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    const r = validatePathRequiresEdge({
      proposed: {
        source_type: 'path',
        source_value: 'src/core/**',
        target_doc_id: 'doc-1',
        edge_type: 'path_requires',
      },
      approvedDocIds: new Set(['doc-1']),
      approvedPathEdges: edges,
      compileLogRows: [
        { compile_id: 'cl-1', request: JSON.stringify({ target_files: ['src/core/a.ts'] }), base_doc_ids: '[]' },
      ],
      compileMissObservations: [],
    });
    expect(r.duplicate).toBe(true);
    expect(r.subsumed_by).toBeNull();
  });

  it('validatePathRequiresEdge: subsumed_by wider existing edge', () => {
    const edges: Edge[] = [
      {
        edge_id: 'e-wide',
        source_type: 'path',
        source_value: 'src/**',
        target_doc_id: 'doc-1',
        edge_type: 'path_requires',
        priority: 1,
        specificity: 1,
        status: 'approved',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    const r = validatePathRequiresEdge({
      proposed: {
        source_type: 'path',
        source_value: 'src/core/**',
        target_doc_id: 'doc-1',
        edge_type: 'path_requires',
      },
      approvedDocIds: new Set(['doc-1']),
      approvedPathEdges: edges,
      compileLogRows: [],
      compileMissObservations: [],
    });
    expect(r.duplicate).toBe(false);
    expect(r.subsumed_by).toBe('src/**');
    expect(r.subsumes).toHaveLength(0);
  });

  it('validatePathRequiresEdge: impact counts', () => {
    const miss: Observation = {
      observation_id: 'o1',
      event_type: 'compile_miss',
      payload: JSON.stringify({
        target_files: ['src/core/x.ts'],
        missing_doc: 'doc-1',
        review_comment: 'x',
      }),
      related_compile_id: 'cmp-1',
      related_snapshot_id: 's1',
      created_at: '2026-01-01T00:00:00.000Z',
      archived_at: null,
      analyzed_at: null,
    };
    const r = validatePathRequiresEdge({
      proposed: {
        source_type: 'path',
        source_value: 'src/core/**',
        target_doc_id: 'doc-1',
        edge_type: 'path_requires',
      },
      approvedDocIds: new Set(['doc-1']),
      approvedPathEdges: [],
      compileLogRows: [
        {
          compile_id: 'cmp-1',
          request: JSON.stringify({ target_files: ['src/core/a.ts'] }),
          base_doc_ids: JSON.stringify([]),
        },
        {
          compile_id: 'cl-other',
          request: JSON.stringify({ target_files: ['other/b.ts'] }),
          base_doc_ids: JSON.stringify([]),
        },
      ],
      compileMissObservations: [miss],
    });
    expect(r.impact.matched_compile_count).toBe(1);
    expect(r.impact.observed_recovery_count).toBe(1);
  });

  it('validatePathRequiresEdge: observed_recovery only when compile_miss points at qualifying compile_id', () => {
    const miss: Observation = {
      observation_id: 'o1',
      event_type: 'compile_miss',
      payload: JSON.stringify({
        target_files: ['src/core/x.ts'],
        missing_doc: 'doc-1',
        review_comment: 'x',
      }),
      related_compile_id: 'wrong-compile',
      related_snapshot_id: 's1',
      created_at: '2026-01-01T00:00:00.000Z',
      archived_at: null,
      analyzed_at: null,
    };
    const r = validatePathRequiresEdge({
      proposed: {
        source_type: 'path',
        source_value: 'src/core/**',
        target_doc_id: 'doc-1',
        edge_type: 'path_requires',
      },
      approvedDocIds: new Set(['doc-1']),
      approvedPathEdges: [],
      compileLogRows: [
        {
          compile_id: 'cmp-qual',
          request: JSON.stringify({ target_files: ['src/core/a.ts'] }),
          base_doc_ids: JSON.stringify([]),
        },
      ],
      compileMissObservations: [miss],
    });
    expect(r.impact.matched_compile_count).toBe(1);
    expect(r.impact.observed_recovery_count).toBe(0);
  });

  it('validatePathRequiresEdge: matched_compile_count skips when base already included target', () => {
    const r = validatePathRequiresEdge({
      proposed: {
        source_type: 'path',
        source_value: 'src/core/**',
        target_doc_id: 'doc-1',
        edge_type: 'path_requires',
      },
      approvedDocIds: new Set(['doc-1']),
      approvedPathEdges: [],
      compileLogRows: [
        {
          compile_id: 'cl-1',
          request: JSON.stringify({ target_files: ['src/core/a.ts'] }),
          base_doc_ids: JSON.stringify(['doc-1']),
        },
      ],
      compileMissObservations: [],
    });
    expect(r.impact.matched_compile_count).toBe(0);
  });
});
