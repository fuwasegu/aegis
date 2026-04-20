import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createInMemoryDatabase } from '../store/database.js';
import { Repository } from '../store/repository.js';
import type { Document } from '../types.js';
import {
  CoChangeAggregator,
  classifyChangedPaths,
  fingerprintKbPaths,
  kbSourcePathSetForApprovedDocs,
  normalizeGitPath,
  parseCommitFileLog,
  pathsRepoRelativeToProject,
  runCoChangeCacheJob,
} from './co-change-cache.js';

describe('co-change-cache', () => {
  it('fingerprintKbPaths is stable regardless of set iteration order', () => {
    expect(fingerprintKbPaths(new Set(['m/a', 'm/b']))).toBe(fingerprintKbPaths(new Set(['m/b', 'm/a'])));
  });

  it('pathsRepoRelativeToProject maps git-root paths when projectRoot is nested', () => {
    const base = mkdtempSync(join(tmpdir(), 'cc-paths-'));
    try {
      const gr = join(base, 'repo');
      mkdirSync(join(gr, 'apps', 'svc', 'docs'), { recursive: true });
      const project = join(gr, 'apps', 'svc');
      expect(
        pathsRepoRelativeToProject(resolve(gr), resolve(project), [
          'apps/svc/docs/a.md',
          'apps/svc/src/x.ts',
          'README.md',
        ]),
      ).toEqual(['docs/a.md', 'src/x.ts']);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('pathsRepoRelativeToProject is identity when projectRoot equals git root', () => {
    const base = mkdtempSync(join(tmpdir(), 'cc-root-'));
    try {
      const gr = join(base, 'r');
      mkdirSync(join(gr, 'src'), { recursive: true });
      expect(pathsRepoRelativeToProject(resolve(gr), resolve(gr), ['src/a.ts', 'README.md'])).toEqual([
        'src/a.ts',
        'README.md',
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('normalizeGitPath flattens separators', () => {
    expect(normalizeGitPath('.\\foo\\bar')).toBe('foo/bar');
    expect(normalizeGitPath('./docs/x.md')).toBe('docs/x.md');
  });

  it('parseCommitFileLog maps commits to touched paths', () => {
    const stdout = `===COMMIT:aaa\n===COMMIT:bbb\nsrc/a.ts\n===COMMIT:ccc\ndocs/x.md\n`;
    const m = parseCommitFileLog(stdout);
    expect(m.get('aaa')).toEqual([]);
    expect(m.get('bbb')).toEqual(['src/a.ts']);
    expect(m.get('ccc')).toEqual(['docs/x.md']);
  });

  it('kbSourcePathSetForApprovedDocs includes only approved docs with source_path', () => {
    const docs: Document[] = [
      {
        doc_id: 'a',
        title: 'A',
        kind: 'guideline',
        content: 'x',
        content_hash: 'h',
        status: 'approved',
        ownership: 'file-anchored',
        template_origin: null,
        source_path: 'docs/a.md',
        source_synced_at: null,
        created_at: 't',
        updated_at: 't',
      },
      {
        doc_id: 'b',
        title: 'B',
        kind: 'guideline',
        content: 'x',
        content_hash: 'h',
        status: 'draft',
        ownership: 'standalone',
        template_origin: null,
        source_path: 'docs/b.md',
        source_synced_at: null,
        created_at: 't',
        updated_at: 't',
      },
    ];
    const s = kbSourcePathSetForApprovedDocs(docs);
    expect([...s]).toEqual(['docs/a.md']);
  });

  it('classifyChangedPaths splits KB sources vs code by exact path match', () => {
    const kb = new Set(['kb.md']);
    const r = classifyChangedPaths(['src/a.ts', 'kb.md', 'pkg/x.go'], kb);
    expect(r.docPatterns).toEqual(['**']);
    expect(r.codePatterns).toEqual(['pkg/**', 'src/**']);
  });

  it('CoChangeAggregator counts pairs and code-commit totals', () => {
    const agg = new CoChangeAggregator();
    agg.addCommit(['src/**'], ['docs/**']);
    agg.addCommit(['src/**'], ['docs/**']);
    expect(agg.codeCommitCount.get('src/**')).toBe(2);
    const rows = agg.toRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].co_change_count).toBe(2);
    expect(rows[0].total_code_changes).toBe(2);
    expect(rows[0].confidence).toBe(1);
  });

  it('CoChangeAggregator.mergeFromExistingRows restores incremental baseline', () => {
    const agg = new CoChangeAggregator();
    agg.mergeFromExistingRows(
      [
        {
          code_pattern: 'src/**',
          doc_pattern: 'docs/**',
          co_change_count: 3,
          total_code_changes: 5,
          confidence: 0.6,
        },
      ],
      new Map([['src/**', 5]]),
    );
    agg.addCommit(['src/**'], ['docs/**']);
    const rows = agg.toRows();
    expect(rows[0].co_change_count).toBe(4);
    expect(rows[0].total_code_changes).toBe(6);
  });

  it('mergeFromExistingRows includes code-only history in total_code_changes (incremental parity)', () => {
    const full = new CoChangeAggregator();
    full.addCommit(['src/**'], []);
    full.addCommit(['src/**'], ['docs/**']);
    const fullRows = full.toRows();
    expect(fullRows[0].total_code_changes).toBe(2);
    expect(fullRows[0].confidence).toBe(0.5);

    const inc = new CoChangeAggregator();
    inc.mergeFromExistingRows([], new Map([['src/**', 1]]));
    inc.addCommit(['src/**'], ['docs/**']);
    const incRows = inc.toRows();
    expect(incRows[0].total_code_changes).toBe(2);
    expect(incRows[0].co_change_count).toBe(1);
    expect(incRows[0].confidence).toBe(0.5);
  });

  it('runCoChangeCacheJob skips git and meta when no approved doc has source_path', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    const r = await runCoChangeCacheJob({
      projectRoot: process.cwd(),
      repo,
      dryRun: false,
    });
    expect(r.skipped_reason).toBe('no_approved_source_paths');
    expect(repo.getCoChangeLastProcessedCommit()).toBeNull();
  });
});
