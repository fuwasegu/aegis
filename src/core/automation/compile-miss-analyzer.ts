/**
 * Combines CoverageAnalyzer (compile_miss → proposals) with DocRefactorAnalyzer (split diagnostics).
 * The refactor pass is O(full table) — run once per `processObservations` drain (see {@link runDocRefactorPass}).
 */

import type { Repository } from '../store/repository.js';
import type { AnalysisContext, AnalysisResult } from '../types.js';
import type { ObservationAnalyzer } from './analyzer.js';
import { CoverageAnalyzer } from './coverage-analyzer.js';
import { DocRefactorAnalyzer } from './doc-refactor-analyzer.js';

export class CompileMissAnalyzer implements ObservationAnalyzer {
  private readonly coverage: CoverageAnalyzer;
  private readonly refactor: DocRefactorAnalyzer;

  constructor(repo: Repository) {
    this.coverage = new CoverageAnalyzer(repo);
    this.refactor = new DocRefactorAnalyzer(repo);
  }

  async analyze(contexts: AnalysisContext[]): Promise<AnalysisResult> {
    return this.coverage.analyze(contexts);
  }

  /** Invoke after the compile_miss queue is drained for this process_observations call. */
  async runDocRefactorPass(): Promise<void> {
    await this.refactor.analyze([]);
  }
}
