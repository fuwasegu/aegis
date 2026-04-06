/**
 * ProposeService
 *
 * Internal service (NOT exposed via MCP) that persists ProposalDrafts
 * from an ObservationAnalyzer into the proposals + proposal_evidence tables.
 *
 * Guarantees:
 * - Idempotent: re-running on already-proposed observations skips duplicates
 * - P-3 compliant: proposals are always created as 'pending'
 * - Transaction: each draft is persisted atomically (proposal + evidence)
 */

import { v4 as uuidv4 } from 'uuid';
import type { Repository } from '../store/repository.js';
import type { ProposalDraft, ProposalType } from '../types.js';

export interface ProposeResult {
  created_proposal_ids: string[];
  skipped_duplicate_count: number;
}

/**
 * Semantic key extraction per proposal_type.
 * These fields uniquely identify the "intent" of a proposal,
 * excluding volatile fields like edge_id (UUID) or priority.
 */
const SEMANTIC_KEY_EXTRACTORS: Record<ProposalType, (p: Record<string, unknown>) => string> = {
  add_edge: (p) => `${p.source_type}:${p.source_value}:${p.target_doc_id}:${p.edge_type}`,
  retarget_edge: (p) => `retarget:${p.edge_id}`,
  remove_edge: (p) => `remove:${p.edge_id}`,
  new_doc: (p) => `${p.doc_id}`,
  update_doc: (p) => `${p.doc_id}`,
  deprecate: (p) => `${p.entity_type}:${p.entity_id}`,
  bootstrap: () => 'bootstrap',
};

function extractSemanticKey(proposalType: ProposalType, payload: Record<string, unknown>): string {
  return SEMANTIC_KEY_EXTRACTORS[proposalType](payload);
}

export class ProposeService {
  constructor(private repo: Repository) {}

  propose(drafts: ProposalDraft[]): ProposeResult {
    // Pre-compute duplicate set BEFORE any inserts to avoid
    // intra-batch interference (e.g. same observation → multiple add_edge drafts)
    const duplicateIndices = new Set<number>();
    for (let i = 0; i < drafts.length; i++) {
      if (this.isDuplicateInDb(drafts[i])) {
        duplicateIndices.add(i);
      }
    }

    const created_proposal_ids: string[] = [];
    let skipped_duplicate_count = 0;

    for (let i = 0; i < drafts.length; i++) {
      if (duplicateIndices.has(i)) {
        skipped_duplicate_count++;
        continue;
      }

      const draft = drafts[i];
      const proposalId = uuidv4();

      this.repo.runInTransaction(() => {
        this.repo.insertProposal({
          proposal_id: proposalId,
          proposal_type: draft.proposal_type,
          payload: JSON.stringify(draft.payload),
          status: 'pending',
          review_comment: null,
        });

        for (const obsId of draft.evidence_observation_ids) {
          this.repo.insertProposalEvidence(proposalId, obsId);
        }
      });

      created_proposal_ids.push(proposalId);
    }

    return { created_proposal_ids, skipped_duplicate_count };
  }

  /**
   * Check if any pending proposal of the same type already has the same
   * semantic key (globally, not scoped to the evidence observation).
   * This prevents concurrent conflicting proposals for the same entity.
   */
  private isDuplicateInDb(draft: ProposalDraft): boolean {
    const draftKey = extractSemanticKey(draft.proposal_type, draft.payload);

    const pendingProposals = this.repo.getPendingProposalsByType(draft.proposal_type);
    for (const existing of pendingProposals) {
      const existingPayload = JSON.parse(existing.payload) as Record<string, unknown>;
      const existingKey = extractSemanticKey(draft.proposal_type, existingPayload);
      if (existingKey === draftKey) {
        return true;
      }
    }
    return false;
  }
}
