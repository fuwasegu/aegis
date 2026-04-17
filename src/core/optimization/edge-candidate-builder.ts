/**
 * ADR-015 Phase 4 — edge candidate clustering for coverage / optimization.
 *
 * PathCluster: files grouped by the same directory-level glob (same derivation as RuleBasedAnalyzer).
 * MissCluster: compile_miss observations grouped by derived pattern + missing_doc.
 */

import type { Observation } from '../types.js';

/** Directory-level glob + member paths (deterministic ordering). */
export interface PathCluster {
  pattern: string;
  members: string[];
  exposure_count: number;
}

/** compile_miss group sharing the same routing key. */
export interface MissCluster {
  pattern: string;
  missing_doc: string;
  observation_ids: string[];
  related_compile_ids: string[];
  miss_count: number;
}

/**
 * Derive a directory-level glob from a file path (RuleBasedAnalyzer-compatible).
 * "app/Domain/User/UserEntity.php" → "app/Domain/User/**"
 */
export function derivePathPattern(filePath: string): string {
  const parts = filePath.split('/');
  if (parts.length <= 1) {
    return '**';
  }
  return `${parts.slice(0, -1).join('/')}/**`;
}

/**
 * Cluster target file paths by derived path pattern.
 */
/**
 * Path + miss clusters for a compile_miss processing batch (ADR-015 optimization context).
 */
export function buildCoverageOptimizationContext(
  compileMissObservations: Observation[],
  batchTargetFiles: string[],
): { pathClusters: PathCluster[]; missClusters: MissCluster[] } {
  return {
    pathClusters: buildPathClustersFromFiles(batchTargetFiles),
    missClusters: buildMissClustersFromObservations(compileMissObservations),
  };
}

export function buildPathClustersFromFiles(targetFiles: string[]): PathCluster[] {
  const byPattern = new Map<string, Set<string>>();
  for (const f of targetFiles) {
    const p = derivePathPattern(f);
    if (!byPattern.has(p)) byPattern.set(p, new Set());
    byPattern.get(p)!.add(f);
  }
  const keys = [...byPattern.keys()].sort();
  return keys.map((pattern) => {
    const members = [...byPattern.get(pattern)!].sort();
    return {
      pattern,
      members,
      exposure_count: members.length,
    };
  });
}

type CompileMissPayload = {
  target_files: string[];
  missing_doc?: string;
  target_doc_id?: string;
  review_comment: string;
};

/**
 * Cluster compile_miss observations by (derivePathPattern(per target_file), missing_doc).
 * One observation may contribute to multiple clusters when target_files span directories.
 */
export function buildMissClustersFromObservations(observations: Observation[]): MissCluster[] {
  type Agg = { observation_ids: Set<string>; compile_ids: Set<string> };
  const map = new Map<string, Agg>();

  for (const obs of observations) {
    if (obs.event_type !== 'compile_miss') continue;
    let payload: CompileMissPayload;
    try {
      payload = JSON.parse(obs.payload) as CompileMissPayload;
    } catch {
      continue;
    }
    const missing = payload.missing_doc;
    if (!missing || payload.target_files.length === 0) continue;

    const patterns = new Set(payload.target_files.map((f) => derivePathPattern(f)));
    for (const pattern of patterns) {
      const key = `${pattern}\0${missing}`;
      if (!map.has(key)) {
        map.set(key, { observation_ids: new Set(), compile_ids: new Set() });
      }
      const agg = map.get(key)!;
      agg.observation_ids.add(obs.observation_id);
      if (obs.related_compile_id) {
        agg.compile_ids.add(obs.related_compile_id);
      }
    }
  }

  const keys = [...map.keys()].sort();
  return keys.map((key) => {
    const agg = map.get(key)!;
    const sep = key.indexOf('\0');
    const pattern = key.slice(0, sep);
    const missing_doc = key.slice(sep + 1);
    const observation_ids = [...agg.observation_ids].sort();
    return {
      pattern,
      missing_doc,
      observation_ids,
      related_compile_ids: [...agg.compile_ids].sort(),
      miss_count: observation_ids.length,
    };
  });
}
