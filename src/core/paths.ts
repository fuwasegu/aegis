/**
 * source_path normalization utilities (ADR-009 D-11).
 *
 * All source_path values are stored as repo-relative paths.
 * These utilities convert between absolute ↔ repo-relative and validate workspace boundaries.
 */

import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import type { Repository } from './store/repository.js';

/**
 * Best-effort realpath: resolve symlinks for the deepest existing ancestor,
 * then append the remaining non-existent suffix. This handles macOS
 * /var → /private/var symlinks even when the leaf file doesn't exist.
 */
function bestEffortRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // Walk up to find an existing ancestor
    const parent = dirname(p);
    if (parent === p) return normalize(p); // root — give up
    const resolvedParent = bestEffortRealpath(parent);
    const leaf = p.slice(parent.length);
    return resolvedParent + leaf;
  }
}

/**
 * Normalize a path (absolute or relative) to repo-relative form.
 * Resolves symlinks via realpath before conversion.
 * Throws if the resolved path is outside the project root.
 */
export function normalizeSourcePath(inputPath: string, projectRoot: string): string {
  const resolvedRoot = bestEffortRealpath(resolve(projectRoot));

  let absPath: string;
  if (isAbsolute(inputPath)) {
    absPath = bestEffortRealpath(inputPath);
  } else {
    // Already relative — resolve against project root, then re-relativize
    const full = resolve(resolvedRoot, inputPath);
    absPath = bestEffortRealpath(full);
  }

  validateInsideProject(absPath, resolvedRoot);

  const rel = relative(resolvedRoot, absPath);
  return rel;
}

/**
 * Resolve a repo-relative source_path back to an absolute path.
 * Validates containment both lexically and after symlink resolution
 * to prevent symlink escape (e.g. "link/passwd" where link → /etc).
 */
export function resolveSourcePath(repoRelPath: string, projectRoot: string): string {
  const absPath = resolve(projectRoot, repoRelPath);
  // Lexical check first (catches ../traversal)
  validateInsideProject(absPath, projectRoot);
  // Symlink-aware check: resolve the real path and re-validate
  const realPath = bestEffortRealpath(absPath);
  const realRoot = bestEffortRealpath(resolve(projectRoot));
  validateInsideProject(realPath, realRoot);
  return absPath;
}

/**
 * Validate that a path is inside the project root.
 * Throws if the path escapes the workspace.
 * Both paths should be pre-resolved (e.g. via bestEffortRealpath) for accurate comparison.
 */
export function validateInsideProject(absPath: string, projectRoot: string): void {
  const normalizedRoot = normalize(projectRoot);
  const normalizedPath = normalize(absPath);

  // Allow exact match (path === root) or child (path starts with root + sep)
  if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(normalizedRoot + sep)) {
    throw new Error(`Path is outside the project root: ${absPath} (project root: ${projectRoot})`);
  }
}

/**
 * One-shot migration: convert absolute source_path values to repo-relative.
 * Must be called on admin surface only (INV-6).
 *
 * - Already relative paths → skip (idempotent)
 * - Absolute paths inside projectRoot → strip to repo-relative
 * - Absolute paths outside projectRoot → set to NULL (fallback)
 */
export function migrateSourcePaths(repo: Repository, projectRoot: string): void {
  const docs = repo.getAllDocumentsWithSourcePath();
  // Use bestEffortRealpath consistently (handles macOS /var → /private/var)
  const realRoot = bestEffortRealpath(resolve(projectRoot));

  for (const doc of docs) {
    const sp = doc.source_path!;

    // Already relative — validate it doesn't escape (lexically or via symlinks)
    if (!isAbsolute(sp)) {
      const resolved = resolve(realRoot, sp);
      const normalizedResolved = normalize(resolved);
      // Lexical check
      if (!normalizedResolved.startsWith(realRoot + sep) && normalizedResolved !== realRoot) {
        repo.updateDocumentSourcePath(doc.doc_id, null);
        continue;
      }
      // Symlink-aware check
      const realResolved = bestEffortRealpath(resolved);
      if (!realResolved.startsWith(realRoot + sep) && realResolved !== realRoot) {
        repo.updateDocumentSourcePath(doc.doc_id, null);
      }
      continue;
    }

    // Absolute path — resolve symlinks then check containment
    const realSp = bestEffortRealpath(sp);
    if (realSp.startsWith(realRoot + sep) || realSp === realRoot) {
      const rel = relative(realRoot, realSp);
      repo.updateDocumentSourcePath(doc.doc_id, rel);
    } else {
      // Outside project root — clear to NULL
      repo.updateDocumentSourcePath(doc.doc_id, null);
    }
  }
}
