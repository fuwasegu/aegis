/**
 * ADR-018 Task 018-02: share-lint — validate shared source before materialize.
 *
 * Runs {@link parseSharedSource} then applies cross-reference checks:
 * - duplicate doc_id / edge_id / rule_id
 * - edges referencing non-existent target_doc_id
 * - tag_mappings referencing non-existent doc_id
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { parseSharedSource } from './source-parser.js';
import type { SharedSourceParseResult, SourceParseError } from './source-types.js';

// -- Result type -------------------------------------------------------

export interface ShareLintResult {
  /** true when zero errors were found. */
  ok: boolean;
  /** All errors (parse + cross-reference). */
  errors: SourceParseError[];
  /** Counts of successfully parsed entities. */
  counts: {
    documents: number;
    edges: number;
    layer_rules: number;
    tag_mappings: number;
  };
}

// -- Public API --------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * Pre-scan `documents/` to extract doc_ids from all .md frontmatters.
 * Returns a map: doc_id → list of filenames that declare that doc_id.
 * This catches duplicates even when the parser rejects files for filename mismatch.
 */
function scanDocIds(sourceDir: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const docsDir = join(sourceDir, 'documents');
  if (!existsSync(docsDir)) return result;
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(docsDir);
  } catch {
    return result;
  }
  if (!stat.isDirectory()) return result;

  let files: string[];
  try {
    files = readdirSync(docsDir);
  } catch {
    return result;
  }

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const filePath = join(docsDir, file);
    let raw: string;
    try {
      if (!statSync(filePath).isFile()) continue;
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    const m = raw.match(FRONTMATTER_RE);
    if (!m) continue;
    try {
      const parsed = yaml.load(m[1]);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const docId = (parsed as Record<string, unknown>).doc_id;
        if (typeof docId === 'string' && docId.length > 0) {
          const list = result.get(docId) ?? [];
          list.push(file);
          result.set(docId, list);
        }
      }
    } catch {
      // YAML parse failure — parser will report it separately
    }
  }
  return result;
}

/**
 * Lint a shared source directory.
 *
 * 1. Pre-scan for duplicate doc_ids across all .md files (including filename-mismatched ones).
 * 2. Parse all entities (delegates to {@link parseSharedSource}).
 * 3. Detect duplicate edge_id / rule_id.
 * 4. Validate referential integrity (edges → documents, tag_mappings → documents).
 */
export function shareLint(sourceDir: string): ShareLintResult {
  // Pre-scan for doc_id duplicates (catches cases where parser rejects on filename mismatch)
  const docIdFiles = scanDocIds(sourceDir);
  const dupDocErrors: SourceParseError[] = [];
  for (const [docId, files] of docIdFiles) {
    if (files.length > 1) {
      for (const file of files.slice(1)) {
        dupDocErrors.push({
          file: `documents/${file}`,
          location: 'frontmatter.doc_id',
          message: `duplicate doc_id "${docId}" (first seen in documents/${files[0]})`,
        });
      }
    }
  }

  const parsed = parseSharedSource(sourceDir);
  return lintParseResult(parsed, dupDocErrors);
}

/**
 * Apply cross-reference validation to an already-parsed result.
 * Exported for direct unit testing of the lint logic without filesystem setup.
 *
 * @param extraErrors - Additional errors to prepend (e.g. from pre-scan).
 */
export function lintParseResult(
  parsed: SharedSourceParseResult,
  extraErrors: SourceParseError[] = [],
): ShareLintResult {
  const errors: SourceParseError[] = [...extraErrors, ...parsed.errors];

  // -- Duplicate detection (parsed documents — defensive for non-FS usage) ---

  const docIds = new Map<string, string>(); // id → first file
  for (const doc of parsed.documents) {
    const prev = docIds.get(doc.doc_id);
    if (prev) {
      errors.push({
        file: `documents/${doc.doc_id}.md`,
        location: 'frontmatter.doc_id',
        message: `duplicate doc_id "${doc.doc_id}" (first seen in ${prev})`,
      });
    } else {
      docIds.set(doc.doc_id, `documents/${doc.doc_id}.md`);
    }
  }

  const edgeIds = new Map<string, string>(); // id → first file
  for (const edge of parsed.edges) {
    const file = edgeSourceFile(edge.source_type);
    const prev = edgeIds.get(edge.edge_id);
    if (prev) {
      errors.push({
        file,
        location: 'edge_id',
        message: `duplicate edge_id "${edge.edge_id}" (first seen in ${prev})`,
      });
    } else {
      edgeIds.set(edge.edge_id, file);
    }
  }

  const ruleIds = new Map<string, string>(); // id → first file
  for (const rule of parsed.layer_rules) {
    const prev = ruleIds.get(rule.rule_id);
    if (prev) {
      errors.push({
        file: 'layer-rules.json',
        location: 'rule_id',
        message: `duplicate rule_id "${rule.rule_id}" (first seen in ${prev})`,
      });
    } else {
      ruleIds.set(rule.rule_id, 'layer-rules.json');
    }
  }

  // -- Referential integrity ---------------------------------------------

  const docIdSet = new Set(docIds.keys());

  for (const edge of parsed.edges) {
    if (!docIdSet.has(edge.target_doc_id)) {
      errors.push({
        file: edgeSourceFile(edge.source_type),
        location: 'target_doc_id',
        message: `edge "${edge.edge_id}" references non-existent document "${edge.target_doc_id}"`,
      });
    }
  }

  for (const tm of parsed.tag_mappings) {
    if (!docIdSet.has(tm.doc_id)) {
      errors.push({
        file: 'tag-mappings.json',
        location: 'doc_id',
        message: `tag mapping (tag="${tm.tag}") references non-existent document "${tm.doc_id}"`,
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    counts: {
      documents: parsed.documents.length,
      edges: parsed.edges.length,
      layer_rules: parsed.layer_rules.length,
      tag_mappings: parsed.tag_mappings.length,
    },
  };
}

// -- Helpers -------------------------------------------------------------

const SOURCE_TYPE_TO_FILE: Record<string, string> = {
  path: 'edges/path-requires.json',
  layer: 'edges/layer-requires.json',
  command: 'edges/command-requires.json',
  doc: 'edges/doc-depends-on.json',
};

function edgeSourceFile(sourceType: string): string {
  return SOURCE_TYPE_TO_FILE[sourceType] ?? `edges/${sourceType}.json`;
}
