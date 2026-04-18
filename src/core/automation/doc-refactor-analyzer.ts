/**
 * DocRefactorAnalyzer
 *
 * ADR-015 Task 015-06: deterministic split-candidate detection → `doc_gap_detected`
 * (`gap_kind: split_candidate`). Diagnostic only — no proposals (same contract as DocGapAnalyzer).
 */

import { v4 as uuidv4 } from 'uuid';

import {
  aggregateRefactorSignals,
  buildSplitCandidatePayload,
  cohortMedianGapRateForKind,
  DEFAULT_REFACTOR_TRIGGER,
  DOC_REFACTOR_ALGORITHM_VERSION,
  type DocRefactorAggregate,
  shouldEmitSplitCandidate,
} from '../optimization/doc-refactor.js';
import type { Repository } from '../store/repository.js';
import type { AnalysisContext, AnalysisResult, DocGapPayload } from '../types.js';
import type { ObservationAnalyzer } from './analyzer.js';

export class DocRefactorAnalyzer implements ObservationAnalyzer {
  constructor(private readonly repo: Repository) {}

  /**
   * Emits zero or more `doc_gap_detected` observations when hybrid thresholds fire.
   * Uses full-table compile_log + compile_miss history (deterministic global signals).
   */
  async analyze(_contexts: AnalysisContext[]): Promise<AnalysisResult> {
    const approved = this.repo.getApprovedDocuments();
    const compileRows = this.repo.listCompileLogStatsRows();
    const misses = this.repo.listObservationsByEventType('compile_miss');

    const aggregates = aggregateRefactorSignals(approved, compileRows, misses);

    for (const agg of aggregates.values()) {
      const cohortMed = cohortMedianGapRateForKind(aggregates, agg.doc_kind);
      if (!shouldEmitSplitCandidate(agg, cohortMed, DEFAULT_REFACTOR_TRIGGER)) continue;
      if (this.hasUnarchivedSplitCandidateForDoc(agg.doc_id)) continue;

      const payload = buildSplitCandidatePayload(agg, cohortMed, DEFAULT_REFACTOR_TRIGGER);
      this.repo.insertObservation({
        observation_id: uuidv4(),
        event_type: 'doc_gap_detected',
        payload: JSON.stringify(payload),
        related_compile_id: pickRelatedCompileId(agg),
        related_snapshot_id: null,
      });
    }

    return { drafts: [], skipped_observation_ids: [], errors: [] };
  }

  private hasUnarchivedSplitCandidateForDoc(docId: string): boolean {
    const rows = this.repo.listObservationsByEventType('doc_gap_detected');
    for (const o of rows) {
      try {
        const p = JSON.parse(o.payload) as DocGapPayload;
        if (
          p.algorithm_version === DOC_REFACTOR_ALGORITHM_VERSION &&
          p.gap_kind === 'split_candidate' &&
          p.target_doc_id === docId
        ) {
          return true;
        }
      } catch {}
    }
    return false;
  }
}

function pickRelatedCompileId(agg: DocRefactorAggregate): string | null {
  const xs = agg.evidence_compile_ids;
  return xs.length > 0 ? xs[xs.length - 1]! : null;
}
