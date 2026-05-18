/**
 * Smoke tests for `npx aegis stats` / `npx aegis doctor` (built dist/main.js).
 * `npm test` runs `build` first (see package.json), so dist exists.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execPath } from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from './core/store/database.js';
import { Repository } from './core/store/repository.js';

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

const MAIN_JS = join(dirname(fileURLToPath(import.meta.url)), '../dist/main.js');

describe('CLI — stats / doctor (dist/main.js)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-'));
    mkdirSync(join(dir, '.aegis'), { recursive: true });
    const dbPath = join(dir, '.aegis', 'aegis.db');
    const db = await createDatabase(dbPath);
    // Release file + advisory lock before spawning CLI (Linux CI: second open must not contend).
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('stats prints JSON with knowledge and health', () => {
    const r = spawnSync(execPath, [MAIN_JS, 'stats', '--project-root', dir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    const stderr = r.stderr ?? '';
    expect(stderr).not.toMatch(/Database not found/i);
    const body = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(body.knowledge).toBeDefined();
    expect(body.usage).toBeDefined();
    expect(body.health).toBeDefined();
  }, 15_000);

  it('doctor exits 0 when no health issues', () => {
    const r = spawnSync(execPath, [MAIN_JS, 'doctor', '--project-root', dir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
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
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('doctor exits 1 when unanalyzed observations exist', () => {
    const r = spawnSync(execPath, [MAIN_JS, 'doctor', '--project-root', dir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stdout).toContain('Status: attention');
    expect(r.stdout).toContain('unanalyzed observation');
  });
});

describe('CLI — share-export (dist/main.js)', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when DB is not initialized', () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-share-uninit-'));
    mkdirSync(join(dir, '.aegis'), { recursive: true });
    // Create empty DB (not initialized)
    const db = createDatabase(join(dir, '.aegis', 'aegis.db'));
    // createDatabase is async but we need to wait
    return db.then((d) => {
      d.close();
      const r = spawnSync(execPath, [MAIN_JS, 'share-export', '--project-root', dir], {
        encoding: 'utf-8',
      });
      expect(r.status, `stderr: ${r.stderr}`).toBe(1);
      expect(r.stderr).toContain('not initialized');
    });
  });

  it('exports to default aegis-share/ directory', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-share-ok-'));
    mkdirSync(join(dir, '.aegis'), { recursive: true });
    const dbPath = join(dir, '.aegis', 'aegis.db');
    const d = await createDatabase(dbPath);
    const repo = new Repository(d);
    repo.insertProposal({
      proposal_id: 'boot',
      proposal_type: 'bootstrap',
      payload: JSON.stringify({
        documents: [{ doc_id: 'doc-1', title: 'D1', kind: 'guideline', content: 'c', content_hash: hash('c') }],
        edges: [
          {
            edge_id: 'e1',
            source_type: 'path',
            source_value: 'src/**',
            target_doc_id: 'doc-1',
            edge_type: 'path_requires',
            priority: 1,
            specificity: 0,
          },
        ],
        layer_rules: [],
      }),
      status: 'pending',
      review_comment: null,
    });
    repo.approveProposal('boot');
    d.close();

    const r = spawnSync(execPath, [MAIN_JS, 'share-export', '--project-root', dir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('share-export');
    expect(r.stdout).toContain('Done.');
    expect(existsSync(join(dir, 'aegis-share', 'manifest.json'))).toBe(true);
    expect(existsSync(join(dir, 'aegis-share', 'canonical.json'))).toBe(true);
  }, 15_000);

  it('exports to custom --out directory', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-share-out-'));
    mkdirSync(join(dir, '.aegis'), { recursive: true });
    const dbPath = join(dir, '.aegis', 'aegis.db');
    const d = await createDatabase(dbPath);
    const repo = new Repository(d);
    repo.insertProposal({
      proposal_id: 'boot',
      proposal_type: 'bootstrap',
      payload: JSON.stringify({
        documents: [{ doc_id: 'doc-1', title: 'D1', kind: 'guideline', content: 'c', content_hash: hash('c') }],
        edges: [],
        layer_rules: [],
      }),
      status: 'pending',
      review_comment: null,
    });
    repo.approveProposal('boot');
    d.close();

    const customOut = join(dir, 'custom-share');
    const r = spawnSync(execPath, [MAIN_JS, 'share-export', '--project-root', dir, '--out', customOut], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(existsSync(join(customOut, 'manifest.json'))).toBe(true);
    expect(existsSync(join(customOut, 'canonical.json'))).toBe(true);

    // Verify manifest content
    const manifest = JSON.parse(readFileSync(join(customOut, 'manifest.json'), 'utf-8'));
    expect(manifest.format_version).toBe(1);
    expect(manifest.knowledge_version).toBe(1);
  }, 15_000);

  it('exits 1 when DB does not exist', () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-share-nodb-'));
    const r = spawnSync(execPath, [MAIN_JS, 'share-export', '--project-root', dir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toContain('Database not found');
  });
});
