/**
 * ADR-017: Project-Shared Canonical Bundle types.
 *
 * These types define the deterministic bundle format for distributing
 * approved Canonical Knowledge via repo-committed artifacts.
 */

// -- Manifest --------------------------------------------------------

export interface SharedCanonicalManifestV1 {
  format_version: 1;
  bundle_file: 'canonical.json';
  snapshot_id: string;
  knowledge_version: number;
  bundle_sha256: string;
  includes_tag_mappings: boolean;
}

// -- Bundle ----------------------------------------------------------

export interface BundleDocument {
  doc_id: string;
  title: string;
  kind: string;
  content: string;
  content_hash: string;
  ownership: string;
  template_origin: string | null;
  source_path: string | null;
  source_refs_json: string | null;
}

export interface BundleEdge {
  edge_id: string;
  source_type: string;
  source_value: string;
  target_doc_id: string;
  edge_type: string;
  priority: number;
  specificity: number;
}

export interface BundleLayerRule {
  rule_id: string;
  path_pattern: string;
  layer_name: string;
  priority: number;
  specificity: number;
}

export interface BundleTagMapping {
  tag: string;
  doc_id: string;
  confidence: number;
  source: 'slm' | 'manual';
}

export interface SharedCanonicalBundleV1 {
  format_version: 1;
  snapshot_id: string;
  knowledge_version: number;
  documents: BundleDocument[];
  edges: BundleEdge[];
  layer_rules: BundleLayerRule[];
  tag_mappings: BundleTagMapping[];
}

// -- Export result ----------------------------------------------------

export interface ShareExportResult {
  snapshot_id: string;
  knowledge_version: number;
  bundle_sha256: string;
  counts: {
    documents: number;
    edges: number;
    layer_rules: number;
    tag_mappings: number;
  };
  warnings: string[];
}
