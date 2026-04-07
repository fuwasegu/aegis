/**
 * Smoke tests for `npx aegis stats` / `npx aegis doctor` (built dist/main.js).
 * `npm test` runs `build` first (see package.json), so dist exists.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from './core/store/database.js';
import { Repository } from './core/store/repository.js';

const MAIN_JS = join(import.meta.dirname, '../dist/main.js');

describe('CLI — stats / doctor (dist/main.js)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-'));
    mkdirSync(join(dir, '.aegis'), { recursive: true });
    const dbPath = join(dir, '.aegis', 'aegis.db');
    await createDatabase(dbPath);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('stats prints JSON with knowledge and health', () => {
    const r = spawnSync('node', [MAIN_JS, 'stats', '--project-root', dir], {
      encoding: 'utf-8',
    });
    expect(r.status).toBe(0);
    const stderr = r.stderr ?? '';
    expect(stderr).not.toMatch(/Database not found/i);
    const body = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(body.knowledge).toBeDefined();
    expect(body.usage).toBeDefined();
    expect(body.health).toBeDefined();
  });

  it('doctor exits 0 when no health issues', () => {
    const r = spawnSync('node', [MAIN_JS, 'doctor', '--project-root', dir], {
      encoding: 'utf-8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Status: OK');
  });
});

describe('CLI — doctor exit 1 on health issues', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-bad-'));
    mkdirSync(join(dir, '.aegis'), { recursive: true });
    const dbPath = join(dir, '.aegis', 'aegis.db');
    const db = await createDatabase(dbPath);
    const repo = new Repository(db);
    repo.insertObservation({
      observation_id: 'obs-cli-doctor',
      event_type: 'compile_miss',
      payload: JSON.stringify({ target_files: ['a.ts'], review_comment: 'x' }),
      related_compile_id: 'c1',
      related_snapshot_id: 's1',
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('doctor exits 1 when unanalyzed observations exist', () => {
    const r = spawnSync('node', [MAIN_JS, 'doctor', '--project-root', dir], {
      encoding: 'utf-8',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Status: attention');
    expect(r.stdout).toContain('unanalyzed observation');
  });
});
