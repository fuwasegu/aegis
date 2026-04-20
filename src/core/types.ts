/**
 * Aegis Core Type Definitions
 * Corresponds to プロジェクト計画v2.md §3, §4, §5, §6
 */

// ============================================================
// Canonical Knowledge Layer
// ============================================================

export type DocumentKind = 'guideline' | 'pattern' | 'constraint' | 'template' | 'reference';
export type EntityStatus = 'draft' | 'proposed' | 'approved' | 'deprecated';
export type DocOwnership = 'file-anchored' | 'standalone' | 'derived';

export interface Document {
  doc_id: string;
  title: string;
  kind: DocumentKind;
  content: string;
  content_hash: string;
  status: EntityStatus;
  ownership: DocOwnership;
  template_origin: string | null;
  source_path: string | null;
  /**
   * ADR-014: last time the on-disk `source_path` file was verified to match Canonical `content_hash`
   * (sync_docs hash match, or new_doc approve with `projectRoot` + same-hash re-read).
   * Not updated by arbitrary `update_doc` approve — use sync_docs to refresh.
   */
  source_synced_at: string | null;
  /**
   * ADR-014: when `status` is `deprecated`, optional approved document that supersedes this one
   * (set when approving a `deprecate` proposal with `replaced_by_doc_id`).
   */
  replaced_by_doc_id?: string | null;
  created_at: string;
  updated_at: string;
}

export type EdgeSourceType = 'path' | 'layer' | 'command' | 'doc';
export type EdgeType = 'path_requires' | 'layer_requires' | 'command_requires' | 'doc_depends_on';

export interface Edge {
  edge_id: string;
  source_type: EdgeSourceType;
  source_value: string;
  target_doc_id: string;
  edge_type: EdgeType;
  priority: number;
  specificity: number;
  status: EntityStatus;
  created_at: string;
}

export interface LayerRule {
  rule_id: string;
  path_pattern: string;
  layer_name: string;
  priority: number;
  specificity: number;
  status: EntityStatus;
  created_at: string;
}

// ============================================================
// Observation Layer
// ============================================================

export type ObservationEventType =
  | 'compile_miss'
  | 'review_correction'
  | 'pr_merged'
  | 'manual_note'
  | 'document_import'
  | 'doc_gap_detected'
  | 'staleness_detected';

/** ADR-015 §3 — persisted contract for `doc_gap_detected` (optimization layer input). */
export type DocGapKind = 'content_gap' | 'split_candidate' | 'routing_gap';

export type DocGapSuggestedNextAction = 'review_doc' | 'split_doc' | 'create_doc';

export interface DocGapMetrics {
  exposure_count: number;
  content_gap_count: number;
  distinct_clusters: number;
  cohort_gap_rate: number;
}

/** Payload for doc_gap_detected (ADR-015): diagnostic record for content gaps / split candidates / routing. */
export interface DocGapPayload {
  gap_kind: DocGapKind;
  target_doc_id?: string;
  /** Normalized directory globs (ADR-015). */
  scope_patterns: string[];
  evidence_observation_ids: string[];
  evidence_compile_ids: string[];
  metrics: DocGapMetrics;
  suggested_next_action: DocGapSuggestedNextAction;
  /** Reproducibility / invalidation (e.g. threshold changes). */
  algorithm_version: string;
}

/** ADR-015 Task 015-07: deterministic semantic staleness (Levels 1–3). */
export interface StalenessDetectedPayload {
  doc_id: string;
  level: 1 | 2 | 3;
  /** e.g. hash_mismatch | source_missing | rename_candidate | symbol_drift | linked_file_removed */
  kind: string;
  detail: string;
  algorithm_version: string;
  paths?: string[];
  rename_candidate_path?: string;
}

export interface Observation {
  observation_id: string;
  event_type: ObservationEventType;
  payload: string; // JSON
  related_compile_id: string | null;
  related_snapshot_id: string | null;
  created_at: string;
  archived_at: string | null;
  analyzed_at: string | null;
}

// ============================================================
// Proposal Layer
// ============================================================

export type ProposalType =
  | 'add_edge'
  | 'retarget_edge'
  | 'remove_edge'
  | 'update_doc'
  | 'new_doc'
  | 'deprecate'
  | 'bootstrap';
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface Proposal {
  proposal_id: string;
  proposal_type: ProposalType;
  payload: string; // JSON
  status: ProposalStatus;
  review_comment: string | null;
  /** ADR-015: groups proposals for `preflightProposalBundle` / `approveProposalBundle` (all-or-nothing). */
  bundle_id?: string | null;
  created_at: string;
  resolved_at: string | null;
}

/** One row per proposal in `preflightProposalBundle` (leaf validation). */
export interface ProposalBundlePreflightLeaf {
  proposal_id: string;
  proposal_type: ProposalType;
  ok: boolean;
  error?: string;
  /** True when earlier leaf failed or ordering failed before this proposal could run. */
  skipped?: boolean;
}

/** Result of validating every proposal in a bundle (dry-run; DB unchanged). */
export interface ProposalBundlePreflightResult {
  bundle_id: string;
  /** Topological apply order used by approve and preflight (empty when ordering fails). */
  ordered_proposal_ids: string[];
  leaves: ProposalBundlePreflightLeaf[];
  ok: boolean;
  /** Set when proposals cannot be ordered (dependency / cycle); every leaf lists this reason. */
  ordering_error?: string;
}

// ============================================================
// Snapshot / Audit Layer
// ============================================================

export interface Snapshot {
  snapshot_id: string;
  knowledge_version: number;
  created_at: string;
}

export interface SnapshotDoc {
  snapshot_id: string;
  doc_id: string;
  content_hash: string;
}

export interface SnapshotEdge {
  snapshot_id: string;
  edge_id: string;
  source_type: EdgeSourceType;
  source_value: string;
  target_doc_id: string;
  edge_type: EdgeType;
  priority: number;
  specificity: number;
}

export interface SnapshotLayerRule {
  snapshot_id: string;
  rule_id: string;
  path_pattern: string;
  layer_name: string;
  priority: number;
  specificity: number;
}

export interface CompileLog {
  compile_id: string;
  snapshot_id: string;
  request: string; // JSON
  base_doc_ids: string; // JSON
  expanded_doc_ids: string | null; // JSON
  audit_meta: string | null; // JSON: CompileAuditMeta | null
  created_at: string;
}

export interface KnowledgeMeta {
  id: 1;
  current_version: number;
  last_updated_at: string;
}

// ============================================================
// Init Manifest
// ============================================================

export interface InitManifest {
  id: 1;
  template_id: string;
  template_version: string;
  preview_hash: string;
  stack_detection: string; // JSON
  selected_profile: string;
  placeholders: string; // JSON
  initial_snapshot_id: string;
  seed_counts: string; // JSON
  created_at: string;
}

// ============================================================
// Read API Types (§3) — v2: delivery-aware (ADR-009)
// ============================================================

/** Default inline content budget in UTF-8 bytes (128KB). */
export const DEFAULT_MAX_INLINE_BYTES = 131_072;

/** In auto mode, source_path docs smaller than this are inlined. */
export const AUTO_INLINE_THRESHOLD_BYTES = 4096;

export type ContentMode = 'auto' | 'always' | 'metadata';

export interface CompileRequest {
  target_files: string[];
  target_layers?: string[];
  command?: string;
  plan?: string;
  /**
   * Agent-supplied intent tags for expanded context. When this property is present (including `[]`),
   * the SLM tagger is never invoked.
   * - `undefined`: if `plan` is set and a tagger is configured, tags are inferred via SLM (backward compatible).
   * - `[]`: explicit opt-out — no `expanded` section.
   * - Non-empty: values are trimmed, empty strings dropped, deduped, sorted; tags not present in
   *   `tag_mappings` are omitted with warnings. `compile_log.request` stores this array as received (raw).
   */
  intent_tags?: string[];
  /** Inline content budget in UTF-8 bytes. Default: 131,072 (128KB). */
  max_inline_bytes?: number;
  /** Content delivery mode. Default: 'auto' (source_path docs deferred, small docs inline). */
  content_mode?: ContentMode;
}

export type DeliveryType = 'inline' | 'deferred' | 'omitted';

export interface ResolvedDoc {
  doc_id: string;
  title: string;
  kind: DocumentKind;

  /** Delivery state (ADR-009 D-1). */
  delivery: DeliveryType;
  /** Full content. Present only when delivery === 'inline'. */
  content?: string;
  /** Repo-relative path. Present when stored in DB, regardless of delivery. */
  source_path?: string;
  /** UTF-8 byte length of content. Always present (for Read decision). */
  content_bytes: number;
  /** SHA-256 content hash. Always present (for consistency verification). */
  content_hash: string;
  /** Reason when delivery === 'omitted'. */
  omit_reason?: string;

  /** Deterministic relevance score (0–1) based on plan keyword matching. Present only when plan is provided. */
  relevance?: number;
}

export interface ResolvedEdge {
  edge_id: string;
  source_type: EdgeSourceType;
  source_value: string;
  target_doc_id: string;
  edge_type: EdgeType;
}

// ============================================================
// Compile Audit Meta (ADR-009 D-13)
// ============================================================

export interface DeliveryStats {
  inline_count: number;
  inline_total_bytes: number;
  deferred_count: number;
  deferred_total_bytes: number;
  omitted_count: number;
  omitted_total_bytes: number;
}

export interface BudgetDroppedDoc {
  doc_id: string;
  bytes: number;
  reason: string;
}

export type NearMissReason = 'glob_no_match' | 'layer_mismatch' | 'command_mismatch';

export interface NearMissEdgeAudit {
  edge_id: string;
  pattern: string;
  target_doc_id: string;
  reason: NearMissReason;
}

export interface CompilePerformanceMeta {
  near_miss_edge_scan_ms: number;
  near_miss_edges_evaluated: number;
}

/** ADR-011: structured audit for intent-tag expanded context (agent explicit tags vs SLM). */
export interface ExpandedTaggingAudit {
  tags_source: 'agent' | 'slm' | null;
  /** As provided: `intent_tags` from the client or tag strings from SLM output order (before trim/dedupe/sort). */
  requested_tags: string[];
  accepted_tags: string[];
  ignored_unknown_count: number;
  /** Distinct expanded documents matched via tag_mappings after base/template overlap exclusion. */
  matched_doc_count: number;
}

export interface CompileAuditMeta {
  delivery_stats: DeliveryStats;
  /** inline_total_bytes / max_inline_bytes (0.0–1.0) */
  budget_utilization: number;
  /** true if mandatory inline docs exceeded budget */
  budget_exceeded: boolean;
  /** docs that lost inline delivery because the inline budget filled up */
  budget_dropped: BudgetDroppedDoc[];
  /** edges that were evaluated during routing but did not match */
  near_miss_edges: NearMissEdgeAudit[];
  /** per-target-file inferred layer (or null when unmatched) */
  layer_classification: Record<string, string | null>;
  /** doc_ids omitted by policy (e.g. non-scaffold templates) */
  policy_omitted_doc_ids: string[];
  /** observed overhead of the near-miss collection pass */
  performance: CompilePerformanceMeta;
  /** ADR-011 intent tagging summary; set by ContextCompiler before persisting compile_log. */
  expanded_tagging?: ExpandedTaggingAudit;
}

/** ADR-012 Phase 2 — read-only observability snapshot for `aegis_get_stats` and stats/doctor CLI. */
export interface AegisStats {
  knowledge: {
    approved_docs: number;
    approved_edges: number;
    pending_proposals: number;
    knowledge_version: number;
  };
  usage: {
    total_compiles: number;
    unique_target_files: number;
    /** Mean of persisted `audit_meta.budget_utilization`; null when no rows contribute a numeric value. */
    avg_budget_utilization: number | null;
    most_referenced_docs: Array<{ doc_id: string; count: number }>;
    most_missed_patterns: Array<{ pattern: string; count: number }>;
  };
  health: {
    stale_docs_count: number;
    stale_file_anchored_doc_ids: string[];
    unanalyzed_observations: number;
    unanalyzed_by_event_type: Record<string, number>;
    orphaned_tag_mappings: number;
    orphaned_tag_mapping_samples: Array<{ tag: string; doc_id: string }>;
  };
}

/**
 * Subset of {@link CompileAuditMeta} on the live compile_context response (ADR-012 Phase 2).
 * `Pick` keeps shapes aligned with persisted `audit_meta`. Informational only (P-1).
 */
export type CompileDebugInfo = Pick<CompileAuditMeta, 'near_miss_edges' | 'layer_classification' | 'budget_dropped'>;

export interface CompiledContext {
  schema_version: 2;
  compile_id: string;
  snapshot_id: string;
  knowledge_version: number;
  base: {
    documents: ResolvedDoc[];
    resolution_path: ResolvedEdge[];
    templates: ResolvedDoc[];
  };
  expanded?: {
    documents: ResolvedDoc[];
    confidence: number;
    reasoning: string;
    resolution_path: ResolvedEdge[];
  };
  warnings: string[];
  /** Operational notices (P-1 excluded): may vary by server runtime state, not recorded in compile_log */
  notices: string[];
  /** Mirrors audit_meta diagnostics; omitted when compile aborts before audit (e.g. empty snapshot). */
  debug_info?: CompileDebugInfo;
}

/** Alias for {@link CompiledContext} (`aegis_compile_context` のレスポンス根). */
export type CompileResult = CompiledContext;

/**
 * Thrown when mandatory inline documents (no source_path) exceed max_inline_bytes.
 * Caught by server.ts and converted to MCP isError: true response.
 */
export class BudgetExceededError extends Error {
  constructor(
    public readonly compile_id: string,
    public readonly mandatory_bytes: number,
    public readonly max_inline_bytes: number,
    /** Offending doc_ids sorted by content_bytes descending. */
    public readonly offending_doc_ids: string[],
  ) {
    super(`Mandatory inline documents exceed max_inline_bytes: ${mandatory_bytes} > ${max_inline_bytes}`);
    this.name = 'BudgetExceededError';
  }
}

// ============================================================
// Write API Types (§4)
// ============================================================

export interface EdgeSpec {
  source_type: EdgeSourceType;
  source_value: string;
  edge_type: EdgeType;
  priority?: number;
}

export type ObserveEvent =
  | {
      event_type: 'compile_miss';
      related_compile_id: string;
      related_snapshot_id: string;
      payload: {
        target_files: string[];
        missing_doc?: string;
        target_doc_id?: string;
        review_comment: string;
      };
    }
  | {
      event_type: 'review_correction';
      related_snapshot_id?: string;
      payload: {
        file_path: string;
        correction: string;
        target_doc_id?: string;
        proposed_content?: string;
      };
    }
  | {
      event_type: 'pr_merged';
      payload: {
        pr_id: string;
        summary: string;
        files_changed: string[];
      };
    }
  | {
      event_type: 'manual_note';
      payload: {
        content: string;
        target_doc_id?: string;
        proposed_content?: string;
        new_doc_hint?: {
          doc_id: string;
          title: string;
          kind: DocumentKind;
        };
      };
    }
  | {
      event_type: 'document_import';
      payload: {
        content: string;
        doc_id: string;
        title: string;
        kind: DocumentKind;
        edge_hints?: EdgeSpec[];
        tags?: string[];
        source_path?: string;
      };
    }
  | {
      event_type: 'doc_gap_detected';
      related_compile_id?: string | null;
      related_snapshot_id?: string | null;
      payload: DocGapPayload;
    }
  | {
      event_type: 'staleness_detected';
      payload: StalenessDetectedPayload;
    };

export interface CanonicalVersion {
  knowledge_version: number;
  snapshot_id: string;
}

// ============================================================
// Automation Layer
// ============================================================

export interface ProposalDraft {
  proposal_type: ProposalType;
  payload: Record<string, unknown>;
  evidence_observation_ids: string[];
  /** ADR-015 import-plan / bundles: when set, proposals are grouped for approveProposalBundle. */
  bundle_id?: string | null;
}

export interface AnalysisContext {
  observation: Observation;
  compile_audit: {
    compile_id: string;
    snapshot_id: string;
    knowledge_version: number;
    request: CompileRequest;
    base_doc_ids: string[];
  } | null;
}

export interface AnalysisResult {
  drafts: ProposalDraft[];
  skipped_observation_ids: string[];
  errors: Array<{ observation_id: string; reason: string }>;
}

// ============================================================
// Tag Mappings Layer (outside Canonical DAG)
// ============================================================

export interface IntentTag {
  tag: string;
  confidence: number;
  reasoning?: string;
}

export interface TagMapping {
  tag: string;
  doc_id: string;
  confidence: number;
  source: 'slm' | 'manual';
  created_at: string;
}

/** Sentinel content for update_doc proposals where human must provide content via modifications. */
export const PENDING_CONTENT_PLACEHOLDER = '(content pending — provide via modifications when approving)';

export interface ExpandedContextCandidate {
  doc_id: string;
  matched_tags: string[];
  aggregate_confidence: number;
  reasoning: string;
}
