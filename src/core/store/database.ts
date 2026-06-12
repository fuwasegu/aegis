/**
 * Database initialization and access — sql.js (WASM) backend.
 * Provides a better-sqlite3-compatible API via AegisDatabase / AegisStatement wrappers.
 *
 * Multi-process write safety is achieved through advisory file locking
 * (O_EXCL lockfile). Every write path — both transactional and single-statement —
 * acquires the lock, reloads from disk, applies the change, persists, and releases.
 */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { ALL_MIGRATIONS, runMigrations } from './migrations/index.js';
import { SCHEMA_SQL } from './schema.js';

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_SPIN_MS = 5;
const LOCK_STALE_MS = 30_000;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

/**
 * Blocking advisory-lock acquisition on an O_EXCL lockfile.
 * Module-level so `createDatabase` can take the lock before the
 * `AegisDatabase` wrapper exists (the initial DB read must happen under it).
 */
function acquireLockfileBlocking(lockPath: string): void {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      closeSync(fd);
      return;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        const lockAge = Date.now() - statSync(lockPath).mtimeMs;
        if (lockAge > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        /* lock file disappeared between checks — retry */
      }
      if (Date.now() > deadline) {
        throw new Error(`Aegis DB lock acquisition timed out: ${lockPath}`);
      }
      Atomics.wait(WAIT_BUFFER, 0, 0, LOCK_SPIN_MS);
    }
  }
}

function releaseLockfile(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    /* already removed */
  }
}

/**
 * Read a file together with the mtime of the very inode the bytes came from
 * (fstat on the open fd, then read from that same fd). A readFileSync(path)
 * followed by statSync(path) can pair a stale buffer with a newer mtime when
 * another process replaces the file in between — the caller would then treat
 * its stale image as current and clobber the other write on persist.
 */
function readFileWithMtime(path: string): { buffer: Buffer; mtimeMs: number } {
  const fd = openSync(path, 'r');
  try {
    const mtimeMs = fstatSync(fd).mtimeMs;
    const buffer = readFileSync(fd);
    return { buffer, mtimeMs };
  } finally {
    closeSync(fd);
  }
}

export interface RunResult {
  changes: number;
}

/**
 * Thin wrapper around a sql.js prepared statement that mirrors the
 * better-sqlite3 Statement API used throughout repository.ts.
 */
export class AegisStatement {
  private preparedGen: number;

  constructor(
    private stmt: import('sql.js').Statement,
    private wrapper: AegisDatabase,
    private sql: string,
  ) {
    this.preparedGen = wrapper._getGeneration();
  }

  /**
   * Re-prepare the statement if the underlying connection has been
   * replaced by a reload since this statement was created.
   */
  private ensureValid(): void {
    const currentGen = this.wrapper._getGeneration();
    if (this.preparedGen !== currentGen) {
      this.stmt = this.wrapper._rawPrepare(this.sql);
      this.preparedGen = currentGen;
    }
  }

  run(...params: unknown[]): RunResult {
    if (this.wrapper._isInTransaction() || this.wrapper._isBootstrapping()) {
      this.ensureValid();
      return this.executeRun(params);
    }
    this.wrapper._acquireFileLock();
    try {
      if (this.wrapper._isFileStale()) {
        this.wrapper._forceReload();
      }
      this.ensureValid();
      return this.executeRun(params);
    } finally {
      this.wrapper._releaseFileLock();
    }
  }

  get(...params: unknown[]): any {
    this.wrapper._reloadIfStale();
    this.ensureValid();
    if (params.length > 0) {
      this.stmt.bind(params as (string | number | null | Uint8Array)[]);
    }
    if (this.stmt.step()) {
      const result = this.stmt.getAsObject();
      this.stmt.reset();
      return result;
    }
    this.stmt.reset();
    return undefined;
  }

  all(...params: unknown[]): any[] {
    this.wrapper._reloadIfStale();
    this.ensureValid();
    if (params.length > 0) {
      this.stmt.bind(params as (string | number | null | Uint8Array)[]);
    }
    const results: Record<string, unknown>[] = [];
    while (this.stmt.step()) {
      results.push(this.stmt.getAsObject());
    }
    this.stmt.reset();
    return results;
  }

  private executeRun(params: unknown[]): RunResult {
    if (params.length > 0) {
      this.stmt.bind(params as (string | number | null | Uint8Array)[]);
    }
    this.stmt.step();
    this.stmt.reset();
    const changes = this.wrapper._getRowsModified();
    this.wrapper._markDirty();
    this.wrapper._maybePersist();
    return { changes };
  }
}

/**
 * sql.js wrapper with better-sqlite3-compatible API.
 * Handles file persistence, transaction management, and multi-process
 * write safety via advisory file locking.
 */
export class AegisDatabase {
  private sqlDb: SqlJsDatabase;
  private dbPath: string | null;
  private inTransaction = false;
  private bootstrapping = false;
  private lastPersistMs = 0;
  private dirty = false;
  private lockHeld = false;
  private generation = 0;
  private sqlJsStatic: Awaited<ReturnType<typeof initSqlJs>>;

  /**
   * @param initialPersistMs mtime of the DB image `sqlDb` was loaded from, taken from the same
   * inode as the bytes (see `readFileWithMtime`). When omitted (fresh/in-memory DB) the current
   * file mtime is used as a best-effort baseline.
   */
  constructor(
    sqlDb: SqlJsDatabase,
    dbPath: string | null,
    sqlJsStatic: Awaited<ReturnType<typeof initSqlJs>>,
    initialPersistMs?: number,
  ) {
    this.sqlDb = sqlDb;
    this.dbPath = dbPath;
    this.sqlJsStatic = sqlJsStatic;
    if (initialPersistMs !== undefined) {
      this.lastPersistMs = initialPersistMs;
    } else if (dbPath && dbPath !== ':memory:' && existsSync(dbPath)) {
      this.lastPersistMs = statSync(dbPath).mtimeMs;
    }
  }

  // ────────────────────────────────────────────────
  // Advisory file lock (O_EXCL lockfile)
  // ────────────────────────────────────────────────

  /** @internal */
  _acquireFileLock(): void {
    if (!this.dbPath || this.lockHeld) return;
    acquireLockfileBlocking(`${this.dbPath}.lock`);
    this.lockHeld = true;
  }

  /**
   * Take ownership of a lockfile already acquired by the caller (createDatabase
   * acquires it before this wrapper exists so the initial DB read happens under
   * the lock). Subsequent _acquireFileLock calls become no-ops and
   * _releaseFileLock / _endBootstrap will release it.
   * @internal
   */
  _adoptFileLock(): void {
    if (!this.dbPath) return;
    this.lockHeld = true;
  }

  /** @internal */
  _releaseFileLock(): void {
    if (!this.dbPath || !this.lockHeld) return;
    this.lockHeld = false;
    releaseLockfile(`${this.dbPath}.lock`);
  }

  // ────────────────────────────────────────────────
  // Reload / stale detection
  // ────────────────────────────────────────────────

  /**
   * Reload DB from disk if another process has written to the file
   * since our last persist. Used for read paths (no lock required).
   * @internal — also used by AegisStatement for read freshness
   */
  _reloadIfStale(): void {
    if (!this.dbPath || this.inTransaction || this.bootstrapping) return;
    try {
      const currentMtime = statSync(this.dbPath).mtimeMs;
      if (currentMtime > this.lastPersistMs) {
        this.reloadFromDisk();
      }
    } catch {
      /* file may have been deleted — keep current in-memory state */
    }
  }

  /**
   * Unconditionally reload DB from disk.
   * Must be called under file lock for write paths.
   * @internal
   */
  _forceReload(): void {
    if (!this.dbPath || !existsSync(this.dbPath)) return;
    this.reloadFromDisk();
  }

  private reloadFromDisk(): void {
    if (!this.dbPath) return;
    // fstat+read on one fd: lastPersistMs must describe the image we actually
    // loaded, never a newer file that raced in after the read.
    const { buffer, mtimeMs } = readFileWithMtime(this.dbPath);
    if (buffer.length === 0) {
      // Torn read against a writer that is not using atomic rename (e.g. an older
      // Aegis version mid-persist). Loading an empty buffer would silently replace
      // our state with a fresh DB — keep the current in-memory state instead.
      return;
    }
    const fresh = new this.sqlJsStatic.Database(new Uint8Array(buffer));
    this.sqlDb.close();
    this.sqlDb = fresh;
    this.sqlDb.run('PRAGMA foreign_keys = ON');
    this.lastPersistMs = mtimeMs;
    this.dirty = false;
    this.generation++;
  }

  // ────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────

  prepare(sql: string): AegisStatement {
    this._reloadIfStale();
    return new AegisStatement(this.sqlDb.prepare(sql), this, sql);
  }

  exec(sql: string): void {
    if (this.inTransaction || this.bootstrapping) {
      this.sqlDb.run(sql);
      this.dirty = true;
      return;
    }
    this._acquireFileLock();
    try {
      if (this._isFileStale()) {
        this._forceReload();
      }
      this.sqlDb.run(sql);
      this.dirty = true;
      this._maybePersist();
    } finally {
      this._releaseFileLock();
    }
  }

  pragma(pragmaStr: string): unknown[] {
    this._reloadIfStale();
    const results = this.sqlDb.exec(`PRAGMA ${pragmaStr}`);
    if (results.length === 0) return [];
    const { columns, values } = results[0];
    return values.map((row: unknown[]) => {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < columns.length; i++) {
        obj[columns[i]] = row[i];
      }
      return obj;
    });
  }

  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T {
    return (...args: unknown[]) => {
      if (this.inTransaction) {
        return fn(...args);
      }
      if (this.bootstrapping) {
        // Already under the bootstrap file lock; reload and persist are deferred
        // to _endBootstrap. Run with BEGIN/COMMIT for in-memory atomicity only.
        this.inTransaction = true;
        this.sqlDb.run('BEGIN');
        try {
          const result = fn(...args);
          this.sqlDb.run('COMMIT');
          this.inTransaction = false;
          return result;
        } catch (e) {
          this.sqlDb.run('ROLLBACK');
          this.inTransaction = false;
          throw e;
        }
      }
      this._acquireFileLock();
      try {
        this._forceReload();
        this.inTransaction = true;
        this.sqlDb.run('BEGIN');
        try {
          const result = fn(...args);
          this.sqlDb.run('COMMIT');
          this.inTransaction = false;
          if (this.dirty) {
            this.persist();
          }
          return result;
        } catch (e) {
          this.sqlDb.run('ROLLBACK');
          this.inTransaction = false;
          this.dirty = false;
          throw e;
        }
      } finally {
        this._releaseFileLock();
      }
    };
  }

  close(): void {
    if (this.dirty) {
      this.persist();
    }
    this.sqlDb.close();
  }

  // ────────────────────────────────────────────────
  // Internal helpers (used by AegisStatement)
  // ────────────────────────────────────────────────

  /** @internal */
  _getRowsModified(): number {
    return this.sqlDb.getRowsModified();
  }

  /** @internal */
  _markDirty(): void {
    this.dirty = true;
  }

  /** @internal */
  _isInTransaction(): boolean {
    return this.inTransaction;
  }

  /** @internal */
  _isBootstrapping(): boolean {
    return this.bootstrapping;
  }

  /**
   * Enter bootstrap mode: hold the file lock across initial schema/migration
   * setup, defer persistence until _endBootstrap. createDatabase already loads
   * the DB image under this same lock (via _adoptFileLock), so the stale check
   * here only fires against writers that bypass the lock protocol entirely
   * (e.g. older Aegis versions) — defense in depth, not the primary guard.
   * @internal — used by createDatabase only
   */
  _beginBootstrap(): void {
    if (!this.dbPath) {
      this.bootstrapping = true;
      return;
    }
    this._acquireFileLock();
    if (this._isFileStale()) {
      this._forceReload();
    }
    this.cleanupOrphanTmpFiles();
    this.bootstrapping = true;
  }

  /**
   * Leave bootstrap mode. Persists once if the bootstrap actually changed
   * anything (fresh DB, new schema objects, applied migrations); otherwise
   * discards the no-op dirt from PRAGMA / CREATE IF NOT EXISTS so that
   * opening an up-to-date DB never rewrites the file.
   * @internal — used by createDatabase only
   */
  _endBootstrap(persistNeeded: boolean): void {
    this.bootstrapping = false;
    try {
      if (persistNeeded && this.dirty) {
        this.persist();
      } else {
        this.dirty = false;
      }
    } finally {
      this._releaseFileLock();
    }
  }

  /** Remove orphaned atomic-write temp files left by crashed processes. Called under lock. */
  private cleanupOrphanTmpFiles(): void {
    if (!this.dbPath) return;
    const dir = dirname(this.dbPath);
    const prefix = `${basename(this.dbPath)}.tmp-`;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const tmpPath = join(dir, entry);
      try {
        // Only reap temp files that are clearly abandoned (not an in-flight persist).
        if (Date.now() - statSync(tmpPath).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(tmpPath);
        }
      } catch {
        /* already gone — ignore */
      }
    }
  }

  /** @internal — true if the DB file has been modified by another process since our last persist/reload */
  _isFileStale(): boolean {
    if (!this.dbPath) return false;
    try {
      return statSync(this.dbPath).mtimeMs > this.lastPersistMs;
    } catch {
      return false;
    }
  }

  /** @internal */
  _getGeneration(): number {
    return this.generation;
  }

  /** @internal */
  _rawPrepare(sql: string): import('sql.js').Statement {
    return this.sqlDb.prepare(sql);
  }

  /** @internal — persist if not inside a transaction or bootstrap */
  _maybePersist(): void {
    if (!this.inTransaction && !this.bootstrapping) {
      this.persist();
    }
  }

  /**
   * Atomically persist the in-memory DB: write to a temp file in the same
   * directory, then rename over the target. Concurrent readers therefore never
   * observe a truncated or empty DB file (the failure mode where another
   * process loads the half-written file as a fresh DB and later clobbers
   * real data with an empty schema).
   */
  private persist(): void {
    if (!this.dbPath || this.dbPath === ':memory:') return;
    const data = this.sqlDb.export();
    const tmpPath = `${this.dbPath}.tmp-${process.pid}`;
    let persistedMtimeMs: number;
    try {
      writeFileSync(tmpPath, Buffer.from(data));
      // Capture the mtime from the temp file (pid-unique, nobody else touches it);
      // rename preserves it. stat(dbPath) after the rename could pick up a foreign
      // writer's newer file and silently mask its change as our own.
      persistedMtimeMs = statSync(tmpPath).mtimeMs;
      renameSync(tmpPath, this.dbPath);
    } catch (e) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* nothing to clean up */
      }
      throw e;
    }
    this.lastPersistMs = persistedMtimeMs;
    this.dirty = false;
  }
}

let sqlJsInstance: Awaited<ReturnType<typeof initSqlJs>> | null = null;

async function getSqlJs() {
  if (!sqlJsInstance) {
    sqlJsInstance = await initSqlJs();
  }
  return sqlJsInstance;
}

function countSchemaObjects(db: AegisDatabase): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get() as { n: number } | undefined;
  return row?.n ?? 0;
}

function countAppliedMigrations(db: AegisDatabase): number {
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0; // table does not exist yet (pre-schema DB)
  }
}

export async function createDatabase(dbPath: string): Promise<AegisDatabase> {
  const SQL = await getSqlJs();

  const isMemory = dbPath === ':memory:';

  // Take the advisory lock BEFORE reading the existing DB image. Reading outside
  // the lock left a window where another process could persist between our read
  // and the mtime snapshot — this instance would then hold a stale image it
  // believes is current, and its first persist would erase the other write.
  if (!isMemory) {
    acquireLockfileBlocking(`${dbPath}.lock`);
  }

  let db: SqlJsDatabase;
  let initialPersistMs: number | undefined;
  let fileExisted = false;
  try {
    fileExisted = !isMemory && existsSync(dbPath);
    if (fileExisted) {
      let { buffer, mtimeMs } = readFileWithMtime(dbPath);
      if (buffer.length === 0) {
        // An empty-but-existing file is either a torn read against a writer that
        // does not use atomic rename (older Aegis mid-persist, outside the lock
        // protocol) or debris from a crashed process. Retry once; if still empty,
        // refuse to proceed — silently initializing a fresh DB here would clobber
        // the real data on the first persist.
        Atomics.wait(WAIT_BUFFER, 0, 0, 100);
        ({ buffer, mtimeMs } = readFileWithMtime(dbPath));
        if (buffer.length === 0) {
          throw new Error(
            `Aegis DB file exists but is empty: ${dbPath}. ` +
              'Refusing to re-initialize over it — restore the file from a backup, ' +
              'or delete it to start a fresh database.',
          );
        }
      }
      db = new SQL.Database(new Uint8Array(buffer));
      initialPersistMs = mtimeMs;
    } else {
      db = new SQL.Database();
    }
  } catch (e) {
    if (!isMemory) releaseLockfile(`${dbPath}.lock`);
    throw e;
  }

  const wrapper = new AegisDatabase(db, isMemory ? null : dbPath, SQL, initialPersistMs);
  if (!isMemory) {
    wrapper._adoptFileLock();
  }

  // Bootstrap continues under the same file lock with deferred persistence:
  // opening an up-to-date DB writes nothing to disk, and concurrent processes
  // cannot interleave with the initial read, schema setup, or migrations.
  wrapper._beginBootstrap();
  let persistNeeded = !fileExisted && !isMemory;
  try {
    wrapper.exec('PRAGMA foreign_keys = ON');

    const objectsBefore = countSchemaObjects(wrapper);
    const migrationsBefore = countAppliedMigrations(wrapper);

    wrapper.exec(SCHEMA_SQL);

    runMigrations(wrapper, ALL_MIGRATIONS);

    const meta = wrapper.prepare('SELECT id FROM knowledge_meta WHERE id = 1').get();
    if (!meta) {
      wrapper.prepare('INSERT INTO knowledge_meta (id, current_version) VALUES (1, 0)').run();
      persistNeeded = true;
    }

    if (countSchemaObjects(wrapper) !== objectsBefore || countAppliedMigrations(wrapper) !== migrationsBefore) {
      persistNeeded = true;
    }
  } catch (e) {
    wrapper._endBootstrap(false);
    throw e;
  }
  wrapper._endBootstrap(persistNeeded);

  return wrapper;
}

export async function createInMemoryDatabase(): Promise<AegisDatabase> {
  return createDatabase(':memory:');
}
