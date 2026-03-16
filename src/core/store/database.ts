/**
 * Database initialization and access — sql.js (WASM) backend.
 * Provides a better-sqlite3-compatible API via AegisDatabase / AegisStatement wrappers.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { SCHEMA_SQL } from './schema.js';

export interface RunResult {
  changes: number;
}

/**
 * Thin wrapper around a sql.js prepared statement that mirrors the
 * better-sqlite3 Statement API used throughout repository.ts.
 */
export class AegisStatement {
  constructor(
    private stmt: import('sql.js').Statement,
    private wrapper: AegisDatabase,
  ) {}

  run(...params: unknown[]): RunResult {
    if (params.length > 0) {
      this.stmt.bind(params as (string | number | null | Uint8Array)[]);
    }
    this.stmt.step();
    this.stmt.reset();
    const changes = this.wrapper._getRowsModified();
    this.wrapper._maybePersist();
    return { changes };
  }

  get(...params: unknown[]): any {
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
}

/**
 * sql.js wrapper with better-sqlite3-compatible API.
 * Handles file persistence and transaction management transparently.
 */
export class AegisDatabase {
  private sqlDb: SqlJsDatabase;
  private dbPath: string | null;
  private inTransaction = false;

  constructor(sqlDb: SqlJsDatabase, dbPath: string | null) {
    this.sqlDb = sqlDb;
    this.dbPath = dbPath;
  }

  prepare(sql: string): AegisStatement {
    return new AegisStatement(this.sqlDb.prepare(sql), this);
  }

  exec(sql: string): void {
    this.sqlDb.run(sql);
    this._maybePersist();
  }

  pragma(pragmaStr: string): unknown[] {
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
      this.inTransaction = true;
      this.sqlDb.run('BEGIN');
      try {
        const result = fn(...args);
        this.sqlDb.run('COMMIT');
        this.inTransaction = false;
        this.persist();
        return result;
      } catch (e) {
        this.sqlDb.run('ROLLBACK');
        this.inTransaction = false;
        throw e;
      }
    };
  }

  close(): void {
    this.persist();
    this.sqlDb.close();
  }

  /** @internal */
  _getRowsModified(): number {
    return this.sqlDb.getRowsModified();
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

  const wrapper = new AegisDatabase(db, isMemory ? null : dbPath);

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
}

export async function createInMemoryDatabase(): Promise<AegisDatabase> {
  return createDatabase(':memory:');
}
