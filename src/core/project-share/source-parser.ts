/**
 * ADR-018 Task 018-01: Shared source parser.
 *
 * Reads `aegis-share/source/` and produces a structured {@link SharedSourceParseResult}.
 * Responsibilities: file layout validation, Markdown frontmatter parsing,
 * JSON parsing, edge source_type derivation, error aggregation.
 *
 * Explicitly NOT responsible for: duplicate ID detection, dangling reference
 * detection, deterministic rewrite, DB diff / materialize.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type { DocOwnership, DocumentKind } from '../types.js';
import type {
  SharedSourceParseResult,
  SourceDocument,
  SourceEdge,
  SourceLayerRule,
  SourceParseError,
  SourceTagMapping,
} from './source-types.js';
import {
  EDGE_FILE_EDGE_TYPE,
  EDGE_FILE_SOURCE_TYPE,
  RECOGNIZED_EDGE_FILES,
  RECOGNIZED_TOP_LEVEL,
} from './source-types.js';

// -- Frontmatter parser -----------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse Markdown frontmatter using js-yaml for robust YAML handling.
 * Returns null when the `---` delimiters are missing.
 */
function parseFrontmatter(
  raw: string,
  relPath: string,
): { meta: Record<string, unknown>; body: string; errors: SourceParseError[] } | null {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return null;
  const [, yamlBlock, body] = m;
  const errors: SourceParseError[] = [];
  let meta: Record<string, unknown>;
  try {
    const parsed = yaml.load(yamlBlock);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      errors.push({ file: relPath, location: 'frontmatter', message: 'frontmatter must be a YAML mapping' });
      return { meta: {}, body, errors };
    }
    meta = parsed as Record<string, unknown>;
  } catch (e) {
    errors.push({
      file: relPath,
      location: 'frontmatter',
      message: `invalid YAML in frontmatter: ${(e as Error).message}`,
    });
    return { meta: {}, body, errors };
  }
  return { meta, body, errors };
}

// -- Validators -------------------------------------------------------

const VALID_KINDS = new Set<DocumentKind>(['guideline', 'pattern', 'constraint', 'template', 'reference']);
const VALID_OWNERSHIPS = new Set<DocOwnership>(['file-anchored', 'standalone', 'derived']);
const VALID_TAG_SOURCES = new Set(['slm', 'manual']);

/** Locale-independent sort for deterministic ordering. */
function codePointSort(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// -- Safe file read helper --------------------------------------------

function safeReadFile(filePath: string, relPath: string, errors: SourceParseError[]): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch (e) {
    errors.push({ file: relPath, location: '$', message: `failed to read file: ${(e as Error).message}` });
    return null;
  }
}

function safeStat(
  filePath: string,
  relPath: string,
  errors: SourceParseError[],
): { isFile: boolean; isDirectory: boolean } | null {
  try {
    const s = statSync(filePath);
    return { isFile: s.isFile(), isDirectory: s.isDirectory() };
  } catch (e) {
    errors.push({ file: relPath, location: '$', message: `cannot stat: ${(e as Error).message}` });
    return null;
  }
}

function safeReaddir(dirPath: string, relPath: string, errors: SourceParseError[]): string[] | null {
  try {
    return readdirSync(dirPath).sort(codePointSort);
  } catch (e) {
    errors.push({ file: relPath, location: '$', message: `cannot read directory: ${(e as Error).message}` });
    return null;
  }
}

// -- Public API -------------------------------------------------------

/**
 * Parse the shared source directory at `sourceDir`.
 * Returns all parsed entities plus any errors encountered.
 * Parse errors do NOT throw — they are accumulated in `errors`.
 */
export function parseSharedSource(sourceDir: string): SharedSourceParseResult {
  const documents: SourceDocument[] = [];
  const edges: SourceEdge[] = [];
  const layer_rules: SourceLayerRule[] = [];
  const tag_mappings: SourceTagMapping[] = [];
  const errors: SourceParseError[] = [];

  const rootStat = safeStat(sourceDir, '.', errors);
  if (!rootStat || !rootStat.isDirectory) {
    if (rootStat) errors.push({ file: '.', location: '$', message: `source directory does not exist: ${sourceDir}` });
    return { documents, edges, layer_rules, tag_mappings, errors };
  }

  // Reject unknown top-level entries
  const entries = safeReaddir(sourceDir, '.', errors);
  if (!entries) return { documents, edges, layer_rules, tag_mappings, errors };
  for (const entry of entries) {
    if (!RECOGNIZED_TOP_LEVEL.has(entry)) {
      errors.push({ file: entry, location: '$', message: `unknown top-level entry: ${entry}` });
    }
  }

  // -- documents/ ---------------------------------------------------
  const docsDir = join(sourceDir, 'documents');
  if (existsSync(docsDir)) {
    const docsDirStat = safeStat(docsDir, 'documents', errors);
    if (docsDirStat && !docsDirStat.isDirectory) {
      errors.push({ file: 'documents', location: '$', message: 'expected a directory, got a file' });
    } else if (docsDirStat) {
      const files = safeReaddir(docsDir, 'documents', errors);
      if (files) {
        for (const file of files) {
          const filePath = join(docsDir, file);
          const relPath = `documents/${file}`;

          if (!file.endsWith('.md')) {
            errors.push({ file: relPath, location: '$', message: 'unexpected file extension (expected .md)' });
            continue;
          }

          const fileStat = safeStat(filePath, relPath, errors);
          if (!fileStat) continue;
          if (!fileStat.isFile) {
            errors.push({ file: relPath, location: '$', message: 'expected a file, got directory' });
            continue;
          }

          const raw = safeReadFile(filePath, relPath, errors);
          if (raw === null) continue;

          const parsed = parseFrontmatter(raw, relPath);
          if (!parsed) {
            errors.push({
              file: relPath,
              location: 'frontmatter',
              message: 'missing or malformed frontmatter (expected --- delimiters)',
            });
            continue;
          }

          const { meta, body, errors: fmErrors } = parsed;
          if (fmErrors.length > 0) {
            errors.push(...fmErrors);
            continue;
          }

          const docErrors = validateDocumentFrontmatter(meta, relPath);
          if (docErrors.length > 0) {
            errors.push(...docErrors);
            continue;
          }

          const docId = String(meta.doc_id);
          const title = String(meta.title);
          const expectedFilename = `${docId}.md`;
          if (file !== expectedFilename) {
            errors.push({
              file: relPath,
              location: 'frontmatter.doc_id',
              message: `filename "${file}" does not match doc_id "${docId}" (expected "${expectedFilename}")`,
            });
            continue;
          }

          // source_refs_json: validate as JSON array string (not scalar/object)
          const rawSourceRefs = meta.source_refs_json;
          let sourceRefsJson: string | null = null;
          if (rawSourceRefs !== undefined && rawSourceRefs !== null) {
            // js-yaml may parse inline JSON as array/object; normalize to string
            const refsStr = typeof rawSourceRefs === 'string' ? rawSourceRefs : JSON.stringify(rawSourceRefs);
            try {
              const parsed = JSON.parse(refsStr);
              if (!Array.isArray(parsed)) {
                errors.push({
                  file: relPath,
                  location: 'frontmatter.source_refs_json',
                  message: 'source_refs_json must be a JSON array string',
                });
                continue;
              }
              sourceRefsJson = refsStr;
            } catch {
              errors.push({
                file: relPath,
                location: 'frontmatter.source_refs_json',
                message: 'source_refs_json must be a valid JSON array string',
              });
              continue;
            }
          }

          documents.push({
            doc_id: docId,
            title,
            kind: meta.kind as DocumentKind,
            ownership: meta.ownership as DocOwnership,
            source_path: meta.source_path != null ? String(meta.source_path) : null,
            source_refs_json: sourceRefsJson,
            template_origin: meta.template_origin != null ? String(meta.template_origin) : null,
            content: body,
          });
        }
      }
    }
  }

  // -- edges/ -------------------------------------------------------
  const edgesDir = join(sourceDir, 'edges');
  if (existsSync(edgesDir)) {
    const edgesDirStat = safeStat(edgesDir, 'edges', errors);
    if (edgesDirStat && !edgesDirStat.isDirectory) {
      errors.push({ file: 'edges', location: '$', message: 'expected a directory, got a file' });
    } else if (edgesDirStat) {
      const files = safeReaddir(edgesDir, 'edges', errors);
      if (files) {
        for (const file of files) {
          const filePath = join(edgesDir, file);
          const relPath = `edges/${file}`;

          if (!RECOGNIZED_EDGE_FILES.has(file)) {
            errors.push({ file: relPath, location: '$', message: `unsupported edge file: ${file}` });
            continue;
          }

          const fileStat = safeStat(filePath, relPath, errors);
          if (!fileStat) continue;
          if (!fileStat.isFile) {
            errors.push({ file: relPath, location: '$', message: 'expected a file, got directory' });
            continue;
          }

          const sourceType = EDGE_FILE_SOURCE_TYPE[file];
          const edgeType = EDGE_FILE_EDGE_TYPE[file];
          const raw = safeReadFile(filePath, relPath, errors);
          if (raw === null) continue;

          let arr: unknown[];
          try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
              errors.push({ file: relPath, location: '$', message: 'expected a JSON array' });
              continue;
            }
            arr = parsed;
          } catch (e) {
            errors.push({ file: relPath, location: '$', message: `malformed JSON: ${(e as Error).message}` });
            continue;
          }

          for (let i = 0; i < arr.length; i++) {
            const entry = arr[i];
            const edgeErrors = validateEdgeEntry(entry, relPath, `[${i}]`, edgeType);
            if (edgeErrors.length > 0) {
              errors.push(...edgeErrors);
              continue;
            }
            const e = entry as Record<string, unknown>;
            edges.push({
              edge_id: e.edge_id as string,
              source_type: sourceType,
              source_value: e.source_value as string,
              target_doc_id: e.target_doc_id as string,
              edge_type: edgeType,
              priority: e.priority as number,
              specificity: e.specificity as number,
            });
          }
        }
      }
    }
  }

  // -- layer-rules.json ---------------------------------------------
  parseJsonFile(sourceDir, 'layer-rules.json', errors, (parsed, relFile) => {
    for (let i = 0; i < parsed.length; i++) {
      const entry = parsed[i];
      const ruleErrors = validateLayerRuleEntry(entry, relFile, `[${i}]`);
      if (ruleErrors.length > 0) {
        errors.push(...ruleErrors);
        continue;
      }
      const e = entry as Record<string, unknown>;
      layer_rules.push({
        rule_id: e.rule_id as string,
        path_pattern: e.path_pattern as string,
        layer_name: e.layer_name as string,
        priority: e.priority as number,
        specificity: e.specificity as number,
      });
    }
  });

  // -- tag-mappings.json --------------------------------------------
  parseJsonFile(sourceDir, 'tag-mappings.json', errors, (parsed, relFile) => {
    for (let i = 0; i < parsed.length; i++) {
      const entry = parsed[i];
      const tmErrors = validateTagMappingEntry(entry, relFile, `[${i}]`);
      if (tmErrors.length > 0) {
        errors.push(...tmErrors);
        continue;
      }
      const e = entry as Record<string, unknown>;
      tag_mappings.push({
        tag: e.tag as string,
        doc_id: e.doc_id as string,
        confidence: e.confidence as number,
        source: e.source as 'slm' | 'manual',
      });
    }
  });

  return { documents, edges, layer_rules, tag_mappings, errors };
}

// -- JSON file helper (validates kind + parses) -----------------------

function parseJsonFile(
  sourceDir: string,
  filename: string,
  errors: SourceParseError[],
  onParsed: (arr: unknown[], relFile: string) => void,
): void {
  const filePath = join(sourceDir, filename);
  if (!existsSync(filePath)) return;

  const stat = safeStat(filePath, filename, errors);
  if (!stat) return;
  if (!stat.isFile) {
    errors.push({ file: filename, location: '$', message: 'expected a file, got directory' });
    return;
  }

  const raw = safeReadFile(filePath, filename, errors);
  if (raw === null) return;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      errors.push({ file: filename, location: '$', message: 'expected a JSON array' });
      return;
    }
    onParsed(parsed, filename);
  } catch (e) {
    errors.push({ file: filename, location: '$', message: `malformed JSON: ${(e as Error).message}` });
  }
}

// -- Validation helpers -----------------------------------------------

function validateDocumentFrontmatter(meta: Record<string, unknown>, relPath: string): SourceParseError[] {
  const errs: SourceParseError[] = [];

  // Required string fields
  for (const field of ['doc_id', 'title'] as const) {
    const val = meta[field];
    if (val === undefined || val === null) {
      errs.push({
        file: relPath,
        location: `frontmatter.${field}`,
        message: `missing required frontmatter field: ${field}`,
      });
    } else if (typeof val !== 'string') {
      errs.push({
        file: relPath,
        location: `frontmatter.${field}`,
        message: `${field} must be a string, got ${typeof val}`,
      });
    } else if (val.length === 0) {
      errs.push({
        file: relPath,
        location: `frontmatter.${field}`,
        message: `missing required frontmatter field: ${field}`,
      });
    }
  }

  // Required enum fields
  for (const field of ['kind', 'ownership'] as const) {
    const val = meta[field];
    if (val === undefined || val === null) {
      errs.push({
        file: relPath,
        location: `frontmatter.${field}`,
        message: `missing required frontmatter field: ${field}`,
      });
    } else if (typeof val !== 'string') {
      errs.push({
        file: relPath,
        location: `frontmatter.${field}`,
        message: `${field} must be a string, got ${typeof val}`,
      });
    }
  }

  if (errs.length > 0) return errs;

  if (!VALID_KINDS.has(meta.kind as DocumentKind)) {
    errs.push({
      file: relPath,
      location: 'frontmatter.kind',
      message: `invalid kind: "${meta.kind}" (expected one of: ${[...VALID_KINDS].join(', ')})`,
    });
  }
  if (!VALID_OWNERSHIPS.has(meta.ownership as DocOwnership)) {
    errs.push({
      file: relPath,
      location: 'frontmatter.ownership',
      message: `invalid ownership: "${meta.ownership}" (expected one of: ${[...VALID_OWNERSHIPS].join(', ')})`,
    });
  }

  // Optional string fields — reject non-string values
  for (const field of ['source_path', 'template_origin'] as const) {
    const val = meta[field];
    if (val !== undefined && val !== null && typeof val !== 'string') {
      errs.push({
        file: relPath,
        location: `frontmatter.${field}`,
        message: `${field} must be a string or null, got ${typeof val}`,
      });
    }
  }

  // Forbidden: content_hash must NOT appear (materialize computes it)
  if (meta.content_hash !== undefined) {
    errs.push({
      file: relPath,
      location: 'frontmatter.content_hash',
      message: 'content_hash must not appear in shared source (computed by materialize)',
    });
  }

  // file-anchored requires source_path or source_refs_json
  if (meta.ownership === 'file-anchored') {
    const hasPath = meta.source_path != null && String(meta.source_path).trim() !== '';
    const hasRefs = meta.source_refs_json != null;
    if (!hasPath && !hasRefs) {
      errs.push({
        file: relPath,
        location: 'frontmatter.ownership',
        message: 'file-anchored ownership requires source_path or source_refs_json',
      });
    }
  }

  return errs;
}

function validateEdgeEntry(
  entry: unknown,
  file: string,
  location: string,
  expectedEdgeType: string,
): SourceParseError[] {
  const errs: SourceParseError[] = [];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    errs.push({ file, location, message: 'expected an object' });
    return errs;
  }
  const e = entry as Record<string, unknown>;
  for (const field of ['edge_id', 'source_value', 'target_doc_id']) {
    if (typeof e[field] !== 'string' || (e[field] as string).length === 0) {
      errs.push({
        file,
        location: `${location}.${field}`,
        message: `missing or invalid field: ${field} (expected non-empty string)`,
      });
    }
  }
  for (const field of ['priority', 'specificity']) {
    if (typeof e[field] !== 'number') {
      errs.push({
        file,
        location: `${location}.${field}`,
        message: `missing or invalid field: ${field} (expected number)`,
      });
    }
  }
  // source_type is file-derived only (ADR-018 D-4); reject if present
  if (e.source_type !== undefined) {
    errs.push({
      file,
      location: `${location}.source_type`,
      message: 'source_type must not appear in edge entries (derived from filename)',
    });
  }
  // edge_type must match the file-derived type if present
  if (e.edge_type !== undefined && e.edge_type !== expectedEdgeType) {
    errs.push({
      file,
      location: `${location}.edge_type`,
      message: `edge_type "${e.edge_type}" conflicts with file-derived type "${expectedEdgeType}"`,
    });
  }
  return errs;
}

function validateLayerRuleEntry(entry: unknown, file: string, location: string): SourceParseError[] {
  const errs: SourceParseError[] = [];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    errs.push({ file, location, message: 'expected an object' });
    return errs;
  }
  const e = entry as Record<string, unknown>;
  for (const field of ['rule_id', 'path_pattern', 'layer_name']) {
    if (typeof e[field] !== 'string' || (e[field] as string).length === 0) {
      errs.push({
        file,
        location: `${location}.${field}`,
        message: `missing or invalid field: ${field} (expected non-empty string)`,
      });
    }
  }
  for (const field of ['priority', 'specificity']) {
    if (typeof e[field] !== 'number') {
      errs.push({
        file,
        location: `${location}.${field}`,
        message: `missing or invalid field: ${field} (expected number)`,
      });
    }
  }
  return errs;
}

function validateTagMappingEntry(entry: unknown, file: string, location: string): SourceParseError[] {
  const errs: SourceParseError[] = [];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    errs.push({ file, location, message: 'expected an object' });
    return errs;
  }
  const e = entry as Record<string, unknown>;
  for (const field of ['tag', 'doc_id']) {
    if (typeof e[field] !== 'string' || (e[field] as string).length === 0) {
      errs.push({
        file,
        location: `${location}.${field}`,
        message: `missing or invalid field: ${field} (expected non-empty string)`,
      });
    }
  }
  if (typeof e.confidence !== 'number') {
    errs.push({
      file,
      location: `${location}.confidence`,
      message: 'missing or invalid field: confidence (expected number)',
    });
  }
  if (!VALID_TAG_SOURCES.has(e.source as string)) {
    errs.push({
      file,
      location: `${location}.source`,
      message: `invalid source: "${e.source}" (expected "slm" or "manual")`,
    });
  }
  return errs;
}
