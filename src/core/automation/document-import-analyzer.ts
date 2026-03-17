/**
 * DocumentImportAnalyzer
 *
 * Analyzes `document_import` observations and produces `new_doc` + `add_edge` drafts.
 * Per ADR-002: metadata is supplied by the caller; Aegis validates only.
 */

import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { Repository } from '../store/repository.js';
import type { AnalysisContext, AnalysisResult, DocumentKind, EdgeSpec, ProposalDraft } from '../types.js';
import type { ObservationAnalyzer } from './analyzer.js';

const VALID_KINDS: DocumentKind[] = ['guideline', 'pattern', 'constraint', 'template', 'reference'];
const DOC_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export class DocumentImportAnalyzer implements ObservationAnalyzer {
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
    if (ctx.observation.event_type !== 'document_import') {
      return [];
    }

    const payload = JSON.parse(ctx.observation.payload) as {
      content: string;
      doc_id: string;
      title: string;
      kind: string;
      edge_hints?: EdgeSpec[];
      tags?: string[];
      source_path?: string;
    };

    this.validate(payload);

    const contentHash = createHash('sha256').update(payload.content).digest('hex');
    const obsId = ctx.observation.observation_id;
    const drafts: ProposalDraft[] = [];

    const existingDoc = this.repo.getDocumentById(payload.doc_id);

    if (existingDoc) {
      const updatePayload: Record<string, unknown> = {
        doc_id: payload.doc_id,
        content: payload.content,
        content_hash: contentHash,
      };
      if (payload.title) {
        updatePayload.title = payload.title;
      }
      if (payload.source_path) {
        updatePayload.source_path = payload.source_path;
      }
      if (payload.tags && payload.tags.length > 0) {
        updatePayload.tags = payload.tags;
      }
      drafts.push({
        proposal_type: 'update_doc',
        payload: updatePayload,
        evidence_observation_ids: [obsId],
      });
    } else {
      const newDocPayload: Record<string, unknown> = {
        doc_id: payload.doc_id,
        title: payload.title,
        kind: payload.kind,
        content: payload.content,
        content_hash: contentHash,
      };
      if (payload.tags && payload.tags.length > 0) {
        newDocPayload.tags = payload.tags;
      }
      if (payload.source_path) {
        newDocPayload.source_path = payload.source_path;
      }
      drafts.push({
        proposal_type: 'new_doc',
        payload: newDocPayload,
        evidence_observation_ids: [obsId],
      });
    }

    if (payload.edge_hints && payload.edge_hints.length > 0) {
      for (const hint of payload.edge_hints) {
        if (hint.edge_type === 'doc_depends_on') {
          if (this.repo.wouldCreateCycle(hint.source_value, payload.doc_id)) {
            continue;
          }
        }

        drafts.push({
          proposal_type: 'add_edge',
          payload: {
            edge_id: uuidv4(),
            source_type: hint.source_type,
            source_value: hint.source_value,
            target_doc_id: payload.doc_id,
            edge_type: hint.edge_type,
            priority: hint.priority ?? 100,
            specificity: 0,
          },
          evidence_observation_ids: [obsId],
        });
      }
    }

    return drafts;
  }

  private validate(payload: {
    content: string;
    doc_id: string;
    title: string;
    kind: string;
    edge_hints?: EdgeSpec[];
  }): void {
    if (!payload.content || typeof payload.content !== 'string') {
      throw new Error('document_import: content is required and must be non-empty');
    }
    if (!payload.doc_id || !DOC_ID_PATTERN.test(payload.doc_id)) {
      throw new Error(`document_import: doc_id must match ${DOC_ID_PATTERN} (got: "${payload.doc_id}")`);
    }
    if (!payload.title || typeof payload.title !== 'string') {
      throw new Error('document_import: title is required');
    }
    if (!VALID_KINDS.includes(payload.kind as DocumentKind)) {
      throw new Error(`document_import: kind must be one of ${VALID_KINDS.join(', ')} (got: "${payload.kind}")`);
    }
  }
}
