/**
 * ADR-012 / docs/tasks/012-04 — compile_audit contract via AegisService + observation concurrency.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AegisDatabase, createDatabase, createInMemoryDatabase, Repository } from '../core/store/index.js';
import { BudgetExceededError } from '../core/types.js';
import { AegisService } from './services.js';

const TEMPLATES_ROOT = join(import.meta.dirname, '../../templates');

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

function bootstrapCompileMissKnowledge(repo: Repository): void {
  repo.insertProposal({
    proposal_id: 'p-boot',
    proposal_type: 'bootstrap',
    payload: JSON.stringify({
      documents: [
        {
          doc_id: 'ddd-guide',
          title: 'DDD Guideline',
          kind: 'guideline',
          content: 'DDD content',
          content_hash: hash('DDD content'),
        },
      ],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'app/UseCases/**',
          target_doc_id: 'ddd-guide',
          edge_type: 'path_requires',
          priority: 100,
          specificity: 2,
        },
      ],
      layer_rules: [],
    }),
    status: 'pending',
    review_comment: null,
  });
  repo.approveProposal('p-boot');
}

describe('compile_audit contract — AegisService (012-04)', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let service: AegisService;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    service = new AegisService(repo, TEMPLATES_ROOT);
  });

  it('compileContext persists agent_id on compile_log (ADR-015 Task 015-11)', async () => {
    bootstrapMinimalDoc(repo);
    const compiled = await service.compileContext({ target_files: ['src/a.ts'], agent_id: 'cursor-agent-1' }, 'agent');
    const log = repo.getCompileLog(compiled.compile_id);
    expect(log?.agent_id).toBe('cursor-agent-1');
  });

  it('getCompileAudit: legacy row (audit_meta null) returns null extended fields on agent surface', () => {
    bootstrapMinimalDoc(repo);
    const snapshot = repo.getCurrentSnapshot()!;
    repo.insertCompileLog({
      compile_id: 'legacy-compile',
      snapshot_id: snapshot.snapshot_id,
      request: '{}',
      base_doc_ids: '["d1"]',
      expanded_doc_ids: null,
      audit_meta: null,
      agent_id: null,
    });

    const audit = service.getCompileAudit('legacy-compile', 'agent');
    expect(audit).toBeDefined();
    expect(audit!.compile_id).toBe('legacy-compile');
    expect(audit!.delivery_stats).toBeNull();
    expect(audit!.budget_utilization).toBeNull();
    expect(audit!.budget_exceeded).toBeNull();
    expect(audit!.budget_dropped).toBeNull();
    expect(audit!.near_miss_edges).toBeNull();
    expect(audit!.layer_classification).toBeNull();
    expect(audit!.policy_omitted_doc_ids).toBeNull();
    expect(audit!.performance).toBeNull();
    expect(audit!.expanded_tagging).toBeNull();
  });

  it('getCompileAudit: v2 audit_meta after compileContext matches on agent and admin', async () => {
    bootstrapMinimalDoc(repo);
    const compiled = await service.compileContext({ target_files: ['src/a.ts'] }, 'agent');
    const fromAgent = service.getCompileAudit(compiled.compile_id, 'agent');
    const fromAdmin = service.getCompileAudit(compiled.compile_id, 'admin');
    expect(fromAgent).toEqual(fromAdmin);
    expect(fromAgent!.delivery_stats).toMatchObject({
      inline_count: expect.any(Number),
      inline_total_bytes: expect.any(Number),
      deferred_count: expect.any(Number),
      deferred_total_bytes: expect.any(Number),
      omitted_count: expect.any(Number),
      omitted_total_bytes: expect.any(Number),
    });
    expect(typeof fromAgent!.budget_utilization).toBe('number');
    expect(fromAgent!.budget_exceeded).toBe(false);
    expect(fromAgent!.budget_dropped).toEqual([]);
    expect(fromAgent!.near_miss_edges).toEqual([]);
    expect(fromAgent!.layer_classification).toEqual({ 'src/a.ts': null });
    expect(fromAgent!.policy_omitted_doc_ids).toEqual([]);
    expect(fromAgent!.performance).toMatchObject({
      near_miss_edge_scan_ms: expect.any(Number),
      near_miss_edges_evaluated: expect.any(Number),
    });
    expect(fromAgent!.expanded_tagging).toEqual({
      tags_source: null,
      requested_tags: [],
      accepted_tags: [],
      ignored_unknown_count: 0,
      matched_doc_count: 0,
    });
    expect(compiled.debug_info).toEqual({
      near_miss_edges: fromAgent!.near_miss_edges,
      layer_classification: fromAgent!.layer_classification,
      budget_dropped: fromAgent!.budget_dropped,
    });
  });

  it('BudgetExceededError: failed compile still records audit readable via getCompileAudit', async () => {
    const largeContent = 'x'.repeat(5000);
    repo.insertProposal({
      proposal_id: 'boot-big',
      proposal_type: 'bootstrap',
      payload: JSON.stringify({
        documents: [
          {
            doc_id: 'big',
            title: 'Big',
            kind: 'guideline',
            content: largeContent,
            content_hash: hash(largeContent),
          },
        ],
        edges: [
          {
            edge_id: 'e1',
            source_type: 'path',
            source_value: 'src/**',
            target_doc_id: 'big',
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
    repo.approveProposal('boot-big');

    try {
      await service.compileContext({ target_files: ['src/a.ts'], max_inline_bytes: 100 }, 'agent');
      expect.fail('expected BudgetExceededError');
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(BudgetExceededError);
      const err = e as BudgetExceededError;
      const audit = service.getCompileAudit(err.compile_id, 'agent');
      expect(audit).toBeDefined();
      expect(audit!.budget_exceeded).toBe(true);
      expect(audit!.expanded_tagging).toEqual({
        tags_source: null,
        requested_tags: [],
        accepted_tags: [],
        ignored_unknown_count: 0,
        matched_doc_count: 0,
      });
    }
  });
});

describe('process_observations — concurrent admin calls (012-04)', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aegis-co-'));
    dbPath = join(tmpDir, 'c.db');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Integration smoke: two AegisService instances on one file-backed DB via Promise.all.
  // This does not prove overlapping claim in a single JS event loop; mutex-like behaviour
  // for multi-connection access is covered by Repository.claimUnanalyzedObservations and
  // src/core/store/repository.test.ts (claimUnanalyzedObservations — file-backed).
  it('two file-backed services process compile_miss in parallel without double-claim', async () => {
    const dbSetup = await createDatabase(dbPath);
    const repoSetup = new Repository(dbSetup);
    bootstrapCompileMissKnowledge(repoSetup);

    const paths = [
      'app/Domain/User/UserEntity.php',
      'app/Domain/Order/OrderEntity.php',
      'app/Domain/Payment/PaymentEntity.php',
    ];
    for (let i = 0; i < paths.length; i++) {
      repoSetup.insertObservation({
        observation_id: `obs-par-${i}`,
        event_type: 'compile_miss',
        payload: JSON.stringify({
          target_files: [paths[i]],
          missing_doc: 'ddd-guide',
          review_comment: 'gap',
        }),
        related_compile_id: `cmp-${i}`,
        related_snapshot_id: `snap-${i}`,
      });
    }
    dbSetup.close();

    const dbA = await createDatabase(dbPath);
    const dbB = await createDatabase(dbPath);
    const repoA = new Repository(dbA);
    const repoB = new Repository(dbB);

    const adminA = new AegisService(repoA, TEMPLATES_ROOT);
    const adminB = new AegisService(repoB, TEMPLATES_ROOT);

    const [a, b] = await Promise.all([
      adminA.processObservations('compile_miss', 'admin'),
      adminB.processObservations('compile_miss', 'admin'),
    ]);

    dbA.close();
    dbB.close();

    const dbVerify = await createDatabase(dbPath);
    const repoVerify = new Repository(dbVerify);

    expect(repoVerify.getUnanalyzedObservations('compile_miss')).toHaveLength(0);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);

    const pendingAddEdge = repoVerify.getPendingProposalsByType('add_edge');
    expect(pendingAddEdge.length).toBeGreaterThanOrEqual(1);
    expect(pendingAddEdge.length).toBeLessThanOrEqual(3);

    const linkedObs = new Set<string>();
    for (const p of pendingAddEdge) {
      for (const ev of repoVerify.getProposalEvidence(p.proposal_id)) {
        expect(linkedObs.has(ev.observation_id)).toBe(false);
        linkedObs.add(ev.observation_id);
      }
    }
    expect(linkedObs.size).toBe(3);

    expect(a.proposals_created + b.proposals_created).toBe(pendingAddEdge.length);
    dbVerify.close();
  });
});
