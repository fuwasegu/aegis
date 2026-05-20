/**
 * Smoke tests for `npx aegis stats` / `npx aegis doctor` (built dist/main.js).
 * `npm test` runs `build` first (see package.json), so dist exists.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('stats prints JSON with knowledge and health and project_share', () => {
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
    expect(body.project_share).toBeDefined();
    const ps = body.project_share as { state: string };
    expect(ps.state).toBe('not_configured');
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

describe('CLI — doctor project-share surfacing', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('doctor exits 1 when bundle is newer than local', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-doctor-share-'));
    mkdirSync(join(dir, '.aegis'), { recursive: true });
    const dbPath = join(dir, '.aegis', 'aegis.db');
    const db = await createDatabase(dbPath);
    db.close();

    // Write a manifest with knowledge_version > 0 (local is 0 / uninitialized)
    const shareDir = join(dir, 'aegis-share');
    mkdirSync(shareDir, { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(shareDir, 'manifest.json'),
      JSON.stringify({
        format_version: 1,
        bundle_file: 'canonical.json',
        snapshot_id: 'snap-remote',
        knowledge_version: 5,
        bundle_sha256: 'abc',
        includes_tag_mappings: false,
      }),
    );
    writeFileSync(join(shareDir, 'canonical.json'), '{}');

    const r = spawnSync(execPath, [MAIN_JS, 'doctor', '--project-root', dir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stdout).toContain('project_share: bundle_newer');
    expect(r.stdout).toContain('project-share bundle_newer');
  }, 15_000);
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

describe('CLI — share-hydrate (dist/main.js)', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Bootstrap an initialized DB, export a bundle, and return the bundle dir. */
  async function prepareBundle(projectRoot: string): Promise<string> {
    mkdirSync(join(projectRoot, '.aegis'), { recursive: true });
    const dbPath = join(projectRoot, '.aegis', 'aegis.db');
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

    // Export bundle
    const r = spawnSync(execPath, [MAIN_JS, 'share-export', '--project-root', projectRoot], {
      encoding: 'utf-8',
    });
    expect(r.status, `share-export stderr: ${r.stderr}`).toBe(0);
    return join(projectRoot, 'aegis-share');
  }

  it('hydrates into default .aegis/aegis.db on fresh project (no pre-existing .aegis/)', async () => {
    // Prepare source project with bundle
    const srcDir = mkdtempSync(join(tmpdir(), 'aegis-cli-hydrate-src-'));
    const bundleDir = await prepareBundle(srcDir);

    // Target project has NO .aegis/ directory — simulates fresh clone
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-hydrate-fresh-'));

    const r = spawnSync(execPath, [MAIN_JS, 'share-hydrate', '--project-root', dir, '--bundle-dir', bundleDir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('share-hydrate');
    expect(r.stdout).toContain('Done.');
    expect(existsSync(join(dir, '.aegis', 'aegis.db'))).toBe(true);

    rmSync(srcDir, { recursive: true, force: true });
  }, 30_000);

  it('fails without --replace when target DB exists', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-hydrate-noreplace-'));
    const bundleDir = await prepareBundle(dir);

    // DB already exists from prepareBundle — hydrate without --replace should fail
    const r = spawnSync(execPath, [MAIN_JS, 'share-hydrate', '--project-root', dir, '--bundle-dir', bundleDir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toContain('--replace');
  }, 30_000);

  it('succeeds with --replace when target DB exists', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-hydrate-replace-'));
    const bundleDir = await prepareBundle(dir);

    const r = spawnSync(
      execPath,
      [MAIN_JS, 'share-hydrate', '--project-root', dir, '--bundle-dir', bundleDir, '--replace'],
      { encoding: 'utf-8' },
    );
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('share-hydrate');
  }, 30_000);

  it('exits 1 when bundle dir has no manifest', () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-hydrate-nomanifest-'));
    const emptyBundleDir = join(dir, 'empty-bundle');
    mkdirSync(emptyBundleDir, { recursive: true });

    const r = spawnSync(execPath, [MAIN_JS, 'share-hydrate', '--project-root', dir, '--bundle-dir', emptyBundleDir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toContain('Manifest not found');
  });

  it('prints operational state warning', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-hydrate-warn-'));
    const srcDir = mkdtempSync(join(tmpdir(), 'aegis-cli-hydrate-warn-src-'));
    const bundleDir = await prepareBundle(srcDir);

    const r = spawnSync(execPath, [MAIN_JS, 'share-hydrate', '--project-root', dir, '--bundle-dir', bundleDir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('operational state');

    rmSync(srcDir, { recursive: true, force: true });
  }, 30_000);
});

describe('CLI — share-lint (dist/main.js)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-lint-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeDoc(docId: string, frontmatter: Record<string, string | null>, body: string): void {
    mkdirSync(join(dir, 'documents'), { recursive: true });
    const fm = Object.entries(frontmatter)
      .map(([k, v]) => `${k}: ${v === null ? 'null' : v}`)
      .join('\n');
    writeFileSync(join(dir, 'documents', `${docId}.md`), `---\n${fm}\n---\n${body}`);
  }

  function writeEdgeFile(filename: string, edges: unknown[]): void {
    mkdirSync(join(dir, 'edges'), { recursive: true });
    writeFileSync(join(dir, 'edges', filename), JSON.stringify(edges, null, 2));
  }

  function writeTagMappings(mappings: unknown[]): void {
    writeFileSync(join(dir, 'tag-mappings.json'), JSON.stringify(mappings, null, 2));
  }

  it('exits 0 for valid source tree', () => {
    writeDoc(
      'guide',
      {
        doc_id: 'guide',
        title: 'Guide',
        kind: 'guideline',
        ownership: 'standalone',
      },
      'Content',
    );
    writeEdgeFile('path-requires.json', [
      { edge_id: 'e1', source_value: 'src/**', target_doc_id: 'guide', priority: 1, specificity: 1 },
    ]);

    const r = spawnSync(execPath, [MAIN_JS, 'share-lint', '--source-dir', dir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('All checks passed');
    expect(r.stdout).toContain('documents:');
  });

  it('exits 1 for dangling edge reference', () => {
    writeDoc(
      'doc-a',
      {
        doc_id: 'doc-a',
        title: 'A',
        kind: 'guideline',
        ownership: 'standalone',
      },
      'A',
    );
    writeEdgeFile('path-requires.json', [
      { edge_id: 'e1', source_value: 'src/**', target_doc_id: 'nonexistent', priority: 1, specificity: 1 },
    ]);

    const r = spawnSync(execPath, [MAIN_JS, 'share-lint', '--source-dir', dir], {
      encoding: 'utf-8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('non-existent document');
    expect(r.stderr).toContain('nonexistent');
  });

  it('exits 1 for dangling tag_mapping reference', () => {
    writeTagMappings([{ tag: 'test', doc_id: 'missing', confidence: 0.9, source: 'manual' }]);

    const r = spawnSync(execPath, [MAIN_JS, 'share-lint', '--source-dir', dir], {
      encoding: 'utf-8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('non-existent document');
    expect(r.stderr).toContain('missing');
  });

  it('exits 1 for malformed JSON', () => {
    mkdirSync(join(dir, 'edges'), { recursive: true });
    writeFileSync(join(dir, 'edges', 'path-requires.json'), '{ broken }');

    const r = spawnSync(execPath, [MAIN_JS, 'share-lint', '--source-dir', dir], {
      encoding: 'utf-8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('error(s) found');
  });

  it('uses default source dir (aegis-share/source/) with --project-root', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'aegis-cli-lint-proj-'));
    const sourceSubDir = join(projectDir, 'aegis-share', 'source');
    mkdirSync(join(sourceSubDir, 'documents'), { recursive: true });
    const fm = 'doc_id: hello\ntitle: Hello\nkind: guideline\nownership: standalone';
    writeFileSync(join(sourceSubDir, 'documents', 'hello.md'), `---\n${fm}\n---\nHello body`);

    const r = spawnSync(execPath, [MAIN_JS, 'share-lint', '--project-root', projectDir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('All checks passed');

    rmSync(projectDir, { recursive: true, force: true });
  });

  it('exits 1 for duplicate doc_id across files', () => {
    writeDoc(
      'real',
      {
        doc_id: 'real',
        title: 'Real',
        kind: 'guideline',
        ownership: 'standalone',
      },
      'First',
    );
    // alias.md with same doc_id → duplicate
    writeFileSync(
      join(dir, 'documents', 'alias.md'),
      '---\ndoc_id: real\ntitle: Alias\nkind: guideline\nownership: standalone\n---\nSecond',
    );

    const r = spawnSync(execPath, [MAIN_JS, 'share-lint', '--source-dir', dir], {
      encoding: 'utf-8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('duplicate doc_id');
    expect(r.stderr).toContain('real');
  });

  it('reports error count in summary', () => {
    writeEdgeFile('path-requires.json', [
      { edge_id: 'e1', source_value: 'a/**', target_doc_id: 'ghost-a', priority: 1, specificity: 1 },
      { edge_id: 'e2', source_value: 'b/**', target_doc_id: 'ghost-b', priority: 1, specificity: 1 },
    ]);

    const r = spawnSync(execPath, [MAIN_JS, 'share-lint', '--source-dir', dir], {
      encoding: 'utf-8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('2 error(s) found');
  });
});

describe('CLI — share-format (dist/main.js)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-cli-format-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeDoc(docId: string, frontmatter: Record<string, string | null>, body: string): void {
    mkdirSync(join(dir, 'documents'), { recursive: true });
    const fm = Object.entries(frontmatter)
      .map(([k, v]) => `${k}: ${v === null ? 'null' : v}`)
      .join('\n');
    writeFileSync(join(dir, 'documents', `${docId}.md`), `---\n${fm}\n---\n${body}`);
  }

  it('exits 0 and formats source tree', () => {
    // Write with scrambled key order
    writeDoc('guide', { ownership: 'standalone', title: 'Guide', kind: 'guideline', doc_id: 'guide' }, 'Content.\n');

    const r = spawnSync(execPath, [MAIN_JS, 'share-format', '--source-dir', dir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('share-format');
    expect(r.stdout).toContain('files_changed');
    expect(r.stdout).toContain('Done.');

    // Verify file was reformatted
    const content = readFileSync(join(dir, 'documents', 'guide.md'), 'utf-8');
    const lines = content.split('\n');
    expect(lines[1]).toMatch(/^doc_id:/);
    expect(lines[2]).toMatch(/^title:/);
  });

  it('second run reports 0 files changed', () => {
    writeDoc('guide', { ownership: 'standalone', title: 'Guide', kind: 'guideline', doc_id: 'guide' }, 'Content.\n');

    // First run
    spawnSync(execPath, [MAIN_JS, 'share-format', '--source-dir', dir], { encoding: 'utf-8' });

    // Second run
    const r = spawnSync(execPath, [MAIN_JS, 'share-format', '--source-dir', dir], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('files_changed:   0');
  });

  it('uses default source dir with --project-root', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'aegis-cli-format-proj-'));
    const sourceSubDir = join(projectDir, 'aegis-share', 'source');
    mkdirSync(join(sourceSubDir, 'documents'), { recursive: true });
    const fm = 'doc_id: hello\ntitle: Hello\nkind: guideline\nownership: standalone';
    writeFileSync(join(sourceSubDir, 'documents', 'hello.md'), `---\n${fm}\n---\nBody.\n`);

    const r = spawnSync(execPath, [MAIN_JS, 'share-format', '--project-root', projectDir], {
      encoding: 'utf-8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('Done.');

    rmSync(projectDir, { recursive: true, force: true });
  });

  it('exits 1 for non-existent source directory', () => {
    const r = spawnSync(execPath, [MAIN_JS, 'share-format', '--source-dir', '/tmp/nonexistent-xxx'], {
      encoding: 'utf-8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('share-format failed');
  });
});
