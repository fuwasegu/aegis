/**
 * StalenessAnalyzer
 *
 * ADR-015 Task 015-07: `staleness_detected` is diagnostic pipeline output — same pattern as
 * `doc_gap_detected`. Observations are marked analyzed with no proposals (admin reviews findings
 * via maintenance report / list_observations).
 */

import type { AnalysisContext, AnalysisResult } from '../types.js';
import type { ObservationAnalyzer } from './analyzer.js';

export class StalenessAnalyzer implements ObservationAnalyzer {
  async analyze(contexts: AnalysisContext[]): Promise<AnalysisResult> {
    return {
      drafts: [],
      skipped_observation_ids: contexts.map((c) => c.observation.observation_id),
      errors: [],
    };
  }
}
