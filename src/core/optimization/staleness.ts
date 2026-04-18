/**
 * ADR-015 Task 015-07: deterministic semantic staleness (Levels 1–3).
 *
 * Level 1: file-anchored `source_path` content hash ≠ canonical `content_hash`
 * Level 2: `source_path` missing, or rename candidate (same content hash elsewhere)
 * Level 3: path_edges → linked files: TypeScript symbol set or non-TS file hash drift
 */

import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import picomatch from 'picomatch';
import { resolveSourcePath } from '../paths.js';
import type { Document, Edge, StalenessDetectedPayload } from '../types.js';

export const SEMANTIC_STALENESS_ALGORITHM_VERSION = '015-07-1' as const;

const SKIP_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.turbo',
  'target',
  'out',
  '.next',
  'build',
]);

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/** Deterministic recursive listing of repo-relative file paths (posix-style). */
export function listRepoRelativeFiles(projectRoot: string): string[] {
  const out: string[] = [];

  function walk(absDir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (SKIP_DIR_NAMES.has(ent.name)) continue;
      const abs = join(absDir, ent.name);
      try {
        if (ent.isDirectory()) {
          walk(abs);
        } else if (ent.isFile()) {
          const rel = relative(projectRoot, abs);
          out.push(toPosix(rel));
        }
      } catch {
        /* unreadable entry */
      }
    }
  }

  try {
    walk(projectRoot);
  } catch {
    return [];
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

/**
 * Deterministic exported surface for TypeScript-like sources: only identifiers that are definitely
 * exported from this module (named export list, export function/class/const/interface/type, default
 * export with a name). Intentionally excludes non-exported top-level declarations.
 */
export function extractTsExportedSymbols(source: string): string[] {
  const names = new Set<string>();
  const lines = source.split('\n');
  for (const raw of lines) {
    const line = raw.trimStart();
    if (!/\bexport\b/.test(line)) continue;

    const block = line.match(/\bexport\s*\{([^}]+)\}/);
    if (block) {
      for (const part of block[1]!.split(',')) {
        const head = part
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim()
          .split(/\s+/)[0];
        if (head && /^\w+$/.test(head)) names.add(head);
      }
      continue;
    }

    let m = line.match(/\bexport\s+default\s+(?:abstract\s+)?class\s+(\w+)/);
    if (m) {
      names.add(m[1]!);
      continue;
    }
    m = line.match(/\bexport\s+default\s+(?:async\s+)?function\s+(\w+)/);
    if (m) {
      names.add(m[1]!);
      continue;
    }

    m = line.match(/\bexport\s+(?:async\s+)?function\s+(\w+)/);
    if (m) {
      names.add(m[1]!);
      continue;
    }
    m = line.match(/\bexport\s+class\s+(\w+)/);
    if (m) {
      names.add(m[1]!);
      continue;
    }
    m = line.match(/\bexport\s+(?:const|let|var)\s+(\w+)/);
    if (m) {
      names.add(m[1]!);
      continue;
    }
    m = line.match(/\bexport\s+interface\s+(\w+)/);
    if (m) {
      names.add(m[1]!);
      continue;
    }
    m = line.match(/\bexport\s+type\s+(\w+)/);
    if (m) {
      names.add(m[1]!);
      continue;
    }
    m = line.match(/\bexport\s+namespace\s+(\w+)/);
    if (m) {
      names.add(m[1]!);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function isTsLike(relPosix: string): boolean {
  const lower = relPosix.toLowerCase();
  return lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.mts') || lower.endsWith('.cts');
}

function fingerprintLinkedFile(projectRoot: string, relPosix: string): string | null {
  let absPath: string;
  try {
    absPath = resolveSourcePath(relPosix, projectRoot);
  } catch {
    return null;
  }
  if (!existsSync(absPath)) return null;
  try {
    const body = readFileSync(absPath);
    if (isTsLike(relPosix)) {
      const txt = body.toString('utf-8');
      const syms = extractTsExportedSymbols(txt);
      const joined = syms.join('\n');
      return `sym:${createHash('sha256').update(joined).digest('hex')}`;
    }
    return `raw:${createHash('sha256').update(body).digest('hex')}`;
  } catch {
    return null;
  }
}

/** Paths under project matching path_requires edges that target docId (approved path edges only). */
export function linkedPathsForDoc(docId: string, edges: Edge[], sortedRelFiles: string[]): string[] {
  const matchers: Array<ReturnType<typeof picomatch>> = [];
  for (const e of edges) {
    if (e.status !== 'approved') continue;
    if (e.target_doc_id !== docId || e.edge_type !== 'path_requires' || e.source_type !== 'path') continue;
    matchers.push(picomatch(e.source_value, { dot: true }));
  }
  if (matchers.length === 0) return [];
  const matched = new Set<string>();
  for (const rel of sortedRelFiles) {
    const posix = toPosix(rel);
    if (matchers.some((m) => m(posix))) matched.add(posix);
  }
  return [...matched].sort((a, b) => a.localeCompare(b));
}

export function fingerprintEdgeLinkedArtifacts(
  projectRoot: string,
  linkedPathsSorted: string[],
): Record<string, string> {
  const rec: Record<string, string> = {};
  for (const p of linkedPathsSorted) {
    const fp = fingerprintLinkedFile(projectRoot, p);
    if (fp !== null) rec[p] = fp;
  }
  const ordered: Record<string, string> = {};
  for (const k of Object.keys(rec).sort((a, b) => a.localeCompare(b))) {
    ordered[k] = rec[k]!;
  }
  return ordered;
}

export function stableStringifyFingerprints(rec: Record<string, string>): string {
  const ordered: Record<string, string> = {};
  for (const k of Object.keys(rec).sort((a, b) => a.localeCompare(b))) {
    ordered[k] = rec[k]!;
  }
  return JSON.stringify(ordered);
}

function finding(payload: Omit<StalenessDetectedPayload, 'algorithm_version'>): StalenessDetectedPayload {
  return { ...payload, algorithm_version: SEMANTIC_STALENESS_ALGORITHM_VERSION };
}

function hashBytesUtf8(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** First path in deterministic order whose file hashes to contentHash (full-file SHA-256 as hex). */
export function findRenameCandidatePath(
  projectRoot: string,
  sortedRelFiles: string[],
  contentHash: string,
): string | undefined {
  for (const rel of sortedRelFiles) {
    const posix = toPosix(rel);
    try {
      const abs = resolveSourcePath(posix, projectRoot);
      if (!existsSync(abs)) continue;
      const txt = readFileSync(abs, 'utf-8');
      if (hashBytesUtf8(txt) === contentHash) return posix;
    } catch {}
  }
  return undefined;
}

export interface SemanticStalenessScanInput {
  docs: Document[];
  edges: Edge[];
  projectRoot: string;
  /** Level-3 baseline keyed by doc_id → JSON fingerprint map (same shape as persisted `staleness_baselines`). */
  getBaseline: (docId: string) => string | null;
  /**
   * When true, persist Level-3 fingerprints (initial baseline, refresh after no drift, repair corrupt JSON).
   * Dry-run maintenance should pass false so SQLite rows are not written.
   */
  persistLevel3Baselines: boolean;
}

export interface SemanticStalenessScanResult {
  findings: StalenessDetectedPayload[];
  baselineUpserts: Array<{ doc_id: string; fingerprint_json: string }>;
}

export function collectSemanticStalenessFindings(input: SemanticStalenessScanInput): SemanticStalenessScanResult {
  const findings: StalenessDetectedPayload[] = [];
  const baselineUpserts: Array<{ doc_id: string; fingerprint_json: string }> = [];

  const sortedFiles = listRepoRelativeFiles(input.projectRoot);
  const edgeTargets = new Set<string>();
  for (const e of input.edges) {
    if (e.status === 'approved' && e.edge_type === 'path_requires' && e.source_type === 'path') {
      edgeTargets.add(e.target_doc_id);
    }
  }

  for (const doc of input.docs) {
    if (doc.status !== 'approved') continue;

    const isAnchored =
      doc.ownership === 'file-anchored' && typeof doc.source_path === 'string' && doc.source_path.trim().length > 0;

    if (isAnchored) {
      let absPath: string | undefined;
      try {
        absPath = resolveSourcePath(doc.source_path!.trim(), input.projectRoot);
      } catch {
        absPath = undefined;
      }

      if (absPath && existsSync(absPath)) {
        let content: string;
        try {
          content = readFileSync(absPath, 'utf-8');
        } catch {
          findings.push(
            finding({
              doc_id: doc.doc_id,
              level: 2,
              kind: 'source_unreadable',
              detail: `Cannot read source_path '${doc.source_path}' for '${doc.doc_id}'.`,
              paths: [doc.source_path!.trim()],
            }),
          );
          continue;
        }
        const diskHash = hashBytesUtf8(content);
        if (diskHash !== doc.content_hash) {
          findings.push(
            finding({
              doc_id: doc.doc_id,
              level: 1,
              kind: 'hash_mismatch',
              detail: `File-anchored document '${doc.doc_id}' (${doc.title}): on-disk SHA-256 differs from canonical content_hash.`,
              paths: [toPosix(doc.source_path!.trim())],
            }),
          );
        }
      } else if (absPath) {
        findings.push(
          finding({
            doc_id: doc.doc_id,
            level: 2,
            kind: 'source_missing',
            detail: `source_path '${doc.source_path}' for '${doc.doc_id}' does not exist under project root.`,
            paths: [doc.source_path!.trim()],
          }),
        );
        const rename = findRenameCandidatePath(input.projectRoot, sortedFiles, doc.content_hash);
        if (rename !== undefined) {
          findings.push(
            finding({
              doc_id: doc.doc_id,
              level: 2,
              kind: 'rename_candidate',
              detail: `Same canonical content_hash found at '${rename}' — possible rename from '${doc.source_path}'.`,
              paths: [doc.source_path!.trim()],
              rename_candidate_path: rename,
            }),
          );
        }
      }
    }

    if (!edgeTargets.has(doc.doc_id)) continue;

    const linked = linkedPathsForDoc(doc.doc_id, input.edges, sortedFiles);
    const currentMap = fingerprintEdgeLinkedArtifacts(input.projectRoot, linked);
    const serialized = stableStringifyFingerprints(currentMap);

    const prev = input.getBaseline(doc.doc_id);
    if (prev === null || prev === '') {
      if (input.persistLevel3Baselines) {
        baselineUpserts.push({ doc_id: doc.doc_id, fingerprint_json: serialized });
      }
      continue;
    }

    let prevObj: Record<string, string>;
    try {
      prevObj = JSON.parse(prev) as Record<string, string>;
    } catch {
      if (input.persistLevel3Baselines) {
        baselineUpserts.push({ doc_id: doc.doc_id, fingerprint_json: serialized });
      }
      continue;
    }

    const keys = new Set([...Object.keys(prevObj), ...Object.keys(currentMap)]);
    const sortedKeys = [...keys].sort((a, b) => a.localeCompare(b));
    let drift = false;
    for (const k of sortedKeys) {
      const a = prevObj[k];
      const b = currentMap[k];
      if (a === undefined && b !== undefined) {
        drift = true;
        findings.push(
          finding({
            doc_id: doc.doc_id,
            level: 3,
            kind: 'linked_file_added',
            detail: `New linked path '${k}' matches routing edges for '${doc.doc_id}' since last baseline.`,
            paths: [k],
          }),
        );
      } else if (a !== undefined && b === undefined) {
        drift = true;
        findings.push(
          finding({
            doc_id: doc.doc_id,
            level: 3,
            kind: 'linked_file_removed',
            detail: `Linked path '${k}' no longer matches routing edges or file was removed for '${doc.doc_id}'.`,
            paths: [k],
          }),
        );
      } else if (a !== undefined && b !== undefined && a !== b) {
        drift = true;
        findings.push(
          finding({
            doc_id: doc.doc_id,
            level: 3,
            kind: 'symbol_drift',
            detail: `Linked artifact fingerprint changed for '${k}' (exported symbols or file bytes) affecting '${doc.doc_id}'.`,
            paths: [k],
          }),
        );
      }
    }

    if (!drift && input.persistLevel3Baselines) {
      baselineUpserts.push({ doc_id: doc.doc_id, fingerprint_json: serialized });
    }
  }

  return { findings, baselineUpserts };
}
