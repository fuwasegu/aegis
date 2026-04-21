import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createInMemoryDatabase } from '../store/database.js';
import { Repository } from '../store/repository.js';
import { buildWorkspaceStatus } from './workspace-status.js';

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function bootstrapMinimalDoc(repo: Repository): void {
  repo.insertProposal({
    proposal_id: 'boot',
    proposal_type: 'bootstrap',
    payload: JSON.stringify({
      documents: [{ doc_id: 'd1', title: 'D1', kind: 'guideline', content: 'content', content_hash: hash('content') }],
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
  repo.approveProposal('boot');
}

describe('workspace-status', () => {
  it('aggregates active_regions from recent compile_log and groups unresolved compile_miss without proposals', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    bootstrapMinimalDoc(repo);

    repo.insertObservation({
      observation_id: 'om1',
      event_type: 'compile_miss',
      payload: JSON.stringify({
        target_files: ['src/foo/a.ts'],
        missing_doc: 'missing-x',
        review_comment: 'r',
      }),
      related_compile_id: null,
      related_snapshot_id: null,
    });

    const snap = repo.getCurrentSnapshot()!;

    repo.insertCompileLog({
      compile_id: 'c1',
      snapshot_id: snap.snapshot_id,
      request: JSON.stringify({ target_files: ['src/foo/a.ts'] }),
      base_doc_ids: '[]',
      expanded_doc_ids: null,
      audit_meta: null,
      agent_id: 'agent-a',
    });

    const ws = buildWorkspaceStatus(repo, { window_hours: 24 });
    expect(ws.pending_proposal_count).toBe(0);
    expect(ws.unresolved_misses).toHaveLength(1);
    expect(ws.unresolved_misses[0]).toMatchObject({
      target_files: ['src/foo/a.ts'],
      missing_doc: 'missing-x',
      count: 1,
    });

    const region = ws.active_regions.find((r) => r.path_pattern === 'src/foo/**');
    expect(region).toBeDefined();
    expect(region!.agent_id).toBe('agent-a');
  });

  it('includes compile_miss again after rejectProposal (evidence link remains but proposal is not pending)', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    bootstrapMinimalDoc(repo);

    repo.insertObservation({
      observation_id: 'om-rej',
      event_type: 'compile_miss',
      payload: JSON.stringify({
        target_files: ['src/bar/x.ts'],
        review_comment: 'r',
      }),
      related_compile_id: null,
      related_snapshot_id: null,
    });
    repo.markObservationsAnalyzed(['om-rej']);

    const pid = repo.insertProposal({
      proposal_id: 'p-reject-me',
      proposal_type: 'add_edge',
      payload: '{}',
      status: 'pending',
      review_comment: null,
    });
    repo.insertProposalEvidence(pid, 'om-rej');

    expect(buildWorkspaceStatus(repo).unresolved_misses).toHaveLength(0);

    repo.rejectProposal(pid, 'no');

    const ws = buildWorkspaceStatus(repo);
    expect(ws.unresolved_misses.some((m) => m.target_files.includes('src/bar/x.ts'))).toBe(true);
  });
});
