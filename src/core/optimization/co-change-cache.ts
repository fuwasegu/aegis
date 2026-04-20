/**
 * ADR-015 Task 015-08 — co-change cache (git history correlation, maintenance-built).
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { normalize as normalizeFsPath, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import type { Repository } from '../store/repository.js';
import type { CoChangePatternRow, Document } from '../types.js';
import { derivePathPattern } from './edge-candidate-builder.js';

export type { CoChangePatternRow } from '../types.js';

const execFileAsync = promisify(execFile);

export interface CoChangeCacheJobResult {
  git_available: boolean;
  commits_scanned: number;
  pattern_rows: number;
  full_scan: boolean;
  skipped_reason?: string;
}

/** Normalize a git path segment for comparison with repo-relative `source_path` values. */
export function normalizeGitPath(relPath: string): string {
  return relPath.replace(/\\/gu, '/').replace(/^\.\//u, '').trim();
}

/** Stable fingerprint for the approved `source_path` set — drives cache invalidation on KB changes. */
export function fingerprintKbPaths(kbPaths: Set<string>): string {
  const sorted = [...kbPaths].sort();
  return createHash('sha256').update(sorted.join('\n'), 'utf8').digest('hex');
}

export function kbSourcePathSetForApprovedDocs(docs: Document[]): Set<string> {
  const s = new Set<string>();
  for (const d of docs) {
    if (d.status !== 'approved') continue;
    const sp = d.source_path;
    if (sp == null || String(sp).trim() === '') continue;
    s.add(normalizeGitPath(String(sp)));
  }
  return s;
}

/**
 * Mutable aggregation state for co-change pairs and per-code-pattern commit totals.
 * Exported for unit tests.
 */
export class CoChangeAggregator {
  readonly pairCount = new Map<string, number>();
  readonly codeCommitCount = new Map<string, number>();

  /**
   * Record one commit: bump code-pattern commit totals, then pair counts when both sides non-empty.
   */
  addCommit(codePatterns: Iterable<string>, docPatterns: Iterable<string>): void {
    const code = [...new Set(codePatterns)].sort();
    const docs = [...new Set(docPatterns)].sort();
    for (const c of code) {
      this.codeCommitCount.set(c, (this.codeCommitCount.get(c) ?? 0) + 1);
    }
    if (code.length === 0 || docs.length === 0) return;
    for (const co of code) {
      for (const dp of docs) {
        const k = `${co}\0${dp}`;
        this.pairCount.set(k, (this.pairCount.get(k) ?? 0) + 1);
      }
    }
  }

  /**
   * Hydrate from DB for incremental maintenance.
   * `codeCommitTotals` must include **all** code patterns with history (including code-only commits).
   */
  mergeFromExistingRows(rows: CoChangePatternRow[], codeCommitTotals: Map<string, number>): void {
    this.pairCount.clear();
    this.codeCommitCount.clear();
    for (const [c, t] of codeCommitTotals) {
      this.codeCommitCount.set(c, t);
    }
    for (const r of rows) {
      const k = `${r.code_pattern}\0${r.doc_pattern}`;
      this.pairCount.set(k, r.co_change_count);
    }
  }

  toRows(): CoChangePatternRow[] {
    const keys = [...this.pairCount.keys()].sort();
    const out: CoChangePatternRow[] = [];
    for (const key of keys) {
      const sep = key.indexOf('\0');
      const code_pattern = key.slice(0, sep);
      const doc_pattern = key.slice(sep + 1);
      const co_change_count = this.pairCount.get(key)!;
      const total_code_changes = this.codeCommitCount.get(code_pattern) ?? 0;
      const confidence = total_code_changes > 0 ? co_change_count / total_code_changes : 0;
      out.push({
        code_pattern,
        doc_pattern,
        co_change_count,
        total_code_changes,
        confidence,
      });
    }
    return out;
  }
}

/**
 * Map paths from `git log --name-only` (repository-root-relative) to paths relative to `projectRoot`,
 * so they align with Canonical `source_path` (ADR-009 repo-relative from project root).
 */
export function pathsRepoRelativeToProject(
  gitWorkTreeRootAbs: string,
  projectRootAbs: string,
  gitLogNames: string[],
): string[] {
  const gr = resolve(gitWorkTreeRootAbs);
  const pr = resolve(projectRootAbs);
  const out: string[] = [];
  for (const raw of gitLogNames) {
    const posix = raw.replace(/\\/gu, '/').trim();
    if (!posix) continue;
    const segments = posix.split('/').filter((s) => s.length > 0);
    const absFile = resolve(gr, ...segments);
    let rel = relative(pr, absFile);
    if (!rel || rel.startsWith('..')) continue;
    rel = normalizeFsPath(rel);
    out.push(rel.split(sep).join('/'));
  }
  return out;
}

export function classifyChangedPaths(
  changedFiles: string[],
  kbPaths: Set<string>,
): { codePatterns: string[]; docPatterns: string[] } {
  const code = new Set<string>();
  const docs = new Set<string>();
  for (const raw of changedFiles) {
    const n = normalizeGitPath(raw);
    if (n === '') continue;
    if (kbPaths.has(n)) {
      docs.add(derivePathPattern(n));
    } else {
      code.add(derivePathPattern(n));
    }
  }
  return { codePatterns: [...code].sort(), docPatterns: [...docs].sort() };
}

async function gitStdout(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 512 * 1024 * 1024,
      encoding: 'utf8',
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
}

async function gitWorkTreeRoot(projectRoot: string): Promise<string | null> {
  const r = await gitStdout(projectRoot, ['rev-parse', '--show-toplevel']);
  if (!r.ok || !r.stdout.trim()) return null;
  return r.stdout.trim();
}

const COMMIT_MARKER = '===COMMIT:';

/** Parse `git log --reverse --name-only --pretty=format:===COMMIT:%H` output into per-commit paths. */
export function parseCommitFileLog(stdout: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let sha: string | null = null;
  for (const raw of stdout.split(/\r?\n/u)) {
    const line = raw.trimEnd();
    if (line.startsWith(COMMIT_MARKER)) {
      sha = line.slice(COMMIT_MARKER.length);
      if (!map.has(sha)) {
        map.set(sha, []);
      }
      continue;
    }
    if (sha != null && line.trim() !== '') {
      map.get(sha)!.push(line);
    }
  }
  return map;
}

async function loadCommitFilesFromGit(
  projectRoot: string,
  lastProcessed: string | null,
): Promise<{
  ok: boolean;
  head: string | null;
  full_scan: boolean;
  commitFiles: Map<string, string[]>;
  reason?: string;
}> {
  const inside = await gitStdout(projectRoot, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return {
      ok: false,
      head: null,
      full_scan: false,
      commitFiles: new Map(),
      reason: 'not_a_git_repository',
    };
  }

  const headR = await gitStdout(projectRoot, ['rev-parse', 'HEAD']);
  const head = headR.ok ? headR.stdout.trim() : null;
  if (!head) {
    return { ok: false, head: null, full_scan: false, commitFiles: new Map(), reason: 'no_commits' };
  }

  let rangeSpec: string;
  let full_scan: boolean;
  let reason: string | undefined;

  if (lastProcessed == null || lastProcessed === '') {
    rangeSpec = 'HEAD';
    full_scan = true;
  } else {
    const anc = await gitStdout(projectRoot, ['merge-base', '--is-ancestor', lastProcessed, 'HEAD']);
    if (!anc.ok) {
      rangeSpec = 'HEAD';
      full_scan = true;
      reason = 'last_commit_not_ancestor_rebuilt';
    } else {
      rangeSpec = `${lastProcessed}..HEAD`;
      full_scan = false;
    }
  }

  const log = await gitStdout(projectRoot, [
    'log',
    '--reverse',
    '--name-only',
    `--pretty=format:${COMMIT_MARKER}%H`,
    rangeSpec,
  ]);
  if (!log.ok) {
    return {
      ok: false,
      head,
      full_scan,
      commitFiles: new Map(),
      reason: 'git_log_failed',
    };
  }

  return {
    ok: true,
    head,
    full_scan,
    commitFiles: parseCommitFileLog(log.stdout),
    reason,
  };
}

export interface RunCoChangeCacheJobOptions {
  projectRoot: string;
  repo: Repository;
  dryRun: boolean;
}

/**
 * Scan git history (full or incremental), correlate KB source paths with other paths, persist aggregates.
 */
export async function runCoChangeCacheJob(opts: RunCoChangeCacheJobOptions): Promise<CoChangeCacheJobResult> {
  const { projectRoot, repo, dryRun } = opts;

  const kbPaths = kbSourcePathSetForApprovedDocs(repo.getApprovedDocuments());
  const kbFp = fingerprintKbPaths(kbPaths);

  if (kbPaths.size === 0) {
    if (!dryRun) {
      repo.clearCoChangeCache();
    }
    return {
      git_available: true,
      commits_scanned: 0,
      pattern_rows: repo.listCoChangePatterns().length,
      full_scan: false,
      skipped_reason: 'no_approved_source_paths',
    };
  }

  const storedKbFp = repo.getCoChangeKbFingerprint();
  const kbMismatch = storedKbFp !== kbFp;

  const effectiveLast = kbMismatch ? null : repo.getCoChangeLastProcessedCommit();
  const scan = await loadCommitFilesFromGit(projectRoot, effectiveLast);

  if (!scan.ok) {
    return {
      git_available: false,
      commits_scanned: 0,
      pattern_rows: 0,
      full_scan: false,
      skipped_reason: scan.reason ?? 'git_unavailable',
    };
  }

  const projectAbs = resolve(projectRoot);
  const gitRootAbs = (await gitWorkTreeRoot(projectRoot)) ?? projectAbs;

  const agg = new CoChangeAggregator();
  if (!scan.full_scan && effectiveLast != null && effectiveLast !== '' && !kbMismatch) {
    agg.mergeFromExistingRows(repo.listCoChangePatterns(), repo.listCoChangeCodeTotals());
  }

  let commitsScanned = 0;
  for (const files of scan.commitFiles.values()) {
    const relPaths = pathsRepoRelativeToProject(gitRootAbs, projectAbs, files);
    const { codePatterns, docPatterns } = classifyChangedPaths(relPaths, kbPaths);
    agg.addCommit(codePatterns, docPatterns);
    commitsScanned++;
  }

  const rows = agg.toRows();

  if (!dryRun && scan.head != null) {
    repo.persistCoChangeCache(rows, agg.codeCommitCount, scan.head, kbFp);
  }

  return {
    git_available: true,
    commits_scanned: commitsScanned,
    pattern_rows: rows.length,
    full_scan: scan.full_scan,
    skipped_reason: scan.reason,
  };
}
