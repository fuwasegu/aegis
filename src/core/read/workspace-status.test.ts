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

  it('includes reconcile_backlog with zeroed counts when no file-anchored docs exist', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    bootstrapMinimalDoc(repo);

    const ws = buildWorkspaceStatus(repo);
    expect(ws.reconcile_backlog).toEqual({
      hash_sync_stale: 0,
      anchor_sync_stale: 0,
      semantic_review_pending: 0,
    });
  });

  it('counts stale hash-sync docs in reconcile_backlog', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);

    // Bootstrap a file-anchored doc with stale source_synced_at
    repo.insertProposal({
      proposal_id: 'boot-stale',
      proposal_type: 'bootstrap',
      payload: JSON.stringify({
        documents: [
          {
            doc_id: 'stale-hash',
            title: 'Stale Hash',
            kind: 'guideline',
            content: 'c',
            content_hash: hash('c'),
            ownership: 'file-anchored',
            source_path: 'docs/stale.md',
          },
        ],
        edges: [],
        layer_rules: [],
      }),
      status: 'pending',
      review_comment: null,
    });
    repo.approveProposal('boot-stale');

    const ws = buildWorkspaceStatus(repo);
    // source_synced_at is null → stale
    expect(ws.reconcile_backlog.hash_sync_stale).toBe(1);
    expect(ws.reconcile_backlog.anchor_sync_stale).toBe(0);
    expect(ws.reconcile_backlog.semantic_review_pending).toBe(0);
  });

  it('counts semantic-review docs in reconcile_backlog', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);

    // Bootstrap a file-anchored doc with multi-source refs (semantic-review)
    repo.insertProposal({
      proposal_id: 'boot-sem',
      proposal_type: 'bootstrap',
      payload: JSON.stringify({
        documents: [
          {
            doc_id: 'sem-review',
            title: 'Semantic Review',
            kind: 'guideline',
            content: 'c',
            content_hash: hash('c'),
            ownership: 'file-anchored',
            source_path: null,
            source_refs_json: JSON.stringify([
              { asset_path: 'a.md', anchor_type: 'file', anchor_value: '' },
              { asset_path: 'b.md', anchor_type: 'file', anchor_value: '' },
            ]),
          },
        ],
        edges: [],
        layer_rules: [],
      }),
      status: 'pending',
      review_comment: null,
    });
    repo.approveProposal('boot-sem');

    const ws = buildWorkspaceStatus(repo);
    expect(ws.reconcile_backlog.semantic_review_pending).toBe(1);
    expect(ws.reconcile_backlog.hash_sync_stale).toBe(0);
  });

  it('counts fresh anchor-sync doc with anchor failure backlog as stale', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);

    // Bootstrap a fresh anchor-sync doc (source_synced_at = recent)
    repo.insertProposal({
      proposal_id: 'boot-anchor',
      proposal_type: 'bootstrap',
      payload: JSON.stringify({
        documents: [
          {
            doc_id: 'anchor-fail',
            title: 'Anchor Fail',
            kind: 'guideline',
            content: 'c',
            content_hash: hash('c'),
            ownership: 'file-anchored',
            source_path: null,
            source_refs_json: JSON.stringify([{ asset_path: 'a.md', anchor_type: 'section', anchor_value: '## X' }]),
          },
        ],
        edges: [],
        layer_rules: [],
      }),
      status: 'pending',
      review_comment: null,
    });
    repo.approveProposal('boot-anchor');

    // Mark as recently synced so age-based check passes
    db.prepare(`UPDATE documents SET source_synced_at = ? WHERE doc_id = ?`).run(
      new Date().toISOString(),
      'anchor-fail',
    );

    // Insert unresolved anchor failure observation
    repo.insertObservation({
      observation_id: 'obs-af',
      event_type: 'staleness_detected',
      payload: JSON.stringify({
        doc_id: 'anchor-fail',
        level: 2,
        kind: 'anchor_missing',
        detail: 'section ## X not found',
        algorithm_version: '1.0',
      }),
      related_compile_id: null,
      related_snapshot_id: null,
    });

    const ws = buildWorkspaceStatus(repo);
    // Should count as stale due to anchor failure backlog, not age
    expect(ws.reconcile_backlog.anchor_sync_stale).toBe(1);
  });
});
