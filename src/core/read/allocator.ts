/**
 * Delivery Allocator (ADR-009 D-7, D-8, D-9)
 *
 * Pure function module — no side effects, no DB access.
 * Assigns delivery state (inline/deferred/omitted) to each document
 * based on content_mode, budget, and source_path availability.
 */

import type {
  CompileAuditMeta,
  ContentMode,
  DeliveryStats,
  DeliveryType,
  ResolvedDoc,
} from '../types.js';
import { AUTO_INLINE_THRESHOLD_BYTES, BudgetExceededError, DEFAULT_MAX_INLINE_BYTES } from '../types.js';

/** Which section the doc belongs to — determines stable order priority. */
export type DocClass = 'template' | 'document' | 'expanded';

/** Input candidate for the allocator. Carries all metadata needed for allocation. */
export interface DocCandidate {
  doc_id: string;
  title: string;
  kind: string;
  content: string;
  content_bytes: number;
  content_hash: string;
  source_path: string | null;
  relevance: number | undefined;
  priority: number;
  doc_class: DocClass;
}

export interface AllocationOptions {
  content_mode: ContentMode;
  max_inline_bytes: number;
  command: string | undefined;
  compile_id: string;
}

export interface AllocationResult {
  /** Docs with delivery assigned. Same order as input candidates (stable). */
  docs: AllocatedDoc[];
  audit_meta: CompileAuditMeta;
}

export interface AllocatedDoc {
  doc_id: string;
  title: string;
  kind: string;
  content: string;
  content_bytes: number;
  content_hash: string;
  source_path: string | null;
  relevance: number | undefined;
  priority: number;
  doc_class: DocClass;
  delivery: DeliveryType;
  omit_reason?: string;
}

/**
 * Stable order for inline budget consumption (D-8 — reverse of omission order).
 *
 * Inline adoption order: templates → documents → expanded
 * (= templates are consumed first, expanded last)
 *
 * Within a class: relevance DESC (null last) → priority ASC (lower = more important,
 * matching compiler's edge convention) → doc_id ASC
 */
function inlineAdoptionOrder(a: DocCandidate, b: DocCandidate): number {
  // Class priority: template=0, document=1, expanded=2
  const classOrder: Record<DocClass, number> = { template: 0, document: 1, expanded: 2 };
  const ca = classOrder[a.doc_class];
  const cb = classOrder[b.doc_class];
  if (ca !== cb) return ca - cb;

  // Relevance DESC (null last)
  const ra = a.relevance ?? -1;
  const rb = b.relevance ?? -1;
  if (rb !== ra) return rb - ra;

  // Priority ASC (lower number = higher importance, matches compiler convention)
  if (a.priority !== b.priority) return a.priority - b.priority;

  // Tie-break: doc_id ASC
  return a.doc_id.localeCompare(b.doc_id);
}

/**
 * Allocate delivery state for all document candidates.
 *
 * Processing flow:
 * 1. Policy omission — non-scaffold templates → omitted (unless content_mode='always')
 * 2. Mandatory inline — source_path-less docs are always inline (all modes)
 * 3. Mandatory budget check — if mandatory alone exceeds budget → BudgetExceededError
 * 4. content_mode rules for remaining docs (source_path present)
 * 5. Budget allocation — sort by inline adoption order, fill budget
 */
export function allocateDelivery(
  candidates: DocCandidate[],
  options: AllocationOptions,
): AllocationResult {
  const { content_mode, max_inline_bytes, command, compile_id } = options;

  // Track policy-omitted doc_ids
  const policyOmittedDocIds: string[] = [];

  // ── Step 1: Policy omission (templates when command !== 'scaffold') ──
  // content_mode='always' disables policy omission
  const policyOmitTemplates = content_mode !== 'always' && command !== 'scaffold';

  // ── Classify each candidate ──
  const allocated: AllocatedDoc[] = candidates.map((c) => {
    // Policy omission check
    if (policyOmitTemplates && c.doc_class === 'template') {
      policyOmittedDocIds.push(c.doc_id);
      return { ...c, delivery: 'omitted' as DeliveryType, omit_reason: 'policy:non_scaffold_command' };
    }

    // ── Step 2: Mandatory inline (no source_path → must be inline) ──
    if (!c.source_path) {
      return { ...c, delivery: 'inline' as DeliveryType };
    }

    // ── Step 4: content_mode rules for docs WITH source_path ──
    switch (content_mode) {
      case 'always':
        // All docs are inline candidates
        return { ...c, delivery: 'inline' as DeliveryType };

      case 'auto':
        // Small docs inline, large docs deferred
        if (c.content_bytes <= AUTO_INLINE_THRESHOLD_BYTES) {
          return { ...c, delivery: 'inline' as DeliveryType };
        }
        return { ...c, delivery: 'deferred' as DeliveryType };

      case 'metadata':
        // source_path present → deferred
        return { ...c, delivery: 'deferred' as DeliveryType };
    }
  });

  // ── Step 3: Mandatory budget check ──
  const mandatoryInlineDocs = allocated.filter(
    (d) => d.delivery === 'inline' && !d.source_path,
  );
  const mandatoryBytes = mandatoryInlineDocs.reduce((sum, d) => sum + d.content_bytes, 0);

  if (mandatoryBytes > max_inline_bytes) {
    // Sort offending doc_ids by content_bytes descending
    const offending = [...mandatoryInlineDocs]
      .sort((a, b) => b.content_bytes - a.content_bytes)
      .map((d) => d.doc_id);

    throw new BudgetExceededError(compile_id, mandatoryBytes, max_inline_bytes, offending);
  }

  // ── Step 5: Budget allocation for non-mandatory inline candidates ──
  let remainingBudget = max_inline_bytes - mandatoryBytes;

  // Collect non-mandatory inline candidates (source_path present, delivery='inline')
  const inlineCandidateIndices: number[] = [];
  for (let i = 0; i < allocated.length; i++) {
    const d = allocated[i];
    if (d.delivery === 'inline' && d.source_path) {
      inlineCandidateIndices.push(i);
    }
  }

  // Sort candidate indices by inline adoption order
  inlineCandidateIndices.sort((ai, bi) => inlineAdoptionOrder(allocated[ai], allocated[bi]));

  // Fill budget
  for (const idx of inlineCandidateIndices) {
    const d = allocated[idx];
    if (d.content_bytes <= remainingBudget) {
      remainingBudget -= d.content_bytes;
      // stays inline
    } else {
      // Budget exceeded — fallback to deferred (has source_path)
      allocated[idx] = { ...d, delivery: 'deferred' };
    }
  }

  // ── Build audit meta ──
  const stats: DeliveryStats = {
    inline_count: 0,
    inline_total_bytes: 0,
    deferred_count: 0,
    deferred_total_bytes: 0,
    omitted_count: 0,
    omitted_total_bytes: 0,
  };

  for (const d of allocated) {
    switch (d.delivery) {
      case 'inline':
        stats.inline_count++;
        stats.inline_total_bytes += d.content_bytes;
        break;
      case 'deferred':
        stats.deferred_count++;
        stats.deferred_total_bytes += d.content_bytes;
        break;
      case 'omitted':
        stats.omitted_count++;
        stats.omitted_total_bytes += d.content_bytes;
        break;
    }
  }

  const audit_meta: CompileAuditMeta = {
    delivery_stats: stats,
    budget_utilization: max_inline_bytes > 0
      ? Math.round((stats.inline_total_bytes / max_inline_bytes) * 100) / 100
      : 0,
    budget_exceeded: false,
    policy_omitted_doc_ids: policyOmittedDocIds,
  };

  return { docs: allocated, audit_meta };
}
