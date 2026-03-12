/**
 * ObservationAnalyzer Port
 *
 * Defines the interface for analyzing observations and producing proposal drafts.
 * Implementations: RuleBasedAnalyzer (first), SLM-powered (future), FakeAnalyzer (tests).
 */

import type { AnalysisContext, AnalysisResult } from '../types.js';

export interface ObservationAnalyzer {
  analyze(contexts: AnalysisContext[]): Promise<AnalysisResult>;
}
