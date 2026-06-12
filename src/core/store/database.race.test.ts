/**
 * Regression test for the read-before-lock window in createDatabase (#72 review):
 * an opener that loads the DB image while a concurrent writer lands between the
 * read and the recorded mtime must not persist its stale image over that write.
 *
 * The interleaving is forced deterministically via a node:fs hook: the moment
 * the opener reads the DB image, a simulated concurrent writer replaces the
 * file (with the mtime pushed forward past filesystem timestamp granularity,
 * mirroring the race where the recorded mtime does not describe the bytes that
 * were actually read).
 */
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from './database.js';
import { Repository } from './repository.js';

const state = vi.hoisted(() => ({
  onDbRead: null as ((target: string | number) => void) | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((...args: unknown[]) => {
    const result = (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
    state.onDbRead?.(args[0] as string | number);
    return result;
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync };
});

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function insertApprovedDoc(repo: Repository, id: string, title: string): void {
  repo.insertDocument({
    doc_id: id,
    title,
    kind: 'guideline',
    content: `content-${id}`,
    content_hash: hash(`content-${id}`),
    status: 'approved',
  });
}

describe('createDatabase read-before-lock race', () => {
  let fs: typeof import('node:fs');
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    tmpDir = fs.mkdtempSync(join(tmpdir(), 'aegis-db-race-'));
    dbPath = join(tmpDir, 'aegis.db');
  });

  afterEach(() => {
    state.onDbRead = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a stale opener does not clobber a write that lands during its initial DB read', async () => {
    // v1 image: doc-a
    const db1 = await createDatabase(dbPath);
    insertApprovedDoc(new Repository(db1), 'doc-a', 'Doc A');
    db1.close();
    const v1 = fs.readFileSync(dbPath);

    // v2 image: doc-a + doc-b — what the concurrent writer will publish
    const db2 = await createDatabase(dbPath);
    insertApprovedDoc(new Repository(db2), 'doc-b', 'Doc B');
    db2.close();
    const v2 = fs.readFileSync(dbPath);

    // Disk starts at v1; the writer lands v2 exactly when the opener reads the image
    fs.writeFileSync(dbPath, v1);
    state.onDbRead = (target) => {
      if (typeof target === 'string' && target !== dbPath) return;
      state.onDbRead = null; // fire exactly once
      fs.writeFileSync(dbPath, v2);
      const future = new Date(Date.now() + 10_000);
      fs.utimesSync(dbPath, future, future);
    };

    const staleOpener = await createDatabase(dbPath);
    state.onDbRead = null;

    insertApprovedDoc(new Repository(staleOpener), 'doc-c', 'Doc C');
    staleOpener.close();

    // doc-b (the concurrent write) must survive the stale opener's persist
    const reopened = await createDatabase(dbPath);
    const ids = new Repository(reopened)
      .getApprovedDocuments()
      .map((d) => d.doc_id)
      .sort();
    expect(ids).toEqual(['doc-a', 'doc-b', 'doc-c']);
  });

  it('no lockfile is left behind when createDatabase refuses an empty DB file', async () => {
    fs.writeFileSync(dbPath, Buffer.alloc(0));
    await expect(createDatabase(dbPath)).rejects.toThrow(/exists but is empty/);
    // The read now happens under the bootstrap lock; the error path must release it
    expect(fs.existsSync(`${dbPath}.lock`)).toBe(false);
  });
});
