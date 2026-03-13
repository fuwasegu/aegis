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
// Read API Types (§3)
// ============================================================

export interface CompileRequest {
  target_files: string[];
  target_layers?: string[];
  command?: string;
  plan?: string;
}

export interface ResolvedDoc {
  doc_id: string;
  title: string;
  kind: DocumentKind;
  content: string;
}

export interface ResolvedEdge {
  edge_id: string;
  source_type: EdgeSourceType;
  source_value: string;
  target_doc_id: string;
  edge_type: EdgeType;
}

export interface CompiledContext {
  compile_id: string;
  snapshot_id: string;
  knowledge_version: number;
  base: {
    documents: ResolvedDoc[];
    resolution_path: ResolvedEdge[];
    templates: { name: string; content: string }[];
  };
  expanded?: {
    documents: ResolvedDoc[];
    confidence: number;
    reasoning: string;
    resolution_path: ResolvedEdge[];
  };
  warnings: string[];
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

export interface ExpandedContextCandidate {
  doc_id: string;
  matched_tags: string[];
  aggregate_confidence: number;
  reasoning: string;
}
