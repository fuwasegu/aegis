/**
 * Database initialization and access — sql.js (WASM) backend.
 * Provides a better-sqlite3-compatible API via AegisDatabase / AegisStatement wrappers.
 *
 * Multi-process write safety is achieved through advisory file locking
 * (O_EXCL lockfile). Every write path — both transactional and single-statement —
 * acquires the lock, reloads from disk, applies the change, persists, and releases.
 */

import { closeSync, constants, existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { SCHEMA_SQL } from './schema.js';

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_SPIN_MS = 5;
const LOCK_STALE_MS = 30_000;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

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
    if (this.wrapper._isInTransaction()) {
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
  private lastPersistMs = 0;
  private dirty = false;
  private lockHeld = false;
  private generation = 0;
  private sqlJsStatic: Awaited<ReturnType<typeof initSqlJs>>;

  constructor(sqlDb: SqlJsDatabase, dbPath: string | null, sqlJsStatic: Awaited<ReturnType<typeof initSqlJs>>) {
    this.sqlDb = sqlDb;
    this.dbPath = dbPath;
    this.sqlJsStatic = sqlJsStatic;
    if (dbPath && dbPath !== ':memory:' && existsSync(dbPath)) {
      this.lastPersistMs = statSync(dbPath).mtimeMs;
    }
  }

  // ────────────────────────────────────────────────
  // Advisory file lock (O_EXCL lockfile)
  // ────────────────────────────────────────────────

  /** @internal */
  _acquireFileLock(): void {
    if (!this.dbPath || this.lockHeld) return;
    const lockPath = `${this.dbPath}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
        closeSync(fd);
        this.lockHeld = true;
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

  /** @internal */
  _releaseFileLock(): void {
    if (!this.dbPath || !this.lockHeld) return;
    this.lockHeld = false;
    try {
      unlinkSync(`${this.dbPath}.lock`);
    } catch {
      /* already removed */
    }
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
    if (!this.dbPath || this.inTransaction) return;
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
    const buffer = readFileSync(this.dbPath);
    const fresh = new this.sqlJsStatic.Database(new Uint8Array(buffer));
    this.sqlDb.close();
    this.sqlDb = fresh;
    this.sqlDb.run('PRAGMA foreign_keys = ON');
    this.lastPersistMs = statSync(this.dbPath).mtimeMs;
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
    this._reloadIfStale();
    this.sqlDb.run(sql);
    this.dirty = true;
    this._maybePersist();
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

  /** @internal — persist if not inside a transaction */
  _maybePersist(): void {
    if (!this.inTransaction) {
      this.persist();
    }
  }

  private persist(): void {
    if (!this.dbPath || this.dbPath === ':memory:') return;
    const data = this.sqlDb.export();
    writeFileSync(this.dbPath, Buffer.from(data));
    this.lastPersistMs = statSync(this.dbPath).mtimeMs;
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

export async function createDatabase(dbPath: string): Promise<AegisDatabase> {
  const SQL = await getSqlJs();

  const isMemory = dbPath === ':memory:';
  let db: SqlJsDatabase;

  if (!isMemory && existsSync(dbPath)) {
    const buffer = readFileSync(dbPath);
    db = new SQL.Database(new Uint8Array(buffer));
  } else {
    db = new SQL.Database();
  }

  const wrapper = new AegisDatabase(db, isMemory ? null : dbPath, SQL);

  wrapper.exec('PRAGMA foreign_keys = ON');

  wrapper.exec(SCHEMA_SQL);

  applyMigrations(wrapper);

  const meta = wrapper.prepare('SELECT id FROM knowledge_meta WHERE id = 1').get();
  if (!meta) {
    wrapper.prepare('INSERT INTO knowledge_meta (id, current_version) VALUES (1, 0)').run();
  }

  return wrapper;
}

function applyMigrations(db: AegisDatabase): void {
  const hasColumn = (table: string, column: string): boolean => {
    const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    return cols.some((c) => c.name === column);
  };

  if (!hasColumn('observations', 'analyzed_at')) {
    db.exec('ALTER TABLE observations ADD COLUMN analyzed_at TEXT');
  }

  if (!hasColumn('documents', 'source_path')) {
    db.exec('ALTER TABLE documents ADD COLUMN source_path TEXT');
  }

  if (!hasColumn('compile_log', 'audit_meta')) {
    db.exec('ALTER TABLE compile_log ADD COLUMN audit_meta TEXT');
  }

  // ADR-010: Document Ownership model
  if (!hasColumn('documents', 'ownership')) {
    db.exec("ALTER TABLE documents ADD COLUMN ownership TEXT NOT NULL DEFAULT 'standalone'");
    // Backfill: source_path present → file-anchored
    db.exec("UPDATE documents SET ownership = 'file-anchored' WHERE source_path IS NOT NULL");
  }

  // ADR-002: Add document_import to observations CHECK constraint.
  // SQLite cannot ALTER CHECK constraints, so recreate the table if needed.
  migrateObservationsCheckConstraint(db);
}

function migrateObservationsCheckConstraint(db: AegisDatabase): void {
  const rows = db.pragma("table_info(observations)") as Array<{ name: string }>;
  if (rows.length === 0) return;

  const sqlRows = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='observations'"
  ).get() as { sql: string } | undefined;
  if (!sqlRows?.sql) return;
  if (sqlRows.sql.includes('document_import')) return;

  db.exec(`
    CREATE TABLE observations_new (
        observation_id      TEXT PRIMARY KEY,
        event_type          TEXT NOT NULL
                            CHECK (event_type IN ('compile_miss', 'review_correction',
                                                  'pr_merged', 'manual_note', 'document_import')),
        payload             TEXT NOT NULL,
        related_compile_id  TEXT,
        related_snapshot_id TEXT,
        created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        archived_at         TEXT,
        analyzed_at         TEXT
    );
    INSERT INTO observations_new SELECT * FROM observations;
    DROP TABLE observations;
    ALTER TABLE observations_new RENAME TO observations;
    CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(event_type);
    CREATE INDEX IF NOT EXISTS idx_observations_snap ON observations(related_snapshot_id);
  `);
}

export async function createInMemoryDatabase(): Promise<AegisDatabase> {
  return createDatabase(':memory:');
}
