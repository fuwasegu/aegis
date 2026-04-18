/**
 * ADR-015 §5 — document split trigger detection (deterministic advisory input for `doc_gap_detected`).
 *
 * Hybrid thresholds: absolute floors plus cohort-relative gap rate within the same document `kind`.
 */

import type { DocGapPayload, Document, Observation } from '../types.js';
import { derivePathPattern } from './edge-candidate-builder.js';

/** Reproducibility label for persisted `DocGapPayload.algorithm_version`. */
export const DOC_REFACTOR_ALGORITHM_VERSION = 'doc-refactor:v1';

/**
 * Hybrid split trigger (ADR-015 §5.1).
 *
 * Design expresses the compare threshold as `gap_rate_threshold = max(0.15, cohort_median * 3)`.
 * We persist the constant **0.15** as {@link RefactorTrigger.gap_rate_threshold_floor} and **3** as
 * {@link RefactorTrigger.cohort_median_multiplier}; use {@link effectiveGapRateThreshold} for the
 * combined value (ADR / task checklist の **gap_rate_threshold** に相当).
 */
export interface RefactorTrigger {
  min_exposure_count: number;
  min_content_gap_count: number;
  /** Static floor inside hybrid `gap_rate_threshold` (= max(this, cohort_median × multiplier)). */
  gap_rate_threshold_floor: number;
  cohort_median_multiplier: number;
  min_distinct_clusters: number;
}

export const DEFAULT_REFACTOR_TRIGGER: RefactorTrigger = {
  min_exposure_count: 10,
  min_content_gap_count: 3,
  gap_rate_threshold_floor: 0.15,
  cohort_median_multiplier: 3,
  min_distinct_clusters: 2,
};

export interface DocRefactorAggregate {
  doc_id: string;
  doc_kind: Document['kind'];
  exposure_count: number;
  content_gap_count: number;
  /** Distinct directory-level glob clusters derived from compile_miss target_files. */
  cluster_patterns: Set<string>;
  evidence_observation_ids: string[];
  evidence_compile_ids: string[];
}

type CompileMissPayload = {
  target_files: string[];
  missing_doc?: string;
  target_doc_id?: string;
  review_comment: string;
};

export function finiteMedian(values: number[]): number {
  const xs = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  const mid = Math.floor(xs.length / 2);
  if (xs.length % 2 === 1) return xs[mid]!;
  return (xs[mid - 1]! + xs[mid]!) / 2;
}

/**
 * Effective per-doc gap rate threshold: max(floor, cohort_median × multiplier).
 */
export function effectiveGapRateThreshold(cohortMedianGapRate: number, t: RefactorTrigger): number {
  return Math.max(t.gap_rate_threshold_floor, cohortMedianGapRate * t.cohort_median_multiplier);
}

export function gapRate(agg: DocRefactorAggregate): number {
  if (agg.exposure_count <= 0) return 0;
  return agg.content_gap_count / agg.exposure_count;
}

/** Median of per-doc gap rates among approved docs of this kind (exposure > 0 only). */
export function cohortMedianGapRateForKind(
  aggregates: Map<string, DocRefactorAggregate>,
  kind: Document['kind'],
): number {
  const rates: number[] = [];
  for (const a of aggregates.values()) {
    if (a.doc_kind !== kind || a.exposure_count <= 0) continue;
    rates.push(gapRate(a));
  }
  return finiteMedian(rates);
}

export function shouldEmitSplitCandidate(
  agg: DocRefactorAggregate,
  cohortMedian: number,
  trigger: RefactorTrigger,
): boolean {
  const threshold = effectiveGapRateThreshold(cohortMedian, trigger);
  const rate = gapRate(agg);
  return (
    agg.exposure_count >= trigger.min_exposure_count &&
    agg.content_gap_count >= trigger.min_content_gap_count &&
    agg.cluster_patterns.size >= trigger.min_distinct_clusters &&
    rate >= threshold
  );
}

export function buildSplitCandidatePayload(
  agg: DocRefactorAggregate,
  cohortMedianGapRate: number,
  _trigger: RefactorTrigger,
): DocGapPayload {
  const scope_patterns = [...agg.cluster_patterns].sort();
  return {
    gap_kind: 'split_candidate',
    target_doc_id: agg.doc_id,
    scope_patterns,
    evidence_observation_ids: [...new Set(agg.evidence_observation_ids)].sort(),
    evidence_compile_ids: [...new Set(agg.evidence_compile_ids)].filter(Boolean).sort(),
    metrics: {
      exposure_count: agg.exposure_count,
      content_gap_count: agg.content_gap_count,
      distinct_clusters: agg.cluster_patterns.size,
      cohort_gap_rate: cohortMedianGapRate,
    },
    suggested_next_action: 'split_doc',
    algorithm_version: DOC_REFACTOR_ALGORITHM_VERSION,
  };
}

function approvedDocKindById(docs: Document[]): Map<string, Document['kind']> {
  const m = new Map<string, Document['kind']>();
  for (const d of docs) {
    if (d.status === 'approved') m.set(d.doc_id, d.kind);
  }
  return m;
}

/**
 * Aggregates exposure (from compile_log base sets) and gap signals from compile_miss observations.
 */
export function aggregateRefactorSignals(
  approvedDocs: Document[],
  compileRows: Array<{ compile_id: string; base_doc_ids: string }>,
  compileMissObservations: Observation[],
): Map<string, DocRefactorAggregate> {
  const kindById = approvedDocKindById(approvedDocs);
  const map = new Map<string, DocRefactorAggregate>();

  const baseIdsByCompile = new Map<string, Set<string>>();
  for (const row of compileRows) {
    try {
      const ids = JSON.parse(row.base_doc_ids) as string[];
      if (Array.isArray(ids)) baseIdsByCompile.set(row.compile_id, new Set(ids));
    } catch {}
  }

  const ensure = (docId: string): DocRefactorAggregate | undefined => {
    const kind = kindById.get(docId);
    if (!kind) return undefined;
    let row = map.get(docId);
    if (!row) {
      row = {
        doc_id: docId,
        doc_kind: kind,
        exposure_count: 0,
        content_gap_count: 0,
        cluster_patterns: new Set(),
        evidence_observation_ids: [],
        evidence_compile_ids: [],
      };
      map.set(docId, row);
    }
    return row;
  };

  for (const row of compileRows) {
    let ids: string[];
    try {
      ids = JSON.parse(row.base_doc_ids) as string[];
    } catch {
      continue;
    }
    if (!Array.isArray(ids)) continue;
    for (const docId of ids) {
      const agg = ensure(docId);
      if (agg) agg.exposure_count++;
    }
  }

  for (const obs of compileMissObservations) {
    if (obs.event_type !== 'compile_miss') continue;

    let payload: CompileMissPayload;
    try {
      payload = JSON.parse(obs.payload) as CompileMissPayload;
    } catch {
      continue;
    }

    // Split-candidate signals follow delivered-but-insufficient docs only (target_doc_id).
    // missing_doc reflects routing/edge gaps — handled by coverage / routing_gap, not split triggers.
    if (typeof payload.target_doc_id !== 'string' || !payload.target_doc_id || payload.target_files.length === 0) {
      continue;
    }

    const compileId = obs.related_compile_id;
    if (!compileId) continue;
    const bases = baseIdsByCompile.get(compileId);
    if (!bases || !bases.has(payload.target_doc_id)) continue;

    const patterns = payload.target_files.map((f) => derivePathPattern(f));

    const docId = payload.target_doc_id;
    const agg = ensure(docId);
    if (!agg) continue;
    agg.content_gap_count++;
    agg.evidence_observation_ids.push(obs.observation_id);
    agg.evidence_compile_ids.push(compileId);
    for (const p of patterns) agg.cluster_patterns.add(p);
  }

  return map;
}
