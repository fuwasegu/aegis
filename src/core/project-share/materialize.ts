/**
 * ADR-018 Task 018-04: share-materialize — source-native lane materializer.
 *
 * Parses shared source, validates, computes content hashes, then delegates
 * diff + apply to Repository.applyMaterialize (single transaction).
 */

import { createHash } from 'node:crypto';
import type { Repository } from '../store/repository.js';
import type { MaterializeChangeCounts } from '../types.js';
import { lintParseResult } from './lint.js';
import { parseSharedSource } from './source-parser.js';
import type { SourceDocument, SourceEdge, SourceLayerRule, SourceTagMapping } from './source-types.js';

export type { MaterializeChangeCounts } from '../types.js';

// -- Result types --------------------------------------------------------

export interface ShareMaterializeResult {
  dry_run: boolean;
  knowledge_version: number;
  snapshot_id: string | null;
  changes: MaterializeChangeCounts;
  warnings: string[];
}

// -- Parsed source with hashes -------------------------------------------

export interface MaterializeSource {
  documents: Array<SourceDocument & { content_hash: string }>;
  edges: SourceEdge[];
  layer_rules: SourceLayerRule[];
  tag_mappings: SourceTagMapping[];
}

// -- Content hash --------------------------------------------------------

function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// -- Public API ----------------------------------------------------------

export interface ShareMaterializeOptions {
  sourceDir: string;
  repo: Repository;
  dryRun?: boolean;
  projectRoot?: string;
}

/**
 * Materialize shared source into the authoring DB.
 *
 * 1. Parse shared source
 * 2. Lint/validate (fail fast on errors)
 * 3. Compute content hashes
 * 4. Delegate diff + apply to Repository (single transaction)
 */
export function shareMaterialize(opts: ShareMaterializeOptions): ShareMaterializeResult {
  const { sourceDir, repo, dryRun = false, projectRoot } = opts;
  const warnings: string[] = [];

  // 1. Parse
  const parsed = parseSharedSource(sourceDir);

  // 2. Lint/validate
  const lintResult = lintParseResult(parsed);
  if (!lintResult.ok) {
    const errorSummary = lintResult.errors.map((e) => `${e.file} [${e.location}]: ${e.message}`).join('; ');
    throw new Error(`Shared source validation failed: ${errorSummary}`);
  }

  // 3. Pre-checks
  if (!repo.isInitialized()) {
    throw new Error('Database is not initialized (knowledge_version = 0). Run aegis init first.');
  }

  // Guard: empty source against non-empty DB would deprecate all documents
  if (parsed.documents.length === 0 && repo.getApprovedDocuments().length > 0) {
    throw new Error(
      'Shared source contains no documents but the database has approved documents. ' +
        'This would deprecate all existing documents. ' +
        'If intentional, deprecate documents individually via the admin surface.',
    );
  }

  // 4. Compute content hashes
  const source: MaterializeSource = {
    documents: parsed.documents.map((d) => ({ ...d, content_hash: computeContentHash(d.content) })),
    edges: parsed.edges,
    layer_rules: parsed.layer_rules,
    tag_mappings: parsed.tag_mappings,
  };

  // 5. Delegate diff + apply to Repository (single transaction)
  const result = repo.applyMaterialize(source, dryRun, projectRoot);

  if (result.no_changes) {
    warnings.push('No changes detected — database is already in sync with shared source.');
  }

  return {
    dry_run: dryRun,
    knowledge_version: result.knowledge_version,
    snapshot_id: dryRun ? null : result.snapshot_id,
    changes: result.changes,
    warnings,
  };
}
