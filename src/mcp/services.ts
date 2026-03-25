/**
 * MCP Service Facade
 * Thin layer between MCP tool handlers and core logic.
 * Enforces INV-6: Agent Surface cannot modify Canonical.
 *
 * No business logic lives here — only delegation and surface authorization.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { deployClaudeAdapter } from '../adapters/claude/generate.js';
import { deployCodexAdapter } from '../adapters/codex/generate.js';
import { deployCursorAdapter } from '../adapters/cursor/generate.js';
import { deploySkills } from '../adapters/skills.js';
import type { AdapterConfig, AdapterResult } from '../adapters/types.js';
import type { ObservationAnalyzer } from '../core/automation/analyzer.js';
import { DocumentImportAnalyzer } from '../core/automation/document-import-analyzer.js';
import { ManualNoteAnalyzer } from '../core/automation/manual-note-analyzer.js';
import { PrMergedAnalyzer } from '../core/automation/pr-merged-analyzer.js';
import { type ProposeResult, ProposeService } from '../core/automation/propose.js';
import { ReviewCorrectionAnalyzer } from '../core/automation/review-correction-analyzer.js';
import { RuleBasedAnalyzer } from '../core/automation/rule-analyzer.js';
import type { InitPreview } from '../core/init/engine.js';
import { initConfirm as coreInitConfirm, initDetect as coreInitDetect } from '../core/init/engine.js';
import { detectUpgrade, generateUpgradeProposals, type UpgradePreview } from '../core/init/upgrade.js';
import { ContextCompiler } from '../core/read/compiler.js';
import type { Repository } from '../core/store/repository.js';
import type { IntentTagger } from '../core/tagging/tagger.js';
import type {
  AnalysisContext,
  AnalysisResult,
  CanonicalVersion,
  CompiledContext,
  CompileRequest,
  EdgeSpec,
  ObservationEventType,
  ObserveEvent,
} from '../core/types.js';

export type Surface = 'agent' | 'admin';

export class SurfaceViolationError extends Error {
  constructor(tool: string, surface: Surface) {
    super(`Tool '${tool}' is not available on the '${surface}' surface`);
    this.name = 'SurfaceViolationError';
  }
}

export class ObserveValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObserveValidationError';
  }
}

/**
 * Aegis MCP Service — the single entry point for all MCP tool handlers.
 */
export class AegisService {
  private compiler: ContextCompiler;
  private previewCache = new Map<string, { preview: InitPreview; projectRoot: string }>();
  private analyzerRegistry: Map<ObservationEventType, ObservationAnalyzer>;

  constructor(
    private repo: Repository,
    private templatesRoot: string,
    tagger: IntentTagger | null = null,
    private extraTemplateDirs: string[] = [],
    adapterOutdated = false,
  ) {
    this.compiler = new ContextCompiler(repo, tagger, adapterOutdated);
    this.analyzerRegistry = new Map<ObservationEventType, ObservationAnalyzer>([
      ['compile_miss', new RuleBasedAnalyzer(repo)],
      ['review_correction', new ReviewCorrectionAnalyzer(repo)],
      ['pr_merged', new PrMergedAnalyzer(repo)],
      ['manual_note', new ManualNoteAnalyzer(repo)],
      ['document_import', new DocumentImportAnalyzer(repo)],
    ]);
  }

  // ============================================================
  // Agent Surface
  // ============================================================

  async compileContext(request: CompileRequest, _surface: Surface): Promise<CompiledContext> {
    // Agent surface: allowed
    return this.compiler.compile(request);
  }

  observe(event: ObserveEvent, _surface: Surface): { observation_id: string } {
    // Agent surface: allowed (writes to Observation only, not Canonical)

    // Enforce discriminated-union contract at service boundary
    this.validateObserveEvent(event);

    const observationId = uuidv4();
    this.repo.insertObservation({
      observation_id: observationId,
      event_type: event.event_type,
      payload: JSON.stringify(event.payload),
      related_compile_id: 'related_compile_id' in event ? event.related_compile_id : null,
      related_snapshot_id: 'related_snapshot_id' in event ? (event.related_snapshot_id ?? null) : null,
    });
    return { observation_id: observationId };
  }

  private validateObserveEvent(event: ObserveEvent): void {
    const p = event.payload as Record<string, unknown>;

    switch (event.event_type) {
      case 'compile_miss':
        if (!('related_compile_id' in event) || !event.related_compile_id) {
          throw new ObserveValidationError('compile_miss requires related_compile_id');
        }
        if (!('related_snapshot_id' in event) || !event.related_snapshot_id) {
          throw new ObserveValidationError('compile_miss requires related_snapshot_id');
        }
        if (!Array.isArray(p.target_files) || p.target_files.length === 0) {
          throw new ObserveValidationError('compile_miss payload requires non-empty target_files');
        }
        if (typeof p.review_comment !== 'string' || !p.review_comment) {
          throw new ObserveValidationError('compile_miss payload requires review_comment');
        }
        if (p.target_doc_id !== undefined && typeof p.target_doc_id !== 'string') {
          throw new ObserveValidationError('compile_miss payload target_doc_id must be a string if provided');
        }
        break;
      case 'review_correction':
        if (typeof p.file_path !== 'string' || !p.file_path) {
          throw new ObserveValidationError('review_correction payload requires file_path');
        }
        if (typeof p.correction !== 'string' || !p.correction) {
          throw new ObserveValidationError('review_correction payload requires correction');
        }
        // If either target_doc_id or proposed_content is present, require both
        {
          const hasDocId = 'target_doc_id' in p && p.target_doc_id !== undefined;
          const hasContent = 'proposed_content' in p && p.proposed_content !== undefined;
          if (hasDocId || hasContent) {
            if (!hasDocId || typeof p.target_doc_id !== 'string' || !p.target_doc_id) {
              throw new ObserveValidationError(
                'review_correction: target_doc_id required when proposed_content is provided',
              );
            }
            if (!hasContent || typeof p.proposed_content !== 'string' || !p.proposed_content) {
              throw new ObserveValidationError(
                'review_correction: proposed_content required when target_doc_id is provided',
              );
            }
          }
        }
        break;
      case 'pr_merged':
        if (typeof p.pr_id !== 'string' || !p.pr_id) {
          throw new ObserveValidationError('pr_merged payload requires pr_id');
        }
        if (typeof p.summary !== 'string' || !p.summary) {
          throw new ObserveValidationError('pr_merged payload requires summary');
        }
        if (!Array.isArray(p.files_changed) || p.files_changed.length === 0) {
          throw new ObserveValidationError('pr_merged payload requires non-empty files_changed');
        }
        break;
      case 'manual_note':
        if (typeof p.content !== 'string' || !p.content) {
          throw new ObserveValidationError('manual_note payload requires content');
        }
        {
          const hasDocId = 'target_doc_id' in p && p.target_doc_id !== undefined;
          const hasContent = 'proposed_content' in p && p.proposed_content !== undefined;
          if (hasDocId || hasContent) {
            if (!hasDocId || typeof p.target_doc_id !== 'string' || !p.target_doc_id) {
              throw new ObserveValidationError('manual_note: target_doc_id required when proposed_content is provided');
            }
            if (!hasContent || typeof p.proposed_content !== 'string' || !p.proposed_content) {
              throw new ObserveValidationError('manual_note: proposed_content required when target_doc_id is provided');
            }
          }
          if ('new_doc_hint' in p && p.new_doc_hint !== undefined) {
            const hint = p.new_doc_hint as Record<string, unknown>;
            if (typeof hint.doc_id !== 'string' || !hint.doc_id) {
              throw new ObserveValidationError('manual_note: new_doc_hint.doc_id is required');
            }
            if (typeof hint.title !== 'string' || !hint.title) {
              throw new ObserveValidationError('manual_note: new_doc_hint.title is required');
            }
            const validKinds = ['guideline', 'pattern', 'constraint', 'template', 'reference'];
            if (hint.kind === undefined || typeof hint.kind !== 'string' || !validKinds.includes(hint.kind)) {
              throw new ObserveValidationError(
                `manual_note: new_doc_hint.kind is required and must be one of: ${validKinds.join(', ')}`,
              );
            }
          }
        }
        break;
      case 'document_import':
        this.validateDocumentImportPayload(p);
        break;
    }
  }

  private validateDocumentImportPayload(p: Record<string, unknown>): void {
    if (typeof p.content !== 'string' || !p.content) {
      throw new ObserveValidationError('document_import: content is required');
    }
    if (typeof p.doc_id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(p.doc_id)) {
      throw new ObserveValidationError('document_import: doc_id must match /^[a-z0-9][a-z0-9_-]*$/');
    }
    if (typeof p.title !== 'string' || !p.title) {
      throw new ObserveValidationError('document_import: title is required');
    }
    const validKinds = ['guideline', 'pattern', 'constraint', 'template', 'reference'];
    if (typeof p.kind !== 'string' || !validKinds.includes(p.kind)) {
      throw new ObserveValidationError(`document_import: kind must be one of ${validKinds.join(', ')}`);
    }
  }

  getCompileAudit(
    compileId: string,
    _surface: Surface,
  ):
    | {
        compile_id: string;
        snapshot_id: string;
        knowledge_version: number;
        request: object;
        base_doc_ids: string[];
        expanded_doc_ids: string[] | null;
        created_at: string;
      }
    | undefined {
    // Agent surface: allowed (read-only audit)
    return this.compiler.getCompileAudit(compileId);
  }

  initDetect(projectRoot: string, _surface: Surface, options?: { skip_template?: boolean }): InitPreview {
    const preview = coreInitDetect(projectRoot, this.templatesRoot, this.extraTemplateDirs, options);
    if (preview.preview_hash) {
      this.previewCache.set(preview.preview_hash, { preview, projectRoot });
    }
    return preview;
  }

  // ============================================================
  // Admin Surface
  // ============================================================

  listProposals(
    params: { status?: string; limit?: number; offset?: number },
    surface: Surface,
  ): { proposals: object[]; total: number } {
    this.assertAdmin('aegis_list_proposals', surface);
    const { proposals, total } = this.repo.listProposals(params.status as any, params.limit ?? 20, params.offset ?? 0);
    return {
      proposals: proposals.map((p) => ({
        proposal_id: p.proposal_id,
        proposal_type: p.proposal_type,
        status: p.status,
        created_at: p.created_at,
        summary: this.summarizePayload(p.proposal_type, p.payload),
      })),
      total,
    };
  }

  getProposal(proposalId: string, surface: Surface): object | undefined {
    this.assertAdmin('aegis_get_proposal', surface);
    const proposal = this.repo.getProposal(proposalId);
    if (!proposal) return undefined;

    const evidence = this.repo.getProposalEvidence(proposalId);
    return {
      proposal_id: proposal.proposal_id,
      proposal_type: proposal.proposal_type,
      payload: JSON.parse(proposal.payload),
      status: proposal.status,
      review_comment: proposal.review_comment,
      created_at: proposal.created_at,
      resolved_at: proposal.resolved_at,
      evidence: evidence.map((e) => ({
        observation_id: e.observation_id,
        event_type: e.event_type,
        payload: JSON.parse(e.payload),
        created_at: e.created_at,
      })),
    };
  }

  approveProposal(
    proposalId: string,
    modifications: Record<string, unknown> | undefined,
    surface: Surface,
  ): CanonicalVersion {
    this.assertAdmin('aegis_approve_proposal', surface);
    return this.repo.approveProposal(proposalId, modifications);
  }

  rejectProposal(proposalId: string, reason: string, surface: Surface): { proposal_id: string; status: 'rejected' } {
    this.assertAdmin('aegis_reject_proposal', surface);
    this.repo.rejectProposal(proposalId, reason);
    return { proposal_id: proposalId, status: 'rejected' };
  }

  /**
   * Internal automation pipeline — NOT exposed via MCP.
   * Fetches unanalyzed observations, runs analyzer, persists proposals.
   *
   * Concurrency safety: observations are claimed (marked analyzed) BEFORE
   * the async analyzer runs, preventing a concurrent call from picking up
   * the same observations. On failure, the claim is rolled back.
   */
  async analyzeAndPropose(
    analyzer: ObservationAnalyzer,
    eventType: 'compile_miss' | 'review_correction' | 'pr_merged' | 'manual_note' | 'document_import',
    surface: Surface,
  ): Promise<{ analysis: AnalysisResult; proposals: ProposeResult }> {
    this.assertAdmin('analyzeAndPropose', surface);

    const observations = this.repo.getUnanalyzedObservations(eventType);
    const claimedIds = observations.map((o) => o.observation_id);

    // Pessimistic claim: mark as analyzed before yielding to async analyzer
    this.repo.markObservationsAnalyzed(claimedIds);

    const contexts: AnalysisContext[] = observations.map((obs) => {
      const audit = obs.related_compile_id ? this.compiler.getCompileAudit(obs.related_compile_id) : null;

      return {
        observation: obs,
        compile_audit: audit
          ? {
              compile_id: audit.compile_id,
              snapshot_id: audit.snapshot_id,
              knowledge_version: audit.knowledge_version,
              request: audit.request as CompileRequest,
              base_doc_ids: audit.base_doc_ids,
            }
          : null,
      };
    });

    try {
      const analysis = await analyzer.analyze(contexts);
      const proposeService = new ProposeService(this.repo);
      const proposals = proposeService.propose(analysis.drafts);
      return { analysis, proposals };
    } catch (err) {
      // Rollback claim so observations are available for retry
      this.repo.resetObservationsAnalyzed(claimedIds);
      throw err;
    }
  }

  initConfirm(previewHash: string, surface: Surface): CanonicalVersion {
    this.assertAdmin('aegis_init_confirm', surface);

    const cached = this.previewCache.get(previewHash);
    if (!cached) {
      throw new Error(`No cached preview found for hash '${previewHash.slice(0, 12)}...'. Run init_detect first.`);
    }

    const { preview } = cached;
    const result = coreInitConfirm(this.repo, preview, previewHash);

    this.previewCache.delete(previewHash);

    return result;
  }

  checkUpgrade(surface: Surface): UpgradePreview | { not_found: true; template_id: string } | null {
    this.assertAdmin('aegis_check_upgrade', surface);
    const result = detectUpgrade(this.repo, this.templatesRoot, this.extraTemplateDirs);
    if (result) return result;

    const manifest = this.repo.getInitManifest();
    if (!manifest) return null;
    if (manifest.template_id === 'none') {
      return { not_found: true, template_id: 'none' };
    }
    return { not_found: true, template_id: manifest.template_id };
  }

  applyUpgrade(surface: Surface): { proposal_ids: string[] } {
    this.assertAdmin('aegis_apply_upgrade', surface);
    const preview = detectUpgrade(this.repo, this.templatesRoot, this.extraTemplateDirs);
    if (!preview || !preview.has_changes) {
      return { proposal_ids: [] };
    }

    const drafts = generateUpgradeProposals(preview, this.repo, this.templatesRoot, this.extraTemplateDirs);
    const proposeService = new ProposeService(this.repo);
    const result = proposeService.propose(drafts);
    return { proposal_ids: result.created_proposal_ids };
  }

  archiveObservations(days: number, surface: Surface): { archived_count: number } {
    this.assertAdmin('aegis_archive_observations', surface);
    const archived_count = this.repo.archiveOldObservations(days);
    return { archived_count };
  }

  /**
   * List observations with outcome-based filtering.
   * Per ADR-008: outcome is derived from proposal_evidence JOIN, not analyzed_at alone.
   */
  listObservations(
    params: {
      event_type?: ObservationEventType;
      outcome?: 'proposed' | 'skipped' | 'pending';
      limit?: number;
      offset?: number;
    },
    surface: Surface,
  ): {
    observations: Array<{
      observation_id: string;
      event_type: string;
      outcome: 'proposed' | 'skipped' | 'pending';
      review_comment: string | null;
      target_doc_id: string | null;
      target_files: string[] | null;
      related_compile_id: string | null;
      related_snapshot_id: string | null;
      created_at: string;
      analyzed_at: string | null;
    }>;
    total: number;
  } {
    this.assertAdmin('aegis_list_observations', surface);

    const result = this.repo.listObservations(
      { event_type: params.event_type, outcome: params.outcome },
      params.limit ?? 20,
      params.offset ?? 0,
    );

    return {
      observations: result.observations.map((obs) => {
        let review_comment: string | null = null;
        let target_doc_id: string | null = null;
        let target_files: string[] | null = null;
        try {
          const payload = JSON.parse(obs.payload);
          review_comment = payload.review_comment ?? null;
          target_doc_id = payload.target_doc_id ?? null;
          if (Array.isArray(payload.target_files)) {
            target_files = payload.target_files;
          }
        } catch {
          // payload parse failure — leave as null
        }
        return {
          observation_id: obs.observation_id,
          event_type: obs.event_type,
          outcome: obs.outcome,
          review_comment,
          target_doc_id,
          target_files,
          related_compile_id: obs.related_compile_id,
          related_snapshot_id: obs.related_snapshot_id,
          created_at: obs.created_at,
          analyzed_at: obs.analyzed_at,
        };
      }),
      total: result.total,
    };
  }

  /**
   * Import a document via the Observation → Analyzer → Proposal pipeline.
   * Per ADR-002: admin-only wrapper that internally does observe + analyzeAndPropose.
   */
  async importDoc(
    params: {
      content?: string;
      file_path?: string;
      doc_id: string;
      title: string;
      kind: string;
      edge_hints?: EdgeSpec[];
      tags?: string[];
      source_path?: string;
    },
    surface: Surface,
  ): Promise<{
    proposal_ids: string[];
    observation_id: string;
    warnings: string[];
  }> {
    this.assertAdmin('aegis_import_doc', surface);

    const payload: Record<string, unknown> = { ...params };

    if (params.file_path) {
      if (!existsSync(params.file_path)) {
        throw new Error(`File not found: ${params.file_path}`);
      }
      payload.content = readFileSync(params.file_path, 'utf-8');
      if (!params.source_path) {
        payload.source_path = params.file_path;
      }
      delete payload.file_path;
    }

    if (!payload.content && !params.file_path) {
      throw new Error('Either content or file_path is required');
    }

    this.validateDocumentImportPayload(payload);

    const observationId = uuidv4();
    this.repo.insertObservation({
      observation_id: observationId,
      event_type: 'document_import',
      payload: JSON.stringify(payload),
      related_compile_id: null,
      related_snapshot_id: null,
    });

    const analyzer = this.analyzerRegistry.get('document_import')!;
    const { proposals } = await this.analyzeAndPropose(analyzer, 'document_import', surface);

    const warnings: string[] = [];
    if (!params.edge_hints?.length && !params.tags?.length) {
      warnings.push(
        'Imported document has no edge_hints or tags — it will be isolated in the DAG until edges are added.',
      );
    }

    return {
      proposal_ids: proposals.created_proposal_ids,
      observation_id: observationId,
      warnings,
    };
  }

  /**
   * Synchronize documents that have a source_path with their source files.
   * Detects stale documents via content_hash comparison and creates
   * update_doc proposals with full evidence chain (P-3 compliant).
   */
  syncDocs(
    params: { doc_ids?: string[] },
    surface: Surface,
  ): {
    checked: number;
    up_to_date: number;
    proposals_created: string[];
    skipped_pending: string[];
    not_found: string[];
  } {
    this.assertAdmin('aegis_sync_docs', surface);

    let docs = this.repo.getDocumentsWithSourcePath();
    if (params.doc_ids && params.doc_ids.length > 0) {
      const filterSet = new Set(params.doc_ids);
      docs = docs.filter((d) => filterSet.has(d.doc_id));
    }

    const up_to_date_ids: string[] = [];
    const not_found: string[] = [];
    const skipped_pending: string[] = [];

    const observationIds: string[] = [];
    const drafts: Array<{ draft: import('../core/types.js').ProposalDraft; obsId: string }> = [];

    for (const doc of docs) {
      if (!existsSync(doc.source_path!)) {
        not_found.push(doc.doc_id);
        continue;
      }

      const fileContent = readFileSync(doc.source_path!, 'utf-8');
      const fileHash = createHash('sha256').update(fileContent).digest('hex');

      if (fileHash === doc.content_hash) {
        up_to_date_ids.push(doc.doc_id);
        continue;
      }

      const pendingUpdateDocs = this.repo.getPendingProposalsByType('update_doc');
      const hasPending = pendingUpdateDocs.some((p) => {
        const pl = JSON.parse(p.payload) as Record<string, unknown>;
        return pl.doc_id === doc.doc_id;
      });
      if (hasPending) {
        skipped_pending.push(doc.doc_id);
        continue;
      }

      const obsId = uuidv4();
      this.repo.insertObservation({
        observation_id: obsId,
        event_type: 'document_import',
        payload: JSON.stringify({
          doc_id: doc.doc_id,
          title: doc.title,
          kind: doc.kind,
          content: fileContent,
          source_path: doc.source_path,
        }),
        related_compile_id: null,
        related_snapshot_id: null,
      });
      observationIds.push(obsId);

      drafts.push({
        obsId,
        draft: {
          proposal_type: 'update_doc',
          payload: {
            doc_id: doc.doc_id,
            content: fileContent,
            content_hash: fileHash,
            source_path: doc.source_path,
          },
          evidence_observation_ids: [obsId],
        },
      });
    }

    if (drafts.length === 0) {
      return {
        checked: docs.length,
        up_to_date: up_to_date_ids.length,
        proposals_created: [],
        skipped_pending,
        not_found,
      };
    }

    this.repo.markObservationsAnalyzed(observationIds);

    try {
      const proposeService = new ProposeService(this.repo);
      const result = proposeService.propose(drafts.map((d) => d.draft));

      if (result.skipped_duplicate_count > 0) {
        const linkedObsIds = new Set<string>();
        for (const proposalId of result.created_proposal_ids) {
          const evidence = this.repo.getProposalEvidence(proposalId);
          for (const e of evidence) {
            linkedObsIds.add(e.observation_id);
          }
        }
        const orphanObsIds = observationIds.filter((id) => !linkedObsIds.has(id));
        if (orphanObsIds.length > 0) {
          this.repo.resetObservationsAnalyzed(orphanObsIds);
        }
      }

      return {
        checked: docs.length,
        up_to_date: up_to_date_ids.length,
        proposals_created: result.created_proposal_ids,
        skipped_pending,
        not_found,
      };
    } catch (err) {
      this.repo.resetObservationsAnalyzed(observationIds);
      throw err;
    }
  }

  /**
   * Process pending observations by running the analyzer registry.
   * Per ADR-003 D-2: admin-only explicit operation.
   */
  async processObservations(
    eventType: ObservationEventType | undefined,
    surface: Surface,
  ): Promise<{
    processed: number;
    proposals_created: number;
    errors: string[];
  }> {
    this.assertAdmin('aegis_process_observations', surface);

    const typesToProcess = eventType ? [eventType] : [...this.analyzerRegistry.keys()];

    let totalProcessed = 0;
    let totalCreated = 0;
    const allErrors: string[] = [];

    for (const et of typesToProcess) {
      const analyzer = this.analyzerRegistry.get(et);
      if (!analyzer) continue;

      const unanalyzed = this.repo.getUnanalyzedObservations(et);
      if (unanalyzed.length === 0) continue;

      try {
        const { analysis, proposals } = await this.analyzeAndPropose(analyzer, et, surface);
        totalProcessed += unanalyzed.length - analysis.skipped_observation_ids.length;
        totalCreated += proposals.created_proposal_ids.length;
        for (const err of analysis.errors) {
          allErrors.push(`[${et}] ${err.observation_id}: ${err.reason}`);
        }
      } catch (e) {
        allErrors.push(`[${et}] Pipeline error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return {
      processed: totalProcessed,
      proposals_created: totalCreated,
      errors: allErrors,
    };
  }

  /**
   * Per ADR-007: adapter deployment is provided via CLI, not MCP tool.
   * Called from the `deploy-adapters` CLI subcommand.
   */
  deployAdapters(projectRoot: string, targets?: string[]): AdapterResult[] {
    const manifest = this.repo.getInitManifest();
    const templateId = manifest?.template_id ?? 'unknown';

    const config: AdapterConfig = {
      projectRoot,
      templateId,
      toolNames: {
        compileContext: 'aegis_compile_context',
        observe: 'aegis_observe',
        getCompileAudit: 'aegis_get_compile_audit',
      },
    };

    const validTargets = targets ?? ['cursor', 'claude', 'codex'];
    const results: AdapterResult[] = [];

    for (const target of validTargets) {
      try {
        if (target === 'cursor') {
          results.push(deployCursorAdapter(config));
        } else if (target === 'claude') {
          results.push(deployClaudeAdapter(config));
        } else if (target === 'codex') {
          results.push(deployCodexAdapter(config));
        }
        results.push(...deploySkills(projectRoot, target));
      } catch (e) {
        results.push({
          filePath: target,
          status: 'failed',
          content: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return results;
  }

  // ============================================================
  // Private
  // ============================================================

  private assertAdmin(tool: string, surface: Surface): void {
    if (surface !== 'admin') {
      throw new SurfaceViolationError(tool, surface);
    }
  }

  private summarizePayload(proposalType: string, payloadJson: string): string {
    try {
      const payload = JSON.parse(payloadJson);
      switch (proposalType) {
        case 'bootstrap':
          return `Bootstrap: ${payload.documents?.length ?? 0} docs, ${payload.edges?.length ?? 0} edges, ${payload.layer_rules?.length ?? 0} rules`;
        case 'new_doc':
          return `New doc: ${payload.title ?? payload.doc_id}`;
        case 'update_doc':
          return `Update doc: ${payload.doc_id}`;
        case 'add_edge':
          return `Add edge: ${payload.source_value} → ${payload.target_doc_id}`;
        case 'deprecate':
          return `Deprecate: ${payload.entity_type} ${payload.entity_id}`;
        default:
          return proposalType;
      }
    } catch {
      return proposalType;
    }
  }
}
