/**
 * ADR-014 Phase 2: file-anchored documents — last successful source verification (source_synced_at).
 */

import { classifyReconcileMode, primaryAssetPathForHashSync, sourceRefCountFromDocument } from './source-refs.js';
import type { Document } from './types.js';

/** Default threshold for compile warnings and maintenance staleness report (days). */
export const SOURCE_SYNC_STALE_WARNING_DAYS = 90;

export function isFileAnchoredSourceStale(doc: Document, thresholdDays: number, nowMs: number): boolean {
  if (doc.ownership !== 'file-anchored') return false;
  /** ADR-014 notices assume single-file hash sync; N:M units use semantic / multi-path flows (015-10). */
  if (sourceRefCountFromDocument(doc) > 1) return false;
  if (!primaryAssetPathForHashSync(doc)?.trim()) return false;
  return isSourceSyncedAtStale(doc, thresholdDays, nowMs);
}

/** Check source_synced_at staleness without hash-sync path constraints (for anchor-sync docs). */
export function isSourceSyncedAtStale(doc: Document, thresholdDays: number, nowMs: number): boolean {
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

/**
 * ADR-016 Task 016-04: reconcile-mode-aware notices for compile_context.
 * Generalizes the existing hash-sync staleness warnings to cover all modes.
 *
 * - `hash-sync`:        per-document stale notice (existing behavior)
 * - `anchor-sync`:      per-document stale notice with anchor-sync wording
 * - `semantic-review`:  summary count only (no per-document notice to avoid noise)
 */
export function reconcileModeAwareNotices(
  docs: Document[],
  thresholdDays: number,
  nowMs: number,
  /** doc_ids with unresolved anchor-failure staleness_detected observations. */
  anchorFailureDocIds?: ReadonlySet<string>,
): string[] {
  const notices: string[] = [];
  const hashSyncStale: Document[] = [];
  const anchorSyncStale: Document[] = [];
  const anchorFailureDocs: Document[] = [];
  let semanticReviewCount = 0;

  const failureSet = anchorFailureDocIds ?? new Set<string>();

  for (const d of docs) {
    if (d.ownership !== 'file-anchored') continue;
    const mode = classifyReconcileMode(d);
    switch (mode) {
      case 'hash-sync':
        if (isFileAnchoredSourceStale(d, thresholdDays, nowMs)) {
          hashSyncStale.push(d);
        }
        break;
      case 'anchor-sync':
        if (failureSet.has(d.doc_id)) {
          anchorFailureDocs.push(d);
        } else if (isSourceSyncedAtStale(d, thresholdDays, nowMs)) {
          anchorSyncStale.push(d);
        }
        break;
      case 'semantic-review':
        semanticReviewCount++;
        break;
    }
  }

  // Sort for deterministic output
  hashSyncStale.sort((a, b) => a.doc_id.localeCompare(b.doc_id));
  anchorSyncStale.sort((a, b) => a.doc_id.localeCompare(b.doc_id));
  anchorFailureDocs.sort((a, b) => a.doc_id.localeCompare(b.doc_id));

  for (const d of hashSyncStale) {
    const ageMsg = formatAgeMessage(d, nowMs);
    notices.push(
      `Stale hash-sync document '${d.doc_id}' (${d.title}): ${ageMsg}; run admin aegis_sync_docs or aegis maintenance (threshold ${thresholdDays}d).`,
    );
  }

  for (const d of anchorFailureDocs) {
    notices.push(
      `Anchor failure for document '${d.doc_id}' (${d.title}): unresolved anchor materialization error; run admin aegis_sync_docs to retry.`,
    );
  }

  for (const d of anchorSyncStale) {
    const ageMsg = formatAgeMessage(d, nowMs);
    notices.push(
      `Stale anchor-sync document '${d.doc_id}' (${d.title}): ${ageMsg}; run admin aegis_sync_docs to re-materialize anchor (threshold ${thresholdDays}d).`,
    );
  }

  if (semanticReviewCount > 0) {
    notices.push(
      `${semanticReviewCount} document(s) in semantic-review mode require manual review; run admin aegis_sync_docs or aegis maintenance for details.`,
    );
  }

  return notices;
}

function formatAgeMessage(d: Document, nowMs: number): string {
  if (d.source_synced_at == null || d.source_synced_at === '') {
    return 'never verified against source file by sync_docs';
  }
  const t = Date.parse(d.source_synced_at);
  if (Number.isNaN(t)) return 'invalid source_synced_at timestamp';
  const days = Math.floor((nowMs - t) / 86_400_000);
  return `${days} day(s) since last source sync`;
}

export function listStaleFileAnchoredDocIds(docs: Document[], thresholdDays: number, nowMs: number): string[] {
  const ids = docs.filter((d) => isFileAnchoredSourceStale(d, thresholdDays, nowMs)).map((d) => d.doc_id);
  ids.sort((a, b) => a.localeCompare(b));
  return ids;
}
