/**
 * Template Upgrade Engine
 *
 * Detects differences between the currently installed template version
 * and a newer version, and generates proposals to bring Canonical up to date.
 *
 * Scope: only template-originated seed data. User-added documents/edges are untouched.
 */

import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { Repository } from '../store/repository.js';
import type { ProposalDraft } from '../types.js';
import {
  loadAllManifests, resolveTemplate,
  type ResolvedSeedDocument, type ResolvedSeedEdge, type ResolvedSeedLayerRule,
} from './template-loader.js';
import { resolvePlaceholders } from './detector.js';

export interface UpgradePreview {
  template_id: string;
  from_version: string;
  to_version: string;
  changes: UpgradeChange[];
  has_changes: boolean;
}

export type UpgradeChange =
  | { type: 'update_doc'; doc_id: string; old_hash: string; new_hash: string }
  | { type: 'new_doc'; doc_id: string; title: string }
  | { type: 'new_edge'; edge_id: string; source_value: string; target_doc_id: string }
  | { type: 'new_layer_rule'; rule_id: string; path_pattern: string; layer_name: string };

export function detectUpgrade(
  repo: Repository,
  templatesRoot: string,
): UpgradePreview | null {
  const manifest = repo.getInitManifest();
  if (!manifest) return null;

  const templateId = manifest.template_id;
  const fromVersion = manifest.template_version;
  const storedPlaceholders = JSON.parse(manifest.placeholders) as Record<string, string | null>;

  const allManifests = loadAllManifests(templatesRoot);
  const entry = allManifests.find(m => m.manifest.template_id === templateId);
  if (!entry) return null;

  const currentManifest = entry.manifest;
  const toVersion = currentManifest.version;

  if (fromVersion === toVersion) {
    return { template_id: templateId, from_version: fromVersion, to_version: toVersion, changes: [], has_changes: false };
  }

  const generated = resolveTemplate(entry.dir, currentManifest, storedPlaceholders);
  const changes: UpgradeChange[] = [];

  // Check document changes
  const existingDocs = repo.getApprovedDocuments();
  const existingDocMap = new Map(existingDocs.map(d => [d.doc_id, d]));

  for (const newDoc of generated.documents) {
    const existing = existingDocMap.get(newDoc.doc_id);
    if (!existing) {
      changes.push({ type: 'new_doc', doc_id: newDoc.doc_id, title: newDoc.title });
    } else if (existing.content_hash !== newDoc.content_hash) {
      changes.push({ type: 'update_doc', doc_id: newDoc.doc_id, old_hash: existing.content_hash, new_hash: newDoc.content_hash });
    }
  }

  // Check edge changes
  const existingEdges = repo.getApprovedEdges();
  const existingEdgeSet = new Set(existingEdges.map(e => `${e.source_type}:${e.source_value}:${e.target_doc_id}:${e.edge_type}`));

  for (const newEdge of generated.edges) {
    const key = `${newEdge.source_type}:${newEdge.source_value}:${newEdge.target_doc_id}:${newEdge.edge_type}`;
    if (!existingEdgeSet.has(key)) {
      changes.push({ type: 'new_edge', edge_id: newEdge.edge_id, source_value: newEdge.source_value, target_doc_id: newEdge.target_doc_id });
    }
  }

  // Check layer_rule changes
  const existingRules = repo.getApprovedLayerRules();
  const existingRuleSet = new Set(existingRules.map(r => `${r.path_pattern}:${r.layer_name}`));

  for (const newRule of generated.layer_rules) {
    const key = `${newRule.path_pattern}:${newRule.layer_name}`;
    if (!existingRuleSet.has(key)) {
      changes.push({ type: 'new_layer_rule', rule_id: newRule.rule_id, path_pattern: newRule.path_pattern, layer_name: newRule.layer_name });
    }
  }

  return {
    template_id: templateId,
    from_version: fromVersion,
    to_version: toVersion,
    changes,
    has_changes: changes.length > 0,
  };
}

export function generateUpgradeProposals(
  preview: UpgradePreview,
  repo: Repository,
  templatesRoot: string,
): ProposalDraft[] {
  if (!preview.has_changes) return [];

  const allManifests = loadAllManifests(templatesRoot);
  const entry = allManifests.find(m => m.manifest.template_id === preview.template_id);
  if (!entry) return [];

  const manifest = repo.getInitManifest();
  if (!manifest) return [];

  const storedPlaceholders = JSON.parse(manifest.placeholders) as Record<string, string | null>;
  const generated = resolveTemplate(entry.dir, entry.manifest, storedPlaceholders);

  const docMap = new Map(generated.documents.map(d => [d.doc_id, d]));
  const drafts: ProposalDraft[] = [];

  for (const change of preview.changes) {
    switch (change.type) {
      case 'update_doc': {
        const doc = docMap.get(change.doc_id);
        if (doc) {
          drafts.push({
            proposal_type: 'update_doc',
            payload: {
              doc_id: doc.doc_id,
              content: doc.content,
              content_hash: doc.content_hash,
            },
            evidence_observation_ids: [],
          });
        }
        break;
      }
      case 'new_doc': {
        const doc = docMap.get(change.doc_id);
        if (doc) {
          drafts.push({
            proposal_type: 'new_doc',
            payload: {
              doc_id: doc.doc_id,
              title: doc.title,
              kind: doc.kind,
              content: doc.content,
              content_hash: doc.content_hash,
            },
            evidence_observation_ids: [],
          });
        }
        break;
      }
      case 'new_edge': {
        const edge = generated.edges.find(e => e.edge_id === change.edge_id);
        if (edge) {
          drafts.push({
            proposal_type: 'add_edge',
            payload: {
              edge_id: edge.edge_id,
              source_type: edge.source_type,
              source_value: edge.source_value,
              target_doc_id: edge.target_doc_id,
              edge_type: edge.edge_type,
              priority: edge.priority,
              specificity: edge.specificity,
            },
            evidence_observation_ids: [],
          });
        }
        break;
      }
    }
  }

  return drafts;
}
