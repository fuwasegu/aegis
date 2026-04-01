import type { AegisDatabase } from '../database.js';
import type { Migration } from './types.js';

/**
 * Creates `schema_migrations` if missing (ADR-013).
 */
export function ensureSchemaMigrationsTable(db: AegisDatabase): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`);
}

function getAppliedVersions(db: AegisDatabase): Set<number> {
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[];
  return new Set(rows.map((r) => r.version));
}

function recordMigration(db: AegisDatabase, version: number, name: string): void {
  db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(version, name);
}

/**
 * Runs pending migrations in ascending version order, each in its own transaction.
 * Idempotent: already-applied versions are skipped.
 *
 * Applied versions are re-read inside each transaction (after the file lock is held on
 * disk-backed DBs) so two processes do not both attempt to INSERT the same version.
 */
export function runMigrations(db: AegisDatabase, migrations: Migration[]): void {
  ensureSchemaMigrationsTable(db);
  const sorted = [...migrations].sort((a, b) => a.version - b.version);

  for (const m of sorted) {
    const run = db.transaction(() => {
      const applied = getAppliedVersions(db);
      if (applied.has(m.version)) return;
      m.up(db);
      recordMigration(db, m.version, m.name);
    });
    run();
  }
}
