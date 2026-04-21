/**
 * DocumentImportAnalyzer
 *
 * Analyzes `document_import` observations and produces `new_doc` + `add_edge` drafts.
 * Per ADR-002: metadata is supplied by the caller; Aegis validates only.
 */

import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { serializeSourceRefs } from '../source-refs.js';
import type { Repository } from '../store/repository.js';
import type { AnalysisContext, AnalysisResult, DocumentKind, EdgeSpec, ProposalDraft, SourceRef } from '../types.js';
import type { ObservationAnalyzer } from './analyzer.js';

const VALID_KINDS: DocumentKind[] = ['guideline', 'pattern', 'constraint', 'template', 'reference'];
const DOC_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export type DocumentImportObservationPayload = {
  content: string;
  doc_id: string;
  title: string;
  kind: string;
  edge_hints?: EdgeSpec[];
  tags?: string[];
  source_path?: string;
  /** Normalized repo-relative refs (caller supplies projectRoot normalization). */
  source_refs?: SourceRef[];
};

/**
 * Build proposal drafts for a validated `document_import` payload (shared with {@link DocumentImportAnalyzer}
 * and {@link executeImportPlan}).
 */
export function buildDocumentImportDraftsFromPayload(
  repo: Repository,
  payload: DocumentImportObservationPayload,
  observationId: string,
): ProposalDraft[] {
  validateDocumentImportPayload(payload);

  const contentHash = createHash('sha256').update(payload.content).digest('hex');
  const drafts: ProposalDraft[] = [];

  const existingDoc = repo.getDocumentById(payload.doc_id);

  const sourceRefsJson =
    payload.source_refs && payload.source_refs.length > 0 ? serializeSourceRefs(payload.source_refs) : null;
  /** Only explicit `source_path` (execute_import slice anchor, import_doc file_path, etc.). Never infer from `source_refs[0]` — that would wrongly file-anchor every split unit to the same path (015-10). */
  const effectiveSourcePath =
    typeof payload.source_path === 'string' && payload.source_path.trim() !== ''
      ? payload.source_path.trim()
      : undefined;

  if (existingDoc) {
    const updatePayload: Record<string, unknown> = {
      doc_id: payload.doc_id,
      content: payload.content,
      content_hash: contentHash,
    };
    if (payload.title) {
      updatePayload.title = payload.title;
    }
    if (effectiveSourcePath) {
      updatePayload.source_path = effectiveSourcePath;
      updatePayload.ownership = 'file-anchored';
      if (!(payload.source_refs && payload.source_refs.length > 0)) {
        updatePayload.source_refs_json = null;
      }
    }
    if (sourceRefsJson) {
      updatePayload.source_refs_json = sourceRefsJson;
      updatePayload.ownership = 'file-anchored';
      /** Refs-only update — clear legacy column so provenance stays a true distinct set (015-10). */
      if (effectiveSourcePath === undefined) {
        updatePayload.source_path = null;
      }
    }
    if (payload.tags && payload.tags.length > 0) {
      updatePayload.tags = payload.tags;
    }
    drafts.push({
      proposal_type: 'update_doc',
      payload: updatePayload,
      evidence_observation_ids: [observationId],
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
    if (effectiveSourcePath) {
      newDocPayload.source_path = effectiveSourcePath;
    }
    if (sourceRefsJson) {
      newDocPayload.source_refs_json = sourceRefsJson;
    }
    drafts.push({
      proposal_type: 'new_doc',
      payload: newDocPayload,
      evidence_observation_ids: [observationId],
    });
  }

  if (payload.edge_hints && payload.edge_hints.length > 0) {
    for (const hint of payload.edge_hints) {
      if (hint.edge_type === 'doc_depends_on') {
        if (repo.wouldCreateCycle(hint.source_value, payload.doc_id)) {
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
        evidence_observation_ids: [observationId],
      });
    }
  }

  return drafts;
}

function validateDocumentImportPayload(payload: DocumentImportObservationPayload): void {
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

    const payload = JSON.parse(ctx.observation.payload) as DocumentImportObservationPayload;

    return buildDocumentImportDraftsFromPayload(this.repo, payload, ctx.observation.observation_id);
  }
}
