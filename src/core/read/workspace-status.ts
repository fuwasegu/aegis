/**
 * ADR-015 Task 015-11 — read-model aggregate for multi-agent workspace visibility.
 */

import { derivePathPattern } from '../optimization/edge-candidate-builder.js';
import type { Repository } from '../store/repository.js';
import type { CompileRequest, WorkspaceStatus } from '../types.js';

const DEFAULT_WINDOW_HOURS = 24;

export interface BuildWorkspaceStatusOptions {
  /** Rolling window for `active_regions`; default 24. */
  window_hours?: number;
}

function isoHoursAgo(hours: number): string {
  const ms = Math.max(0, hours) * 60 * 60 * 1000;
  return new Date(Date.now() - ms).toISOString();
}

/** Sort and dedupe for stable `unresolved_misses` keys. */
function sortedUniquePaths(files: string[]): string[] {
  return [...new Set(files)].sort();
}

/**
 * Aggregate compile_log rows (recent), compile_miss backlog, and pending proposals.
 */
export function buildWorkspaceStatus(repo: Repository, opts?: BuildWorkspaceStatusOptions): WorkspaceStatus {
  const window_hours = opts?.window_hours ?? DEFAULT_WINDOW_HOURS;
  const since = isoHoursAgo(window_hours);

  const rows = repo.listCompileLogsSince(since);

  /** Latest activity per derived path_pattern (deterministic ordering by processing rows ascending). */
  const patternLatest = new Map<string, { last_compiled: string; agent_id?: string }>();

  for (const row of rows) {
    let req: CompileRequest;
    try {
      req = JSON.parse(row.request) as CompileRequest;
    } catch {
      continue;
    }
    const files = Array.isArray(req.target_files) ? req.target_files : [];
    const agentTrimmed = row.agent_id?.trim();
    const agent_id = agentTrimmed && agentTrimmed.length > 0 ? agentTrimmed : undefined;

    for (const f of files) {
      if (typeof f !== 'string' || !f.trim()) continue;
      const pattern = derivePathPattern(f.trim());
      const prev = patternLatest.get(pattern);
      if (!prev || row.created_at >= prev.last_compiled) {
        patternLatest.set(pattern, {
          last_compiled: row.created_at,
          ...(agent_id !== undefined ? { agent_id } : {}),
        });
      }
    }
  }

  const patterns = [...patternLatest.keys()].sort();
  const active_regions = patterns.map((path_pattern) => {
    const row = patternLatest.get(path_pattern)!;
    const out: { path_pattern: string; last_compiled: string; agent_id?: string } = {
      path_pattern,
      last_compiled: row.last_compiled,
    };
    if (row.agent_id !== undefined) {
      out.agent_id = row.agent_id;
    }
    return out;
  });

  const misses = repo.listCompileMissObservationsWithoutProposal();
  const missBuckets = new Map<string, { target_files: string[]; missing_doc?: string; count: number }>();

  for (const o of misses) {
    try {
      const payload = JSON.parse(o.payload) as {
        target_files?: unknown;
        missing_doc?: string;
      };
      const rawFiles = payload.target_files;
      const tf = Array.isArray(rawFiles)
        ? sortedUniquePaths(
            rawFiles.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()),
          )
        : [];
      const missing_doc =
        typeof payload.missing_doc === 'string' && payload.missing_doc.trim() !== ''
          ? payload.missing_doc.trim()
          : undefined;
      const key = JSON.stringify({ target_files: tf, missing_doc: missing_doc ?? null });
      const prev = missBuckets.get(key);
      if (prev) {
        prev.count++;
      } else {
        missBuckets.set(key, { target_files: tf, ...(missing_doc !== undefined ? { missing_doc } : {}), count: 1 });
      }
    } catch {}
  }

  const unresolved_misses = [...missBuckets.values()].sort((a, b) => {
    const ca = a.count - b.count;
    if (ca !== 0) return -ca;
    return JSON.stringify(a).localeCompare(JSON.stringify(b));
  });

  return {
    window_hours,
    since,
    active_regions,
    unresolved_misses,
    pending_proposal_count: repo.countPendingProposals(),
  };
}
