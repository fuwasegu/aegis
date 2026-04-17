/**
 * ADR-015 Phase 4 — validate proposed path_requires edges: glob containment, duplicates, impact simulation.
 */

import picomatch from 'picomatch';
import type { Edge, Observation } from '../types.js';

export interface EdgeValidationImpact {
  /** compile_log rows where target_files match the glob and base did not yet include target_doc_id. */
  matched_compile_count: number;
  /**
   * Among those compiles, count of compile_miss observations with matching missing_doc / paths whose
   * `related_compile_id` is exactly one of those compile_log rows (subset of matched compiles).
   */
  observed_recovery_count: number;
}

export interface EdgeValidationResult {
  target_exists: boolean;
  /** Same path_requires already approved. */
  duplicate: boolean;
  /** Approved edge_ids (path_requires, same target) whose pattern is strictly narrower than the proposal. */
  subsumes: string[];
  /** Wider approved pattern + same target makes this proposal redundant; null if none. */
  subsumed_by: string | null;
  impact: EdgeValidationImpact;
}

export interface ValidatePathRequiresEdgeInput {
  proposed: {
    source_type: 'path';
    source_value: string;
    target_doc_id: string;
    edge_type: 'path_requires';
  };
  approvedDocIds: Set<string>;
  approvedPathEdges: Edge[];
  /** Rows from `compile_log` (compile_id + request JSON + base_doc_ids JSON). */
  compileLogRows: Array<{ compile_id: string; request: string; base_doc_ids: string }>;
  compileMissObservations: Observation[];
}

/** Fixed probe paths — deterministic subset used for glob containment checks. */
const PATH_PROBE_GRID: string[] = (() => {
  const xs: string[] = [];
  const dirs = ['', 'a', 'src', 'src/x', 'src/x/y', 'src/core', 'src/core/read', 'pkg/nested', 'deep/a/b'];
  const files = ['t.ts', 'u.tsx', 'z/deep.ts'];
  for (const d of dirs) {
    for (const f of files) {
      xs.push(d ? `${d}/${f}` : f);
    }
  }
  return xs;
})();

/**
 * Paths that match `globPat` — used to test whether a wider glob covers all paths matched by a narrower glob.
 */
export function deterministicPathProbesForGlob(globPat: string): string[] {
  const g = globPat.trim();
  const isMatch = picomatch(g);
  const hits = PATH_PROBE_GRID.filter((p) => isMatch(p));
  if (hits.length > 0) {
    return hits.slice(0, 8);
  }
  const synthetic = g.replace(/\*\*/g, 'gen/gen').replace(/\*/g, 'x').replace(/\/+/g, '/').replace(/^\//, '');
  if (synthetic && isMatch(synthetic)) {
    return [synthetic];
  }
  return ['probe.ts'];
}

/** `**` or `seg/seg/**` only (no `{`, single-`*` segments, etc.) — matches automation-derived path patterns. */
export function isCanonicalDirTreeGlob(pattern: string): boolean {
  const s = pattern.trim();
  if (s === '**') return true;
  return /^([^*{}]+\/)*[^*{}]+\/\*\*$/.test(s);
}

/**
 * True iff every path matching `narrowerPattern` also matches `widerPattern`.
 * Only defined for {@link isCanonicalDirTreeGlob} patterns; otherwise returns false (no subsumption claim).
 */
export function pathGlobSubsumes(widerPattern: string, narrowerPattern: string): boolean {
  const w = widerPattern.trim();
  const n = narrowerPattern.trim();
  if (w === n) return true;
  if (!isCanonicalDirTreeGlob(w) || !isCanonicalDirTreeGlob(n)) {
    return false;
  }
  if (w === '**' || w === '**/*') return true;

  const dirWide = w.match(/^(.+)\/\*\*$/);
  const dirNarrow = n.match(/^(.+)\/\*\*$/);
  if (!dirWide || !dirNarrow) {
    return false;
  }
  const pw = dirWide[1];
  const pn = dirNarrow[1];
  if (pw !== pn && pw.startsWith(`${pn}/`)) {
    return false;
  }
  if (pn === pw || pn.startsWith(`${pw}/`)) {
    return true;
  }
  return false;
}

/**
 * compile_id set for compiles where a target file matches the proposed glob and `target_doc_id`
 * was not already in base (the proposed edge would have added the doc).
 */
function qualifyingCompileIdsForEdge(
  sourceGlob: string,
  targetDocId: string,
  compileLogRows: Array<{ compile_id: string; request: string; base_doc_ids: string }>,
): Set<string> {
  const matcher = picomatch(sourceGlob);
  const ids = new Set<string>();
  for (const row of compileLogRows) {
    let targetFiles: string[];
    let baseIds: string[];
    try {
      const req = JSON.parse(row.request) as { target_files?: string[] };
      targetFiles = req.target_files ?? [];
      baseIds = JSON.parse(row.base_doc_ids) as string[];
    } catch {
      continue;
    }
    if (!targetFiles.some((f) => matcher(f))) continue;
    if (baseIds.includes(targetDocId)) continue;
    ids.add(row.compile_id);
  }
  return ids;
}

function countObservedRecoveryAgainstCompiles(
  sourceGlob: string,
  targetDocId: string,
  qualifyingCompileIds: Set<string>,
  observations: Observation[],
): number {
  const matcher = picomatch(sourceGlob);
  let n = 0;
  for (const obs of observations) {
    if (obs.event_type !== 'compile_miss') continue;
    const cid = obs.related_compile_id;
    if (!cid || !qualifyingCompileIds.has(cid)) continue;
    let payload: { target_files?: string[]; missing_doc?: string };
    try {
      payload = JSON.parse(obs.payload) as { target_files?: string[]; missing_doc?: string };
    } catch {
      continue;
    }
    if (payload.missing_doc !== targetDocId) continue;
    const files = payload.target_files ?? [];
    if (files.some((f) => matcher(f))) n++;
  }
  return n;
}

/**
 * Validate a proposed path_requires edge against approved edges and historical compile / miss data.
 */
export function validatePathRequiresEdge(input: ValidatePathRequiresEdgeInput): EdgeValidationResult {
  const { proposed, approvedDocIds, approvedPathEdges, compileLogRows, compileMissObservations } = input;
  const target_exists = approvedDocIds.has(proposed.target_doc_id);

  const sameTargetEdges = approvedPathEdges.filter((e) => e.target_doc_id === proposed.target_doc_id);

  const duplicate = sameTargetEdges.some((e) => e.source_value === proposed.source_value);

  const widerPatterns = sameTargetEdges
    .filter((e) => e.source_value !== proposed.source_value && pathGlobSubsumes(e.source_value, proposed.source_value))
    .map((e) => e.source_value)
    .sort();
  const subsumed_by = widerPatterns[0] ?? null;

  const subsumes = sameTargetEdges
    .filter((e) => e.source_value !== proposed.source_value && pathGlobSubsumes(proposed.source_value, e.source_value))
    .map((e) => e.edge_id)
    .sort();

  const qualifyingCompileIds = qualifyingCompileIdsForEdge(
    proposed.source_value,
    proposed.target_doc_id,
    compileLogRows,
  );

  const impact: EdgeValidationImpact = {
    matched_compile_count: qualifyingCompileIds.size,
    observed_recovery_count: countObservedRecoveryAgainstCompiles(
      proposed.source_value,
      proposed.target_doc_id,
      qualifyingCompileIds,
      compileMissObservations,
    ),
  };

  return {
    target_exists,
    duplicate,
    subsumes,
    subsumed_by,
    impact,
  };
}
