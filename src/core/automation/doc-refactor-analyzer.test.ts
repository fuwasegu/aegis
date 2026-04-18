import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DOC_REFACTOR_ALGORITHM_VERSION } from '../optimization/doc-refactor.js';
import { type AegisDatabase, createInMemoryDatabase, Repository } from '../store/index.js';
import type { AnalysisContext, Observation } from '../types.js';
import { DocRefactorAnalyzer } from './doc-refactor-analyzer.js';

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Minimal bootstrap so compile_log.snapshot_id FK resolves. */
function bootstrapDocs(repo: Repository): { snapshot_id: string } {
  repo.insertProposal({
    proposal_id: 'boot-doc-refactor-test',
    proposal_type: 'bootstrap',
    payload: JSON.stringify({
      documents: [
        { doc_id: 'd1', title: 'd1', kind: 'guideline', content: 'x', content_hash: hash('x') },
        { doc_id: 'd2', title: 'd2', kind: 'guideline', content: 'x', content_hash: hash('x') },
        { doc_id: 'd3', title: 'd3', kind: 'guideline', content: 'x', content_hash: hash('x') },
      ],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'd1',
          edge_type: 'path_requires',
          priority: 100,
          specificity: 0,
        },
      ],
      layer_rules: [],
    }),
    status: 'pending',
    review_comment: null,
  });
  const v = repo.approveProposal('boot-doc-refactor-test');
  return { snapshot_id: v.snapshot_id };
}

describe('DocRefactorAnalyzer', () => {
  let db: AegisDatabase;
  let repo: Repository;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
  });

  it('emits doc_gap_detected split_candidate when hybrid thresholds are met', async () => {
    const { snapshot_id } = bootstrapDocs(repo);

    for (let i = 0; i < 10; i++) {
      repo.insertCompileLog({
        compile_id: `cmp-${i}`,
        snapshot_id,
        request: '{}',
        base_doc_ids: JSON.stringify(['d1', 'd2', 'd3']),
        expanded_doc_ids: null,
        audit_meta: null,
      });
    }

    const missPayload = (files: string[]) =>
      JSON.stringify({
        target_files: files,
        target_doc_id: 'd1',
        review_comment: 'miss',
      });

    repo.insertObservation({
      observation_id: 'o1',
      event_type: 'compile_miss',
      payload: missPayload(['src/a/x.ts']),
      related_compile_id: 'cmp-0',
      related_snapshot_id: 'snap',
    });
    repo.insertObservation({
      observation_id: 'o2',
      event_type: 'compile_miss',
      payload: missPayload(['src/b/y.ts']),
      related_compile_id: 'cmp-1',
      related_snapshot_id: 'snap',
    });
    repo.insertObservation({
      observation_id: 'o3',
      event_type: 'compile_miss',
      payload: missPayload(['src/a/z.ts']),
      related_compile_id: 'cmp-2',
      related_snapshot_id: 'snap',
    });

    const analyzer = new DocRefactorAnalyzer(repo);
    const obs: Observation = {
      observation_id: 'claim',
      event_type: 'compile_miss',
      payload: missPayload(['src/a/q.ts']),
      related_compile_id: 'cmp-9',
      related_snapshot_id: 'snap',
      created_at: '2026-01-01T00:00:00.000Z',
      archived_at: null,
      analyzed_at: null,
    };
    const ctx: AnalysisContext = { observation: obs, compile_audit: null };

    await analyzer.analyze([ctx]);

    const gaps = repo.listObservationsByEventType('doc_gap_detected');
    expect(gaps.length).toBe(1);
    const p = JSON.parse(gaps[0]!.payload) as {
      gap_kind: string;
      target_doc_id: string;
      algorithm_version: string;
    };
    expect(p.gap_kind).toBe('split_candidate');
    expect(p.target_doc_id).toBe('d1');
    expect(p.algorithm_version).toBe(DOC_REFACTOR_ALGORITHM_VERSION);

    await analyzer.analyze([ctx]);
    expect(repo.listObservationsByEventType('doc_gap_detected').length).toBe(1);
  });
});
