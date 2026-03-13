/**
 * ManualNoteAnalyzer
 *
 * Rule-based ObservationAnalyzer for manual_note events.
 *
 * Strategy:
 * - manual_note with target_doc_id + proposed_content → update_doc (same as review_correction)
 * - manual_note with new_doc_hint + content → new_doc proposal
 * - manual_note without hints → skip (store only, no automation)
 */

import { createHash } from 'node:crypto';
import type { Repository } from '../store/repository.js';
import type { AnalysisContext, AnalysisResult, DocumentKind, ProposalDraft } from '../types.js';
import type { ObservationAnalyzer } from './analyzer.js';

export class ManualNoteAnalyzer implements ObservationAnalyzer {
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
    if (ctx.observation.event_type !== 'manual_note') {
      return null;
    }

    const payload = JSON.parse(ctx.observation.payload) as {
      content: string;
      target_doc_id?: string;
      proposed_content?: string;
      new_doc_hint?: {
        doc_id: string;
        title: string;
        kind: DocumentKind;
      };
    };

    if (payload.target_doc_id && payload.proposed_content) {
      return this.tryUpdateDoc(ctx, payload);
    }

    if (payload.new_doc_hint) {
      return this.tryNewDoc(ctx, payload);
    }

    return null;
  }

  private tryUpdateDoc(
    ctx: AnalysisContext,
    payload: { target_doc_id?: string; proposed_content?: string },
  ): ProposalDraft | null {
    const docs = this.repo.getApprovedDocumentsByIds([payload.target_doc_id!]);
    if (docs.length === 0) return null;

    const contentHash = createHash('sha256').update(payload.proposed_content!).digest('hex');

    return {
      proposal_type: 'update_doc',
      payload: {
        doc_id: payload.target_doc_id!,
        content: payload.proposed_content!,
        content_hash: contentHash,
      },
      evidence_observation_ids: [ctx.observation.observation_id],
    };
  }

  private tryNewDoc(
    ctx: AnalysisContext,
    payload: { content: string; new_doc_hint?: { doc_id: string; title: string; kind: DocumentKind } },
  ): ProposalDraft | null {
    const hint = payload.new_doc_hint!;
    const contentHash = createHash('sha256').update(payload.content).digest('hex');

    return {
      proposal_type: 'new_doc',
      payload: {
        doc_id: hint.doc_id,
        title: hint.title,
        kind: hint.kind,
        content: payload.content,
        content_hash: contentHash,
      },
      evidence_observation_ids: [ctx.observation.observation_id],
    };
  }
}
