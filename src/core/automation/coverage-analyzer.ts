/**
 * CoverageAnalyzer
 *
 * ADR-015 Phase 4: wraps RuleBasedAnalyzer for compile_miss and filters proposals using
 * edge-validation (duplicate / subsumed-by wider edge) + impact precomputation.
 */

import { buildCoverageOptimizationContext } from '../optimization/edge-candidate-builder.js';
import { validatePathRequiresEdge } from '../optimization/edge-validation.js';
import type { Repository } from '../store/repository.js';
import type { AnalysisContext, AnalysisResult, ProposalDraft } from '../types.js';
import type { ObservationAnalyzer } from './analyzer.js';
import { RuleBasedAnalyzer } from './rule-analyzer.js';

export class CoverageAnalyzer implements ObservationAnalyzer {
  private readonly rules = new RuleBasedAnalyzer();

  constructor(private readonly repo: Repository) {}

  async analyze(contexts: AnalysisContext[]): Promise<AnalysisResult> {
    const base = await this.rules.analyze(contexts);

    const approvedDocs = this.repo.getApprovedDocuments();
    const approvedDocIds = new Set(approvedDocs.map((d) => d.doc_id));
    const pathEdges = this.repo.getApprovedEdgesByType('path_requires');
    const compileRows = this.repo.listCompileLogStatsRows();
    const compileMisses = this.repo.listObservationsByEventType('compile_miss');

    const batchTargetFiles = contexts.flatMap((ctx) => {
      try {
        const pl = JSON.parse(ctx.observation.payload) as { target_files?: string[] };
        return pl.target_files ?? [];
      } catch {
        return [];
      }
    });
    const { missClusters } = buildCoverageOptimizationContext(compileMisses, batchTargetFiles, this.repo);

    const filteredDrafts: ProposalDraft[] = [];
    for (const draft of base.drafts) {
      if (draft.proposal_type !== 'add_edge') {
        filteredDrafts.push(draft);
        continue;
      }
      const p = draft.payload as {
        source_type?: string;
        source_value?: string;
        target_doc_id?: string;
        edge_type?: string;
      };
      if (
        p.source_type !== 'path' ||
        p.edge_type !== 'path_requires' ||
        typeof p.source_value !== 'string' ||
        typeof p.target_doc_id !== 'string'
      ) {
        filteredDrafts.push(draft);
        continue;
      }

      if (
        missClusters.length > 0 &&
        !missClusters.some(
          (c) =>
            c.pattern === p.source_value &&
            c.missing_doc === p.target_doc_id &&
            draft.evidence_observation_ids.some((id) => c.observation_ids.includes(id)),
        )
      ) {
        continue;
      }

      const validation = validatePathRequiresEdge({
        proposed: {
          source_type: 'path',
          source_value: p.source_value,
          target_doc_id: p.target_doc_id,
          edge_type: 'path_requires',
        },
        approvedDocIds,
        approvedPathEdges: pathEdges,
        compileLogRows: compileRows.map((r) => ({
          compile_id: r.compile_id,
          request: r.request,
          base_doc_ids: r.base_doc_ids,
        })),
        compileMissObservations: compileMisses,
      });

      if (!validation.target_exists || validation.duplicate || validation.subsumed_by !== null) {
        continue;
      }

      filteredDrafts.push(draft);
    }

    const hadDraftObs = new Set(base.drafts.flatMap((d) => d.evidence_observation_ids));
    const keptObs = new Set(filteredDrafts.flatMap((d) => d.evidence_observation_ids));
    const extraSkipped = [...hadDraftObs].filter((id) => !keptObs.has(id));

    return {
      drafts: filteredDrafts,
      skipped_observation_ids: [...base.skipped_observation_ids, ...extraSkipped],
      errors: base.errors,
    };
  }
}
