import type { Proposal, ProposalType } from '../types.js';
import type { Repository } from './repository.js';

export class ProposalBundleOrderingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposalBundleOrderingError';
  }
}

function parsePayload(p: Proposal): Record<string, unknown> {
  try {
    return JSON.parse(p.payload) as Record<string, unknown>;
  } catch {
    throw new ProposalBundleOrderingError(`Proposal ${p.proposal_id}: invalid JSON payload`);
  }
}

/** Reject bundles that both deprecate a document and mutate/route to that document (ordering cannot fix). */
function assertNoDeprecateVersusMutationConflicts(repo: Repository, proposals: Proposal[]): void {
  const deprecateDocIds = new Set<string>();
  for (const p of proposals) {
    if (p.proposal_type !== 'deprecate') continue;
    const raw = parsePayload(p);
    if (raw.entity_type === 'document' && typeof raw.entity_id === 'string' && raw.entity_id.length > 0) {
      deprecateDocIds.add(raw.entity_id);
    }
  }
  if (deprecateDocIds.size === 0) return;

  for (const p of proposals) {
    const raw = parsePayload(p);
    if (p.proposal_type === 'new_doc') {
      const id = raw.doc_id;
      if (typeof id === 'string' && deprecateDocIds.has(id)) {
        throw new ProposalBundleOrderingError(
          `Bundle conflict: new_doc for '${id}' cannot combine with deprecate(document '${id}')`,
        );
      }
    }
    if (p.proposal_type === 'update_doc') {
      const id = raw.doc_id;
      if (typeof id === 'string' && deprecateDocIds.has(id)) {
        throw new ProposalBundleOrderingError(
          `Bundle conflict: update_doc on '${id}' cannot combine with deprecate(document '${id}')`,
        );
      }
    }
    if (p.proposal_type === 'add_edge') {
      const t = raw.target_doc_id;
      if (typeof t === 'string' && deprecateDocIds.has(t)) {
        throw new ProposalBundleOrderingError(
          `Bundle conflict: add_edge targets document '${t}' which is deprecated in this bundle`,
        );
      }
      if (raw.source_type === 'doc') {
        const s = raw.source_value;
        if (typeof s === 'string' && s.length > 0 && deprecateDocIds.has(s)) {
          throw new ProposalBundleOrderingError(
            `Bundle conflict: add_edge uses source document '${s}' which is deprecated in this bundle`,
          );
        }
      }
    }
    if (p.proposal_type === 'retarget_edge') {
      if (typeof raw.target_doc_id === 'string' && raw.target_doc_id.length > 0) {
        if (deprecateDocIds.has(raw.target_doc_id)) {
          throw new ProposalBundleOrderingError(
            `Bundle conflict: retarget_edge targets document '${raw.target_doc_id}' which is deprecated in this bundle`,
          );
        }
      }
      const edgeId = raw.edge_id;
      if (typeof edgeId !== 'string' || edgeId.length === 0) {
        continue;
      }
      const existing = repo.getEdgeById(edgeId);
      let resolvedSourceType: string | undefined;
      let newSourceStr = '';
      if (existing) {
        resolvedSourceType = existing.source_type;
        newSourceStr = existing.source_value;
      } else {
        const addP = proposals.find((x) => {
          if (x.proposal_type !== 'add_edge') return false;
          const ar = parsePayload(x);
          return ar.edge_id === edgeId;
        });
        if (addP) {
          const ar = parsePayload(addP);
          resolvedSourceType = typeof ar.source_type === 'string' ? ar.source_type : undefined;
          const sv = ar.source_value;
          newSourceStr = typeof sv === 'string' ? sv : '';
        }
      }
      if (typeof raw.source_value === 'string' && raw.source_value.length > 0) {
        newSourceStr = raw.source_value;
      }
      if (resolvedSourceType === 'doc' && newSourceStr.length > 0 && deprecateDocIds.has(newSourceStr)) {
        throw new ProposalBundleOrderingError(
          `Bundle conflict: retarget_edge uses source document '${newSourceStr}' which is deprecated in this bundle`,
        );
      }
    }
  }
}

function requireDocReady(
  docId: string,
  approvedDocIds: Set<string>,
  newDocPidByDocId: Map<string, string>,
  updateDocPidByDocId: Map<string, string>,
  consumerPid: string,
  addOrderingEdge: (before: string, after: string) => void,
  label: string,
): void {
  if (approvedDocIds.has(docId)) return;
  const creator = newDocPidByDocId.get(docId);
  if (creator) {
    addOrderingEdge(creator, consumerPid);
    return;
  }
  const updater = updateDocPidByDocId.get(docId);
  if (updater) {
    addOrderingEdge(updater, consumerPid);
    return;
  }
  throw new ProposalBundleOrderingError(
    `${label}: document '${docId}' is not approved and is not created by a new_doc or update_doc in this bundle`,
  );
}

function requireEdgeReady(
  edgeId: string,
  approvedEdgeIds: Set<string>,
  addEdgePidByEdgeId: Map<string, string>,
  consumerPid: string,
  addOrderingEdge: (before: string, after: string) => void,
  label: string,
): void {
  if (approvedEdgeIds.has(edgeId)) return;
  const creator = addEdgePidByEdgeId.get(edgeId);
  if (creator) {
    addOrderingEdge(creator, consumerPid);
    return;
  }
  throw new ProposalBundleOrderingError(
    `${label}: edge '${edgeId}' is not approved and is not created by add_edge in this bundle`,
  );
}

/**
 * Computes a valid topological apply order for pending proposals sharing a bundle.
 * @throws ProposalBundleOrderingError when dependencies cannot be satisfied or a cycle exists.
 */
export function orderPendingBundleProposals(repo: Repository, proposals: Proposal[]): Proposal[] {
  if (proposals.length === 0) {
    throw new ProposalBundleOrderingError('Bundle has no proposals');
  }

  const boots = proposals.filter((p) => p.proposal_type === 'bootstrap');
  if (boots.length > 1) {
    throw new ProposalBundleOrderingError('Bundle contains multiple bootstrap proposals');
  }
  if (boots.length === 1 && proposals.length > 1) {
    throw new ProposalBundleOrderingError('bootstrap cannot be combined with other proposals in a bundle');
  }
  if (boots.length === 1) {
    return proposals;
  }

  assertNoDeprecateVersusMutationConflicts(repo, proposals);

  const approvedDocIds = new Set(repo.getApprovedDocuments().map((d) => d.doc_id));
  const approvedEdgeIds = new Set(repo.getApprovedEdges().map((e) => e.edge_id));
  const approvedRuleIds = new Set(repo.getApprovedLayerRules().map((r) => r.rule_id));

  const newDocPidByDocId = new Map<string, string>();
  const addEdgePidByEdgeId = new Map<string, string>();
  const updateDocPidByDocId = new Map<string, string>();

  for (const p of proposals) {
    const raw = parsePayload(p);
    if (p.proposal_type === 'new_doc') {
      const docId = raw.doc_id;
      if (typeof docId !== 'string' || docId.length === 0) {
        throw new ProposalBundleOrderingError(`new_doc proposal ${p.proposal_id}: missing doc_id`);
      }
      if (newDocPidByDocId.has(docId)) {
        throw new ProposalBundleOrderingError(`Duplicate new_doc for doc_id '${docId}' in bundle`);
      }
      if (approvedDocIds.has(docId)) {
        throw new ProposalBundleOrderingError(`new_doc proposal ${p.proposal_id}: doc_id '${docId}' already exists`);
      }
      newDocPidByDocId.set(docId, p.proposal_id);
    }
    if (p.proposal_type === 'add_edge') {
      const eid = raw.edge_id;
      if (typeof eid !== 'string' || eid.length === 0) {
        throw new ProposalBundleOrderingError(`add_edge proposal ${p.proposal_id}: missing edge_id`);
      }
      if (addEdgePidByEdgeId.has(eid)) {
        throw new ProposalBundleOrderingError(`Duplicate add_edge for edge_id '${eid}' in bundle`);
      }
      if (approvedEdgeIds.has(eid)) {
        throw new ProposalBundleOrderingError(`add_edge proposal ${p.proposal_id}: edge_id '${eid}' already exists`);
      }
      addEdgePidByEdgeId.set(eid, p.proposal_id);
    }
  }

  for (const p of proposals) {
    if (p.proposal_type !== 'update_doc') continue;
    const raw = parsePayload(p);
    const docId = raw.doc_id;
    if (typeof docId !== 'string' || docId.length === 0) {
      throw new ProposalBundleOrderingError(`update_doc proposal ${p.proposal_id}: missing doc_id`);
    }
    if (updateDocPidByDocId.has(docId)) {
      throw new ProposalBundleOrderingError(`Duplicate update_doc for doc_id '${docId}' in bundle`);
    }
    if (newDocPidByDocId.has(docId)) {
      continue;
    }
    const doc = repo.getDocumentById(docId);
    if (!doc) {
      throw new ProposalBundleOrderingError(`update_doc proposal ${p.proposal_id}: document '${docId}' does not exist`);
    }
    if (!approvedDocIds.has(docId)) {
      updateDocPidByDocId.set(docId, p.proposal_id);
    }
  }

  const ids = proposals.map((p) => p.proposal_id);
  const forward = new Map<string, Set<string>>();
  const indeg = new Map<string, number>();
  for (const id of ids) {
    forward.set(id, new Set());
    indeg.set(id, 0);
  }

  const addOrderingEdge = (beforePid: string, afterPid: string): void => {
    if (beforePid === afterPid) return;
    const outs = forward.get(beforePid);
    if (!outs) return;
    if (!outs.has(afterPid)) {
      outs.add(afterPid);
      indeg.set(afterPid, (indeg.get(afterPid) ?? 0) + 1);
    }
  };

  for (const p of proposals) {
    const raw = parsePayload(p);
    const pid = p.proposal_id;

    switch (p.proposal_type as ProposalType) {
      case 'new_doc':
        break;
      case 'add_edge': {
        const target = raw.target_doc_id;
        if (typeof target !== 'string' || target.length === 0) {
          throw new ProposalBundleOrderingError(`add_edge ${pid}: missing target_doc_id`);
        }
        requireDocReady(
          target,
          approvedDocIds,
          newDocPidByDocId,
          updateDocPidByDocId,
          pid,
          addOrderingEdge,
          `add_edge ${pid}`,
        );
        if (raw.source_type === 'doc') {
          const src = raw.source_value;
          if (typeof src !== 'string' || src.length === 0) {
            throw new ProposalBundleOrderingError(`add_edge ${pid}: doc source requires non-empty source_value`);
          }
          requireDocReady(
            src,
            approvedDocIds,
            newDocPidByDocId,
            updateDocPidByDocId,
            pid,
            addOrderingEdge,
            `add_edge ${pid} source doc`,
          );
        }
        break;
      }
      case 'update_doc': {
        const docId = raw.doc_id;
        if (typeof docId !== 'string') {
          throw new ProposalBundleOrderingError(`update_doc ${pid}: missing doc_id`);
        }
        requireDocReady(
          docId,
          approvedDocIds,
          newDocPidByDocId,
          updateDocPidByDocId,
          pid,
          addOrderingEdge,
          `update_doc ${pid}`,
        );
        break;
      }
      case 'deprecate': {
        const entityType = raw.entity_type;
        const entityId = raw.entity_id;
        if (entityType !== 'document' && entityType !== 'edge' && entityType !== 'layer_rule') {
          throw new ProposalBundleOrderingError(`deprecate ${pid}: invalid entity_type`);
        }
        if (typeof entityId !== 'string' || entityId.length === 0) {
          throw new ProposalBundleOrderingError(`deprecate ${pid}: missing entity_id`);
        }
        if (entityType === 'document') {
          requireDocReady(
            entityId,
            approvedDocIds,
            newDocPidByDocId,
            updateDocPidByDocId,
            pid,
            addOrderingEdge,
            `deprecate ${pid}`,
          );
        } else if (entityType === 'edge') {
          requireEdgeReady(entityId, approvedEdgeIds, addEdgePidByEdgeId, pid, addOrderingEdge, `deprecate ${pid}`);
        } else {
          if (!approvedRuleIds.has(entityId)) {
            throw new ProposalBundleOrderingError(
              `deprecate ${pid}: layer_rule '${entityId}' is not approved (cannot be created in-bundle)`,
            );
          }
        }
        const replacedBy = raw.replaced_by_doc_id;
        if (typeof replacedBy === 'string' && replacedBy.trim() !== '') {
          requireDocReady(
            replacedBy.trim(),
            approvedDocIds,
            newDocPidByDocId,
            updateDocPidByDocId,
            pid,
            addOrderingEdge,
            `deprecate ${pid} replaced_by_doc_id`,
          );
        }
        break;
      }
      case 'retarget_edge': {
        const edgeId = raw.edge_id;
        if (typeof edgeId !== 'string' || edgeId.length === 0) {
          throw new ProposalBundleOrderingError(`retarget_edge ${pid}: missing edge_id`);
        }
        requireEdgeReady(edgeId, approvedEdgeIds, addEdgePidByEdgeId, pid, addOrderingEdge, `retarget_edge ${pid}`);
        const existing = repo.getEdgeById(edgeId);
        let resolvedSourceType: string | undefined;
        let newSourceStr = '';
        if (existing) {
          resolvedSourceType = existing.source_type;
          newSourceStr = existing.source_value;
        } else {
          const addPid = addEdgePidByEdgeId.get(edgeId);
          const addProp = proposals.find((x) => x.proposal_id === addPid);
          const addRaw = addProp ? parsePayload(addProp) : undefined;
          resolvedSourceType = typeof addRaw?.source_type === 'string' ? addRaw.source_type : undefined;
          const sv = addRaw?.source_value;
          newSourceStr = typeof sv === 'string' ? sv : '';
        }
        if (typeof raw.source_value === 'string' && raw.source_value.length > 0) {
          newSourceStr = raw.source_value;
        }
        if (resolvedSourceType === 'doc' && newSourceStr.length > 0) {
          requireDocReady(
            newSourceStr,
            approvedDocIds,
            newDocPidByDocId,
            updateDocPidByDocId,
            pid,
            addOrderingEdge,
            `retarget_edge ${pid} source doc`,
          );
        }
        let newTarget: string | undefined;
        if (typeof raw.target_doc_id === 'string' && raw.target_doc_id.length > 0) {
          newTarget = raw.target_doc_id;
        } else if (existing) {
          newTarget = existing.target_doc_id;
        } else {
          const addPid = addEdgePidByEdgeId.get(edgeId);
          const addProp = proposals.find((x) => x.proposal_id === addPid);
          const addRaw = addProp ? parsePayload(addProp) : undefined;
          const t = addRaw?.target_doc_id;
          if (typeof t === 'string') newTarget = t;
        }
        if (typeof newTarget === 'string' && newTarget.length > 0) {
          requireDocReady(
            newTarget,
            approvedDocIds,
            newDocPidByDocId,
            updateDocPidByDocId,
            pid,
            addOrderingEdge,
            `retarget_edge ${pid}`,
          );
        }
        break;
      }
      case 'remove_edge': {
        const edgeId = raw.edge_id;
        if (typeof edgeId !== 'string' || edgeId.length === 0) {
          throw new ProposalBundleOrderingError(`remove_edge ${pid}: missing edge_id`);
        }
        requireEdgeReady(edgeId, approvedEdgeIds, addEdgePidByEdgeId, pid, addOrderingEdge, `remove_edge ${pid}`);
        break;
      }
      case 'bootstrap':
        break;
      default:
        throw new ProposalBundleOrderingError(`Unsupported proposal_type in bundle: ${p.proposal_type}`);
    }
  }

  const queue: string[] = [];
  for (const id of ids) {
    if ((indeg.get(id) ?? 0) === 0) queue.push(id);
  }
  queue.sort();

  const sorted: string[] = [];
  while (queue.length > 0) {
    const u = queue.shift()!;
    sorted.push(u);
    const outs = forward.get(u)!;
    const outsArr = [...outs].sort();
    for (const v of outsArr) {
      indeg.set(v, (indeg.get(v) ?? 0) - 1);
      if ((indeg.get(v) ?? 0) === 0) {
        queue.push(v);
        queue.sort();
      }
    }
  }

  if (sorted.length !== proposals.length) {
    throw new ProposalBundleOrderingError('Cycle detected in bundle proposal dependencies');
  }

  const byId = new Map(proposals.map((p) => [p.proposal_id, p]));
  return sorted.map((id) => byId.get(id)!);
}
