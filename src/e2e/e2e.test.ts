/**
 * E2E Integration Tests
 *
 * Tests the full flow through AegisService without MCP transport:
 * init → compile_context → observe → analyzeAndPropose → approve
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ManualNoteAnalyzer } from '../core/automation/manual-note-analyzer.js';
import { PrMergedAnalyzer } from '../core/automation/pr-merged-analyzer.js';
import { ReviewCorrectionAnalyzer } from '../core/automation/review-correction-analyzer.js';
import { RuleBasedAnalyzer } from '../core/automation/rule-analyzer.js';
import { createInMemoryDatabase } from '../core/store/database.js';
import { Repository } from '../core/store/repository.js';
import type { IntentTagger } from '../core/tagging/tagger.js';
import type { IntentTag } from '../core/types.js';
import { AegisService } from '../mcp/services.js';

const TEMPLATES_ROOT = join(import.meta.dirname, '../../templates');

function makeTmpProject(): string {
  const dir = join(import.meta.dirname, '../../.tmp-test', randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
}

class FakeTagger implements IntentTagger {
  async extractTags(_plan: string, _knownTags: string[]): Promise<IntentTag[]> {
    return [{ tag: 'state_mutation', confidence: 0.9 }];
  }
}

describe('E2E: Full Lifecycle', () => {
  let repo: Repository;
  let adminService: AegisService;
  let agentService: AegisService;
  let tmpDir: string;

  beforeEach(async () => {
    const db = await createInMemoryDatabase();
    repo = new Repository(db);
    const tagger = new FakeTagger();
    adminService = new AegisService(repo, TEMPLATES_ROOT, tagger);
    agentService = new AegisService(repo, TEMPLATES_ROOT, tagger);

    tmpDir = makeTmpProject();

    // Create a Laravel-like project for detection
    writeFileSync(
      join(tmpDir, 'composer.json'),
      JSON.stringify({
        require: { 'laravel/framework': '^11.0' },
      }),
    );
    mkdirSync(join(tmpDir, 'app/Domain'), { recursive: true });
    mkdirSync(join(tmpDir, 'app/UseCases'), { recursive: true });
  });

  it('full lifecycle: init → compile → observe → analyze → approve', async () => {
    // ── Step 1: Admin detects project ──
    const preview = adminService.initDetect(tmpDir, 'admin');
    expect(preview.template_id).toBe('laravel-ddd');
    expect(preview.has_blocking_warnings).toBe(false);
    expect(preview.generated.documents.length).toBeGreaterThan(0);

    // ── Step 2: Admin confirms init ──
    const initResult = adminService.initConfirm(preview.preview_hash, 'admin');
    expect(initResult.knowledge_version).toBe(1);
    expect(initResult.snapshot_id).toBeTruthy();

    // ── Step 3: Agent compiles context for a domain file ──
    const compiled = await agentService.compileContext(
      {
        target_files: ['app/Domain/User/UserEntity.php'],
      },
      'agent',
    );

    expect(compiled.knowledge_version).toBe(1);
    expect(compiled.base.documents.length).toBeGreaterThan(0);
    expect(compiled.compile_id).toBeTruthy();
    expect(compiled.snapshot_id).toBeTruthy();

    // Verify resolution path includes path_requires edges
    const pathEdges = compiled.base.resolution_path.filter((e) => e.edge_type === 'path_requires');
    expect(pathEdges.length).toBeGreaterThan(0);

    // ── Step 4: Agent reports a compile miss ──
    const observation = agentService.observe(
      {
        event_type: 'compile_miss',
        related_compile_id: compiled.compile_id,
        related_snapshot_id: compiled.snapshot_id,
        payload: {
          target_files: ['app/Domain/User/UserEntity.php'],
          missing_doc: 'laravel-ddd-entity',
          review_comment: 'Entity guidelines were not specific enough',
        },
      },
      'agent',
    );
    expect(observation.observation_id).toBeTruthy();

    // ── Step 5: Admin runs automation ──
    const analyzer = new RuleBasedAnalyzer();
    const analysis = await adminService.analyzeAndPropose(analyzer, 'compile_miss', 'admin');
    expect(analysis.proposals.created_proposal_ids.length).toBeGreaterThan(0);

    // ── Step 6: Admin reviews and approves ──
    const proposalList = adminService.listProposals({ status: 'pending' }, 'admin');
    expect(proposalList.proposals.length).toBeGreaterThan(0);

    for (const p of proposalList.proposals as any[]) {
      const approved = adminService.approveProposal(p.proposal_id, undefined, 'admin');
      expect(approved.knowledge_version).toBeGreaterThan(1);
    }

    // ── Step 7: Verify audit trail ──
    const audit = agentService.getCompileAudit(compiled.compile_id, 'agent');
    expect(audit).toBeDefined();
    expect(audit!.base_doc_ids.length).toBeGreaterThan(0);
  });

  it('review_correction lifecycle: observe → analyze → approve → doc updated', async () => {
    // Init project
    const preview = adminService.initDetect(tmpDir, 'admin');
    adminService.initConfirm(preview.preview_hash, 'admin');

    // Find the first approved doc
    const docs = repo.getApprovedDocuments();
    const targetDoc = docs[0];

    // Agent observes a correction
    const _obs = agentService.observe(
      {
        event_type: 'review_correction',
        payload: {
          file_path: 'app/Domain/User/UserEntity.php',
          correction: 'Entity should use factory methods',
          target_doc_id: targetDoc.doc_id,
          proposed_content: '# Updated Entity Guidelines\n\nUse factory methods.',
        },
      },
      'agent',
    );

    // Admin runs analyzer
    const analyzer = new ReviewCorrectionAnalyzer(repo);
    const result = await adminService.analyzeAndPropose(analyzer, 'review_correction', 'admin');
    expect(result.proposals.created_proposal_ids.length).toBe(1);

    // Approve
    const proposalId = result.proposals.created_proposal_ids[0];
    const approved = adminService.approveProposal(proposalId, undefined, 'admin');
    expect(approved.knowledge_version).toBeGreaterThan(1);

    // Verify document was updated
    const updatedDocs = repo.getApprovedDocumentsByIds([targetDoc.doc_id]);
    expect(updatedDocs[0].content).toContain('factory methods');
  });

  it('pr_merged lifecycle: observe → analyze → proposes edges for uncovered paths', async () => {
    // Init project
    const preview = adminService.initDetect(tmpDir, 'admin');
    adminService.initConfirm(preview.preview_hash, 'admin');

    // Agent observes a PR merge with files in an uncovered directory
    agentService.observe(
      {
        event_type: 'pr_merged',
        payload: {
          pr_id: 'PR-42',
          summary: 'Add new API controller',
          files_changed: ['app/Http/Controllers/ApiController.php', 'app/Http/Controllers/AuthController.php'],
        },
      },
      'agent',
    );

    // Admin runs pr_merged analyzer
    const analyzer = new PrMergedAnalyzer(repo);
    const result = await adminService.analyzeAndPropose(analyzer, 'pr_merged', 'admin');

    // Should propose edge(s) for uncovered paths
    expect(result.proposals.created_proposal_ids.length).toBeGreaterThanOrEqual(1);
  });

  it('manual_note new_doc lifecycle: observe → analyze → approve → new doc in canonical', async () => {
    // Init project
    const preview = adminService.initDetect(tmpDir, 'admin');
    adminService.initConfirm(preview.preview_hash, 'admin');

    // Agent observes a manual note with new_doc_hint
    agentService.observe(
      {
        event_type: 'manual_note',
        payload: {
          content: '# Error Handling\n\nAll domain operations should return Result types.',
          new_doc_hint: {
            doc_id: 'error-handling-guide',
            title: 'Error Handling Guidelines',
            kind: 'guideline',
          },
        },
      },
      'agent',
    );

    // Admin runs manual_note analyzer
    const analyzer = new ManualNoteAnalyzer(repo);
    const result = await adminService.analyzeAndPropose(analyzer, 'manual_note', 'admin');
    expect(result.proposals.created_proposal_ids.length).toBe(1);

    // Approve the new doc proposal
    const proposalId = result.proposals.created_proposal_ids[0];
    adminService.approveProposal(proposalId, undefined, 'admin');

    // Verify new document exists in canonical
    const docs = repo.getApprovedDocumentsByIds(['error-handling-guide']);
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe('Error Handling Guidelines');
    expect(docs[0].content).toContain('Error Handling');
  });

  it('agent can call init_detect but not init_confirm', () => {
    const preview = agentService.initDetect(tmpDir, 'agent');
    expect(preview.template_id).toBe('laravel-ddd');

    expect(() => agentService.initConfirm(preview.preview_hash, 'agent')).toThrow('not available');
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });
});
