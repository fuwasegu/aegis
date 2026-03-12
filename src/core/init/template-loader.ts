/**
 * Template Manifest Loader
 * Loads manifest.yaml, evaluates `when` conditions, resolves placeholders,
 * and auto-calculates specificity.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';

// ── Manifest schema types (mirrors v2 §8.4) ──

export interface DetectSignal {
  type: 'file_exists' | 'dir_exists' | 'package_dependency' | 'dir_structure';
  path?: string;
  file?: string;
  key?: string;
  pattern?: string;
  weight?: number;
}

export interface PlaceholderDef {
  description: string;
  required: boolean;
  detect_strategy: 'first_match' | 'composer_autoload' | 'package_json_field';
  candidates?: string[];
  ambiguity_policy: 'first' | 'block';
  default: string | null;
}

export interface WhenCondition {
  placeholder: string;
  operator: 'is_not_null' | 'is_null' | 'equals';
  value?: string;
}

export interface SeedDocumentDef {
  doc_id: string;
  title: string;
  kind: string;
  file: string;
}

export interface SeedEdgeDef {
  source_type: string;
  source_value: string;
  target_doc_id: string;
  edge_type: string;
  priority: number;
  when?: WhenCondition;
}

export interface SeedLayerRuleDef {
  path_pattern: string;
  layer_name: string;
  priority: number;
  when?: WhenCondition;
}

export interface TemplateManifest {
  template_id: string;
  version: string;
  display_name: string;
  description: string;
  detect_signals: {
    required: DetectSignal[];
    boosters: (DetectSignal & { weight: number })[];
    confidence_thresholds: { high: number; medium: number };
  };
  placeholders: Record<string, PlaceholderDef>;
  seed_documents: SeedDocumentDef[];
  seed_edges: SeedEdgeDef[];
  seed_layer_rules: SeedLayerRuleDef[];
}

// ── Resolved seed types (after placeholder expansion + specificity calculation) ──

export interface ResolvedSeedDocument {
  doc_id: string;
  title: string;
  kind: string;
  content: string;
  content_hash: string;
}

export interface ResolvedSeedEdge {
  edge_id: string;
  source_type: string;
  source_value: string;
  target_doc_id: string;
  edge_type: string;
  priority: number;
  specificity: number;
}

export interface ResolvedSeedLayerRule {
  rule_id: string;
  path_pattern: string;
  layer_name: string;
  priority: number;
  specificity: number;
}

/**
 * Load and parse a template manifest from disk.
 */
export function loadManifest(templateDir: string): TemplateManifest {
  const manifestPath = join(templateDir, 'manifest.yaml');
  const raw = readFileSync(manifestPath, 'utf-8');
  return yaml.load(raw) as TemplateManifest;
}

/**
 * Load all template manifests from the templates root directory.
 */
export function loadAllManifests(templatesRoot: string): { dir: string; manifest: TemplateManifest }[] {
  const results: { dir: string; manifest: TemplateManifest }[] = [];
  for (const entry of readdirSync(templatesRoot)) {
    const dir = join(templatesRoot, entry);
    if (statSync(dir).isDirectory() && existsSync(join(dir, 'manifest.yaml'))) {
      results.push({ dir, manifest: loadManifest(dir) });
    }
  }
  return results;
}

/**
 * Evaluate a `when` condition against resolved placeholders.
 */
export function evaluateWhen(
  when: WhenCondition | undefined,
  placeholders: Record<string, string | null>,
): boolean {
  if (!when) return true;
  const val = placeholders[when.placeholder] ?? null;
  switch (when.operator) {
    case 'is_not_null': return val !== null;
    case 'is_null': return val === null;
    case 'equals': return val === when.value;
    default: return false;
  }
}

/**
 * Expand {{placeholder}} tokens in a string.
 */
export function expandPlaceholders(template: string, values: Record<string, string | null>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = values[key];
    return val ?? '';
  });
}

/**
 * Auto-calculate specificity from a glob pattern.
 * Based on segment count (number of path separators + 1 for non-** segments).
 * More specific patterns get higher scores.
 */
export function calculateSpecificity(globPattern: string): number {
  const segments = globPattern.split('/');
  let score = 0;
  for (const seg of segments) {
    if (seg === '**') {
      // Wildcard — doesn't add specificity
      continue;
    } else if (seg.includes('*')) {
      // Partial wildcard — partial specificity
      score += 1;
    } else {
      // Exact segment — full specificity
      score += 2;
    }
  }
  return score;
}

/**
 * Resolve a template's seed data: expand placeholders, evaluate `when` conditions,
 * load document content, compute hashes and specificity.
 */
export function resolveTemplate(
  templateDir: string,
  manifest: TemplateManifest,
  placeholders: Record<string, string | null>,
): {
  documents: ResolvedSeedDocument[];
  edges: ResolvedSeedEdge[];
  layer_rules: ResolvedSeedLayerRule[];
} {
  // ── Documents (with placeholder expansion in content) ──
  const documents: ResolvedSeedDocument[] = [];
  for (const docDef of manifest.seed_documents) {
    const filePath = join(templateDir, 'documents', docDef.file);
    const rawContent = readFileSync(filePath, 'utf-8');
    const content = expandPlaceholders(rawContent, placeholders);
    const contentHash = createHash('sha256').update(content).digest('hex');
    documents.push({
      doc_id: docDef.doc_id,
      title: docDef.title,
      kind: docDef.kind,
      content,
      content_hash: contentHash,
    });
  }

  // ── Edges (with when + placeholder expansion + specificity) ──
  const edges: ResolvedSeedEdge[] = [];
  let edgeCounter = 0;
  for (const edgeDef of manifest.seed_edges) {
    if (!evaluateWhen(edgeDef.when, placeholders)) continue;

    const sourceValue = expandPlaceholders(edgeDef.source_value, placeholders);
    const specificity = edgeDef.source_type === 'path'
      ? calculateSpecificity(sourceValue)
      : 0;

    edgeCounter++;
    edges.push({
      edge_id: `${manifest.template_id}-edge-${edgeCounter}`,
      source_type: edgeDef.source_type,
      source_value: sourceValue,
      target_doc_id: edgeDef.target_doc_id,
      edge_type: edgeDef.edge_type,
      priority: edgeDef.priority,
      specificity,
    });
  }

  // ── Layer Rules (with when + placeholder expansion + specificity) ──
  const layer_rules: ResolvedSeedLayerRule[] = [];
  let ruleCounter = 0;
  for (const ruleDef of manifest.seed_layer_rules) {
    if (!evaluateWhen(ruleDef.when, placeholders)) continue;

    const pathPattern = expandPlaceholders(ruleDef.path_pattern, placeholders);
    const specificity = calculateSpecificity(pathPattern);

    ruleCounter++;
    layer_rules.push({
      rule_id: `${manifest.template_id}-rule-${ruleCounter}`,
      path_pattern: pathPattern,
      layer_name: ruleDef.layer_name,
      priority: ruleDef.priority,
      specificity,
    });
  }

  return { documents, edges, layer_rules };
}
