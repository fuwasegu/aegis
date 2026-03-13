/**
 * RuleBasedAnalyzer
 *
 * Simple rule-based ObservationAnalyzer for compile_miss events.
 *
 * Rules:
 * - compile_miss with missing_doc → propose add_edge (path_requires)
 * - compile_miss without missing_doc → skip (cannot auto-propose)
 * - non-compile_miss → skip
 */

import { v4 as uuidv4 } from 'uuid';
import type { AnalysisContext, AnalysisResult, ProposalDraft } from '../types.js';
import type { ObservationAnalyzer } from './analyzer.js';

export class RuleBasedAnalyzer implements ObservationAnalyzer {
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
    if (ctx.observation.event_type !== 'compile_miss') {
      return [];
    }

    const payload = JSON.parse(ctx.observation.payload) as {
      target_files: string[];
      missing_doc?: string;
      review_comment: string;
    };

    if (!payload.missing_doc) {
      return [];
    }

    // Derive unique directory patterns from all target_files
    const patterns = new Set<string>();
    for (const file of payload.target_files) {
      patterns.add(this.derivePathPattern(file));
    }

    return [...patterns].map((sourceValue) => ({
      proposal_type: 'add_edge' as const,
      payload: {
        edge_id: uuidv4(),
        source_type: 'path',
        source_value: sourceValue,
        target_doc_id: payload.missing_doc!,
        edge_type: 'path_requires',
        priority: 100,
        specificity: this.calculateSpecificity(sourceValue),
      },
      evidence_observation_ids: [ctx.observation.observation_id],
    }));
  }

  /**
   * Derive a directory-level glob from a file path.
   * "app/Domain/User/UserEntity.php" → "app/Domain/User/**"
   * "index.ts" → "**"
   */
  private derivePathPattern(filePath: string): string {
    const parts = filePath.split('/');
    if (parts.length <= 1) {
      return '**';
    }
    return `${parts.slice(0, -1).join('/')}/**`;
  }

  private calculateSpecificity(pattern: string): number {
    return pattern.split('/').filter((s) => s !== '**' && s !== '*').length;
  }
}
