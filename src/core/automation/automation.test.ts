import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AegisService, SurfaceViolationError } from '../../mcp/services.js';
import { type AegisDatabase, createInMemoryDatabase, Repository } from '../store/index.js';
import type { AnalysisContext, Observation } from '../types.js';
import type { ObservationAnalyzer } from './analyzer.js';
import { DocumentImportAnalyzer } from './document-import-analyzer.js';
import { ManualNoteAnalyzer } from './manual-note-analyzer.js';
import { PrMergedAnalyzer } from './pr-merged-analyzer.js';
import { ProposeService } from './propose.js';
import { ReviewCorrectionAnalyzer } from './review-correction-analyzer.js';
import { RuleBasedAnalyzer } from './rule-analyzer.js';

const TEMPLATES_ROOT = join(import.meta.dirname, '../../../templates');

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function makeObservation(id: string, overrides: Partial<Observation> = {}): Observation {
  return {
    observation_id: id,
    event_type: 'compile_miss',
    payload: JSON.stringify({
      target_files: ['app/Domain/User/UserEntity.php'],
      missing_doc: 'ddd-guide',
      review_comment: 'missing DDD guideline',
    }),
    related_compile_id: 'cmp-001',
    related_snapshot_id: 'snap-001',
    created_at: '2025-01-01T00:00:00.000Z',
    archived_at: null,
    analyzed_at: null,
    ...overrides,
  };
}

// ============================================================
// RuleBasedAnalyzer
// ============================================================

describe('RuleBasedAnalyzer', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let analyzer: RuleBasedAnalyzer;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    analyzer = new RuleBasedAnalyzer();
  });

  it('compile_miss with missing_doc produces add_edge draft', async () => {
    const obs = makeObservation('obs-1');
    const ctx: AnalysisContext = { observation: obs, compile_audit: null };

    const result = await analyzer.analyze([ctx]);

    expect(result.drafts).toHaveLength(1);
    expect(result.skipped_observation_ids).toHaveLength(0);
    const draft = result.drafts[0];
    expect(draft.proposal_type).toBe('add_edge');
    expect(draft.payload.source_type).toBe('path');
    expect(draft.payload.source_value).toBe('app/Domain/User/**');
    expect(draft.payload.target_doc_id).toBe('ddd-guide');
    expect(draft.payload.edge_type).toBe('path_requires');
    expect(draft.evidence_observation_ids).toEqual(['obs-1']);
  });

  it('compile_miss without missing_doc → skip', async () => {
    const obs = makeObservation('obs-2', {
      payload: JSON.stringify({
        target_files: ['src/a.ts'],
        review_comment: 'something missing',
      }),
    });
    const ctx: AnalysisContext = { observation: obs, compile_audit: null };

    const result = await analyzer.analyze([ctx]);

    expect(result.drafts).toHaveLength(0);
    expect(result.skipped_observation_ids).toEqual(['obs-2']);
  });

  it('non-compile_miss event → skip', async () => {
    const obs = makeObservation('obs-3', {
      event_type: 'manual_note',
      payload: JSON.stringify({ content: 'some note' }),
      related_compile_id: null,
      related_snapshot_id: null,
    });
    const ctx: AnalysisContext = { observation: obs, compile_audit: null };

    const result = await analyzer.analyze([ctx]);

    expect(result.drafts).toHaveLength(0);
    expect(result.skipped_observation_ids).toEqual(['obs-3']);
  });

  it('derives correct path pattern from deeply nested file', async () => {
    const obs = makeObservation('obs-4', {
      payload: JSON.stringify({
        target_files: ['src/modules/auth/middleware/jwt.ts'],
        missing_doc: 'auth-guide',
        review_comment: 'missing auth doc',
      }),
    });
    const ctx: AnalysisContext = { observation: obs, compile_audit: null };

    const result = await analyzer.analyze([ctx]);

    expect(result.drafts[0].payload.source_value).toBe('src/modules/auth/middleware/**');
  });

  it('root-level file derives "**"', async () => {
    const obs = makeObservation('obs-5', {
      payload: JSON.stringify({
        target_files: ['index.ts'],
        missing_doc: 'root-guide',
        review_comment: 'missing root doc',
      }),
    });
    const ctx: AnalysisContext = { observation: obs, compile_audit: null };

    const result = await analyzer.analyze([ctx]);

    expect(result.drafts[0].payload.source_value).toBe('**');
  });

  it('calculates specificity from path segments', async () => {
    const obs = makeObservation('obs-6', {
      payload: JSON.stringify({
        target_files: ['app/Domain/User/UserEntity.php'],
        missing_doc: 'doc-1',
        review_comment: 'test',
      }),
    });
    const ctx: AnalysisContext = { observation: obs, compile_audit: null };

    const result = await analyzer.analyze([ctx]);

    // "app/Domain/User/**" → 3 non-glob segments
    expect(result.drafts[0].payload.specificity).toBe(3);
  });

  it('multiple target_files produce one draft per unique directory pattern', async () => {
    const obs = makeObservation('obs-7', {
      payload: JSON.stringify({
        target_files: [
          'app/Domain/User/UserEntity.php',
          'app/Domain/User/UserRepository.php',
          'app/Domain/Order/OrderEntity.php',
        ],
        missing_doc: 'ddd-guide',
        review_comment: 'missing DDD guideline across Domain dirs',
      }),
    });
    const ctx: AnalysisContext = { observation: obs, compile_audit: null };

    const result = await analyzer.analyze([ctx]);

    // Two unique patterns: app/Domain/User/** and app/Domain/Order/**
    expect(result.drafts).toHaveLength(2);
    const patterns = result.drafts.map((d) => d.payload.source_value).sort();
    expect(patterns).toEqual(['app/Domain/Order/**', 'app/Domain/User/**']);
    // All drafts share same evidence
    for (const draft of result.drafts) {
      expect(draft.evidence_observation_ids).toEqual(['obs-7']);
      expect(draft.payload.target_doc_id).toBe('ddd-guide');
    }
  });

  it('duplicate directories in target_files are deduplicated', async () => {
    const obs = makeObservation('obs-8', {
      payload: JSON.stringify({
        target_files: ['src/utils/helper.ts', 'src/utils/format.ts'],
        missing_doc: 'util-guide',
        review_comment: 'test',
      }),
    });
    const ctx: AnalysisContext = { observation: obs, compile_audit: null };

    const result = await analyzer.analyze([ctx]);

    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0].payload.source_value).toBe('src/utils/**');
  });

  it('batch: mixed observations → correct split', async () => {
    const contexts: AnalysisContext[] = [
      { observation: makeObservation('obs-a'), compile_audit: null },
      {
        observation: makeObservation('obs-b', {
          payload: JSON.stringify({
            target_files: ['src/a.ts'],
            review_comment: 'no missing_doc',
          }),
        }),
        compile_audit: null,
      },
      {
        observation: makeObservation('obs-c', {
          event_type: 'manual_note',
          payload: JSON.stringify({ content: 'note' }),
          related_compile_id: null,
          related_snapshot_id: null,
        }),
        compile_audit: null,
      },
    ];

    const result = await analyzer.analyze(contexts);

    expect(result.drafts).toHaveLength(1);
    expect(result.skipped_observation_ids).toEqual(['obs-b', 'obs-c']);
    expect(result.errors).toHaveLength(0);
  });

  // ── Content gap: compile_miss with target_doc_id (no missing_doc) → skip (ADR-008 D-2) ──

  it('compile_miss with target_doc_id (no missing_doc) is skipped per ADR-008 D-2', async () => {
    // Bootstrap an approved document
    repo.insertProposal({
      proposal_id: 'boot',
      proposal_type: 'bootstrap',
      payload: JSON.stringify({
        documents: [{ doc_id: 'ddd-guide', title: 'DDD', kind: 'guideline', content: 'c', content_hash: hash('c') }],
        edges: [],
        layer_rules: [],
      }),
      status: 'pending',
      review_comment: null,
    });
    repo.approveProposal('boot');

    const obs = makeObservation('obs-gap-1', {
      payload: JSON.stringify({
        target_files: ['src/a.ts'],
        target_doc_id: 'ddd-guide',
        review_comment: 'missing validation section in DDD guide',
      }),
    });
    const ctx: AnalysisContext = { observation: obs, compile_audit: null };

    const result = await analyzer.analyze([ctx]);

    expect(result.drafts).toHaveLength(0);
    expect(result.skipped_observation_ids).toEqual(['obs-gap-1']);
  });

  it('compile_miss with target_doc_id but doc not approved → skip', async () => {
    // Insert a non-approved (proposed) document directly
    repo.insertDocument({
      doc_id: 'draft-doc',
      title: 'Draft',
      kind: 'guideline',
      content: 'draft',
      content_hash: hash('draft'),
      status: 'proposed',
      template_origin: null,
      source_path: null,
    });

    const obs = makeObservation('obs-gap-2', {
      payload: JSON.stringify({
        target_files: ['src/a.ts'],
        target_doc_id: 'draft-doc',
        review_comment: 'content insufficient',
      }),
    });
    const ctx: AnalysisContext = { observation: obs, compile_audit: null };

    const result = await analyzer.analyze([ctx]);

    expect(result.drafts).toHaveLength(0);
    expect(result.skipped_observation_ids).toEqual(['obs-gap-2']);
  });

  it('compile_miss with target_doc_id pointing to nonexistent doc → skip', async () => {
    const obs = makeObservation('obs-gap-3', {
      payload: JSON.stringify({
        target_files: ['src/a.ts'],
        target_doc_id: 'nonexistent',
        review_comment: 'content insufficient',
      }),
    });
    const ctx: AnalysisContext = { observation: obs, compile_audit: null };

    const result = await analyzer.analyze([ctx]);

    expect(result.drafts).toHaveLength(0);
    expect(result.skipped_observation_ids).toEqual(['obs-gap-3']);
  });

  it('compile_miss with both missing_doc and target_doc_id → prefers add_edge', async () => {
    const obs = makeObservation('obs-gap-4', {
      payload: JSON.stringify({
        target_files: ['src/a.ts'],
        missing_doc: 'some-doc',
        target_doc_id: 'ddd-guide',
        review_comment: 'both fields',
      }),
    });
    const ctx: AnalysisContext = { observation: obs, compile_audit: null };

    const result = await analyzer.analyze([ctx]);

    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0].proposal_type).toBe('add_edge');
  });
});

// ============================================================
// ReviewCorrectionAnalyzer
// ============================================================

describe('ReviewCorrectionAnalyzer', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let analyzer: ReviewCorrectionAnalyzer;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    analyzer = new ReviewCorrectionAnalyzer(repo);

    // Seed an approved document to target
    repo.insertDocument({
      doc_id: 'ddd-guide',
      title: 'DDD Guideline',
      kind: 'guideline',
      content: 'Original DDD content',
      content_hash: hash('Original DDD content'),
      status: 'approved',
    });
  });

  it('review_correction with target_doc_id + proposed_content → update_doc draft', async () => {
    const obs = makeObservation('obs-rc-1', {
      event_type: 'review_correction',
      payload: JSON.stringify({
        file_path: 'app/Domain/User/UserEntity.php',
        correction: 'DDD guide should mention aggregate roots',
        target_doc_id: 'ddd-guide',
        proposed_content: 'Updated DDD content with aggregate roots',
      }),
      related_compile_id: null,
      related_snapshot_id: null,
    });
    const ctx: AnalysisContext = { observation: obs, compile_audit: null };

    const result = await analyzer.analyze([ctx]);

    expect(result.drafts).toHaveLength(1);
    expect(result.skipped_observation_ids).toHaveLength(0);
    const draft = result.drafts[0];
    expect(draft.proposal_type).toBe('update_doc');
    expect(draft.payload.doc_id).toBe('ddd-guide');
    expect(draft.payload.content).toBe('Updated DDD content with aggregate roots');
    expect(draft.payload.content_hash).toBe(hash('Updated DDD content with aggregate roots'));
    expect(draft.evidence_observation_ids).toEqual(['obs-rc-1']);
  });

  it('review_correction without target_doc_id → skip', async () => {
    const obs = makeObservation('obs-rc-2', {
      event_type: 'review_correction',
      payload: JSON.stringify({
        file_path: 'app/Domain/User/UserEntity.php',
        correction: 'Something needs fixing',
      }),
      related_compile_id: null,
      related_snapshot_id: null,
    });
    const ctx: AnalysisContext = { observation: obs, compile_audit: null };

    const result = await analyzer.analyze([ctx]);

    expect(result.drafts).toHaveLength(0);
    expect(result.skipped_observation_ids).toEqual(['obs-rc-2']);
  });

  it('review_correction without proposed_content → skip', async () => {
    const obs = makeObservation('obs-rc-3', {
      event_type: 'review_correction',
      payload: JSON.stringify({
        file_path: 'app/Domain/User/UserEntity.php',
        correction: 'Something needs fixing',
        target_doc_id: 'ddd-guide',
      }),
      related_compile_id: null,
      related_snapshot_id: null,
    });
    const ctx: AnalysisContext = { observation: obs, compile_audit: null };

    const result = await analyzer.analyze([ctx]);

    expect(result.drafts).toHaveLength(0);
    expect(result.skipped_observation_ids).toEqual(['obs-rc-3']);
  });

  it('review_correction targeting non-existent doc → skip', async () => {
    const obs = makeObservation('obs-rc-4', {
      event_type: 'review_correction',
      payload: JSON.stringify({
        file_path: 'app/Domain/User/UserEntity.php',
        correction: 'Fix this doc',
        target_doc_id: 'nonexistent-doc',
        proposed_content: 'New content',
      }),
      related_compile_id: null,
      related_snapshot_id: null,
    });
    const ctx: AnalysisContext = { observation: obs, compile_audit: null };

    const result = await analyzer.analyze([ctx]);

    expect(result.drafts).toHaveLength(0);
    expect(result.skipped_observation_ids).toEqual(['obs-rc-4']);
  });

  it('review_correction targeting non-approved doc → skip', async () => {
    repo.insertDocument({
      doc_id: 'draft-doc',
      title: 'Draft Doc',
      kind: 'guideline',
      content: 'draft content',
      content_hash: hash('draft content'),
      status: 'draft',
    });

    const obs = makeObservation('obs-rc-5', {
      event_type: 'review_correction',
      payload: JSON.stringify({
        file_path: 'app/Domain/User/UserEntity.php',
        correction: 'Fix this',
        target_doc_id: 'draft-doc',
        proposed_content: 'New content',
      }),
      related_compile_id: null,
      related_snapshot_id: null,
    });
    const ctx: AnalysisContext = { observation: obs, compile_audit: null };

    const result = await analyzer.analyze([ctx]);

    expect(result.drafts).toHaveLength(0);
    expect(result.skipped_observation_ids).toEqual(['obs-rc-5']);
  });

  it('non-review_correction event → skip', async () => {
    const obs = makeObservation('obs-rc-6', {
      event_type: 'compile_miss',
      payload: JSON.stringify({
        target_files: ['src/a.ts'],
        missing_doc: 'ddd-guide',
        review_comment: 'missing doc',
      }),
    });
    const ctx: AnalysisContext = { observation: obs, compile_audit: null };

    const result = await analyzer.analyze([ctx]);

    expect(result.drafts).toHaveLength(0);
    expect(result.skipped_observation_ids).toEqual(['obs-rc-6']);
  });

  it('content_hash is server-derived from proposed_content', async () => {
    const proposedContent = 'Specific content for hash verification';
    const obs = makeObservation('obs-rc-7', {
      event_type: 'review_correction',
      payload: JSON.stringify({
        file_path: 'src/a.ts',
        correction: 'test',
        target_doc_id: 'ddd-guide',
        proposed_content: proposedContent,
      }),
      related_compile_id: null,
      related_snapshot_id: null,
    });
    const ctx: AnalysisContext = { observation: obs, compile_audit: null };

    const result = await analyzer.analyze([ctx]);

    expect(result.drafts[0].payload.content_hash).toBe(hash(proposedContent));
  });
});

// ============================================================
// ProposeService
// ============================================================

describe('ProposeService', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let proposeService: ProposeService;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    proposeService = new ProposeService(repo);
  });

  it('creates pending proposal with evidence link', () => {
    repo.insertObservation({
      observation_id: 'obs-1',
      event_type: 'compile_miss',
      payload: '{}',
      related_compile_id: null,
      related_snapshot_id: null,
    });

    const result = proposeService.propose([
      {
        proposal_type: 'add_edge',
        payload: { source_type: 'path', source_value: 'app/**', target_doc_id: 'doc-1' },
        evidence_observation_ids: ['obs-1'],
      },
    ]);

    expect(result.created_proposal_ids).toHaveLength(1);
    expect(result.skipped_duplicate_count).toBe(0);

    const proposal = repo.getProposal(result.created_proposal_ids[0]);
    expect(proposal).toBeDefined();
    expect(proposal!.status).toBe('pending');
    expect(proposal!.proposal_type).toBe('add_edge');

    const evidence = repo.getProposalEvidence(result.created_proposal_ids[0]);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].observation_id).toBe('obs-1');
  });

  it('idempotency: same observation does not create duplicate', () => {
    repo.insertObservation({
      observation_id: 'obs-1',
      event_type: 'compile_miss',
      payload: '{}',
      related_compile_id: null,
      related_snapshot_id: null,
    });

    const draft = {
      proposal_type: 'add_edge' as const,
      payload: { source_value: 'app/**', target_doc_id: 'doc-1' },
      evidence_observation_ids: ['obs-1'],
    };

    const first = proposeService.propose([draft]);
    expect(first.created_proposal_ids).toHaveLength(1);

    const second = proposeService.propose([draft]);
    expect(second.created_proposal_ids).toHaveLength(0);
    expect(second.skipped_duplicate_count).toBe(1);
  });

  it('different observations create separate proposals', () => {
    repo.insertObservation({
      observation_id: 'obs-1',
      event_type: 'compile_miss',
      payload: '{}',
      related_compile_id: null,
      related_snapshot_id: null,
    });
    repo.insertObservation({
      observation_id: 'obs-2',
      event_type: 'compile_miss',
      payload: '{}',
      related_compile_id: null,
      related_snapshot_id: null,
    });

    const result = proposeService.propose([
      { proposal_type: 'add_edge', payload: { target: 'a' }, evidence_observation_ids: ['obs-1'] },
      { proposal_type: 'add_edge', payload: { target: 'b' }, evidence_observation_ids: ['obs-2'] },
    ]);

    expect(result.created_proposal_ids).toHaveLength(2);
  });

  it('rejected proposal does not block re-proposal', () => {
    repo.insertObservation({
      observation_id: 'obs-1',
      event_type: 'compile_miss',
      payload: '{}',
      related_compile_id: null,
      related_snapshot_id: null,
    });

    const first = proposeService.propose([
      {
        proposal_type: 'add_edge',
        payload: { target: 'a' },
        evidence_observation_ids: ['obs-1'],
      },
    ]);
    repo.rejectProposal(first.created_proposal_ids[0], 'not needed');

    const second = proposeService.propose([
      {
        proposal_type: 'add_edge',
        payload: { target: 'a' },
        evidence_observation_ids: ['obs-1'],
      },
    ]);
    expect(second.created_proposal_ids).toHaveLength(1);
  });

  it('serializes payload to JSON correctly', () => {
    repo.insertObservation({
      observation_id: 'obs-1',
      event_type: 'compile_miss',
      payload: '{}',
      related_compile_id: null,
      related_snapshot_id: null,
    });

    const payloadObj = { source_type: 'path', source_value: 'src/**', target_doc_id: 'doc-x', priority: 100 };
    const result = proposeService.propose([
      {
        proposal_type: 'add_edge',
        payload: payloadObj,
        evidence_observation_ids: ['obs-1'],
      },
    ]);

    const proposal = repo.getProposal(result.created_proposal_ids[0]);
    expect(JSON.parse(proposal!.payload)).toEqual(payloadObj);
  });

  it('multiple drafts from same observation are all persisted', () => {
    repo.insertObservation({
      observation_id: 'obs-1',
      event_type: 'compile_miss',
      payload: '{}',
      related_compile_id: null,
      related_snapshot_id: null,
    });

    const result = proposeService.propose([
      {
        proposal_type: 'add_edge',
        payload: { source_value: 'app/Domain/User/**', target_doc_id: 'ddd-guide' },
        evidence_observation_ids: ['obs-1'],
      },
      {
        proposal_type: 'add_edge',
        payload: { source_value: 'app/Domain/Order/**', target_doc_id: 'ddd-guide' },
        evidence_observation_ids: ['obs-1'],
      },
    ]);

    expect(result.created_proposal_ids).toHaveLength(2);
    expect(result.skipped_duplicate_count).toBe(0);
  });

  it('semantic duplicate: same source_value+target_doc_id is skipped', () => {
    repo.insertObservation({
      observation_id: 'obs-1',
      event_type: 'compile_miss',
      payload: '{}',
      related_compile_id: null,
      related_snapshot_id: null,
    });

    const first = proposeService.propose([
      {
        proposal_type: 'add_edge',
        payload: { source_type: 'path', source_value: 'app/**', target_doc_id: 'doc-1', edge_type: 'path_requires' },
        evidence_observation_ids: ['obs-1'],
      },
    ]);
    expect(first.created_proposal_ids).toHaveLength(1);

    // Same semantic key (source_type:source_value:target_doc_id:edge_type), different edge_id
    const second = proposeService.propose([
      {
        proposal_type: 'add_edge',
        payload: {
          source_type: 'path',
          source_value: 'app/**',
          target_doc_id: 'doc-1',
          edge_type: 'path_requires',
          edge_id: 'new-uuid',
        },
        evidence_observation_ids: ['obs-1'],
      },
    ]);
    expect(second.created_proposal_ids).toHaveLength(0);
    expect(second.skipped_duplicate_count).toBe(1);
  });

  it('different semantic key is not treated as duplicate', () => {
    repo.insertObservation({
      observation_id: 'obs-1',
      event_type: 'compile_miss',
      payload: '{}',
      related_compile_id: null,
      related_snapshot_id: null,
    });

    proposeService.propose([
      {
        proposal_type: 'add_edge',
        payload: {
          source_type: 'path',
          source_value: 'app/User/**',
          target_doc_id: 'doc-1',
          edge_type: 'path_requires',
        },
        evidence_observation_ids: ['obs-1'],
      },
    ]);

    // Different source_value → different semantic key
    const second = proposeService.propose([
      {
        proposal_type: 'add_edge',
        payload: {
          source_type: 'path',
          source_value: 'app/Order/**',
          target_doc_id: 'doc-1',
          edge_type: 'path_requires',
        },
        evidence_observation_ids: ['obs-1'],
      },
    ]);
    expect(second.created_proposal_ids).toHaveLength(1);
  });

  it('transaction rollback on evidence insert failure leaves no orphan proposal', () => {
    repo.insertObservation({
      observation_id: 'obs-1',
      event_type: 'compile_miss',
      payload: '{}',
      related_compile_id: null,
      related_snapshot_id: null,
    });

    // Draft with a non-existent observation ID as evidence → FK violation
    expect(() => {
      proposeService.propose([
        {
          proposal_type: 'add_edge',
          payload: { source_value: 'app/**' },
          evidence_observation_ids: ['obs-nonexistent'],
        },
      ]);
    }).toThrow();

    // No orphan proposals in DB
    const { proposals } = repo.listProposals(undefined, 100, 0);
    expect(proposals).toHaveLength(0);
  });
});

// ============================================================
// Repository — automation queries
// ============================================================

describe('Repository — automation queries', () => {
  let db: AegisDatabase;
  let repo: Repository;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
  });

  describe('getObservation', () => {
    it('returns stored observation', () => {
      repo.insertObservation({
        observation_id: 'obs-1',
        event_type: 'compile_miss',
        payload: '{"a":1}',
        related_compile_id: 'cmp-1',
        related_snapshot_id: 'snap-1',
      });

      const obs = repo.getObservation('obs-1');
      expect(obs).toBeDefined();
      expect(obs!.observation_id).toBe('obs-1');
      expect(obs!.event_type).toBe('compile_miss');
    });

    it('returns undefined for non-existent id', () => {
      expect(repo.getObservation('nonexistent')).toBeUndefined();
    });
  });

  describe('getPendingProposalsByType', () => {
    it('returns all pending proposals of given type', () => {
      repo.insertProposal({
        proposal_id: 'p-1',
        proposal_type: 'add_edge',
        payload: '{"source_value":"a"}',
        status: 'pending',
        review_comment: null,
      });
      repo.insertProposal({
        proposal_id: 'p-2',
        proposal_type: 'add_edge',
        payload: '{"source_value":"b"}',
        status: 'pending',
        review_comment: null,
      });

      const result = repo.getPendingProposalsByType('add_edge');
      expect(result).toHaveLength(2);
    });

    it('returns empty when no proposals exist', () => {
      expect(repo.getPendingProposalsByType('add_edge')).toHaveLength(0);
    });

    it('excludes rejected proposals', () => {
      repo.insertObservation({
        observation_id: 'obs-1',
        event_type: 'compile_miss',
        payload: '{}',
        related_compile_id: null,
        related_snapshot_id: null,
      });
      repo.insertProposal({
        proposal_id: 'p-1',
        proposal_type: 'add_edge',
        payload: '{}',
        status: 'pending',
        review_comment: null,
      });
      repo.insertProposalEvidence('p-1', 'obs-1');
      repo.rejectProposal('p-1', 'nope');

      expect(repo.getPendingProposalsByType('add_edge')).toHaveLength(0);
    });

    it('excludes proposals of different type', () => {
      repo.insertProposal({
        proposal_id: 'p-1',
        proposal_type: 'new_doc',
        payload: '{}',
        status: 'pending',
        review_comment: null,
      });

      expect(repo.getPendingProposalsByType('add_edge')).toHaveLength(0);
    });
  });

  describe('getUnanalyzedObservations', () => {
    it('returns observations with analyzed_at IS NULL', () => {
      repo.insertObservation({
        observation_id: 'obs-1',
        event_type: 'compile_miss',
        payload: '{}',
        related_compile_id: null,
        related_snapshot_id: null,
      });
      repo.insertObservation({
        observation_id: 'obs-2',
        event_type: 'compile_miss',
        payload: '{}',
        related_compile_id: null,
        related_snapshot_id: null,
      });

      // Mark obs-1 as analyzed
      repo.markObservationsAnalyzed(['obs-1']);

      const unanalyzed = repo.getUnanalyzedObservations('compile_miss');
      expect(unanalyzed).toHaveLength(1);
      expect(unanalyzed[0].observation_id).toBe('obs-2');
    });

    it('respects eventType filter', () => {
      repo.insertObservation({
        observation_id: 'obs-1',
        event_type: 'compile_miss',
        payload: '{}',
        related_compile_id: null,
        related_snapshot_id: null,
      });
      repo.insertObservation({
        observation_id: 'obs-2',
        event_type: 'manual_note',
        payload: '{}',
        related_compile_id: null,
        related_snapshot_id: null,
      });

      const result = repo.getUnanalyzedObservations('compile_miss');
      expect(result).toHaveLength(1);
      expect(result[0].observation_id).toBe('obs-1');
    });

    it('returns empty array when all are analyzed', () => {
      repo.insertObservation({
        observation_id: 'obs-1',
        event_type: 'compile_miss',
        payload: '{}',
        related_compile_id: null,
        related_snapshot_id: null,
      });
      repo.markObservationsAnalyzed(['obs-1']);

      expect(repo.getUnanalyzedObservations('compile_miss')).toHaveLength(0);
    });

    it('resetObservationsAnalyzed makes observations available again', () => {
      repo.insertObservation({
        observation_id: 'obs-1',
        event_type: 'compile_miss',
        payload: '{}',
        related_compile_id: null,
        related_snapshot_id: null,
      });
      repo.markObservationsAnalyzed(['obs-1']);
      expect(repo.getUnanalyzedObservations('compile_miss')).toHaveLength(0);

      repo.resetObservationsAnalyzed(['obs-1']);
      expect(repo.getUnanalyzedObservations('compile_miss')).toHaveLength(1);
    });
  });

  describe('markObservationsAnalyzed', () => {
    it('sets analyzed_at on specified observations', () => {
      repo.insertObservation({
        observation_id: 'obs-1',
        event_type: 'compile_miss',
        payload: '{}',
        related_compile_id: null,
        related_snapshot_id: null,
      });

      repo.markObservationsAnalyzed(['obs-1']);

      const obs = repo.getObservation('obs-1');
      expect(obs!.analyzed_at).not.toBeNull();
    });

    it('handles empty array gracefully', () => {
      expect(() => repo.markObservationsAnalyzed([])).not.toThrow();
    });
  });

  describe('rejectProposal resets analyzed_at', () => {
    it('resets analyzed_at on evidence observations', () => {
      repo.insertObservation({
        observation_id: 'obs-1',
        event_type: 'compile_miss',
        payload: '{}',
        related_compile_id: null,
        related_snapshot_id: null,
      });
      repo.markObservationsAnalyzed(['obs-1']);
      repo.insertProposal({
        proposal_id: 'p-1',
        proposal_type: 'add_edge',
        payload: '{}',
        status: 'pending',
        review_comment: null,
      });
      repo.insertProposalEvidence('p-1', 'obs-1');

      repo.rejectProposal('p-1', 'wrong edge');

      const obs = repo.getObservation('obs-1');
      expect(obs!.analyzed_at).toBeNull();
      // obs-1 is now available for re-analysis
      expect(repo.getUnanalyzedObservations('compile_miss')).toHaveLength(1);
    });
  });
});

// ============================================================
// Integration: AegisService.analyzeAndPropose
// ============================================================

describe('AegisService — analyzeAndPropose', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let adminService: AegisService;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    adminService = new AegisService(repo, TEMPLATES_ROOT);
  });

  function bootstrapKnowledge(): void {
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

  it('full flow: observe compile_miss → analyzeAndPropose → proposal in DB', async () => {
    bootstrapKnowledge();

    const { observation_id } = adminService.observe(
      {
        event_type: 'compile_miss',
        related_compile_id: 'cmp-001',
        related_snapshot_id: 'snap-001',
        payload: {
          target_files: ['app/Domain/User/UserEntity.php'],
          missing_doc: 'ddd-guide',
          review_comment: 'DDD guideline was missing for Domain files',
        },
      },
      'agent',
    );

    const analyzer = new RuleBasedAnalyzer();
    const result = await adminService.analyzeAndPropose(analyzer, 'compile_miss', 'admin');

    expect(result.analysis.drafts).toHaveLength(1);
    expect(result.proposals.created_proposal_ids).toHaveLength(1);

    const proposal = repo.getProposal(result.proposals.created_proposal_ids[0]);
    expect(proposal).toBeDefined();
    expect(proposal!.status).toBe('pending');
    expect(proposal!.proposal_type).toBe('add_edge');

    const payload = JSON.parse(proposal!.payload);
    expect(payload.source_value).toBe('app/Domain/User/**');
    expect(payload.target_doc_id).toBe('ddd-guide');

    const evidence = repo.getProposalEvidence(result.proposals.created_proposal_ids[0]);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].observation_id).toBe(observation_id);
  });

  it('analyzeAndPropose marks observations as analyzed (idempotent)', async () => {
    bootstrapKnowledge();

    adminService.observe(
      {
        event_type: 'compile_miss',
        related_compile_id: 'cmp-001',
        related_snapshot_id: 'snap-001',
        payload: {
          target_files: ['app/Domain/User/UserEntity.php'],
          missing_doc: 'ddd-guide',
          review_comment: 'missing doc',
        },
      },
      'agent',
    );

    const analyzer = new RuleBasedAnalyzer();

    const first = await adminService.analyzeAndPropose(analyzer, 'compile_miss', 'admin');
    expect(first.proposals.created_proposal_ids).toHaveLength(1);

    // Second run: observation is analyzed, so not returned
    const second = await adminService.analyzeAndPropose(analyzer, 'compile_miss', 'admin');
    expect(second.analysis.drafts).toHaveLength(0);
    expect(second.proposals.created_proposal_ids).toHaveLength(0);
  });

  it('skip/error observations are marked as analyzed (no starvation)', async () => {
    bootstrapKnowledge();

    // Observation without missing_doc → will be skipped by RuleBasedAnalyzer
    adminService.observe(
      {
        event_type: 'compile_miss',
        related_compile_id: 'cmp-001',
        related_snapshot_id: 'snap-001',
        payload: {
          target_files: ['src/a.ts'],
          review_comment: 'something was missing but idk what',
        },
      },
      'agent',
    );

    // New observation with missing_doc
    adminService.observe(
      {
        event_type: 'compile_miss',
        related_compile_id: 'cmp-002',
        related_snapshot_id: 'snap-001',
        payload: {
          target_files: ['src/b.ts'],
          missing_doc: 'ddd-guide',
          review_comment: 'missing doc',
        },
      },
      'agent',
    );

    const analyzer = new RuleBasedAnalyzer();

    // First run: processes both, skips the first, creates proposal for second
    const first = await adminService.analyzeAndPropose(analyzer, 'compile_miss', 'admin');
    expect(first.analysis.skipped_observation_ids).toHaveLength(1);
    expect(first.proposals.created_proposal_ids).toHaveLength(1);

    // Second run: both are marked as analyzed → empty
    const second = await adminService.analyzeAndPropose(analyzer, 'compile_miss', 'admin');
    expect(second.analysis.drafts).toHaveLength(0);
    expect(second.analysis.skipped_observation_ids).toHaveLength(0);
  });

  it('rejected proposal allows re-analysis end-to-end', async () => {
    bootstrapKnowledge();

    adminService.observe(
      {
        event_type: 'compile_miss',
        related_compile_id: 'cmp-001',
        related_snapshot_id: 'snap-001',
        payload: {
          target_files: ['app/Domain/User/UserEntity.php'],
          missing_doc: 'ddd-guide',
          review_comment: 'missing doc',
        },
      },
      'agent',
    );

    const analyzer = new RuleBasedAnalyzer();

    // First analysis → proposal created
    const first = await adminService.analyzeAndPropose(analyzer, 'compile_miss', 'admin');
    expect(first.proposals.created_proposal_ids).toHaveLength(1);

    // Admin rejects → analyzed_at reset on evidence observations
    adminService.rejectProposal(first.proposals.created_proposal_ids[0], 'wrong edge', 'admin');

    // Re-analysis → observation is available again, new proposal created
    const second = await adminService.analyzeAndPropose(analyzer, 'compile_miss', 'admin');
    expect(second.proposals.created_proposal_ids).toHaveLength(1);
    expect(second.proposals.created_proposal_ids[0]).not.toBe(first.proposals.created_proposal_ids[0]);
  });

  it('agent surface cannot call analyzeAndPropose', async () => {
    const analyzer = new RuleBasedAnalyzer();
    await expect(adminService.analyzeAndPropose(analyzer, 'compile_miss', 'agent')).rejects.toThrow(
      SurfaceViolationError,
    );
  });

  it('fake analyzer works for deterministic testing', async () => {
    bootstrapKnowledge();

    repo.insertObservation({
      observation_id: 'obs-fake',
      event_type: 'compile_miss',
      payload: JSON.stringify({ target_files: ['a.ts'], review_comment: 'test' }),
      related_compile_id: null,
      related_snapshot_id: null,
    });

    const fakeAnalyzer: ObservationAnalyzer = {
      analyze: async () => ({
        drafts: [
          {
            proposal_type: 'new_doc',
            payload: {
              doc_id: 'fake-doc',
              title: 'Fake',
              kind: 'guideline',
              content: 'fake',
              content_hash: hash('fake'),
            },
            evidence_observation_ids: ['obs-fake'],
          },
        ],
        skipped_observation_ids: [],
        errors: [],
      }),
    };

    const result = await adminService.analyzeAndPropose(fakeAnalyzer, 'compile_miss', 'admin');
    expect(result.proposals.created_proposal_ids).toHaveLength(1);

    const proposal = repo.getProposal(result.proposals.created_proposal_ids[0]);
    expect(proposal!.proposal_type).toBe('new_doc');
  });

  it('multiple target_files produce multiple proposals end-to-end', async () => {
    bootstrapKnowledge();

    adminService.observe(
      {
        event_type: 'compile_miss',
        related_compile_id: 'cmp-001',
        related_snapshot_id: 'snap-001',
        payload: {
          target_files: ['app/Domain/User/UserEntity.php', 'app/Domain/Order/OrderEntity.php'],
          missing_doc: 'ddd-guide',
          review_comment: 'missing DDD doc for both dirs',
        },
      },
      'agent',
    );

    const analyzer = new RuleBasedAnalyzer();
    const result = await adminService.analyzeAndPropose(analyzer, 'compile_miss', 'admin');

    expect(result.analysis.drafts).toHaveLength(2);
    expect(result.proposals.created_proposal_ids).toHaveLength(2);

    const patterns = result.proposals.created_proposal_ids
      .map((id) => {
        const p = repo.getProposal(id)!;
        return JSON.parse(p.payload).source_value;
      })
      .sort();
    expect(patterns).toEqual(['app/Domain/Order/**', 'app/Domain/User/**']);
  });

  it('partial reject: only rejected edge is re-proposed, surviving one is skipped', async () => {
    bootstrapKnowledge();

    adminService.observe(
      {
        event_type: 'compile_miss',
        related_compile_id: 'cmp-001',
        related_snapshot_id: 'snap-001',
        payload: {
          target_files: ['app/Domain/User/UserEntity.php', 'app/Domain/Order/OrderEntity.php'],
          missing_doc: 'ddd-guide',
          review_comment: 'missing DDD doc',
        },
      },
      'agent',
    );

    const analyzer = new RuleBasedAnalyzer();

    // First analysis: 2 proposals created
    const first = await adminService.analyzeAndPropose(analyzer, 'compile_miss', 'admin');
    expect(first.proposals.created_proposal_ids).toHaveLength(2);

    // Find which proposal has User pattern and reject it
    const userProposalId = first.proposals.created_proposal_ids.find((id) => {
      const p = repo.getProposal(id)!;
      return JSON.parse(p.payload).source_value === 'app/Domain/User/**';
    })!;
    adminService.rejectProposal(userProposalId, 'wrong pattern', 'admin');

    // Re-analysis: only the rejected semantic key should produce a new proposal
    const second = await adminService.analyzeAndPropose(analyzer, 'compile_miss', 'admin');
    expect(second.proposals.created_proposal_ids).toHaveLength(1);
    expect(second.proposals.skipped_duplicate_count).toBe(1);

    // Verify it's the User pattern that was re-proposed
    const reProposed = repo.getProposal(second.proposals.created_proposal_ids[0])!;
    expect(JSON.parse(reProposed.payload).source_value).toBe('app/Domain/User/**');
  });

  // ── review_correction → update_doc integration ──

  it('review_correction → analyzeAndPropose → pending update_doc proposal', async () => {
    bootstrapKnowledge();

    const { observation_id } = adminService.observe(
      {
        event_type: 'review_correction',
        payload: {
          file_path: 'app/Domain/User/UserEntity.php',
          correction: 'DDD guide needs aggregate root section',
          target_doc_id: 'ddd-guide',
          proposed_content: 'Updated DDD content with aggregate roots',
        },
      },
      'agent',
    );

    const analyzer = new ReviewCorrectionAnalyzer(repo);
    const result = await adminService.analyzeAndPropose(analyzer, 'review_correction', 'admin');

    expect(result.analysis.drafts).toHaveLength(1);
    expect(result.proposals.created_proposal_ids).toHaveLength(1);

    const proposal = repo.getProposal(result.proposals.created_proposal_ids[0]);
    expect(proposal).toBeDefined();
    expect(proposal!.status).toBe('pending');
    expect(proposal!.proposal_type).toBe('update_doc');

    const payload = JSON.parse(proposal!.payload);
    expect(payload.doc_id).toBe('ddd-guide');
    expect(payload.content).toBe('Updated DDD content with aggregate roots');
    expect(payload.content_hash).toBe(hash('Updated DDD content with aggregate roots'));

    const evidence = repo.getProposalEvidence(result.proposals.created_proposal_ids[0]);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].observation_id).toBe(observation_id);
  });

  it('review_correction reject → re-analyze produces new update_doc', async () => {
    bootstrapKnowledge();

    adminService.observe(
      {
        event_type: 'review_correction',
        payload: {
          file_path: 'app/Domain/User/UserEntity.php',
          correction: 'Fix DDD guide',
          target_doc_id: 'ddd-guide',
          proposed_content: 'First attempt content',
        },
      },
      'agent',
    );

    const analyzer = new ReviewCorrectionAnalyzer(repo);

    // First analysis → proposal
    const first = await adminService.analyzeAndPropose(analyzer, 'review_correction', 'admin');
    expect(first.proposals.created_proposal_ids).toHaveLength(1);

    // Reject → observation becomes re-analyzable
    adminService.rejectProposal(first.proposals.created_proposal_ids[0], 'incomplete fix', 'admin');

    // Re-analysis → new proposal from same observation
    const second = await adminService.analyzeAndPropose(analyzer, 'review_correction', 'admin');
    expect(second.proposals.created_proposal_ids).toHaveLength(1);
    expect(second.proposals.created_proposal_ids[0]).not.toBe(first.proposals.created_proposal_ids[0]);
  });

  it('review_correction update_doc dedup: global semantic key prevents conflicting proposals', async () => {
    bootstrapKnowledge();

    // Dedup is global: if ANY pending update_doc for the same doc_id exists,
    // a new proposal for the same doc_id is skipped regardless of observation.
    // This prevents concurrent conflicting updates to the same document.

    adminService.observe(
      {
        event_type: 'review_correction',
        payload: {
          file_path: 'src/a.ts',
          correction: 'First correction',
          target_doc_id: 'ddd-guide',
          proposed_content: 'First update',
        },
      },
      'agent',
    );

    const analyzer = new ReviewCorrectionAnalyzer(repo);
    const first = await adminService.analyzeAndPropose(analyzer, 'review_correction', 'admin');
    expect(first.proposals.created_proposal_ids).toHaveLength(1);

    // Second observation for same doc — skipped because pending proposal exists
    adminService.observe(
      {
        event_type: 'review_correction',
        payload: {
          file_path: 'src/b.ts',
          correction: 'Second correction',
          target_doc_id: 'ddd-guide',
          proposed_content: 'Second update',
        },
      },
      'agent',
    );

    const second = await adminService.analyzeAndPropose(analyzer, 'review_correction', 'admin');
    expect(second.proposals.created_proposal_ids).toHaveLength(0);
    expect(second.proposals.skipped_duplicate_count).toBe(1);
  });

  it('review_correction without target_doc_id is skipped by analyzer', async () => {
    bootstrapKnowledge();

    adminService.observe(
      {
        event_type: 'review_correction',
        payload: {
          file_path: 'src/a.ts',
          correction: 'Something needs fixing but no target specified',
        },
      },
      'agent',
    );

    const analyzer = new ReviewCorrectionAnalyzer(repo);
    const result = await adminService.analyzeAndPropose(analyzer, 'review_correction', 'admin');

    expect(result.analysis.drafts).toHaveLength(0);
    expect(result.analysis.skipped_observation_ids).toHaveLength(1);
    expect(result.proposals.created_proposal_ids).toHaveLength(0);
  });

  it('review_correction → approve → doc updated in Canonical', async () => {
    bootstrapKnowledge();

    adminService.observe(
      {
        event_type: 'review_correction',
        payload: {
          file_path: 'app/Domain/User/UserEntity.php',
          correction: 'Add aggregate root section',
          target_doc_id: 'ddd-guide',
          proposed_content: 'DDD content with aggregate roots',
        },
      },
      'agent',
    );

    const analyzer = new ReviewCorrectionAnalyzer(repo);
    const result = await adminService.analyzeAndPropose(analyzer, 'review_correction', 'admin');
    const proposalId = result.proposals.created_proposal_ids[0];

    // Approve the update_doc proposal
    const version = adminService.approveProposal(proposalId, undefined, 'admin');
    expect(version.knowledge_version).toBe(2);

    // Verify the document was updated
    const docs = repo.getApprovedDocuments();
    const updated = docs.find((d) => d.doc_id === 'ddd-guide');
    expect(updated).toBeDefined();
    expect(updated!.content).toBe('DDD content with aggregate roots');
    expect(updated!.content_hash).toBe(hash('DDD content with aggregate roots'));
  });

  it('genuinely async analyzer: delayed result flows through analyzeAndPropose', async () => {
    bootstrapKnowledge();

    repo.insertObservation({
      observation_id: 'obs-async',
      event_type: 'compile_miss',
      payload: JSON.stringify({ target_files: ['src/a.ts'], review_comment: 'test' }),
      related_compile_id: null,
      related_snapshot_id: null,
    });

    const asyncAnalyzer: ObservationAnalyzer = {
      analyze: async (contexts) => {
        // Simulate async work (e.g. SLM inference)
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          drafts: contexts.map((ctx) => ({
            proposal_type: 'add_edge' as const,
            payload: {
              source_type: 'path',
              source_value: 'src/**',
              target_doc_id: 'ddd-guide',
              edge_type: 'path_requires',
            },
            evidence_observation_ids: [ctx.observation.observation_id],
          })),
          skipped_observation_ids: [],
          errors: [],
        };
      },
    };

    const result = await adminService.analyzeAndPropose(asyncAnalyzer, 'compile_miss', 'admin');

    expect(result.analysis.drafts).toHaveLength(1);
    expect(result.proposals.created_proposal_ids).toHaveLength(1);

    const proposal = repo.getProposal(result.proposals.created_proposal_ids[0]);
    expect(proposal!.proposal_type).toBe('add_edge');
    expect(JSON.parse(proposal!.payload).source_value).toBe('src/**');
  });

  it('concurrent analyzeAndPropose: pessimistic claim prevents duplicate processing', async () => {
    bootstrapKnowledge();

    adminService.observe(
      {
        event_type: 'compile_miss',
        related_compile_id: 'cmp-001',
        related_snapshot_id: 'snap-001',
        payload: {
          target_files: ['app/Domain/User/UserEntity.php'],
          missing_doc: 'ddd-guide',
          review_comment: 'missing doc',
        },
      },
      'agent',
    );

    const slowAnalyzer: ObservationAnalyzer = {
      analyze: async (contexts) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          drafts: contexts.map((ctx) => ({
            proposal_type: 'add_edge' as const,
            payload: {
              source_type: 'path',
              source_value: 'app/Domain/User/**',
              target_doc_id: 'ddd-guide',
              edge_type: 'path_requires',
            },
            evidence_observation_ids: [ctx.observation.observation_id],
          })),
          skipped_observation_ids: [],
          errors: [],
        };
      },
    };

    // Launch two concurrent calls — only the first should see the observation
    const [first, second] = await Promise.all([
      adminService.analyzeAndPropose(slowAnalyzer, 'compile_miss', 'admin'),
      adminService.analyzeAndPropose(slowAnalyzer, 'compile_miss', 'admin'),
    ]);

    // Exactly one proposal total across both calls
    const totalProposals = first.proposals.created_proposal_ids.length + second.proposals.created_proposal_ids.length;
    expect(totalProposals).toBe(1);

    // One call got the observation, the other got empty
    const totalDrafts = first.analysis.drafts.length + second.analysis.drafts.length;
    expect(totalDrafts).toBe(1);
  });

  it('analyzer failure rolls back pessimistic claim', async () => {
    bootstrapKnowledge();

    adminService.observe(
      {
        event_type: 'compile_miss',
        related_compile_id: 'cmp-001',
        related_snapshot_id: 'snap-001',
        payload: {
          target_files: ['app/Domain/User/UserEntity.php'],
          missing_doc: 'ddd-guide',
          review_comment: 'missing doc',
        },
      },
      'agent',
    );

    const failingAnalyzer: ObservationAnalyzer = {
      analyze: async () => {
        throw new Error('SLM crashed');
      },
    };

    await expect(adminService.analyzeAndPropose(failingAnalyzer, 'compile_miss', 'admin')).rejects.toThrow(
      'SLM crashed',
    );

    // Claim was rolled back — observation is available again
    const unanalyzed = repo.getUnanalyzedObservations('compile_miss');
    expect(unanalyzed).toHaveLength(1);

    // Retry with a working analyzer succeeds
    const analyzer = new RuleBasedAnalyzer();
    const result = await adminService.analyzeAndPropose(analyzer, 'compile_miss', 'admin');
    expect(result.proposals.created_proposal_ids).toHaveLength(1);
  });

  it('propose failure rolls back pessimistic claim', async () => {
    bootstrapKnowledge();

    adminService.observe(
      {
        event_type: 'compile_miss',
        related_compile_id: 'cmp-001',
        related_snapshot_id: 'snap-001',
        payload: {
          target_files: ['app/Domain/User/UserEntity.php'],
          missing_doc: 'ddd-guide',
          review_comment: 'missing doc',
        },
      },
      'agent',
    );

    // Analyzer returns a draft with a non-existent evidence observation ID → FK violation in propose()
    const badDraftAnalyzer: ObservationAnalyzer = {
      analyze: async () => ({
        drafts: [
          {
            proposal_type: 'add_edge' as const,
            payload: {
              source_type: 'path',
              source_value: 'app/**',
              target_doc_id: 'ddd-guide',
              edge_type: 'path_requires',
            },
            evidence_observation_ids: ['obs-nonexistent'],
          },
        ],
        skipped_observation_ids: [],
        errors: [],
      }),
    };

    await expect(adminService.analyzeAndPropose(badDraftAnalyzer, 'compile_miss', 'admin')).rejects.toThrow();

    // Claim was rolled back — observation is available for retry
    const unanalyzed = repo.getUnanalyzedObservations('compile_miss');
    expect(unanalyzed).toHaveLength(1);

    // Retry with a correct analyzer succeeds
    const analyzer = new RuleBasedAnalyzer();
    const result = await adminService.analyzeAndPropose(analyzer, 'compile_miss', 'admin');
    expect(result.proposals.created_proposal_ids).toHaveLength(1);
  });
});

// ============================================================
// PrMergedAnalyzer
// ============================================================

describe('PrMergedAnalyzer', () => {
  let repo: Repository;

  beforeEach(async () => {
    const db = await createInMemoryDatabase();
    repo = new Repository(db);

    // Seed an approved root document
    repo.insertDocument({
      doc_id: 'arch-root',
      title: 'Architecture Root',
      kind: 'guideline',
      content: '# Root',
      content_hash: hash('# Root'),
      status: 'approved',
    });

    // Seed an approved path_requires edge covering src/core/**
    repo.insertEdge({
      edge_id: 'edge-core',
      source_type: 'path',
      source_value: 'src/core/**',
      target_doc_id: 'arch-root',
      edge_type: 'path_requires',
      priority: 100,
      specificity: 1,
      status: 'approved',
    });
  });

  it('skips non-pr_merged events', async () => {
    const analyzer = new PrMergedAnalyzer(repo);
    const ctx: AnalysisContext = {
      observation: makeObservation('obs-1'),
      compile_audit: null,
    };
    const result = await analyzer.analyze([ctx]);
    expect(result.skipped_observation_ids).toContain('obs-1');
    expect(result.drafts).toHaveLength(0);
  });

  it('skips when all files are covered by existing edges', async () => {
    const analyzer = new PrMergedAnalyzer(repo);
    const ctx: AnalysisContext = {
      observation: {
        ...makeObservation('obs-pr1'),
        event_type: 'pr_merged',
        payload: JSON.stringify({
          pr_id: 'PR-42',
          summary: 'Refactor core store',
          files_changed: ['src/core/store/repository.ts', 'src/core/store/schema.ts'],
        }),
      },
      compile_audit: null,
    };
    const result = await analyzer.analyze([ctx]);
    expect(result.skipped_observation_ids).toContain('obs-pr1');
    expect(result.drafts).toHaveLength(0);
  });

  it('proposes add_edge for uncovered file patterns', async () => {
    const analyzer = new PrMergedAnalyzer(repo);
    const ctx: AnalysisContext = {
      observation: {
        ...makeObservation('obs-pr2'),
        event_type: 'pr_merged',
        payload: JSON.stringify({
          pr_id: 'PR-99',
          summary: 'Add new CLI commands',
          files_changed: ['src/cli/commands/init.ts', 'src/cli/commands/status.ts'],
        }),
      },
      compile_audit: null,
    };
    const result = await analyzer.analyze([ctx]);
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0].proposal_type).toBe('add_edge');

    const payload = result.drafts[0].payload as any;
    expect(payload.source_type).toBe('path');
    expect(payload.source_value).toBe('src/cli/commands/**');
    expect(payload.target_doc_id).toBe('arch-root');
    expect(payload.edge_type).toBe('path_requires');
    expect(result.drafts[0].evidence_observation_ids).toContain('obs-pr2');
  });

  it('deduplicates directory patterns from multiple files in same dir', async () => {
    const analyzer = new PrMergedAnalyzer(repo);
    const ctx: AnalysisContext = {
      observation: {
        ...makeObservation('obs-pr3'),
        event_type: 'pr_merged',
        payload: JSON.stringify({
          pr_id: 'PR-100',
          summary: 'Add adapters',
          files_changed: [
            'src/adapters/cursor/generate.ts',
            'src/adapters/cursor/types.ts',
            'src/adapters/claude/generate.ts',
          ],
        }),
      },
      compile_audit: null,
    };
    const result = await analyzer.analyze([ctx]);
    expect(result.drafts).toHaveLength(2);
    const patterns = result.drafts.map((d) => (d.payload as any).source_value).sort();
    expect(patterns).toEqual(['src/adapters/claude/**', 'src/adapters/cursor/**']);
  });

  it('handles mix of covered and uncovered files', async () => {
    const analyzer = new PrMergedAnalyzer(repo);
    const ctx: AnalysisContext = {
      observation: {
        ...makeObservation('obs-pr4'),
        event_type: 'pr_merged',
        payload: JSON.stringify({
          pr_id: 'PR-101',
          summary: 'Mixed changes',
          files_changed: ['src/core/store/repository.ts', 'src/new-module/handler.ts'],
        }),
      },
      compile_audit: null,
    };
    const result = await analyzer.analyze([ctx]);
    expect(result.drafts).toHaveLength(1);
    expect((result.drafts[0].payload as any).source_value).toBe('src/new-module/**');
  });
});

// ============================================================
// ManualNoteAnalyzer
// ============================================================

describe('ManualNoteAnalyzer', () => {
  let repo: Repository;

  beforeEach(async () => {
    const db = await createInMemoryDatabase();
    repo = new Repository(db);

    repo.insertDocument({
      doc_id: 'test-doc',
      title: 'Test Document',
      kind: 'guideline',
      content: '# Original',
      content_hash: hash('# Original'),
      status: 'approved',
    });
  });

  it('skips non-manual_note events', async () => {
    const analyzer = new ManualNoteAnalyzer(repo);
    const ctx: AnalysisContext = {
      observation: makeObservation('obs-1'),
      compile_audit: null,
    };
    const result = await analyzer.analyze([ctx]);
    expect(result.skipped_observation_ids).toContain('obs-1');
    expect(result.drafts).toHaveLength(0);
  });

  it('skips manual_note without hints', async () => {
    const analyzer = new ManualNoteAnalyzer(repo);
    const ctx: AnalysisContext = {
      observation: {
        ...makeObservation('obs-mn1'),
        event_type: 'manual_note',
        payload: JSON.stringify({ content: 'Just a note' }),
      },
      compile_audit: null,
    };
    const result = await analyzer.analyze([ctx]);
    expect(result.skipped_observation_ids).toContain('obs-mn1');
  });

  it('produces update_doc for target_doc_id + proposed_content', async () => {
    const analyzer = new ManualNoteAnalyzer(repo);
    const ctx: AnalysisContext = {
      observation: {
        ...makeObservation('obs-mn2'),
        event_type: 'manual_note',
        payload: JSON.stringify({
          content: 'Update the test doc',
          target_doc_id: 'test-doc',
          proposed_content: '# Updated content',
        }),
      },
      compile_audit: null,
    };
    const result = await analyzer.analyze([ctx]);
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0].proposal_type).toBe('update_doc');

    const payload = result.drafts[0].payload as any;
    expect(payload.doc_id).toBe('test-doc');
    expect(payload.content).toBe('# Updated content');
    expect(typeof payload.content_hash).toBe('string');
  });

  it('skips update_doc when target doc not approved', async () => {
    const analyzer = new ManualNoteAnalyzer(repo);
    const ctx: AnalysisContext = {
      observation: {
        ...makeObservation('obs-mn3'),
        event_type: 'manual_note',
        payload: JSON.stringify({
          content: 'Update nonexistent',
          target_doc_id: 'nonexistent-doc',
          proposed_content: '# New',
        }),
      },
      compile_audit: null,
    };
    const result = await analyzer.analyze([ctx]);
    expect(result.skipped_observation_ids).toContain('obs-mn3');
  });

  it('produces new_doc for new_doc_hint', async () => {
    const analyzer = new ManualNoteAnalyzer(repo);
    const ctx: AnalysisContext = {
      observation: {
        ...makeObservation('obs-mn4'),
        event_type: 'manual_note',
        payload: JSON.stringify({
          content: '# Error Handling\n\nAlways use Result types.',
          new_doc_hint: {
            doc_id: 'error-handling-guide',
            title: 'Error Handling Guidelines',
            kind: 'guideline',
          },
        }),
      },
      compile_audit: null,
    };
    const result = await analyzer.analyze([ctx]);
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0].proposal_type).toBe('new_doc');

    const payload = result.drafts[0].payload as any;
    expect(payload.doc_id).toBe('error-handling-guide');
    expect(payload.title).toBe('Error Handling Guidelines');
    expect(payload.kind).toBe('guideline');
    expect(payload.content).toContain('Error Handling');
  });

  it('prefers update_doc over new_doc when both hints present', async () => {
    const analyzer = new ManualNoteAnalyzer(repo);
    const ctx: AnalysisContext = {
      observation: {
        ...makeObservation('obs-mn5'),
        event_type: 'manual_note',
        payload: JSON.stringify({
          content: 'Both hints',
          target_doc_id: 'test-doc',
          proposed_content: '# Updated',
          new_doc_hint: { doc_id: 'new', title: 'New', kind: 'guideline' },
        }),
      },
      compile_audit: null,
    };
    const result = await analyzer.analyze([ctx]);
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0].proposal_type).toBe('update_doc');
  });
});

// ============================================================
// DocumentImportAnalyzer
// ============================================================

describe('DocumentImportAnalyzer', () => {
  let repo: Repository;
  let analyzer: DocumentImportAnalyzer;

  beforeEach(async () => {
    const db = await createInMemoryDatabase();
    repo = new Repository(db);
    analyzer = new DocumentImportAnalyzer(repo);
  });

  function makeContext(payload: Record<string, unknown>): AnalysisContext {
    const obs: Observation = {
      observation_id: 'obs-import-1',
      event_type: 'document_import',
      payload: JSON.stringify(payload),
      related_compile_id: null,
      related_snapshot_id: null,
      created_at: new Date().toISOString(),
      archived_at: null,
      analyzed_at: null,
    };
    return { observation: obs, compile_audit: null };
  }

  it('creates new_doc draft from valid document_import', async () => {
    const ctx = makeContext({
      content: '# Hello\nWorld',
      doc_id: 'hello-world',
      title: 'Hello World',
      kind: 'guideline',
    });

    const result = await analyzer.analyze([ctx]);

    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0].proposal_type).toBe('new_doc');
    expect(result.drafts[0].payload).toMatchObject({
      doc_id: 'hello-world',
      title: 'Hello World',
      kind: 'guideline',
      content: '# Hello\nWorld',
    });
    expect(result.drafts[0].payload.content_hash).toBeTruthy();
    expect(result.drafts[0].evidence_observation_ids).toEqual(['obs-import-1']);
  });

  it('includes tags in new_doc payload', async () => {
    const ctx = makeContext({
      content: 'content',
      doc_id: 'tagged-doc',
      title: 'Tagged',
      kind: 'pattern',
      tags: ['auth', 'security'],
    });

    const result = await analyzer.analyze([ctx]);

    expect(result.drafts[0].payload.tags).toEqual(['auth', 'security']);
  });

  it('generates add_edge drafts from edge_hints', async () => {
    const ctx = makeContext({
      content: 'content',
      doc_id: 'with-edges',
      title: 'With Edges',
      kind: 'guideline',
      edge_hints: [
        { source_type: 'path', source_value: 'src/**', edge_type: 'path_requires' },
        { source_type: 'layer', source_value: 'Domain', edge_type: 'layer_requires', priority: 50 },
      ],
    });

    const result = await analyzer.analyze([ctx]);

    expect(result.drafts).toHaveLength(3);
    expect(result.drafts[0].proposal_type).toBe('new_doc');
    expect(result.drafts[1].proposal_type).toBe('add_edge');
    expect(result.drafts[1].payload).toMatchObject({
      source_type: 'path',
      source_value: 'src/**',
      target_doc_id: 'with-edges',
      edge_type: 'path_requires',
      priority: 100,
    });
    expect(result.drafts[2].payload).toMatchObject({
      source_type: 'layer',
      source_value: 'Domain',
      priority: 50,
    });
  });

  it('rejects invalid doc_id', async () => {
    const ctx = makeContext({
      content: 'content',
      doc_id: 'INVALID ID!',
      title: 'Bad',
      kind: 'guideline',
    });

    const result = await analyzer.analyze([ctx]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toContain('doc_id');
  });

  it('rejects empty content', async () => {
    const ctx = makeContext({
      content: '',
      doc_id: 'empty-doc',
      title: 'Empty',
      kind: 'guideline',
    });

    const result = await analyzer.analyze([ctx]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toContain('content');
  });

  it('rejects invalid kind', async () => {
    const ctx = makeContext({
      content: 'content',
      doc_id: 'bad-kind',
      title: 'Bad Kind',
      kind: 'invalid',
    });

    const result = await analyzer.analyze([ctx]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toContain('kind');
  });

  it('skips non-document_import events', async () => {
    const obs: Observation = {
      observation_id: 'obs-wrong',
      event_type: 'manual_note',
      payload: JSON.stringify({ content: 'note' }),
      related_compile_id: null,
      related_snapshot_id: null,
      created_at: new Date().toISOString(),
      archived_at: null,
      analyzed_at: null,
    };
    const ctx: AnalysisContext = { observation: obs, compile_audit: null };

    const result = await analyzer.analyze([ctx]);

    expect(result.skipped_observation_ids).toEqual(['obs-wrong']);
    expect(result.drafts).toHaveLength(0);
  });

  it('includes source_path in payload when provided', async () => {
    const ctx = makeContext({
      content: 'content',
      doc_id: 'sourced-doc',
      title: 'Sourced',
      kind: 'reference',
      source_path: '/path/to/original.md',
    });

    const result = await analyzer.analyze([ctx]);

    expect(result.drafts[0].payload.source_path).toBe('/path/to/original.md');
  });

  it('generates update_doc when doc_id already exists (approved)', async () => {
    repo.insertDocument({
      doc_id: 'existing-doc',
      title: 'Existing',
      kind: 'guideline',
      content: 'old content',
      content_hash: 'oldhash',
      status: 'approved',
      template_origin: null,
      source_path: null,
    });

    const ctx = makeContext({
      content: 'new content',
      doc_id: 'existing-doc',
      title: 'Existing Updated',
      kind: 'guideline',
    });

    const result = await analyzer.analyze([ctx]);

    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0].proposal_type).toBe('update_doc');
    expect(result.drafts[0].payload.doc_id).toBe('existing-doc');
    expect(result.drafts[0].payload.content).toBe('new content');
    expect(result.drafts[0].payload.title).toBe('Existing Updated');
  });

  it('generates update_doc when doc_id exists with non-approved status', async () => {
    repo.insertDocument({
      doc_id: 'deprecated-doc',
      title: 'Deprecated',
      kind: 'guideline',
      content: 'old',
      content_hash: 'h',
      status: 'deprecated',
      template_origin: null,
      source_path: null,
    });

    const ctx = makeContext({
      content: 'revived content',
      doc_id: 'deprecated-doc',
      title: 'Revived',
      kind: 'guideline',
    });

    const result = await analyzer.analyze([ctx]);

    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0].proposal_type).toBe('update_doc');
  });

  it('generates new_doc when doc_id does not exist', async () => {
    const ctx = makeContext({
      content: 'brand new',
      doc_id: 'brand-new-doc',
      title: 'Brand New',
      kind: 'pattern',
    });

    const result = await analyzer.analyze([ctx]);

    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0].proposal_type).toBe('new_doc');
  });

  it('includes tags in update_doc payload for existing doc', async () => {
    repo.insertDocument({
      doc_id: 'tagged-existing',
      title: 'Tagged',
      kind: 'guideline',
      content: 'old',
      content_hash: 'h',
      status: 'approved',
      template_origin: null,
      source_path: null,
    });

    const ctx = makeContext({
      content: 'new content',
      doc_id: 'tagged-existing',
      title: 'Tagged Updated',
      kind: 'guideline',
      tags: ['auth', 'security'],
    });

    const result = await analyzer.analyze([ctx]);

    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0].proposal_type).toBe('update_doc');
    expect(result.drafts[0].payload.tags).toEqual(['auth', 'security']);
  });
});
