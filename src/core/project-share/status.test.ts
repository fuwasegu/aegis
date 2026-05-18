import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveShareState, type LocalSnapshotInfo } from './status.js';
import type { SharedCanonicalManifestV1 } from './types.js';

describe('deriveShareState', () => {
  let bundleDir: string;

  beforeEach(() => {
    bundleDir = mkdtempSync(join(tmpdir(), 'aegis-share-status-'));
  });

  afterEach(() => {
    rmSync(bundleDir, { recursive: true, force: true });
  });

  function writeManifest(manifest: SharedCanonicalManifestV1): void {
    writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    // Also write the bundle file so it passes existence check
    writeFileSync(join(bundleDir, manifest.bundle_file), '{}');
  }

  function makeManifest(overrides: Partial<SharedCanonicalManifestV1> = {}): SharedCanonicalManifestV1 {
    return {
      format_version: 1,
      bundle_file: 'canonical.json',
      snapshot_id: 'snap-bundle',
      knowledge_version: 5,
      bundle_sha256: 'abc123',
      includes_tag_mappings: false,
      ...overrides,
    };
  }

  const localSnapshot: LocalSnapshotInfo = {
    snapshot_id: 'snap-local',
    knowledge_version: 5,
  };

  // ── not_configured ──

  it('returns not_configured when manifest.json does not exist', () => {
    const result = deriveShareState(localSnapshot, bundleDir);
    expect(result.state).toBe('not_configured');
    expect(result.bundle_snapshot_id).toBeNull();
    expect(result.bundle_knowledge_version).toBeNull();
    expect(result.local_snapshot_id).toBe('snap-local');
    expect(result.local_knowledge_version).toBe(5);
  });

  it('returns not_configured when bundleDir itself does not exist', () => {
    const result = deriveShareState(localSnapshot, join(bundleDir, 'nonexistent'));
    expect(result.state).toBe('not_configured');
  });

  // ── unreadable_bundle ──

  it('returns unreadable_bundle when manifest.json is not valid JSON', () => {
    writeFileSync(join(bundleDir, 'manifest.json'), 'not-json{{{');
    const result = deriveShareState(localSnapshot, bundleDir);
    expect(result.state).toBe('unreadable_bundle');
    expect(result.bundle_snapshot_id).toBeNull();
  });

  it('returns unreadable_bundle when manifest.json has wrong format_version', () => {
    writeFileSync(
      join(bundleDir, 'manifest.json'),
      JSON.stringify({ format_version: 99, snapshot_id: 's', knowledge_version: 1, bundle_sha256: 'x' }),
    );
    const result = deriveShareState(localSnapshot, bundleDir);
    expect(result.state).toBe('unreadable_bundle');
  });

  it('returns unreadable_bundle when manifest.json is missing required fields', () => {
    writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify({ format_version: 1 }));
    const result = deriveShareState(localSnapshot, bundleDir);
    expect(result.state).toBe('unreadable_bundle');
  });

  it('returns unreadable_bundle when bundle_file is not canonical.json', () => {
    writeFileSync(
      join(bundleDir, 'manifest.json'),
      JSON.stringify({
        format_version: 1,
        bundle_file: '../outside/external.json',
        snapshot_id: 'snap-local',
        knowledge_version: 5,
        bundle_sha256: 'abc',
        includes_tag_mappings: false,
      }),
    );
    const result = deriveShareState(localSnapshot, bundleDir);
    expect(result.state).toBe('unreadable_bundle');
  });

  it('returns unreadable_bundle when manifest references a missing bundle file', () => {
    // Write manifest but NOT the canonical.json it references
    writeFileSync(
      join(bundleDir, 'manifest.json'),
      JSON.stringify(makeManifest({ snapshot_id: 'snap-local', knowledge_version: 5 }), null, 2),
    );
    const result = deriveShareState(localSnapshot, bundleDir);
    expect(result.state).toBe('unreadable_bundle');
  });

  it('returns unreadable_bundle when bundle_file is a directory', () => {
    writeFileSync(
      join(bundleDir, 'manifest.json'),
      JSON.stringify(makeManifest({ snapshot_id: 'snap-local', knowledge_version: 5 }), null, 2),
    );
    // Create canonical.json as a directory instead of a file
    mkdirSync(join(bundleDir, 'canonical.json'));
    const result = deriveShareState(localSnapshot, bundleDir);
    expect(result.state).toBe('unreadable_bundle');
  });

  // chmod 000 has no effect when running as root (e.g. Docker CI)
  it.skipIf(process.getuid?.() === 0)('returns unreadable_bundle when bundle_file has no read permission', () => {
    // Write manifest pointing to canonical.json, then remove read permission
    writeFileSync(
      join(bundleDir, 'manifest.json'),
      JSON.stringify(makeManifest({ snapshot_id: 'snap-local', knowledge_version: 5 }), null, 2),
    );
    const bundlePath = join(bundleDir, 'canonical.json');
    writeFileSync(bundlePath, '{}');
    chmodSync(bundlePath, 0o000);
    try {
      const result = deriveShareState(localSnapshot, bundleDir);
      expect(result.state).toBe('unreadable_bundle');
    } finally {
      // Restore permission so cleanup can remove the file
      chmodSync(bundlePath, 0o644);
    }
  });

  // ── in_sync ──

  it('returns in_sync when local snapshot_id matches bundle snapshot_id', () => {
    writeManifest(makeManifest({ snapshot_id: 'snap-local', knowledge_version: 5 }));
    const result = deriveShareState(localSnapshot, bundleDir);
    expect(result.state).toBe('in_sync');
    expect(result.local_snapshot_id).toBe('snap-local');
    expect(result.bundle_snapshot_id).toBe('snap-local');
    expect(result.local_knowledge_version).toBe(5);
    expect(result.bundle_knowledge_version).toBe(5);
  });

  // ── bundle_newer ──

  it('returns bundle_newer when bundle knowledge_version > local', () => {
    writeManifest(makeManifest({ snapshot_id: 'snap-bundle', knowledge_version: 10 }));
    const result = deriveShareState(localSnapshot, bundleDir);
    expect(result.state).toBe('bundle_newer');
    expect(result.bundle_knowledge_version).toBe(10);
    expect(result.local_knowledge_version).toBe(5);
    expect(result.message).toContain('share-hydrate');
  });

  it('returns bundle_newer when local is uninitialized (version 0)', () => {
    writeManifest(makeManifest({ snapshot_id: 'snap-bundle', knowledge_version: 3 }));
    const result = deriveShareState(undefined, bundleDir);
    expect(result.state).toBe('bundle_newer');
    expect(result.local_snapshot_id).toBeNull();
    expect(result.local_knowledge_version).toBe(0);
  });

  // ── local_ahead ──

  it('returns local_ahead when local knowledge_version > bundle', () => {
    writeManifest(makeManifest({ snapshot_id: 'snap-bundle', knowledge_version: 2 }));
    const result = deriveShareState(localSnapshot, bundleDir);
    expect(result.state).toBe('local_ahead');
    expect(result.local_knowledge_version).toBe(5);
    expect(result.bundle_knowledge_version).toBe(2);
    expect(result.message).toContain('share-export');
  });

  // ── diverged ──

  it('returns diverged when same version but different snapshot_id', () => {
    writeManifest(makeManifest({ snapshot_id: 'snap-other', knowledge_version: 5 }));
    const result = deriveShareState(localSnapshot, bundleDir);
    expect(result.state).toBe('diverged');
    expect(result.local_snapshot_id).toBe('snap-local');
    expect(result.bundle_snapshot_id).toBe('snap-other');
    expect(result.message).toContain('share-hydrate');
    expect(result.message).toContain('share-export');
  });

  // ── edge cases ──

  it('handles undefined localSnapshot with no manifest as not_configured', () => {
    const result = deriveShareState(undefined, bundleDir);
    expect(result.state).toBe('not_configured');
    expect(result.local_snapshot_id).toBeNull();
    expect(result.local_knowledge_version).toBe(0);
  });
});
