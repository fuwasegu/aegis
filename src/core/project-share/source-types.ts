/**
 * ADR-018: Collaborative Shared Source types.
 *
 * Defines the directory contract and parsed representations for
 * `aegis-share/source/` — the human-editable authoring source layer.
 */

import type { DocOwnership, DocumentKind, EdgeSourceType, EdgeType } from '../types.js';

// -- Directory contract -----------------------------------------------

/**
 * Well-known edge filenames under `edges/`.
 * The filename → source_type mapping is deterministic (D-4).
 */
export const EDGE_FILE_SOURCE_TYPE: Record<string, EdgeSourceType> = {
  'path-requires.json': 'path',
  'layer-requires.json': 'layer',
  'command-requires.json': 'command',
  'doc-depends-on.json': 'doc',
};

/** Filename → edge_type mapping (mirrors source_type but as EdgeType). */
export const EDGE_FILE_EDGE_TYPE: Record<string, EdgeType> = {
  'path-requires.json': 'path_requires',
  'layer-requires.json': 'layer_requires',
  'command-requires.json': 'command_requires',
  'doc-depends-on.json': 'doc_depends_on',
};

/** All recognized top-level entries within `source/`. */
export const RECOGNIZED_TOP_LEVEL = new Set(['documents', 'edges', 'layer-rules.json', 'tag-mappings.json']);

/** All recognized filenames within `edges/`. */
export const RECOGNIZED_EDGE_FILES = new Set(Object.keys(EDGE_FILE_SOURCE_TYPE));

// -- Parsed document --------------------------------------------------

/** Frontmatter fields required in every `documents/<doc_id>.md`. */
export interface SourceDocumentFrontmatter {
  doc_id: string;
  title: string;
  kind: DocumentKind;
  ownership: DocOwnership;
  source_path?: string | null;
  source_refs_json?: string | null;
  template_origin?: string | null;
}

/**
 * A parsed document from `documents/<doc_id>.md`.
 * `content_hash` is intentionally absent — materialize computes it.
 */
export interface SourceDocument {
  doc_id: string;
  title: string;
  kind: DocumentKind;
  ownership: DocOwnership;
  source_path: string | null;
  source_refs_json: string | null;
  template_origin: string | null;
  content: string;
}

// -- Parsed edge ------------------------------------------------------

/** A single edge entry within an edge JSON file. */
export interface SourceEdge {
  edge_id: string;
  source_type: EdgeSourceType;
  source_value: string;
  target_doc_id: string;
  edge_type: EdgeType;
  priority: number;
  specificity: number;
}

// -- Parsed layer rule ------------------------------------------------

export interface SourceLayerRule {
  rule_id: string;
  path_pattern: string;
  layer_name: string;
  priority: number;
  specificity: number;
}

// -- Parsed tag mapping -----------------------------------------------

export interface SourceTagMapping {
  tag: string;
  doc_id: string;
  confidence: number;
  source: 'slm' | 'manual';
}

// -- Parse errors -----------------------------------------------------

export interface SourceParseError {
  /** Relative file path within `source/` (e.g. `documents/foo.md`). */
  file: string;
  /** Machine-readable logical location within the file (e.g. `frontmatter.kind`, `[3].priority`, `$` for file-level). */
  location: string;
  /** Human-readable description of the error. */
  message: string;
}

// -- Full parse result ------------------------------------------------

export interface SharedSourceParseResult {
  documents: SourceDocument[];
  edges: SourceEdge[];
  layer_rules: SourceLayerRule[];
  tag_mappings: SourceTagMapping[];
  errors: SourceParseError[];
}
