/**
 * ADR-015 — import-plan: deterministic first-import analysis (admin request path, not observation-driven).
 */

import { createHash } from 'node:crypto';
import type { Repository } from '../store/repository.js';
import type { DocumentKind, EdgeSpec } from '../types.js';
import { derivePathPattern } from './edge-candidate-builder.js';
import { pathGlobSubsumes } from './edge-validation.js';

export const IMPORT_PLAN_ALGORITHM_VERSION = 'import-plan/1';

const DOC_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export interface SuggestedImportUnit {
  /** Stable within the parent ImportPlan (0-based). */
  unit_index: number;
  doc_id: string;
  title: string;
  kind: DocumentKind;
  content_slice: string;
  edge_hints: EdgeSpec[];
  tags: string[];
}

export interface OverlapWarning {
  existing_doc_id: string;
  similarity: number;
  /** Short deterministic reason. */
  reason: string;
}

export interface CoverageDelta {
  /** Distinct directory-level globs inferred from path-like strings in the import body. */
  proposed_path_globs: string[];
  /** How many of `proposed_path_globs` already appear as path/layer edge `source_value` in Canonical (approved). */
  existing_pattern_matches: number;
  /** proposed_path_globs.length - existing_pattern_matches (floored at 0). */
  estimated_new_coverage_globs: number;
  summary: string;
}

export interface ImportPlan {
  algorithm_version: string;
  /** Provenance / UX label only — never used as Canonical `source_path` or file anchor. */
  source_label: string | null;
  /**
   * Repo-relative path only when analysis read markdown from disk (`file_path`).
   * Execute uses this (after `normalizeSourcePath`) as `document_import.source_path`; omit or null for pure `content` flows.
   */
  resolved_source_path: string | null;
  suggested_units: SuggestedImportUnit[];
  overlap_warnings: OverlapWarning[];
  coverage_delta: CoverageDelta;
}

export interface CrossDocOverlap {
  /** Repo-relative labels for the two sources compared. */
  source_labels: [string | null, string | null];
  similarity: number;
  overlap_excerpt: string;
}

export interface BatchImportPlan {
  algorithm_version: string;
  plans: ImportPlan[];
  cross_doc_overlap: CrossDocOverlap[];
  total_coverage_delta: CoverageDelta;
}

/**
 * Token set for Jaccard similarity: Unicode letters/numbers (any script), plus adjacent bigrams on the
 * letter/digit-only stream so space-less languages (e.g. Japanese) get meaningful overlap.
 */
function tokenize(text: string): Set<string> {
  const nf = text.normalize('NFKC').toLowerCase();
  const tokens = new Set<string>();

  // Word-like runs (length ≥ 3): preserves English-style tokens and long CJK runs.
  const longRuns = nf.match(/[\p{L}\p{N}_]{3,}/gu);
  if (longRuns) {
    for (const w of longRuns) {
      tokens.add(w);
    }
  }

  // Short runs (length 2): helps short CJK words and Latin digrams not caught above.
  const shortRuns = nf.match(/[\p{L}\p{N}]{2}/gu);
  if (shortRuns) {
    for (const w of shortRuns) {
      tokens.add(w);
    }
  }

  const compact = nf.replace(/[^\p{L}\p{N}]+/gu, '');
  const maxCompact = 32_768;
  const slice = compact.length > maxCompact ? compact.slice(0, maxCompact) : compact;
  for (let i = 0; i + 1 < slice.length; i++) {
    tokens.add(slice.slice(i, i + 2));
  }

  return tokens;
}

/** Jaccard similarity on token sets (0–1). */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter++;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function slugDocId(raw: string, index: number): string {
  const nf = raw.normalize('NFKC');
  const slug = nf
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  /** Deterministic ASCII doc_id segment when heading is CJK-only (must satisfy {@link DOC_ID_PATTERN}). */
  const base = slug || `u${createHash('sha256').update(nf).digest('hex').slice(0, 12)}`;
  const candidate = `${base}-${index}`;
  if (DOC_ID_PATTERN.test(candidate)) return candidate;
  return `unit-${index}`;
}

/**
 * Split markdown on `## ` headings; preamble before the first `## ` is prepended to the first section body.
 */
export function splitMarkdownSections(content: string): Array<{ title: string; body: string }> {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const blocks: Array<{ title: string; lines: string[] }> = [];
  let preamble: string[] = [];
  let currentTitle = '';
  let currentLines: string[] = [];
  let seenH2 = false;

  for (const line of lines) {
    const m = line.match(/^## (.+)$/);
    if (m) {
      seenH2 = true;
      if (!currentTitle) {
        currentTitle = m[1].trim();
        currentLines = [...preamble];
        preamble = [];
      } else {
        blocks.push({ title: currentTitle, lines: currentLines });
        currentTitle = m[1].trim();
        currentLines = [];
      }
    } else if (!seenH2) {
      preamble.push(line);
    } else {
      currentLines.push(line);
    }
  }

  if (!seenH2) {
    const t = normalized.match(/^#\s+(.+)$/m);
    const title = t ? t[1].trim() : 'Imported document';
    return [{ title, body: normalized.trim() }];
  }

  blocks.push({ title: currentTitle, lines: currentLines });
  return blocks.map((b) => ({
    title: b.title,
    body: b.lines.join('\n').trim() || '(empty)',
  }));
}

/** Extract repo-like path strings; deterministic unique order. */
export function extractPathLikeStrings(body: string): string[] {
  const found = new Set<string>();
  const re = /(?:`|\b)((?:src|test|tests|docs|lib|app)\/[a-zA-Z0-9_.$/{}-]+(?:\.[a-zA-Z0-9]+)?)(?:`|\b)/g;
  for (;;) {
    const m = re.exec(body);
    if (m === null) break;
    const p = m[1].replace(/\/{2,}/g, '/');
    found.add(p);
  }
  return [...found].sort();
}

function globsFromBody(body: string): string[] {
  const paths = extractPathLikeStrings(body);
  const globs = new Set(paths.map((p) => derivePathPattern(p)));
  return [...globs].sort();
}

function existingPathSources(repo: Repository): Set<string> {
  const edges = repo.getApprovedEdges();
  const set = new Set<string>();
  for (const e of edges) {
    if (e.source_type === 'path' || e.source_type === 'layer') {
      set.add(e.source_value);
    }
  }
  return set;
}

/** True when an approved path/layer edge already covers routing for `proposedGlob` (exact or wider pattern). */
function proposedGlobCoveredByExistingKb(proposedGlob: string, existingPatterns: Set<string>): boolean {
  if (existingPatterns.has(proposedGlob)) return true;
  for (const wider of existingPatterns) {
    if (pathGlobSubsumes(wider, proposedGlob)) return true;
  }
  return false;
}

function inferDefaultKind(sectionTitle: string, fullContent: string): DocumentKind {
  const t = `${sectionTitle}\n${fullContent}`.normalize('NFKC').toLowerCase();
  // Avoid `\b` — it does not treat CJK boundaries as word boundaries.
  if (/template|ボイラー|boilerplate/.test(t)) return 'template';
  if (/constraint|must not|禁止|不変条件|invariant|制約/.test(t)) return 'constraint';
  if (/pattern|パターン|recipe/.test(t)) return 'pattern';
  if (/reference|参考|リンク/.test(t)) return 'reference';
  return 'guideline';
}

function headingTags(title: string): string[] {
  const nf = title.normalize('NFKC').toLowerCase();
  const seen = new Set<string>();
  const longRuns = nf.match(/[\p{L}\p{N}]{3,}/gu);
  if (longRuns) {
    for (const w of longRuns) {
      if (w.length < 40) seen.add(w);
    }
  }
  const shortRuns = nf.match(/[\p{L}\p{N}]{2}/gu);
  if (shortRuns) {
    for (const w of shortRuns) {
      if (w.length >= 2 && w.length < 40) seen.add(w);
    }
  }
  return [...seen].sort().slice(0, 8);
}

function edgeHintsForBody(body: string): EdgeSpec[] {
  const globs = globsFromBody(body);
  const hints: EdgeSpec[] = [];
  for (const g of globs) {
    hints.push({
      source_type: 'path',
      source_value: g,
      edge_type: 'path_requires',
      priority: 100,
    });
  }
  return hints;
}

function buildCoverage(repo: Repository, bodies: string[]): CoverageDelta {
  const existing = existingPathSources(repo);
  const globSet = new Set<string>();
  for (const b of bodies) {
    for (const g of globsFromBody(b)) globSet.add(g);
  }
  const proposed_path_globs = [...globSet].sort();
  let matches = 0;
  for (const g of proposed_path_globs) {
    if (proposedGlobCoveredByExistingKb(g, existing)) matches++;
  }
  const estimated = Math.max(0, proposed_path_globs.length - matches);
  const summary =
    proposed_path_globs.length === 0
      ? 'No path-like strings found — routing edges must be added manually.'
      : `${estimated} of ${proposed_path_globs.length} inferred directory globs appear novel vs existing path/layer edge sources.`;
  return {
    proposed_path_globs,
    existing_pattern_matches: matches,
    estimated_new_coverage_globs: estimated,
    summary,
  };
}

/** Options for {@link analyzeDocumentForImportPlan} (batch analysis passes shared state). */
export interface AnalyzeImportPlanOptions {
  /** 0-based index when analyzing multiple sources in one batch — avoids duplicate auto doc_ids across files. */
  batch_file_index?: number;
  /** Pool of doc_ids already taken (KB + siblings in the same batch). */
  reserved_doc_ids?: Set<string>;
  /** Set only when content was read from `file_path` (repo-relative, already normalized by caller). */
  resolved_source_path?: string | null;
}

function allocateUniqueDocId(repo: Repository, baseCandidate: string, reserved: Set<string>): string {
  let candidate = baseCandidate;
  let n = 0;
  while (reserved.has(candidate) || repo.getDocumentById(candidate)) {
    n += 1;
    candidate = `${baseCandidate}-u${n}`;
  }
  reserved.add(candidate);
  return candidate;
}

export function analyzeDocumentForImportPlan(
  repo: Repository,
  content: string,
  sourceLabel: string | null,
  options?: AnalyzeImportPlanOptions,
): ImportPlan {
  const normalizedInput = content.replace(/\r\n/g, '\n');
  if (normalizedInput.trim() === '') {
    throw new Error('import analysis: content is empty or whitespace-only');
  }

  const sections = splitMarkdownSections(content);
  const units: SuggestedImportUnit[] = [];
  const overlap_warnings: OverlapWarning[] = [];
  const approved = repo.getApprovedDocuments();
  const reserved = options?.reserved_doc_ids ?? new Set<string>();
  const batchIdx = options?.batch_file_index;
  const multiSource = batchIdx !== undefined && batchIdx >= 0;

  sections.forEach((sec, idx) => {
    let base = slugDocId(sec.title, idx);
    if (multiSource) {
      base = `${base}-b${batchIdx}`;
    }
    const doc_id = allocateUniqueDocId(repo, base, reserved);
    const kind = inferDefaultKind(sec.title, sec.body);
    const tags = headingTags(sec.title);
    const edge_hints = edgeHintsForBody(sec.body);

    units.push({
      unit_index: idx,
      doc_id,
      title: sec.title.slice(0, 200),
      kind,
      content_slice: sec.body,
      edge_hints,
      tags,
    });

    const tokens = tokenize(sec.body);
    for (const d of approved) {
      const sim = jaccardSimilarity(tokens, tokenize(d.content));
      if (sim >= 0.22) {
        overlap_warnings.push({
          existing_doc_id: d.doc_id,
          similarity: Number(sim.toFixed(4)),
          reason: `Token Jaccard ${sim.toFixed(2)} between import section "${sec.title}" and existing document`,
        });
      }
    }
  });

  overlap_warnings.sort((a, b) => b.similarity - a.similarity);

  return {
    algorithm_version: IMPORT_PLAN_ALGORITHM_VERSION,
    source_label: sourceLabel,
    resolved_source_path: options?.resolved_source_path ?? null,
    suggested_units: units,
    overlap_warnings,
    coverage_delta: buildCoverage(
      repo,
      units.map((u) => u.content_slice),
    ),
  };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function parseEdgeHint(raw: unknown): EdgeSpec {
  if (!isRecord(raw)) throw new Error('edge_hint must be an object');
  const st = raw.source_type;
  const sv = raw.source_value;
  const et = raw.edge_type;
  const pr = raw.priority;
  if (st !== 'path' && st !== 'layer' && st !== 'command' && st !== 'doc') {
    throw new Error('edge_hint.source_type invalid');
  }
  if (typeof sv !== 'string' || !sv) throw new Error('edge_hint.source_value required');
  if (et !== 'path_requires' && et !== 'layer_requires' && et !== 'command_requires' && et !== 'doc_depends_on') {
    throw new Error('edge_hint.edge_type invalid');
  }
  const hint: EdgeSpec = {
    source_type: st,
    source_value: sv,
    edge_type: et,
  };
  if (pr !== undefined) {
    if (typeof pr !== 'number' || !Number.isInteger(pr)) throw new Error('edge_hint.priority must be int');
    hint.priority = pr;
  }
  return hint;
}

/** Validate client-supplied plan JSON before executeImportPlan (same shape as analyzer output). */
export function parseImportPlanJson(repo: Repository, raw: unknown): ImportPlan {
  if (!isRecord(raw)) throw new Error('import_plan must be an object');
  if (raw.algorithm_version !== IMPORT_PLAN_ALGORITHM_VERSION) {
    throw new Error(`import_plan.algorithm_version must be "${IMPORT_PLAN_ALGORITHM_VERSION}"`);
  }
  const unitsRaw = raw.suggested_units;
  if (!Array.isArray(unitsRaw) || unitsRaw.length === 0) {
    throw new Error('import_plan.suggested_units must be a non-empty array');
  }
  const suggested_units: SuggestedImportUnit[] = unitsRaw.map((ur, idx) => {
    if (!isRecord(ur)) throw new Error(`suggested_units[${idx}] invalid`);
    const doc_id = ur.doc_id;
    const title = ur.title;
    const kind = ur.kind;
    const content_slice = ur.content_slice;
    if (typeof doc_id !== 'string' || !DOC_ID_PATTERN.test(doc_id)) {
      throw new Error(`suggested_units[${idx}].doc_id invalid`);
    }
    if (typeof title !== 'string' || !title.trim()) throw new Error(`suggested_units[${idx}].title required`);
    const kinds: DocumentKind[] = ['guideline', 'pattern', 'constraint', 'template', 'reference'];
    if (typeof kind !== 'string' || !kinds.includes(kind as DocumentKind)) {
      throw new Error(`suggested_units[${idx}].kind invalid`);
    }
    if (typeof content_slice !== 'string' || !content_slice.trim()) {
      throw new Error(`suggested_units[${idx}].content_slice required`);
    }
    const edge_hints_raw = ur.edge_hints;
    const tags_raw = ur.tags;
    const edge_hints = Array.isArray(edge_hints_raw)
      ? edge_hints_raw.map((h, i) => {
          try {
            return parseEdgeHint(h);
          } catch (e) {
            throw new Error(`suggested_units[${idx}].edge_hints[${i}]: ${(e as Error).message}`);
          }
        })
      : [];
    const tags = Array.isArray(tags_raw) && tags_raw.every((t) => typeof t === 'string') ? (tags_raw as string[]) : [];
    return {
      unit_index: typeof ur.unit_index === 'number' && Number.isInteger(ur.unit_index) ? ur.unit_index : idx,
      doc_id,
      title,
      kind: kind as DocumentKind,
      content_slice,
      edge_hints,
      tags,
    };
  });

  const overlap_warnings: OverlapWarning[] = [];
  const ow = raw.overlap_warnings;
  if (Array.isArray(ow)) {
    for (const w of ow) {
      if (!isRecord(w)) continue;
      if (typeof w.existing_doc_id === 'string' && typeof w.similarity === 'number' && typeof w.reason === 'string') {
        overlap_warnings.push({
          existing_doc_id: w.existing_doc_id,
          similarity: w.similarity,
          reason: w.reason,
        });
      }
    }
  }

  let coverage_delta: CoverageDelta;
  const cd = raw.coverage_delta;
  if (
    isRecord(cd) &&
    Array.isArray(cd.proposed_path_globs) &&
    typeof cd.existing_pattern_matches === 'number' &&
    typeof cd.estimated_new_coverage_globs === 'number' &&
    typeof cd.summary === 'string'
  ) {
    coverage_delta = {
      proposed_path_globs: cd.proposed_path_globs.filter((x) => typeof x === 'string') as string[],
      existing_pattern_matches: cd.existing_pattern_matches,
      estimated_new_coverage_globs: cd.estimated_new_coverage_globs,
      summary: cd.summary,
    };
  } else {
    coverage_delta = buildCoverage(
      repo,
      suggested_units.map((u) => u.content_slice),
    );
  }

  const source_label =
    raw.source_label === null || raw.source_label === undefined
      ? null
      : typeof raw.source_label === 'string'
        ? raw.source_label
        : null;

  let resolved_source_path: string | null = null;
  if ('resolved_source_path' in raw) {
    const rsp = raw.resolved_source_path;
    if (rsp === null || rsp === undefined) {
      resolved_source_path = null;
    } else if (typeof rsp === 'string' && rsp.trim() !== '') {
      resolved_source_path = rsp.trim();
    } else {
      throw new Error('import_plan.resolved_source_path must be null or a non-empty string');
    }
  }

  return {
    algorithm_version: IMPORT_PLAN_ALGORITHM_VERSION,
    source_label,
    resolved_source_path,
    suggested_units,
    overlap_warnings,
    coverage_delta,
  };
}

export function parseBatchImportPlanJson(repo: Repository, raw: unknown): BatchImportPlan {
  if (!isRecord(raw)) throw new Error('batch_plan must be an object');
  if (raw.algorithm_version !== IMPORT_PLAN_ALGORITHM_VERSION) {
    throw new Error(`batch_plan.algorithm_version must be "${IMPORT_PLAN_ALGORITHM_VERSION}"`);
  }
  const plansRaw = raw.plans;
  if (!Array.isArray(plansRaw) || plansRaw.length === 0) throw new Error('batch_plan.plans required');
  const plans = plansRaw.map((p, i) => {
    try {
      return parseImportPlanJson(repo, p);
    } catch (e) {
      throw new Error(`batch_plan.plans[${i}]: ${(e as Error).message}`);
    }
  });

  const cross_doc_overlap: CrossDocOverlap[] = [];
  const cdo = raw.cross_doc_overlap;
  if (Array.isArray(cdo)) {
    for (const c of cdo) {
      if (!isRecord(c)) continue;
      const sl = c.source_labels;
      if (
        Array.isArray(sl) &&
        sl.length === 2 &&
        typeof c.similarity === 'number' &&
        typeof c.overlap_excerpt === 'string'
      ) {
        cross_doc_overlap.push({
          source_labels: [typeof sl[0] === 'string' ? sl[0] : null, typeof sl[1] === 'string' ? sl[1] : null],
          similarity: c.similarity,
          overlap_excerpt: c.overlap_excerpt,
        });
      }
    }
  }

  let total_coverage_delta: CoverageDelta;
  const tcd = raw.total_coverage_delta;
  if (
    isRecord(tcd) &&
    Array.isArray(tcd.proposed_path_globs) &&
    typeof tcd.existing_pattern_matches === 'number' &&
    typeof tcd.estimated_new_coverage_globs === 'number' &&
    typeof tcd.summary === 'string'
  ) {
    total_coverage_delta = {
      proposed_path_globs: tcd.proposed_path_globs.filter((x) => typeof x === 'string') as string[],
      existing_pattern_matches: tcd.existing_pattern_matches,
      estimated_new_coverage_globs: tcd.estimated_new_coverage_globs,
      summary: tcd.summary,
    };
  } else {
    total_coverage_delta = buildCoverage(
      repo,
      plans.flatMap((p) => p.suggested_units.map((u) => u.content_slice)),
    );
  }

  return {
    algorithm_version: IMPORT_PLAN_ALGORITHM_VERSION,
    plans,
    cross_doc_overlap,
    total_coverage_delta,
  };
}

export function analyzeImportBatch(
  repo: Repository,
  inputs: Array<{ content: string; source_label: string | null; resolved_source_path?: string | null }>,
): BatchImportPlan {
  const reserved = new Set<string>();
  const multi = inputs.length > 1;
  const plans = inputs.map((i, fileIdx) =>
    analyzeDocumentForImportPlan(repo, i.content, i.source_label, {
      batch_file_index: multi ? fileIdx : undefined,
      reserved_doc_ids: reserved,
      resolved_source_path: i.resolved_source_path ?? null,
    }),
  );

  const cross_doc_overlap: CrossDocOverlap[] = [];
  for (let i = 0; i < plans.length; i++) {
    for (let j = i + 1; j < plans.length; j++) {
      let best = 0;
      let excerpt = '';
      for (const ua of plans[i].suggested_units) {
        const ta = tokenize(ua.content_slice);
        for (const ub of plans[j].suggested_units) {
          const tb = tokenize(ub.content_slice);
          const s = jaccardSimilarity(ta, tb);
          if (s > best) {
            best = s;
            const sampleA = ua.content_slice.split('\n').find((l) => l.trim().length > 0) ?? '';
            excerpt = sampleA.slice(0, 160);
          }
        }
      }
      if (best >= 0.18) {
        cross_doc_overlap.push({
          source_labels: [plans[i].source_label, plans[j].source_label],
          similarity: Number(best.toFixed(4)),
          overlap_excerpt: excerpt,
        });
      }
    }
  }

  const allBodies = plans.flatMap((p) => p.suggested_units.map((u) => u.content_slice));
  const total_coverage_delta = buildCoverage(repo, allBodies);

  return {
    algorithm_version: IMPORT_PLAN_ALGORITHM_VERSION,
    plans,
    cross_doc_overlap,
    total_coverage_delta,
  };
}
