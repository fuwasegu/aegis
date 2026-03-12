/**
 * ReviewCorrectionAnalyzer
 *
 * Rule-based ObservationAnalyzer for review_correction events.
 *
 * Rules:
 * - review_correction with target_doc_id + proposed_content,
 *   where target doc exists and is approved → emit update_doc
 * - review_correction without both fields → skip
 * - target doc not found or not approved → skip
 * - non-review_correction → skip
 */

import { createHash } from 'node:crypto';
import type { ObservationAnalyzer } from './analyzer.js';
import type { Repository } from '../store/repository.js';
import type { AnalysisContext, AnalysisResult, ProposalDraft } from '../types.js';

export class ReviewCorrectionAnalyzer implements ObservationAnalyzer {
  constructor(private repo: Repository) {}

  async analyze(contexts: AnalysisContext[]): Promise<AnalysisResult> {
    const drafts: ProposalDraft[] = [];
    const skipped_observation_ids: string[] = [];
    const errors: Array<{ observation_id: string; reason: string }> = [];

    for (const ctx of contexts) {
      try {
        const result = this.analyzeOne(ctx);
        if (result) {
          drafts.push(result);
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

  private analyzeOne(ctx: AnalysisContext): ProposalDraft | null {
    if (ctx.observation.event_type !== 'review_correction') {
      return null;
    }

    const payload = JSON.parse(ctx.observation.payload) as {
      file_path: string;
      correction: string;
      target_doc_id?: string;
      proposed_content?: string;
    };

    if (!payload.target_doc_id || !payload.proposed_content) {
      return null;
    }

    // Verify target doc exists and is approved
    const docs = this.repo.getApprovedDocumentsByIds([payload.target_doc_id]);
    if (docs.length === 0) {
      return null;
    }

    const contentHash = createHash('sha256')
      .update(payload.proposed_content)
      .digest('hex');

    return {
      proposal_type: 'update_doc',
      payload: {
        doc_id: payload.target_doc_id,
        content: payload.proposed_content,
        content_hash: contentHash,
      },
      evidence_observation_ids: [ctx.observation.observation_id],
    };
  }
}
