/**
 * PrMergedAnalyzer
 *
 * Rule-based ObservationAnalyzer for pr_merged events.
 *
 * Strategy:
 * - Extract directory-level patterns from files_changed
 * - Check which patterns are NOT covered by existing path_requires edges
 * - For uncovered patterns, propose add_edge targeting the architecture root doc
 * - Skip observations where all changed files are already covered
 */

import { v4 as uuidv4 } from 'uuid';
import picomatch from 'picomatch';
import type { ObservationAnalyzer } from './analyzer.js';
import type { Repository } from '../store/repository.js';
import type { AnalysisContext, AnalysisResult, ProposalDraft } from '../types.js';

export class PrMergedAnalyzer implements ObservationAnalyzer {
  constructor(private repo: Repository) {}

  async analyze(contexts: AnalysisContext[]): Promise<AnalysisResult> {
    const drafts: ProposalDraft[] = [];
    const skipped_observation_ids: string[] = [];
    const errors: Array<{ observation_id: string; reason: string }> = [];

    for (const ctx of contexts) {
      try {
        const result = this.analyzeOne(ctx);
        if (result.length > 0) {
          drafts.push(...result);
        } else {
          skipped_observation_ids.push(ctx.observation.observation_id);
        }
      } catch (e) {
        errors.push({
          observation_id: ctx.observation.observation_id,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return { drafts, skipped_observation_ids, errors };
  }

  private analyzeOne(ctx: AnalysisContext): ProposalDraft[] {
    if (ctx.observation.event_type !== 'pr_merged') {
      return [];
    }

    const payload = JSON.parse(ctx.observation.payload) as {
      pr_id: string;
      summary: string;
      files_changed: string[];
    };

    if (!payload.files_changed || payload.files_changed.length === 0) {
      return [];
    }

    const existingEdges = this.repo.getApprovedEdgesByType('path_requires');
    const existingPatterns = existingEdges.map(e => e.source_value);

    const uncoveredPatterns = this.findUncoveredPatterns(payload.files_changed, existingPatterns);

    if (uncoveredPatterns.length === 0) {
      return [];
    }

    const rootDoc = this.findRootDocument();
    if (!rootDoc) {
      return [];
    }

    return uncoveredPatterns.map(pattern => ({
      proposal_type: 'add_edge' as const,
      payload: {
        edge_id: uuidv4(),
        source_type: 'path',
        source_value: pattern,
        target_doc_id: rootDoc,
        edge_type: 'path_requires',
        priority: 150,
        specificity: this.calculateSpecificity(pattern),
      },
      evidence_observation_ids: [ctx.observation.observation_id],
    }));
  }

  private findUncoveredPatterns(files: string[], existingPatterns: string[]): string[] {
    const matchers = existingPatterns.map(p => picomatch(p));

    const dirPatterns = new Set<string>();
    for (const file of files) {
      const covered = matchers.some(match => match(file));
      if (!covered) {
        dirPatterns.add(this.derivePathPattern(file));
      }
    }

    return [...dirPatterns];
  }

  private findRootDocument(): string | null {
    const docs = this.repo.getApprovedDocuments();
    const root = docs.find(d => d.kind === 'guideline' && d.doc_id.includes('root'));
    return root?.doc_id ?? docs[0]?.doc_id ?? null;
  }

  private derivePathPattern(filePath: string): string {
    const parts = filePath.split('/');
    if (parts.length <= 1) return '**';
    return parts.slice(0, -1).join('/') + '/**';
  }

  private calculateSpecificity(pattern: string): number {
    return pattern.split('/').filter(s => s !== '**' && s !== '*').length;
  }
}
