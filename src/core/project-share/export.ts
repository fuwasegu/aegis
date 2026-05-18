/**
 * ADR-017: share-export — deterministic bundle writer.
 *
 * Reads approved Canonical Knowledge from the DB and writes
 * `manifest.json` + `canonical.json` to the output directory.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Repository } from '../store/repository.js';
import type {
  BundleDocument,
  BundleEdge,
  BundleLayerRule,
  BundleTagMapping,
  SharedCanonicalBundleV1,
  SharedCanonicalManifestV1,
  ShareExportResult,
} from './types.js';

/** Locale-independent code-point comparator (deterministic across environments). */
function codePointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Export approved Canonical Knowledge as a deterministic bundle.
 *
 * All DB reads are pinned inside a single transaction so that an approval
 * landing mid-export cannot cause the bundle to mix two knowledge versions.
 *
 * @param repo   Initialized Repository instance
 * @param outDir Output directory (default: `<projectRoot>/aegis-share`)
 * @returns Export result with counts and warnings
 * @throws If the DB is not initialized (knowledge_version === 0)
 */
export function shareExport(repo: Repository, outDir: string): ShareExportResult {
  // ---- snapshot-pinned read (single transaction) ----
  const snapshot = repo.runInTransactionReturn(() => {
    const meta = repo.getKnowledgeMeta();
    if (meta.current_version === 0) {
      throw new Error('Database is not initialized (knowledge_version = 0). Run aegis init first.');
    }

    const snap = repo.getCurrentSnapshot();
    if (!snap) {
      throw new Error('No snapshot found for current knowledge_version. Run aegis init or approve a proposal first.');
    }

    return {
      meta,
      snap,
      docs: repo.getApprovedDocuments(),
      edges: repo.getApprovedEdges(),
      rules: repo.getApprovedLayerRules(),
      tagMappings: repo.getApprovedTagMappings(),
      pendingCount: repo.listProposals('pending', 0, 0).total,
    };
  });

  const { meta, snap, docs, edges, rules, tagMappings, pendingCount } = snapshot;

  // Advisory warnings
  const warnings: string[] = [];
  if (pendingCount > 0) {
    warnings.push(
      `${pendingCount} pending proposal(s) not yet approved — bundle reflects current approved state only.`,
    );
  }

  // Build deterministic bundle (ADR-017 D-4)
  // All sorts use raw code-point ordering (< / >) for locale-independent determinism.
  const bundleDocuments: BundleDocument[] = docs
    .slice()
    .sort((a, b) => codePointCompare(a.doc_id, b.doc_id))
    .map((d) => ({
      doc_id: d.doc_id,
      title: d.title,
      kind: d.kind,
      content: d.content,
      content_hash: d.content_hash,
      ownership: d.ownership,
      template_origin: d.template_origin,
      source_path: d.source_path,
      source_refs_json: d.source_refs_json,
    }));

  const bundleEdges: BundleEdge[] = edges
    .slice()
    .sort((a, b) => codePointCompare(a.edge_id, b.edge_id))
    .map((e) => ({
      edge_id: e.edge_id,
      source_type: e.source_type,
      source_value: e.source_value,
      target_doc_id: e.target_doc_id,
      edge_type: e.edge_type,
      priority: e.priority,
      specificity: e.specificity,
    }));

  const bundleLayerRules: BundleLayerRule[] = rules
    .slice()
    .sort((a, b) => codePointCompare(a.rule_id, b.rule_id))
    .map((r) => ({
      rule_id: r.rule_id,
      path_pattern: r.path_pattern,
      layer_name: r.layer_name,
      priority: r.priority,
      specificity: r.specificity,
    }));

  const bundleTagMappings: BundleTagMapping[] = tagMappings
    .slice()
    .sort((a, b) => codePointCompare(a.tag, b.tag) || codePointCompare(a.doc_id, b.doc_id))
    .map((tm) => ({
      tag: tm.tag,
      doc_id: tm.doc_id,
      confidence: tm.confidence,
      source: tm.source,
    }));

  const bundle: SharedCanonicalBundleV1 = {
    format_version: 1,
    snapshot_id: snap.snapshot_id,
    knowledge_version: meta.current_version,
    documents: bundleDocuments,
    edges: bundleEdges,
    layer_rules: bundleLayerRules,
    tag_mappings: bundleTagMappings,
  };

  // Deterministic JSON serialization (stable key order via interface ordering + no trailing whitespace)
  const bundleJson = JSON.stringify(bundle, null, 2) + '\n';
  const bundleSha256 = createHash('sha256').update(bundleJson, 'utf-8').digest('hex');

  const manifest: SharedCanonicalManifestV1 = {
    format_version: 1,
    bundle_file: 'canonical.json',
    snapshot_id: snap.snapshot_id,
    knowledge_version: meta.current_version,
    bundle_sha256: bundleSha256,
    includes_tag_mappings: bundleTagMappings.length > 0,
  };

  const manifestJson = JSON.stringify(manifest, null, 2) + '\n';

  // Write files
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'canonical.json'), bundleJson, 'utf-8');
  writeFileSync(join(outDir, 'manifest.json'), manifestJson, 'utf-8');

  return {
    snapshot_id: snap.snapshot_id,
    knowledge_version: meta.current_version,
    bundle_sha256: bundleSha256,
    counts: {
      documents: bundleDocuments.length,
      edges: bundleEdges.length,
      layer_rules: bundleLayerRules.length,
      tag_mappings: bundleTagMappings.length,
    },
    warnings,
  };
}
