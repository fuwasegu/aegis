/**
 * ADR-015 Task 015-10: N:M delivery unit ↔ repo asset references (`documents.source_refs_json`).
 */

import { normalizeSourcePath } from './paths.js';
import type { Document, SourceAnchorType, SourceRef } from './types.js';

const ANCHOR_TYPES = new Set<SourceAnchorType>(['file', 'section', 'lines']);

export function isSourceAnchorType(x: string): x is SourceAnchorType {
  return ANCHOR_TYPES.has(x as SourceAnchorType);
}

/** Parse and validate `documents.source_refs_json`. Invalid JSON or shape yields []. */
export function parseSourceRefsJson(json: string | null | undefined): SourceRef[] {
  if (json == null || String(json).trim() === '') return [];
  try {
    const raw = JSON.parse(json) as unknown;
    if (!Array.isArray(raw)) return [];
    const out: SourceRef[] = [];
    for (const item of raw) {
      try {
        out.push(validateSourceRef(item));
      } catch {
        /* skip invalid row */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function validateSourceRef(raw: unknown): SourceRef {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('source_ref must be an object');
  }
  const o = raw as Record<string, unknown>;
  const asset_path = o.asset_path;
  const anchor_type = o.anchor_type;
  const anchor_value = o.anchor_value;
  if (typeof asset_path !== 'string' || asset_path.trim() === '') {
    throw new Error('source_ref.asset_path required');
  }
  if (typeof anchor_type !== 'string' || !isSourceAnchorType(anchor_type)) {
    throw new Error('source_ref.anchor_type must be file | section | lines');
  }
  if (anchor_value !== undefined && anchor_value !== null && typeof anchor_value !== 'string') {
    throw new Error('source_ref.anchor_value must be a string');
  }
  const rawAv = typeof anchor_value === 'string' ? anchor_value : '';
  const trimmedAv = rawAv.trim();
  if (anchor_type !== 'file' && trimmedAv === '') {
    throw new Error('source_ref.anchor_value is required when anchor_type is not file');
  }
  return {
    asset_path: asset_path.trim(),
    anchor_type,
    anchor_value: anchor_type === 'file' ? rawAv : trimmedAv,
  };
}

export function normalizeSourceRefs(refs: SourceRef[], projectRoot: string): SourceRef[] {
  return refs.map((r) => ({
    ...r,
    asset_path: normalizeSourcePath(r.asset_path, projectRoot),
  }));
}

/** Stable JSON for Canonical storage (deterministic byte sequence). */
export function serializeSourceRefs(refs: SourceRef[]): string {
  const sorted = [...refs].sort(
    (a, b) =>
      a.asset_path.localeCompare(b.asset_path) ||
      a.anchor_type.localeCompare(b.anchor_type) ||
      a.anchor_value.localeCompare(b.anchor_value),
  );
  return JSON.stringify(sorted);
}

/**
 * Effective number of **distinct** repo assets (`asset_path` ∪ legacy `source_path`).
 * When both `source_path` and `source_refs_json` are set (e.g. import `file_path` + extra `source_refs`),
 * both count unless `source_path` duplicates an ref `asset_path` (015-10 / Codex: avoid false single-source hash sync).
 */
export function sourceRefCountFromDocument(doc: Pick<Document, 'source_path' | 'source_refs_json'>): number {
  const parsed = parseSourceRefsJson(doc.source_refs_json ?? null);
  const legacy =
    doc.source_path != null && String(doc.source_path).trim() !== '' ? String(doc.source_path).trim() : null;

  if (parsed.length === 0) {
    return legacy ? 1 : 0;
  }

  const refPaths = new Set(parsed.map((r) => r.asset_path.trim()));
  let count = refPaths.size;
  if (legacy !== null && !refPaths.has(legacy)) {
    count += 1;
  }
  return count;
}

/**
 * Repo-relative path for **whole-file** hash sync (015-10) and ADR-014 “verified against source file”.
 * Slice-only refs (`section`/`lines`) with no legacy `source_path` are out of scope for whole-file hash.
 * When the sole distinct asset includes at least one `file` anchor, whole-file sync applies even if slice
 * refs on the same path coexist (same rule as legacy path + slice refs).
 */
export function primaryAssetPathForHashSync(doc: Pick<Document, 'source_path' | 'source_refs_json'>): string | null {
  if (sourceRefCountFromDocument(doc) !== 1) return null;

  const parsed = parseSourceRefsJson(doc.source_refs_json ?? null);
  const legacy =
    doc.source_path != null && String(doc.source_path).trim() !== '' ? String(doc.source_path).trim() : null;

  if (parsed.length === 0) {
    return legacy;
  }

  const uniquePaths = [...new Set(parsed.map((r) => r.asset_path.trim()))];
  if (uniquePaths.length !== 1) return null;

  const onlyPath = uniquePaths[0]!;
  if (legacy !== null && legacy !== onlyPath) return null;

  /** Legacy column names the same repo file as every ref → whole-file hash targets `source_path` (slice refs annotate the same asset). */
  if (legacy !== null && legacy === onlyPath) {
    return legacy;
  }

  /** Sole asset includes an explicit `file` anchor → whole-file hash may run alongside slice refs. */
  if (parsed.some((r) => r.asset_path.trim() === onlyPath && r.anchor_type === 'file')) {
    return onlyPath;
  }

  return null;
}

/** Proposal / approve path: normalize paths inside optional `source_refs_json`. */
export function normalizeStoredSourceRefsPayload(raw: unknown, projectRoot: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new Error('source_refs_json must be a string or null');
  }
  const refs = parseSourceRefsJson(raw);
  if (refs.length === 0) return null;
  return serializeSourceRefs(normalizeSourceRefs(refs, projectRoot));
}

/**
 * Approve / preflight only: malformed JSON must throw (never silently clear provenance).
 * Rows must satisfy {@link validateSourceRef}.
 */
export function normalizeStoredSourceRefsPayloadStrict(raw: unknown, projectRoot: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new Error('source_refs_json must be a string or null');
  }
  const s = String(raw).trim();
  if (s === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s) as unknown;
  } catch {
    throw new Error('source_refs_json: invalid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('source_refs_json: JSON must be an array');
  }
  if (parsed.length === 0) return null;
  const refs = parsed.map((item) => validateSourceRef(item));
  return serializeSourceRefs(normalizeSourceRefs(refs, projectRoot));
}
