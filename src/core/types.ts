/**
 * Aegis Core Type Definitions
 * Corresponds to プロジェクト計画v2.md §3, §4, §5, §6
 */

// ============================================================
// Canonical Knowledge Layer
// ============================================================

export type DocumentKind = 'guideline' | 'pattern' | 'constraint' | 'template' | 'reference';
export type EntityStatus = 'draft' | 'proposed' | 'approved' | 'deprecated';

export interface Document {
  doc_id: string;
  title: string;
  kind: DocumentKind;
  content: string;
  content_hash: string;
  status: EntityStatus;
  template_origin: string | null;
  source_path: string | null;
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
  | 'document_import';

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

export type ProposalType = 'add_edge' | 'update_doc' | 'new_doc' | 'deprecate' | 'bootstrap';
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface Proposal {
  proposal_id: string;
  proposal_type: ProposalType;
  payload: string; // JSON
  status: ProposalStatus;
  review_comment: string | null;
  created_at: string;
  resolved_at: string | null;
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
export const AUTO_INLINE_THRESHOLD_BYTES = 2048;

export type ContentMode = 'auto' | 'always' | 'metadata';

export interface CompileRequest {
  target_files: string[];
  target_layers?: string[];
  command?: string;
  plan?: string;
  /** Inline content budget in UTF-8 bytes. Default: 131,072 (128KB). */
  max_inline_bytes?: number;
  /** Content delivery mode. Phase 1 default: 'always' (full inline, existing compat). */
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

export interface CompileAuditMeta {
  delivery_stats: DeliveryStats;
  /** inline_total_bytes / max_inline_bytes (0.0–1.0) */
  budget_utilization: number;
  /** true if mandatory inline docs exceeded budget */
  budget_exceeded: boolean;
  /** doc_ids omitted by policy (e.g. non-scaffold templates) */
  policy_omitted_doc_ids: string[];
}

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
    super(
      `Mandatory inline documents exceed max_inline_bytes: ${mandatory_bytes} > ${max_inline_bytes}`,
    );
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
