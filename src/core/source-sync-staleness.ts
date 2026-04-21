/**
 * ADR-014 Phase 2: file-anchored documents — last successful source verification (source_synced_at).
 */

import { primaryAssetPathForHashSync, sourceRefCountFromDocument } from './source-refs.js';
import type { Document } from './types.js';

/** Default threshold for compile warnings and maintenance staleness report (days). */
export const SOURCE_SYNC_STALE_WARNING_DAYS = 90;

export function isFileAnchoredSourceStale(doc: Document, thresholdDays: number, nowMs: number): boolean {
  if (doc.ownership !== 'file-anchored') return false;
  /** ADR-014 notices assume single-file hash sync; N:M units use semantic / multi-path flows (015-10). */
  if (sourceRefCountFromDocument(doc) > 1) return false;
  if (!primaryAssetPathForHashSync(doc)?.trim()) return false;
  const synced = doc.source_synced_at;
  if (synced == null || synced === '') return true;
  const t = Date.parse(synced);
  if (Number.isNaN(t)) return true;
  const ageDays = (nowMs - t) / 86_400_000;
  return ageDays >= thresholdDays;
}

/**
 * Deterministic ordering by doc_id. One warning per stale document.
 */
export function sourceSyncStalenessWarningsForDocuments(
  docs: Document[],
  thresholdDays: number,
  nowMs: number,
): string[] {
  const stale = docs.filter((d) => isFileAnchoredSourceStale(d, thresholdDays, nowMs));
  stale.sort((a, b) => a.doc_id.localeCompare(b.doc_id));
  return stale.map((d) => {
    let ageMsg: string;
    if (d.source_synced_at == null || d.source_synced_at === '') {
      ageMsg = 'never verified against source file by sync_docs';
    } else {
      const t = Date.parse(d.source_synced_at);
      const days = Number.isNaN(t) ? 'unknown' : Math.floor((nowMs - t) / 86_400_000);
      ageMsg =
        typeof days === 'number' ? `${days} day(s) since last source sync` : 'invalid source_synced_at timestamp';
    }
    return `Stale file-anchored document '${d.doc_id}' (${d.title}): ${ageMsg}; run admin aegis_sync_docs or aegis maintenance (threshold ${thresholdDays}d).`;
  });
}

export function listStaleFileAnchoredDocIds(docs: Document[], thresholdDays: number, nowMs: number): string[] {
  const ids = docs.filter((d) => isFileAnchoredSourceStale(d, thresholdDays, nowMs)).map((d) => d.doc_id);
  ids.sort((a, b) => a.localeCompare(b));
  return ids;
}
