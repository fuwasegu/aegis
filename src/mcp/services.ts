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
import { CompileMissAnalyzer } from '../core/automation/compile-miss-analyzer.js';
import { DocGapAnalyzer } from '../core/automation/doc-gap-analyzer.js';
import {
  buildDocumentImportDraftsFromPayload,
  DocumentImportAnalyzer,
  type DocumentImportObservationPayload,
} from '../core/automation/document-import-analyzer.js';
import { ManualNoteAnalyzer } from '../core/automation/manual-note-analyzer.js';
import { PrMergedAnalyzer } from '../core/automation/pr-merged-analyzer.js';
import { type ProposeResult, ProposeService } from '../core/automation/propose.js';
import { ReviewCorrectionAnalyzer } from '../core/automation/review-correction-analyzer.js';
import { StalenessAnalyzer } from '../core/automation/staleness-analyzer.js';
import type { InitPreview } from '../core/init/engine.js';
import { initConfirm as coreInitConfirm, initDetect as coreInitDetect } from '../core/init/engine.js';
import { detectUpgrade, generateUpgradeProposals, type UpgradePreview } from '../core/init/upgrade.js';
import { runCoChangeCacheJob } from '../core/optimization/co-change-cache.js';
import {
  analyzeDocumentForImportPlan,
  analyzeImportBatch,
  type BatchImportPlan,
  type ImportPlan,
  parseBatchImportPlanJson,
  parseImportPlanJson,
  splitMarkdownSections,
} from '../core/optimization/import-plan.js';
import {
  collectSemanticStalenessFindings,
  SEMANTIC_STALENESS_ALGORITHM_VERSION,
} from '../core/optimization/staleness.js';
import { normalizeSourcePath, resolveSourcePath } from '../core/paths.js';
import { ContextCompiler } from '../core/read/compiler.js';
import { listStaleFileAnchoredDocIds, SOURCE_SYNC_STALE_WARNING_DAYS } from '../core/source-sync-staleness.js';
import type { Repository } from '../core/store/repository.js';
import type { IntentTagger } from '../core/tagging/tagger.js';
import type {
  AegisStats,
  AnalysisContext,
  AnalysisResult,
  CanonicalVersion,
  CompileAuditMeta,
  CompiledContext,
  CompileRequest,
  EdgeSpec,
  ObservationEventType,
  ObserveEvent,
  ProposalBundlePreflightResult,
  ProposalDraft,
  StalenessDetectedPayload,
} from '../core/types.js';

export type Surface = 'agent' | 'admin';

/** Result of `runMaintenance` (ADR-014 maintenance CLI). */
export interface MaintenanceRunResult {
  dry_run: boolean;
  process_observations: {
    pending_by_type: Record<string, number>;
    pending_total: number;
    processed?: number;
    proposals_created?: number;
    errors?: string[];
  };
  sync_docs: {
    checked: number;
    up_to_date: number;
    proposals_created: string[];
    skipped_pending: string[];
    not_found: string[];
    /**
     * Skipped file-anchored docs: missing/blank source_path, path outside project, or resolveSourcePath failure.
     */
    skipped_invalid_anchor: string[];
    dry_run?: boolean;
    would_create_proposals?: string[];
  };
  archive_observations: {
    eligible_count: number;
    archived_count?: number;
  };
  check_upgrade: UpgradePreview | { not_found: true; template_id: string } | null;
  /** ADR-015 Task 015-08: git co-change aggregates (maintenance-built cache). */
  co_change_cache: {
    git_available: boolean;
    commits_scanned: number;
    pattern_rows: number;
    full_scan: boolean;
    skipped_reason?: string;
  };
  /** ADR-014: file-anchored docs whose source_synced_at is absent or older than threshold. */
  staleness_report: {
    threshold_days: number;
    stale_file_anchored_doc_ids: string[];
    /** ADR-015 Task 015-07: deterministic semantic staleness (Levels 1–3). */
    semantic?: {
      algorithm_version: string;
      findings: StalenessDetectedPayload[];
      baseline_writes: number;
    };
  };
}

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
 * Normalize file/slice text so import-plan compares like `analyzeDoc({ file_path })` reads vs stored slice.
 */
function normalizeImportAnchorText(s: string): string {
  return s
    .replace(/^\ufeff/u, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

/**
 * ADR-015 / ADR-010: `sync_docs` hashes **full files** against file-anchored docs. Attach `source_path`
 * only when exactly one suggested unit exists and the unit body matches the source file:
 * either full-file text (no `##` split) or a single `##` section body — same rules as `splitMarkdownSections`.
 */
function maybeImportPlanFileAnchor(
  projectRoot: string,
  repoRelNormalized: string | undefined,
  suggestedUnitCount: number,
  contentSlice: string,
): string | undefined {
  if (suggestedUnitCount !== 1) return undefined;
  if (repoRelNormalized == null || String(repoRelNormalized).trim() === '') return undefined;
  try {
    const absPath = resolveSourcePath(repoRelNormalized, projectRoot);
    if (!existsSync(absPath)) return undefined;
    const diskRaw = readFileSync(absPath, 'utf-8');
    const diskNorm = normalizeImportAnchorText(diskRaw);
    const slice = normalizeImportAnchorText(contentSlice);
    if (diskNorm === slice) {
      return repoRelNormalized;
    }
    const sections = splitMarkdownSections(diskRaw);
    if (sections.length === 1) {
      const bodyNorm = normalizeImportAnchorText(sections[0].body);
      if (bodyNorm === slice) {
        return repoRelNormalized;
      }
    }
    return undefined;
  } catch {
    return undefined;
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
    private projectRoot: string = process.cwd(),
  ) {
    this.compiler = new ContextCompiler(repo, tagger, adapterOutdated);
    this.analyzerRegistry = new Map<ObservationEventType, ObservationAnalyzer>([
      ['compile_miss', new CompileMissAnalyzer(repo)],
      ['review_correction', new ReviewCorrectionAnalyzer(repo)],
      ['pr_merged', new PrMergedAnalyzer(repo)],
      ['manual_note', new ManualNoteAnalyzer(repo)],
      ['document_import', new DocumentImportAnalyzer(repo)],
      ['doc_gap_detected', new DocGapAnalyzer()],
      ['staleness_detected', new StalenessAnalyzer()],
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
      related_compile_id: 'related_compile_id' in event ? (event.related_compile_id ?? null) : null,
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
      case 'doc_gap_detected': {
        const gapKinds = ['content_gap', 'split_candidate', 'routing_gap'];
        if (typeof p.gap_kind !== 'string' || !gapKinds.includes(p.gap_kind)) {
          throw new ObserveValidationError(`doc_gap_detected gap_kind must be one of: ${gapKinds.join(', ')}`);
        }
        if (!Array.isArray(p.scope_patterns) || !p.scope_patterns.every((x) => typeof x === 'string')) {
          throw new ObserveValidationError('doc_gap_detected scope_patterns must be an array of strings');
        }
        if (p.target_doc_id !== undefined && typeof p.target_doc_id !== 'string') {
          throw new ObserveValidationError('doc_gap_detected target_doc_id must be a string if provided');
        }
        if (
          !Array.isArray(p.evidence_observation_ids) ||
          !p.evidence_observation_ids.every((x) => typeof x === 'string')
        ) {
          throw new ObserveValidationError('doc_gap_detected evidence_observation_ids must be an array of strings');
        }
        if (!Array.isArray(p.evidence_compile_ids) || !p.evidence_compile_ids.every((x) => typeof x === 'string')) {
          throw new ObserveValidationError('doc_gap_detected evidence_compile_ids must be an array of strings');
        }
        const m = p.metrics as Record<string, unknown> | undefined;
        if (!m || typeof m !== 'object') {
          throw new ObserveValidationError('doc_gap_detected metrics is required');
        }
        for (const key of ['exposure_count', 'content_gap_count', 'distinct_clusters', 'cohort_gap_rate'] as const) {
          const v = m[key];
          if (typeof v !== 'number' || !Number.isFinite(v)) {
            throw new ObserveValidationError(`doc_gap_detected metrics.${key} must be a finite number`);
          }
        }
        const actions = ['review_doc', 'split_doc', 'create_doc'];
        if (typeof p.suggested_next_action !== 'string' || !actions.includes(p.suggested_next_action)) {
          throw new ObserveValidationError(
            `doc_gap_detected suggested_next_action must be one of: ${actions.join(', ')}`,
          );
        }
        if (typeof p.algorithm_version !== 'string' || !p.algorithm_version.trim()) {
          throw new ObserveValidationError('doc_gap_detected algorithm_version must be a non-empty string');
        }
        break;
      }
      case 'staleness_detected': {
        if (typeof p.doc_id !== 'string' || !p.doc_id) {
          throw new ObserveValidationError('staleness_detected doc_id is required');
        }
        if (p.level !== 1 && p.level !== 2 && p.level !== 3) {
          throw new ObserveValidationError('staleness_detected level must be 1, 2, or 3');
        }
        if (typeof p.kind !== 'string' || !p.kind) {
          throw new ObserveValidationError('staleness_detected kind is required');
        }
        if (typeof p.detail !== 'string' || !p.detail) {
          throw new ObserveValidationError('staleness_detected detail is required');
        }
        if (typeof p.algorithm_version !== 'string' || !p.algorithm_version.trim()) {
          throw new ObserveValidationError('staleness_detected algorithm_version is required');
        }
        if (p.paths !== undefined) {
          if (!Array.isArray(p.paths) || !p.paths.every((x) => typeof x === 'string')) {
            throw new ObserveValidationError('staleness_detected paths must be an array of strings when provided');
          }
        }
        if (p.rename_candidate_path !== undefined && typeof p.rename_candidate_path !== 'string') {
          throw new ObserveValidationError('staleness_detected rename_candidate_path must be a string when provided');
        }
        break;
      }
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

  getCompileAudit(compileId: string, _surface: Surface): ReturnType<ContextCompiler['getCompileAudit']> {
    // Agent surface: allowed (read-only audit)
    return this.compiler.getCompileAudit(compileId);
  }

  /**
   * Returns the distinct tag catalog from `tag_mappings` (approved-linked only via {@link Repository.getAllTags})
   * plus a SHA-256 hash of the canonical tag list for cache invalidation. `knowledge_version` is returned
   * separately for snapshot alignment; the hash intentionally reflects tags only.
   * Read-only on both surfaces (INV-6).
   */
  getKnownTags(_surface: Surface): { tags: string[]; knowledge_version: number; tag_catalog_hash: string } {
    const tags = this.repo.getAllTags();
    const knowledge_version = this.repo.getKnowledgeMeta().current_version;
    const tag_catalog_hash = createHash('sha256').update(JSON.stringify(tags), 'utf8').digest('hex');
    return { tags, knowledge_version, tag_catalog_hash };
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
      bundle_id: proposal.bundle_id ?? null,
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
    return this.repo.approveProposal(proposalId, modifications, this.projectRoot);
  }

  preflightProposalBundle(bundleId: string, surface: Surface): ProposalBundlePreflightResult {
    this.assertAdmin('aegis_preflight_proposal_bundle', surface);
    return this.repo.preflightProposalBundle(bundleId, this.projectRoot);
  }

  approveProposalBundle(bundleId: string, surface: Surface): CanonicalVersion {
    this.assertAdmin('aegis_approve_proposal_bundle', surface);
    return this.repo.approveProposalBundle(bundleId, this.projectRoot);
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
   * Concurrency safety: {@link Repository.claimUnanalyzedObservations} runs inside a DB
   * transaction so two processes cannot claim the same rows; claim completes BEFORE
   * the async analyzer runs. On failure, the claim is rolled back.
   */
  async analyzeAndPropose(
    analyzer: ObservationAnalyzer,
    eventType: ObservationEventType,
    surface: Surface,
  ): Promise<{ analysis: AnalysisResult; proposals: ProposeResult; claimed_count: number }> {
    this.assertAdmin('analyzeAndPropose', surface);

    const observations = this.repo.claimUnanalyzedObservations(eventType);
    const claimedIds = observations.map((o) => o.observation_id);

    if (claimedIds.length === 0) {
      return {
        analysis: { drafts: [], skipped_observation_ids: [], errors: [] },
        proposals: { created_proposal_ids: [], skipped_duplicate_count: 0 },
        claimed_count: 0,
      };
    }

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
      return { analysis, proposals, claimed_count: claimedIds.length };
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

    const { preview, projectRoot } = cached;
    const result = coreInitConfirm(this.repo, preview, previewHash, projectRoot);

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
   * ADR-014: orchestrate process_observations → sync_docs → archive_observations → check_upgrade.
   * Does not approve proposals (P-3). When `dryRun`, no Canonical mutations except read-only checks.
   */
  async runMaintenance(
    surface: Surface,
    options: { dryRun: boolean; archiveDays?: number },
  ): Promise<MaintenanceRunResult> {
    this.assertAdmin('aegis_maintenance', surface);
    const dryRun = options.dryRun;
    const archiveDays = options.archiveDays ?? 90;

    const pending_by_type: Record<string, number> = {};
    let pending_total = 0;
    for (const et of this.analyzerRegistry.keys()) {
      const n = this.repo.countUnanalyzedObservations(et);
      pending_by_type[et] = n;
      pending_total += n;
    }

    let process_observations: MaintenanceRunResult['process_observations'];
    if (dryRun) {
      process_observations = { pending_by_type, pending_total };
    } else {
      const r = await this.processObservations(undefined, surface);
      process_observations = {
        pending_by_type,
        pending_total,
        processed: r.processed,
        proposals_created: r.proposals_created,
        errors: r.errors,
      };
    }

    const sync_docs = this.syncDocs({ dryRun }, surface);

    const eligible_count = this.repo.countObservationsEligibleForArchive(archiveDays);
    let archive_observations: MaintenanceRunResult['archive_observations'];
    if (dryRun) {
      archive_observations = { eligible_count };
    } else {
      const archived_count = this.repo.archiveOldObservations(archiveDays);
      archive_observations = { eligible_count, archived_count };
    }

    const check_upgrade = this.checkUpgrade(surface);

    const co_change_cache = await runCoChangeCacheJob({
      projectRoot: this.projectRoot,
      repo: this.repo,
      dryRun,
    });

    const nowMs = Date.now();

    const semantic_scan = collectSemanticStalenessFindings({
      docs: this.repo.getApprovedDocuments(),
      edges: this.repo.getApprovedEdges(),
      projectRoot: this.projectRoot,
      getBaseline: (id) => this.repo.getStalenessBaseline(id),
      persistLevel3Baselines: !dryRun,
    });

    if (!dryRun) {
      for (const u of semantic_scan.baselineUpserts) {
        this.repo.upsertStalenessBaseline(u.doc_id, u.fingerprint_json);
      }
      for (const f of semantic_scan.findings) {
        const payloadStr = JSON.stringify(f);
        if (this.repo.hasUnarchivedObservationWithExactPayload('staleness_detected', payloadStr)) {
          continue;
        }
        this.repo.insertObservation({
          observation_id: uuidv4(),
          event_type: 'staleness_detected',
          payload: payloadStr,
          related_compile_id: null,
          related_snapshot_id: null,
        });
      }
      if (semantic_scan.findings.length > 0) {
        await this.processObservations('staleness_detected', surface);
      }
    }

    const staleness_report = {
      threshold_days: SOURCE_SYNC_STALE_WARNING_DAYS,
      stale_file_anchored_doc_ids: listStaleFileAnchoredDocIds(
        this.repo.getFileAnchoredDocuments(),
        SOURCE_SYNC_STALE_WARNING_DAYS,
        nowMs,
      ),
      semantic: {
        algorithm_version: SEMANTIC_STALENESS_ALGORITHM_VERSION,
        findings: semantic_scan.findings,
        baseline_writes: semantic_scan.baselineUpserts.length,
      },
    };

    return {
      dry_run: dryRun,
      process_observations,
      sync_docs,
      archive_observations,
      check_upgrade,
      co_change_cache,
      staleness_report,
    };
  }

  /**
   * ADR-012 / ADR-014: aggregate knowledge, compile_log usage, and health signals (admin read-only).
   * Usage aggregates scan all compile_log rows and parse JSON in-process (O(n) time/memory vs log size).
   */
  getStats(surface: Surface): AegisStats {
    this.assertAdmin('aegis_get_stats', surface);
    const meta = this.repo.getKnowledgeMeta();
    const rows = this.repo.listCompileLogStatsRows();
    const docFreq = new Map<string, number>();
    const patternFreq = new Map<string, number>();
    const targetFilesSet = new Set<string>();
    let budgetSum = 0;
    let budgetCount = 0;

    for (const row of rows) {
      try {
        const req = JSON.parse(row.request) as { target_files?: unknown };
        if (Array.isArray(req.target_files)) {
          for (const f of req.target_files) {
            if (typeof f === 'string' && f.length > 0) targetFilesSet.add(f);
          }
        }
      } catch {
        // ignore malformed request JSON
      }

      const bumpDocIds = (json: string | null): void => {
        if (json == null || json === '') return;
        try {
          const ids = JSON.parse(json) as unknown;
          if (!Array.isArray(ids)) return;
          for (const id of ids) {
            if (typeof id === 'string' && id.length > 0) {
              docFreq.set(id, (docFreq.get(id) ?? 0) + 1);
            }
          }
        } catch {
          // ignore malformed doc id JSON
        }
      };
      bumpDocIds(row.base_doc_ids);
      bumpDocIds(row.expanded_doc_ids);

      if (row.audit_meta) {
        try {
          const audit = JSON.parse(row.audit_meta) as CompileAuditMeta;
          if (typeof audit.budget_utilization === 'number' && !Number.isNaN(audit.budget_utilization)) {
            budgetSum += audit.budget_utilization;
            budgetCount += 1;
          }
          if (Array.isArray(audit.near_miss_edges)) {
            for (const nm of audit.near_miss_edges) {
              if (nm && typeof nm.pattern === 'string' && nm.pattern.length > 0) {
                patternFreq.set(nm.pattern, (patternFreq.get(nm.pattern) ?? 0) + 1);
              }
            }
          }
        } catch {
          // ignore malformed audit_meta
        }
      }
    }

    const unanalyzed_by_event_type: Record<string, number> = {};
    let unanalyzed_observations = 0;
    for (const et of this.analyzerRegistry.keys()) {
      const n = this.repo.countUnanalyzedObservations(et);
      unanalyzed_by_event_type[et] = n;
      unanalyzed_observations += n;
    }

    const nowMs = Date.now();
    const stale_file_anchored_doc_ids = listStaleFileAnchoredDocIds(
      this.repo.getFileAnchoredDocuments(),
      SOURCE_SYNC_STALE_WARNING_DAYS,
      nowMs,
    );

    return {
      knowledge: {
        approved_docs: this.repo.countApprovedDocuments(),
        approved_edges: this.repo.countApprovedEdges(),
        pending_proposals: this.repo.countPendingProposals(),
        knowledge_version: meta.current_version,
      },
      usage: {
        total_compiles: rows.length,
        unique_target_files: targetFilesSet.size,
        avg_budget_utilization: budgetCount > 0 ? budgetSum / budgetCount : null,
        most_referenced_docs: topKeyCounts(docFreq, 10).map(({ key, count }) => ({ doc_id: key, count })),
        most_missed_patterns: topKeyCounts(patternFreq, 10).map(({ key, count }) => ({ pattern: key, count })),
      },
      health: {
        stale_docs_count: stale_file_anchored_doc_ids.length,
        stale_file_anchored_doc_ids,
        unanalyzed_observations,
        unanalyzed_by_event_type,
        orphaned_tag_mappings: this.repo.countOrphanedTagMappings(),
        orphaned_tag_mapping_samples: this.repo.listOrphanedTagMappingSamples(20),
      },
    };
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
      /** Parsed observation payload (same shape as stored JSON). Admin triage: full doc_gap_detected diagnostics. */
      payload: Record<string, unknown> | null;
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
        let payload: Record<string, unknown> | null = null;
        let review_comment: string | null = null;
        let target_doc_id: string | null = null;
        let target_files: string[] | null = null;
        try {
          const parsed = JSON.parse(obs.payload) as Record<string, unknown>;
          payload = parsed;
          review_comment =
            (typeof parsed.review_comment === 'string' ? parsed.review_comment : null) ??
            (typeof parsed.gap_kind === 'string' && typeof parsed.suggested_next_action === 'string'
              ? `${parsed.gap_kind} → ${parsed.suggested_next_action}`
              : null);
          target_doc_id = typeof parsed.target_doc_id === 'string' ? parsed.target_doc_id : null;
          if (Array.isArray(parsed.target_files) && parsed.target_files.every((x) => typeof x === 'string')) {
            target_files = parsed.target_files as string[];
          }
        } catch {
          // payload parse failure — leave payload and derived fields null
        }
        return {
          observation_id: obs.observation_id,
          event_type: obs.event_type,
          outcome: obs.outcome,
          payload,
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
        payload.source_path = normalizeSourcePath(params.file_path, this.projectRoot);
      }
      delete payload.file_path;
    }

    // Normalize explicit source_path to repo-relative
    if (payload.source_path && typeof payload.source_path === 'string') {
      payload.source_path = normalizeSourcePath(payload.source_path as string, this.projectRoot);
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
   * ADR-015: deterministic import analysis (read-only). Returns an ImportPlan for review/editing before execute_import_plan.
   */
  analyzeDoc(
    params: { content?: string; file_path?: string; source_label?: string | null },
    surface: Surface,
  ): ImportPlan {
    this.assertAdmin('aegis_analyze_doc', surface);

    let body = params.content;
    let label: string | null = params.source_label ?? null;

    if (params.file_path) {
      if (!existsSync(params.file_path)) {
        throw new Error(`File not found: ${params.file_path}`);
      }
      body = readFileSync(params.file_path, 'utf-8');
      if (label == null || label === '') {
        try {
          label = normalizeSourcePath(params.file_path, this.projectRoot);
        } catch {
          label = params.file_path;
        }
      }
    }

    if (!body || typeof body !== 'string') {
      throw new Error('Either content or file_path is required');
    }

    let resolved_source_path: string | null = null;
    if (params.file_path) {
      try {
        resolved_source_path = normalizeSourcePath(params.file_path, this.projectRoot);
      } catch {
        resolved_source_path = null;
      }
    }

    return analyzeDocumentForImportPlan(this.repo, body, label, { resolved_source_path });
  }

  /**
   * ADR-015: batch import analysis — per-document ImportPlans plus cross-document overlap signals.
   */
  analyzeImportBatch(
    params: {
      items: Array<{ content?: string; file_path?: string; source_label?: string | null }>;
    },
    surface: Surface,
  ): BatchImportPlan {
    this.assertAdmin('aegis_analyze_import_batch', surface);

    if (!Array.isArray(params.items) || params.items.length === 0) {
      throw new Error('items must be a non-empty array');
    }

    const inputs: Array<{ content: string; source_label: string | null; resolved_source_path: string | null }> = [];
    for (const item of params.items) {
      let content = item.content;
      let source_label: string | null = item.source_label ?? null;
      let resolved_source_path: string | null = null;

      if (item.file_path) {
        if (!existsSync(item.file_path)) {
          throw new Error(`File not found: ${item.file_path}`);
        }
        content = readFileSync(item.file_path, 'utf-8');
        try {
          resolved_source_path = normalizeSourcePath(item.file_path, this.projectRoot);
        } catch {
          resolved_source_path = null;
        }
        if (source_label == null || source_label === '') {
          source_label = resolved_source_path ?? item.file_path;
        }
      }

      if (!content || typeof content !== 'string') {
        throw new Error('Each item requires content or file_path');
      }

      inputs.push({ content, source_label, resolved_source_path });
    }

    return analyzeImportBatch(this.repo, inputs);
  }

  /**
   * ADR-015: materialize an ImportPlan or BatchImportPlan as pending proposals sharing one bundle_id (approve via approve_proposal_bundle).
   */
  executeImportPlan(
    params: { import_plan?: unknown; batch_plan?: unknown; bundle_id?: string },
    surface: Surface,
  ): {
    bundle_id: string;
    proposal_ids: string[];
    observation_ids: string[];
    skipped_duplicate_count: number;
  } {
    this.assertAdmin('aegis_execute_import_plan', surface);

    const bundleId =
      params.bundle_id && String(params.bundle_id).trim() !== '' ? String(params.bundle_id).trim() : uuidv4();

    const unitRows: Array<{
      doc_id: string;
      title: string;
      kind: string;
      content: string;
      edge_hints: EdgeSpec[];
      tags: string[];
      source_path?: string;
    }> = [];

    if (params.import_plan != null && params.batch_plan != null) {
      throw new Error('Provide only one of import_plan or batch_plan');
    }

    if (params.import_plan != null) {
      const plan = parseImportPlanJson(this.repo, params.import_plan);
      let repoRelSourcePath: string | undefined;
      if (plan.resolved_source_path != null && String(plan.resolved_source_path).trim() !== '') {
        try {
          repoRelSourcePath = normalizeSourcePath(plan.resolved_source_path, this.projectRoot);
        } catch (e) {
          throw new Error(`Invalid resolved_source_path in import_plan: ${(e as Error).message}`);
        }
      }
      const su = plan.suggested_units;
      for (const u of su) {
        const anchorPath = maybeImportPlanFileAnchor(this.projectRoot, repoRelSourcePath, su.length, u.content_slice);
        unitRows.push({
          doc_id: u.doc_id,
          title: u.title,
          kind: u.kind,
          content: u.content_slice,
          edge_hints: u.edge_hints,
          tags: u.tags,
          ...(anchorPath ? { source_path: anchorPath } : {}),
        });
      }
    } else if (params.batch_plan != null) {
      const batch = parseBatchImportPlanJson(this.repo, params.batch_plan);
      for (const plan of batch.plans) {
        let repoRelSourcePath: string | undefined;
        if (plan.resolved_source_path != null && String(plan.resolved_source_path).trim() !== '') {
          try {
            repoRelSourcePath = normalizeSourcePath(plan.resolved_source_path, this.projectRoot);
          } catch (e) {
            throw new Error(`Invalid resolved_source_path in batch plan: ${(e as Error).message}`);
          }
        }
        const units = plan.suggested_units;
        for (const u of units) {
          const anchorPath = maybeImportPlanFileAnchor(
            this.projectRoot,
            repoRelSourcePath,
            units.length,
            u.content_slice,
          );
          unitRows.push({
            doc_id: u.doc_id,
            title: u.title,
            kind: u.kind,
            content: u.content_slice,
            edge_hints: u.edge_hints,
            tags: u.tags,
            ...(anchorPath ? { source_path: anchorPath } : {}),
          });
        }
      }
    } else {
      throw new Error('import_plan or batch_plan is required');
    }

    const seenDocIds = new Set<string>();
    for (const row of unitRows) {
      if (seenDocIds.has(row.doc_id)) {
        throw new Error(`Duplicate doc_id in import plan: '${row.doc_id}'`);
      }
      seenDocIds.add(row.doc_id);
    }

    const observationIds: string[] = [];
    const drafts: ProposalDraft[] = [];

    let outcome!: {
      bundle_id: string;
      proposal_ids: string[];
      observation_ids: string[];
      skipped_duplicate_count: number;
    };

    /** One transaction: observations + proposals + analyzed markers roll back together on failure (ADR-015 bundle all-or-nothing). */
    this.repo.runInTransaction(() => {
      observationIds.length = 0;
      drafts.length = 0;

      for (const row of unitRows) {
        const observationId = uuidv4();
        /** File-anchored docs must hash like `sync_docs` (raw `readFileSync`) — use disk bytes when anchored. */
        let effectiveContent = row.content;
        if (row.source_path) {
          try {
            const abs = resolveSourcePath(row.source_path, this.projectRoot);
            if (existsSync(abs)) {
              effectiveContent = readFileSync(abs, 'utf-8');
            }
          } catch {
            // keep row.content
          }
        }
        const payload: Record<string, unknown> = {
          content: effectiveContent,
          doc_id: row.doc_id,
          title: row.title,
          kind: row.kind,
          edge_hints: row.edge_hints,
          tags: row.tags,
        };
        if (row.source_path) {
          payload.source_path = row.source_path;
        }

        this.validateDocumentImportPayload(payload);

        this.repo.insertObservation({
          observation_id: observationId,
          event_type: 'document_import',
          payload: JSON.stringify(payload),
          related_compile_id: null,
          related_snapshot_id: null,
        });
        observationIds.push(observationId);

        const built = buildDocumentImportDraftsFromPayload(
          this.repo,
          payload as DocumentImportObservationPayload,
          observationId,
        );
        for (const d of built) {
          drafts.push({ ...d, bundle_id: bundleId });
        }
      }

      const proposeService = new ProposeService(this.repo);
      const proposals = proposeService.propose(drafts);

      if (proposals.created_proposal_ids.length === 0) {
        if (drafts.length === 0) {
          throw new Error('execute_import_plan: internal error — no proposal drafts were generated');
        }
        throw new Error(
          'execute_import_plan: every proposal duplicates an existing pending proposal (same semantic key). ' +
            'Reject or approve those proposals, then retry.',
        );
      }

      if (proposals.skipped_duplicate_count > 0) {
        throw new Error(
          'execute_import_plan: cannot create a consistent bundle — one or more drafts duplicate existing pending proposals ' +
            '(same semantic key). Resolve pending proposals or adjust the import plan so every unit is novel.',
        );
      }

      this.repo.markObservationsAnalyzed(observationIds);

      outcome = {
        bundle_id: bundleId,
        proposal_ids: proposals.created_proposal_ids,
        observation_ids: [...observationIds],
        skipped_duplicate_count: proposals.skipped_duplicate_count,
      };
    });

    return outcome;
  }

  /**
   * Synchronize approved **file-anchored** documents with repo files (ADR-010).
   * Detects stale documents via content_hash comparison and creates
   * update_doc proposals with full evidence chain (P-3 compliant).
   *
   * `skipped_invalid_anchor`: missing/blank `source_path`, path outside `projectRoot`, or `resolveSourcePath` failure.
   *
   * When `dryRun` is true, no observations or proposals are written; `would_create_proposals`
   * lists doc_ids that would receive update_doc proposals.
   */
  syncDocs(
    params: { doc_ids?: string[]; dryRun?: boolean },
    surface: Surface,
  ): {
    checked: number;
    up_to_date: number;
    proposals_created: string[];
    skipped_pending: string[];
    not_found: string[];
    skipped_invalid_anchor: string[];
    dry_run?: boolean;
    would_create_proposals?: string[];
  } {
    this.assertAdmin('aegis_sync_docs', surface);

    let docs = this.repo.getFileAnchoredDocuments();
    if (params.doc_ids && params.doc_ids.length > 0) {
      const filterSet = new Set(params.doc_ids);
      docs = docs.filter((d) => filterSet.has(d.doc_id));
    }

    const up_to_date_ids: string[] = [];
    const not_found: string[] = [];
    const skipped_pending: string[] = [];
    const skipped_invalid_anchor: string[] = [];
    const would_create_proposals: string[] = [];

    const observationIds: string[] = [];
    const drafts: Array<{ draft: import('../core/types.js').ProposalDraft; obsId: string }> = [];

    for (const doc of docs) {
      if (doc.source_path == null || String(doc.source_path).trim() === '') {
        skipped_invalid_anchor.push(doc.doc_id);
        continue;
      }
      let absPath: string;
      try {
        absPath = resolveSourcePath(doc.source_path, this.projectRoot);
      } catch {
        skipped_invalid_anchor.push(doc.doc_id);
        continue;
      }
      if (!existsSync(absPath)) {
        not_found.push(doc.doc_id);
        continue;
      }

      const fileContent = readFileSync(absPath, 'utf-8');
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

      if (params.dryRun) {
        would_create_proposals.push(doc.doc_id);
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

    if (params.dryRun) {
      return {
        checked: docs.length,
        up_to_date: up_to_date_ids.length,
        proposals_created: [],
        skipped_pending,
        not_found,
        skipped_invalid_anchor,
        dry_run: true,
        would_create_proposals,
      };
    }

    if (up_to_date_ids.length > 0) {
      this.repo.touchDocumentsSourceSyncedAt(up_to_date_ids);
    }

    if (drafts.length === 0) {
      return {
        checked: docs.length,
        up_to_date: up_to_date_ids.length,
        proposals_created: [],
        skipped_pending,
        not_found,
        skipped_invalid_anchor,
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
        skipped_invalid_anchor,
      };
    } catch (err) {
      this.repo.resetObservationsAnalyzed(observationIds);
      throw err;
    }
  }

  /**
   * Process pending observations by running the analyzer registry.
   * Per ADR-003 D-2: admin-only explicit operation.
   *
   * Drains the queue in batches of 50 (same as {@link Repository.getUnanalyzedObservations} default).
   * `processed` counts observations completed without analyzer-level failure (excludes
   * `analysis.errors` entries; skipped rule-based items are not counted as processed).
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

      // Process in batches of 50 (claimUnanalyzedObservations default limit) until queue is empty.
      while (true) {
        try {
          const { analysis, proposals, claimed_count } = await this.analyzeAndPropose(analyzer, et, surface);
          if (claimed_count === 0) break;
          totalProcessed += claimed_count - analysis.skipped_observation_ids.length - analysis.errors.length;
          totalCreated += proposals.created_proposal_ids.length;
          for (const err of analysis.errors) {
            allErrors.push(`[${et}] ${err.observation_id}: ${err.reason}`);
          }
        } catch (e) {
          allErrors.push(`[${et}] Pipeline error: ${e instanceof Error ? e.message : String(e)}`);
          break;
        }
      }

      if (et === 'compile_miss' && analyzer instanceof CompileMissAnalyzer) {
        try {
          await analyzer.runDocRefactorPass();
        } catch (e) {
          allErrors.push(`[${et}] DocRefactor pass: ${e instanceof Error ? e.message : String(e)}`);
        }
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
        getKnownTags: 'aegis_get_known_tags',
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
        case 'retarget_edge':
          return `Retarget edge: ${payload.edge_id}`;
        case 'remove_edge':
          return `Remove edge: ${payload.edge_id}`;
        case 'deprecate': {
          const suffix =
            typeof payload.replaced_by_doc_id === 'string' && payload.replaced_by_doc_id.trim() !== ''
              ? ` → replaced by ${payload.replaced_by_doc_id.trim()}`
              : '';
          return `Deprecate: ${payload.entity_type} ${payload.entity_id}${suffix}`;
        }
        default:
          return proposalType;
      }
    } catch {
      return proposalType;
    }
  }
}

function topKeyCounts(freq: Map<string, number>, limit: number): Array<{ key: string; count: number }> {
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}
