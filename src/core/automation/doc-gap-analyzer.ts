/**
 * DocGapAnalyzer
 *
 * ADR-015: `doc_gap_detected` is diagnostic-only — never emits proposals.
 * Observations are marked analyzed by the pipeline with no proposal_evidence → outcome "skipped".
 */

import type { AnalysisContext, AnalysisResult } from '../types.js';
import type { ObservationAnalyzer } from './analyzer.js';

export class DocGapAnalyzer implements ObservationAnalyzer {
  async analyze(contexts: AnalysisContext[]): Promise<AnalysisResult> {
    return {
      drafts: [],
      skipped_observation_ids: contexts.map((c) => c.observation.observation_id),
      errors: [],
    };
  }
}
