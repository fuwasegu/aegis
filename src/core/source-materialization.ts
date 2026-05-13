/**
 * Deterministic anchor materializer for single-source / single-anchor compile units.
 * Reads a repo artifact and extracts the anchored region, producing content + content_hash.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { splitMarkdownSections } from './optimization/import-plan.js';
import { resolveSourcePath } from './paths.js';
import type { SourceRef } from './types.js';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type AnchorMaterializationFailureKind =
  | 'unsupported_shape'
  | 'ambiguous_anchor'
  | 'missing_anchor'
  | 'invalid_range'
  | 'unreadable_source';

export type AnchorMaterializationResult =
  | {
      ok: true;
      content: string;
      content_hash: string;
      materialization_kind: 'markdown-section' | 'line-range';
    }
  | {
      ok: false;
      kind: AnchorMaterializationFailureKind;
      detail: string;
    };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function materializeAnchoredContent(params: {
  projectRoot: string;
  source_path: string;
  source_ref: SourceRef;
}): AnchorMaterializationResult {
  const { projectRoot, source_path, source_ref } = params;

  // Guard: only single-anchor, section or lines
  if (source_ref.anchor_type === 'file') {
    return fail('unsupported_shape', 'anchor_type "file" is not an anchored extraction; use full-file sync instead');
  }
  if (source_ref.anchor_type !== 'section' && source_ref.anchor_type !== 'lines') {
    return fail('unsupported_shape', `unsupported anchor_type: ${source_ref.anchor_type as string}`);
  }

  // Validate containment (prevents ../traversal and symlink escape)
  let absPath: string;
  try {
    absPath = resolveSourcePath(source_path, projectRoot);
  } catch {
    return fail('unreadable_source', `source_path escapes project root: ${source_path}`);
  }

  // Read source file
  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf-8');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail('unreadable_source', `cannot read ${source_path}: ${msg}`);
  }

  if (source_ref.anchor_type === 'section') {
    return materializeSection(raw, source_ref.anchor_value);
  }
  return materializeLines(raw, source_ref.anchor_value);
}

// ---------------------------------------------------------------------------
// Section extraction
// ---------------------------------------------------------------------------

function materializeSection(raw: string, anchorValue: string): AnchorMaterializationResult {
  // Only support exact `## Heading` form
  if (!anchorValue.startsWith('## ')) {
    return fail('unsupported_shape', `section anchor must start with "## "; got: ${anchorValue}`);
  }

  const headingText = anchorValue.slice(3).trim();
  const sections = splitMarkdownSections(raw);

  const matches = sections.filter((s) => s.title === headingText);
  if (matches.length === 0) {
    return fail('missing_anchor', `section heading not found: ${anchorValue}`);
  }
  if (matches.length > 1) {
    return fail(
      'ambiguous_anchor',
      `duplicate heading "${anchorValue}" appears ${matches.length} times; cannot deterministically resolve`,
    );
  }

  return ok(matches[0].body, 'markdown-section');
}

// ---------------------------------------------------------------------------
// Line-range extraction
// ---------------------------------------------------------------------------

const LINE_RANGE_RE = /^(\d+)-(\d+)$/;

function materializeLines(raw: string, anchorValue: string): AnchorMaterializationResult {
  const m = anchorValue.match(LINE_RANGE_RE);
  if (!m) {
    return fail('invalid_range', `anchor_value must be "start-end" (digits); got: ${anchorValue}`);
  }

  const start = Number(m[1]);
  const end = Number(m[2]);

  if (start < 1 || end < 1) {
    return fail('invalid_range', `line numbers must be >= 1; got: ${anchorValue}`);
  }
  if (start > end) {
    return fail('invalid_range', `start must be <= end; got: ${anchorValue}`);
  }

  const normalized = raw.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  if (end > lines.length) {
    return fail('invalid_range', `end line ${end} exceeds file length ${lines.length}`);
  }

  const slice = lines.slice(start - 1, end);
  const content = slice.join('\n');

  return ok(content, 'line-range');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(content: string, materialization_kind: 'markdown-section' | 'line-range'): AnchorMaterializationResult {
  const content_hash = createHash('sha256').update(content).digest('hex');
  return { ok: true, content, content_hash, materialization_kind };
}

function fail(kind: AnchorMaterializationFailureKind, detail: string): AnchorMaterializationResult {
  return { ok: false, kind, detail };
}
