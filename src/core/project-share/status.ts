/**
 * ADR-017 Task 017-03: Project-Share status derivation.
 *
 * Compares the repo-committed shared bundle (aegis-share/manifest.json)
 * against the local DB's current snapshot to derive a ProjectShareState.
 */

import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SharedCanonicalManifestV1 } from './types.js';

export type ProjectShareState =
  | 'not_configured'
  | 'in_sync'
  | 'bundle_newer'
  | 'local_ahead'
  | 'diverged'
  | 'unreadable_bundle';

export interface ProjectShareStatus {
  state: ProjectShareState;
  local_snapshot_id: string | null;
  local_knowledge_version: number;
  bundle_snapshot_id: string | null;
  bundle_knowledge_version: number | null;
  message: string;
}

export interface LocalSnapshotInfo {
  snapshot_id: string;
  knowledge_version: number;
}

/**
 * Read and parse `manifest.json` from the bundle directory.
 * Returns `null` if the file does not exist, or `'unreadable'` if the file
 * exists but cannot be parsed or has an unexpected shape.
 */
function readManifest(bundleDir: string): SharedCanonicalManifestV1 | null | 'unreadable' {
  const manifestPath = join(bundleDir, 'manifest.json');
  if (!existsSync(manifestPath)) return null;

  try {
    const raw = readFileSync(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    if (
      parsed.format_version !== 1 ||
      typeof parsed.snapshot_id !== 'string' ||
      typeof parsed.knowledge_version !== 'number' ||
      typeof parsed.bundle_sha256 !== 'string' ||
      parsed.bundle_file !== 'canonical.json'
    ) {
      return 'unreadable';
    }

    // Verify the referenced bundle file is a readable regular file
    const bundleFilePath = join(bundleDir, parsed.bundle_file as string);
    try {
      if (!statSync(bundleFilePath).isFile()) {
        return 'unreadable';
      }
      accessSync(bundleFilePath, constants.R_OK);
    } catch {
      return 'unreadable';
    }

    return parsed as unknown as SharedCanonicalManifestV1;
  } catch {
    return 'unreadable';
  }
}

/**
 * Derive the project-share state by comparing the local DB snapshot
 * with the repo-committed bundle manifest.
 *
 * @param localSnapshot - Current snapshot from the local DB (undefined if uninitialized)
 * @param bundleDir     - Path to the bundle directory (default: `<projectRoot>/aegis-share`)
 */
export function deriveShareState(localSnapshot: LocalSnapshotInfo | undefined, bundleDir: string): ProjectShareStatus {
  const manifest = readManifest(bundleDir);

  // No manifest → not_configured
  if (manifest === null) {
    return {
      state: 'not_configured',
      local_snapshot_id: localSnapshot?.snapshot_id ?? null,
      local_knowledge_version: localSnapshot?.knowledge_version ?? 0,
      bundle_snapshot_id: null,
      bundle_knowledge_version: null,
      message: 'No shared bundle found. Run `npx aegis share-export` to create one.',
    };
  }

  // Malformed manifest → unreadable_bundle
  if (manifest === 'unreadable') {
    return {
      state: 'unreadable_bundle',
      local_snapshot_id: localSnapshot?.snapshot_id ?? null,
      local_knowledge_version: localSnapshot?.knowledge_version ?? 0,
      bundle_snapshot_id: null,
      bundle_knowledge_version: null,
      message: 'Shared bundle manifest is malformed or unreadable.',
    };
  }

  const localKV = localSnapshot?.knowledge_version ?? 0;
  const localSid = localSnapshot?.snapshot_id ?? null;
  const bundleKV = manifest.knowledge_version;
  const bundleSid = manifest.snapshot_id;

  // Same snapshot → in_sync
  if (localSid === bundleSid) {
    return {
      state: 'in_sync',
      local_snapshot_id: localSid,
      local_knowledge_version: localKV,
      bundle_snapshot_id: bundleSid,
      bundle_knowledge_version: bundleKV,
      message: 'Local DB and shared bundle are in sync.',
    };
  }

  // Different snapshots — compare knowledge_version
  if (localKV < bundleKV) {
    return {
      state: 'bundle_newer',
      local_snapshot_id: localSid,
      local_knowledge_version: localKV,
      bundle_snapshot_id: bundleSid,
      bundle_knowledge_version: bundleKV,
      message: `Shared bundle is newer (v${bundleKV}) than local (v${localKV}). Run \`npx aegis share-hydrate\` to update.`,
    };
  }

  if (localKV > bundleKV) {
    return {
      state: 'local_ahead',
      local_snapshot_id: localSid,
      local_knowledge_version: localKV,
      bundle_snapshot_id: bundleSid,
      bundle_knowledge_version: bundleKV,
      message: `Local DB is ahead (v${localKV}) of shared bundle (v${bundleKV}). Run \`npx aegis share-export\` to publish.`,
    };
  }

  // Same knowledge_version but different snapshot_id → diverged
  return {
    state: 'diverged',
    local_snapshot_id: localSid,
    local_knowledge_version: localKV,
    bundle_snapshot_id: bundleSid,
    bundle_knowledge_version: bundleKV,
    message: `Local and bundle have the same version (v${localKV}) but different snapshots. Run \`npx aegis share-hydrate\` or \`npx aegis share-export\` to reconcile.`,
  };
}
