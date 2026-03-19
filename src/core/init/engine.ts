/**
 * Init Engine
 * Implements §8.2: detect → preview → approve → materialize
 *
 * Key invariant: init reuses approveProposal() — no separate Canonical mutation path.
 */

import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { Repository } from '../store/repository.js';
import { AlreadyInitializedError } from '../store/repository.js';
import type { CanonicalVersion } from '../types.js';
import {
  type DetectionEvidence,
  detectStack,
  type InitWarning,
  type ProfileCandidate,
  resolvePlaceholders,
  type StackDetection,
  scoreProfile,
} from './detector.js';
import {
  loadAllManifests,
  type ResolvedSeedDocument,
  type ResolvedSeedEdge,
  type ResolvedSeedLayerRule,
  resolveTemplate,
} from './template-loader.js';

// ── InitPreview (mirrors v2 §8.3) ──

export interface InitPreview {
  preview_hash: string;

  detection: {
    stack: StackDetection;
    architecture_profiles: ProfileCandidate[];
    evidence: DetectionEvidence[];
  };

  generated: {
    documents: ResolvedSeedDocument[];
    edges: ResolvedSeedEdge[];
    layer_rules: ResolvedSeedLayerRule[];
  };

  warnings: InitWarning[];
  has_blocking_warnings: boolean;

  template_id: string;
  template_version: string;

  // Internal: needed by init_confirm
  _placeholders: Record<string, string | null>;
}

export interface InitDetectOptions {
  skip_template?: boolean;
}

/**
 * init_detect — Stage 1+2: detect stack, score profiles, generate preview.
 */
export function initDetect(
  projectRoot: string,
  templatesRoot: string,
  extraTemplateDirs?: string[],
  options?: InitDetectOptions,
): InitPreview {
  // ── Stage 1: detect ──
  const stack = detectStack(projectRoot);

  if (options?.skip_template) {
    const warnings: InitWarning[] = [
      {
        severity: 'warn',
        message:
          'Template skipped. Knowledge base will be empty — use aegis_import_doc (admin surface) to add documents from your codebase.',
      },
    ];
    return templatelessPreview(stack, [], [], warnings);
  }

  const manifests = loadAllManifests(templatesRoot, extraTemplateDirs);

  const allEvidence: DetectionEvidence[] = [];
  const profiles: ProfileCandidate[] = [];

  for (const { manifest } of manifests) {
    const result = scoreProfile(manifest, projectRoot);
    if (result) {
      profiles.push(result.candidate);
      allEvidence.push(...result.evidence);
    }
  }

  // Sort by score DESC → profile_id ASC (deterministic)
  profiles.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.profile_id.localeCompare(b.profile_id);
  });

  // ── Stage 2: preview ──
  const warnings: InitWarning[] = [];

  // ── Profile selection with ambiguity handling ──
  const selection = selectProfile(profiles, warnings);

  if (selection.kind === 'ambiguous') {
    return emptyPreview(stack, profiles, allEvidence, warnings);
  }

  if (selection.kind === 'none') {
    warnings.push({
      severity: 'warn',
      message:
        'No matching architecture profile found. Knowledge base will be empty — use aegis_import_doc (admin surface) to add documents from your codebase.',
    });
    return templatelessPreview(stack, profiles, allEvidence, warnings);
  }

  const selectedProfile = selection.profile;

  const selectedEntry = manifests.find((m) => m.manifest.template_id === selectedProfile.profile_id);
  if (!selectedEntry) {
    warnings.push({ severity: 'block', message: `Template for profile '${selectedProfile.profile_id}' not found.` });
    return emptyPreview(stack, profiles, allEvidence, warnings);
  }

  const { dir: templateDir, manifest: selectedManifest } = selectedEntry;

  // Resolve placeholders
  const { resolved: placeholders, warnings: phWarnings } = resolvePlaceholders(selectedManifest, projectRoot);
  warnings.push(...phWarnings);

  // Resolve template seed data
  const generated = resolveTemplate(templateDir, selectedManifest, placeholders);

  // ── Compute preview_hash (ALL fields that affect Canonical state) ──
  const previewContent = JSON.stringify({
    template_id: selectedManifest.template_id,
    template_version: selectedManifest.version,
    placeholders,
    documents: generated.documents.map((d) => ({
      doc_id: d.doc_id,
      title: d.title,
      kind: d.kind,
      content_hash: d.content_hash,
    })),
    edges: generated.edges.map((e) => ({
      edge_id: e.edge_id,
      source_type: e.source_type,
      source_value: e.source_value,
      target_doc_id: e.target_doc_id,
      edge_type: e.edge_type,
      priority: e.priority,
      specificity: e.specificity,
    })),
    layer_rules: generated.layer_rules.map((r) => ({
      rule_id: r.rule_id,
      path_pattern: r.path_pattern,
      layer_name: r.layer_name,
      priority: r.priority,
      specificity: r.specificity,
    })),
  });
  const previewHash = createHash('sha256').update(previewContent).digest('hex');

  const hasBlocking = warnings.some((w) => w.severity === 'block');

  return {
    preview_hash: previewHash,
    detection: { stack, architecture_profiles: profiles, evidence: allEvidence },
    generated,
    warnings,
    has_blocking_warnings: hasBlocking,
    template_id: selectedManifest.template_id,
    template_version: selectedManifest.version,
    _placeholders: placeholders,
  };
}

type SelectResult = { kind: 'selected'; profile: ProfileCandidate } | { kind: 'none' } | { kind: 'ambiguous' };

/**
 * Select the best profile, emitting warnings for ambiguous or low-confidence situations.
 *
 * Rules:
 * - If no candidates at all → 'none'
 * - If top candidates are tied on score at high confidence → 'ambiguous' (block)
 * - If top candidate is 'low' confidence → 'selected' with warn
 * - Otherwise → 'selected'
 */
function selectProfile(profiles: ProfileCandidate[], warnings: InitWarning[]): SelectResult {
  if (profiles.length === 0) return { kind: 'none' };

  const top = profiles[0];

  // Check for same-score tie among top candidates
  const tied = profiles.filter((p) => p.score === top.score);
  if (tied.length > 1) {
    const tiedIds = tied.map((p) => p.profile_id).join(', ');
    if (top.confidence === 'high') {
      warnings.push({
        severity: 'block',
        message: `Ambiguous profile selection: [${tiedIds}] tied at score ${top.score}. Cannot auto-select.`,
        suggestion: 'Use init_detect with skip_template or an explicit profile selection.',
      });
      return { kind: 'ambiguous' };
    }
    // Tied but not high — warn and pick the first (deterministic via sort)
    warnings.push({
      severity: 'warn',
      message: `Multiple profiles tied at score ${top.score}: [${tiedIds}]. Auto-selecting '${top.profile_id}'.`,
      suggestion: 'Review the selected profile before confirming.',
    });
  }

  // Low confidence warning
  if (top.confidence === 'low') {
    warnings.push({
      severity: 'warn',
      message: `Selected profile '${top.profile_id}' has low confidence (score: ${top.score}).`,
      suggestion: 'Review the generated seed data carefully before confirming.',
    });
  }

  return { kind: 'selected', profile: top };
}

function emptyPreview(
  stack: StackDetection,
  profiles: ProfileCandidate[],
  evidence: DetectionEvidence[],
  warnings: InitWarning[],
): InitPreview {
  return {
    preview_hash: '',
    detection: { stack, architecture_profiles: profiles, evidence },
    generated: { documents: [], edges: [], layer_rules: [] },
    warnings,
    has_blocking_warnings: true,
    template_id: '',
    template_version: '',
    _placeholders: {},
  };
}

/**
 * Template-less preview: empty generated content but confirmable (has_blocking_warnings: false).
 * Used when skip_template is set or no profiles matched.
 */
function templatelessPreview(
  stack: StackDetection,
  profiles: ProfileCandidate[],
  evidence: DetectionEvidence[],
  warnings: InitWarning[],
): InitPreview {
  const previewContent = JSON.stringify({
    template_id: 'none',
    template_version: '0.0.0',
    placeholders: {},
    documents: [],
    edges: [],
    layer_rules: [],
  });
  const previewHash = createHash('sha256').update(previewContent).digest('hex');

  return {
    preview_hash: previewHash,
    detection: { stack, architecture_profiles: profiles, evidence },
    generated: { documents: [], edges: [], layer_rules: [] },
    warnings,
    has_blocking_warnings: false,
    template_id: 'none',
    template_version: '0.0.0',
    _placeholders: {},
  };
}

/**
 * init_confirm — Stage 3+4: verify preview_hash, create bootstrap proposal, approve, record manifest.
 *
 * Reuses repo.approveProposal() — no Canonical bypass.
 */
export function initConfirm(repo: Repository, preview: InitPreview, confirmPreviewHash: string): CanonicalVersion {
  // Guard: already initialized
  if (repo.isInitialized()) {
    throw new AlreadyInitializedError();
  }

  // Guard: blocking warnings
  if (preview.has_blocking_warnings) {
    throw new Error('Cannot confirm init with blocking warnings. Resolve them first.');
  }

  // Guard: TOCTOU — preview_hash must match
  if (preview.preview_hash !== confirmPreviewHash) {
    throw new PreviewHashMismatchError(confirmPreviewHash, preview.preview_hash);
  }

  // ── Stage 3: create bootstrap proposal ──
  const proposalId = `boot-${uuidv4()}`;
  const payload = {
    documents: preview.generated.documents,
    edges: preview.generated.edges,
    layer_rules: preview.generated.layer_rules,
  };

  repo.insertProposal({
    proposal_id: proposalId,
    proposal_type: 'bootstrap',
    payload: JSON.stringify(payload),
    status: 'pending',
    review_comment: null,
  });

  // ── Stage 4: approve (reuses standard governance) ──
  const result = repo.approveProposal(proposalId);

  // Record template provenance on bootstrapped documents (ADR-006 D-7)
  const provenanceTag = `${preview.template_id}:${preview.template_version}`;
  for (const doc of preview.generated.documents) {
    repo.setDocumentTemplateOrigin(doc.doc_id, provenanceTag);
  }

  // Record init provenance in init_manifest
  repo.insertInitManifest({
    template_id: preview.template_id,
    template_version: preview.template_version,
    preview_hash: preview.preview_hash,
    stack_detection: JSON.stringify(preview.detection.stack),
    selected_profile: preview.detection.architecture_profiles[0]?.profile_id ?? '',
    placeholders: JSON.stringify(preview._placeholders),
    initial_snapshot_id: result.snapshot_id,
    seed_counts: JSON.stringify({
      documents: preview.generated.documents.length,
      edges: preview.generated.edges.length,
      layer_rules: preview.generated.layer_rules.length,
    }),
  });

  return result;
}

export class PreviewHashMismatchError extends Error {
  constructor(provided: string, expected: string) {
    super(
      `Preview hash mismatch: provided '${provided.slice(0, 12)}...' does not match expected '${expected.slice(0, 12)}...'`,
    );
    this.name = 'PreviewHashMismatchError';
  }
}
