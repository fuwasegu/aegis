/**
 * ADR-018 Task 018-03: share-format — deterministic normalization of shared source.
 *
 * Reads `aegis-share/source/`, normalizes key order, array sort order,
 * and trailing newlines, then rewrites files in-place.
 * Stabilises Git diffs and code review by eliminating cosmetic variance.
 *
 * Explicitly NOT responsible for: validation (that is share-lint's job).
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { RECOGNIZED_EDGE_FILES } from './source-types.js';

// -- Result type -------------------------------------------------------

export interface ShareFormatResult {
  /** Number of files that were rewritten (content changed). */
  files_changed: number;
  /** Number of files inspected but already normalized. */
  files_unchanged: number;
  /** Non-fatal warnings (e.g. skipped files). */
  warnings: string[];
}

// -- Deterministic helpers ---------------------------------------------

/** Locale-independent code-point comparator. */
function codePointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Normalize line endings to \n. */
function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Ensure exactly one trailing newline. */
function ensureTrailingNewline(s: string): string {
  return s.replace(/\n*$/, '\n');
}

/** Guarded statSync — returns undefined on broken symlinks or other FS errors. */
function safeStat(p: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
}

// -- Frontmatter normalization -----------------------------------------

/**
 * Canonical key order for document frontmatter.
 * Keys not in this list are preserved at the end in code-point order.
 */
const FRONTMATTER_KEY_ORDER = [
  'doc_id',
  'title',
  'kind',
  'ownership',
  'source_path',
  'source_refs_json',
  'template_origin',
];

/** Canonical key order for source refs (mirrors serializeSourceRefs in source-refs.ts). */
const SOURCE_REF_KEY_ORDER = ['asset_path', 'anchor_type', 'anchor_value'];

/**
 * Normalize a source_refs array: sort by asset_path/anchor_type/anchor_value,
 * fix key order per entry. Matches the deterministic serialization in source-refs.ts.
 */
function normalizeSourceRefsArray(arr: unknown[]): Record<string, unknown>[] | null {
  // Reject arrays containing non-object elements to avoid silent data loss
  for (const item of arr) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
  }
  return (arr as Record<string, unknown>[])
    .slice()
    .sort((a, b) => {
      const ap = codePointCompare(String(a.asset_path ?? ''), String(b.asset_path ?? ''));
      if (ap !== 0) return ap;
      const at = codePointCompare(String(a.anchor_type ?? ''), String(b.anchor_type ?? ''));
      if (at !== 0) return at;
      return codePointCompare(String(a.anchor_value ?? ''), String(b.anchor_value ?? ''));
    })
    .map((e) => reorderKeys(e, SOURCE_REF_KEY_ORDER));
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/**
 * Normalize a Markdown document file:
 * - Reorder frontmatter keys to canonical order
 * - Strip null-valued optional keys
 * - Normalize line endings to \n
 * - Ensure trailing newline
 * - Preserve body content as-is (except newline normalization)
 */
function formatDocument(raw: string): string | null {
  const normalized = normalizeNewlines(raw);
  const m = normalized.match(FRONTMATTER_RE);
  if (!m) return null; // Can't parse — skip

  const [, yamlBlock, body] = m;
  let meta: Record<string, unknown>;
  try {
    const parsed = yaml.load(yamlBlock);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    meta = parsed as Record<string, unknown>;
  } catch {
    return null; // Invalid YAML — skip (lint will catch it)
  }

  // Build ordered keys: canonical order first, then remaining in code-point order
  const canonicalKeys = FRONTMATTER_KEY_ORDER.filter((k) => k in meta);
  const extraKeys = Object.keys(meta)
    .filter((k) => !FRONTMATTER_KEY_ORDER.includes(k))
    .sort(codePointCompare);
  const orderedKeys = [...canonicalKeys, ...extraKeys];

  // Rebuild YAML frontmatter with deterministic key order
  // Use js-yaml dump for each value to ensure consistent formatting
  const lines: string[] = [];
  for (const key of orderedKeys) {
    let val = meta[key];
    // Strip null-valued optional fields (not doc_id/title/kind/ownership)
    if (val === null || val === undefined) {
      if (!['doc_id', 'title', 'kind', 'ownership'].includes(key)) continue;
    }
    // Normalize source_refs_json to a deterministic compact JSON string.
    // YAML may parse inline JSON arrays as native arrays — always emit a JSON string.
    // Sort refs and fix key order for deterministic output.
    if (key === 'source_refs_json' && val !== null && val !== undefined) {
      const str = typeof val === 'string' ? val : JSON.stringify(val);
      try {
        const parsed = JSON.parse(str);
        if (Array.isArray(parsed)) {
          const sorted = normalizeSourceRefsArray(parsed);
          if (sorted !== null) {
            val = JSON.stringify(sorted);
          }
          // If null, leave as-is (contains non-object elements)
        }
      } catch {
        // Leave as-is if not valid JSON
      }
    }
    // Dump single key-value pair to get consistent YAML formatting
    const dumped = yaml.dump({ [key]: val }, { flowLevel: -1, lineWidth: -1, noRefs: true }).trimEnd();
    lines.push(dumped);
  }

  const result = `---\n${lines.join('\n')}\n---\n${body}`;
  return ensureTrailingNewline(result);
}

// -- JSON normalization ------------------------------------------------

/** Canonical key order for edge entries. */
const EDGE_KEY_ORDER = ['edge_id', 'source_value', 'target_doc_id', 'priority', 'specificity'];

/** Canonical key order for layer rule entries. */
const LAYER_RULE_KEY_ORDER = ['rule_id', 'path_pattern', 'layer_name', 'priority', 'specificity'];

/** Canonical key order for tag mapping entries. */
const TAG_MAPPING_KEY_ORDER = ['tag', 'doc_id', 'confidence', 'source'];

/**
 * Reorder object keys to match a canonical order.
 * Keys not in the order list are appended in code-point order.
 */
function reorderKeys(obj: Record<string, unknown>, keyOrder: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keyOrder) {
    if (key in obj) result[key] = obj[key];
  }
  const extraKeys = Object.keys(obj)
    .filter((k) => !keyOrder.includes(k))
    .sort(codePointCompare);
  for (const key of extraKeys) {
    result[key] = obj[key];
  }
  return result;
}

/** Parse JSON array from raw string. Returns null if unparseable or not an array. */
function parseJsonArray(raw: string): Record<string, unknown>[] | null {
  const normalized = normalizeNewlines(raw);
  try {
    const parsed = JSON.parse(normalized);
    if (!Array.isArray(parsed)) return null;
    // Reject arrays containing non-object elements to avoid silent data loss
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    }
    return parsed as Record<string, unknown>[];
  } catch {
    return null;
  }
}

/**
 * Format an edge JSON file:
 * - Sort array by edge_id ASC
 * - Normalize key order per entry
 * - Deterministic JSON serialization
 */
function formatEdgeFile(raw: string): string | null {
  const arr = parseJsonArray(raw);
  if (!arr) return null;

  const sorted = arr
    .sort((a, b) => codePointCompare(String(a.edge_id ?? ''), String(b.edge_id ?? '')))
    .map((e) => reorderKeys(e, EDGE_KEY_ORDER));

  return JSON.stringify(sorted, null, 2) + '\n';
}

/**
 * Format layer-rules.json:
 * - Sort array by rule_id ASC
 * - Normalize key order per entry
 */
function formatLayerRules(raw: string): string | null {
  const arr = parseJsonArray(raw);
  if (!arr) return null;

  const sorted = arr
    .sort((a, b) => codePointCompare(String(a.rule_id ?? ''), String(b.rule_id ?? '')))
    .map((e) => reorderKeys(e, LAYER_RULE_KEY_ORDER));

  return JSON.stringify(sorted, null, 2) + '\n';
}

/**
 * Format tag-mappings.json:
 * - Sort array by tag ASC, then doc_id ASC
 * - Normalize key order per entry
 */
function formatTagMappings(raw: string): string | null {
  const arr = parseJsonArray(raw);
  if (!arr) return null;

  const sorted = arr
    .sort(
      (a, b) =>
        codePointCompare(String(a.tag ?? ''), String(b.tag ?? '')) ||
        codePointCompare(String(a.doc_id ?? ''), String(b.doc_id ?? '')),
    )
    .map((e) => reorderKeys(e, TAG_MAPPING_KEY_ORDER));

  return JSON.stringify(sorted, null, 2) + '\n';
}

// -- Public API --------------------------------------------------------

/**
 * Format shared source directory in-place.
 *
 * @param sourceDir Path to `aegis-share/source/`
 * @returns Result with counts and warnings
 */
export function shareFormat(sourceDir: string): ShareFormatResult {
  const warnings: string[] = [];
  let filesChanged = 0;
  let filesUnchanged = 0;

  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    throw new Error(`Source directory does not exist: ${sourceDir}`);
  }

  // -- documents/ ---------------------------------------------------
  const docsDir = join(sourceDir, 'documents');
  if (existsSync(docsDir) && safeStat(docsDir)?.isDirectory()) {
    const files = readdirSync(docsDir).sort(codePointCompare);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const filePath = join(docsDir, file);
      if (!safeStat(filePath)?.isFile()) {
        warnings.push(`documents/${file}: skipped (cannot stat)`);
        continue;
      }

      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf-8');
      } catch {
        warnings.push(`documents/${file}: skipped (cannot read)`);
        continue;
      }
      const formatted = formatDocument(raw);
      if (formatted === null) {
        warnings.push(`documents/${file}: skipped (cannot parse frontmatter)`);
        continue;
      }
      if (raw === formatted) {
        filesUnchanged++;
      } else {
        writeFileSync(filePath, formatted, 'utf-8');
        filesChanged++;
      }
    }
  }

  // -- edges/ -------------------------------------------------------
  const edgesDir = join(sourceDir, 'edges');
  if (existsSync(edgesDir) && safeStat(edgesDir)?.isDirectory()) {
    const files = readdirSync(edgesDir).sort(codePointCompare);
    for (const file of files) {
      if (!RECOGNIZED_EDGE_FILES.has(file)) continue;
      const filePath = join(edgesDir, file);
      if (!safeStat(filePath)?.isFile()) {
        warnings.push(`edges/${file}: skipped (cannot stat)`);
        continue;
      }

      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf-8');
      } catch {
        warnings.push(`edges/${file}: skipped (cannot read)`);
        continue;
      }
      const formatted = formatEdgeFile(raw);
      if (formatted === null) {
        warnings.push(`edges/${file}: skipped (cannot parse JSON)`);
        continue;
      }
      if (raw === formatted) {
        filesUnchanged++;
      } else {
        writeFileSync(filePath, formatted, 'utf-8');
        filesChanged++;
      }
    }
  }

  // -- layer-rules.json ---------------------------------------------
  formatTopLevelJson(join(sourceDir, 'layer-rules.json'), 'layer-rules.json', formatLayerRules);

  // -- tag-mappings.json --------------------------------------------
  formatTopLevelJson(join(sourceDir, 'tag-mappings.json'), 'tag-mappings.json', formatTagMappings);

  return {
    files_changed: filesChanged,
    files_unchanged: filesUnchanged,
    warnings,
  };

  /** Guarded format for top-level JSON files (layer-rules, tag-mappings). */
  function formatTopLevelJson(filePath: string, label: string, formatter: (raw: string) => string | null): void {
    if (!existsSync(filePath) || !safeStat(filePath)?.isFile()) return;
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      warnings.push(`${label}: skipped (cannot read)`);
      return;
    }
    const formatted = formatter(raw);
    if (formatted === null) {
      warnings.push(`${label}: skipped (cannot parse JSON)`);
    } else if (raw === formatted) {
      filesUnchanged++;
    } else {
      writeFileSync(filePath, formatted, 'utf-8');
      filesChanged++;
    }
  }
}
