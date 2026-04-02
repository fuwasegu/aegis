import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { type AegisDatabase, createInMemoryDatabase, Repository } from '../store/index.js';
import type { AnalysisContext, Observation } from '../types.js';
import { RuleBasedAnalyzer } from './rule-analyzer.js';

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

  it('compile_miss with target_doc_id (no missing_doc) does not emit update_doc (ADR-008 D-2)', async () => {
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
    expect(result.drafts.filter((d) => d.proposal_type === 'update_doc')).toHaveLength(0);
    expect(result.skipped_observation_ids).toEqual(['obs-gap-1']);
  });

  it('compile_miss with target_doc_id but doc not approved → skip', async () => {
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
