import { migrateSourcePaths } from '../../paths.js';
import type { AegisDatabase } from '../database.js';
import type { Repository } from '../repository.js';
import type { Migration } from './types.js';

/**
 * Recreates `observations` when the table predates `document_import` in the event_type CHECK.
 * `proposal_evidence` references `observations`; drop it temporarily so DROP TABLE observations
 * succeeds under PRAGMA foreign_keys=ON (Codex review / SQLite FK rules).
 */
export function migrateObservationsCheckConstraint(db: AegisDatabase): void {
  const rows = db.pragma('table_info(observations)') as Array<{ name: string }>;
  if (rows.length === 0) return;

  const sqlRows = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='observations'").get() as
    | { sql: string }
    | undefined;
  if (!sqlRows?.sql) return;
  if (sqlRows.sql.includes('document_import')) return;

  const pe = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='proposal_evidence'").get() as
    | { '1': number }
    | undefined;
  if (pe) {
    db.exec(`
      CREATE TABLE _proposal_evidence_migration_backup AS SELECT * FROM proposal_evidence;
      DROP TABLE proposal_evidence;
    `);
  }

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

  if (pe) {
    db.exec(`
      CREATE TABLE proposal_evidence (
          proposal_id     TEXT NOT NULL REFERENCES proposals(proposal_id),
          observation_id  TEXT NOT NULL REFERENCES observations(observation_id),
          PRIMARY KEY (proposal_id, observation_id)
      );
      INSERT INTO proposal_evidence SELECT * FROM _proposal_evidence_migration_backup;
      DROP TABLE _proposal_evidence_migration_backup;
    `);
  }
}

/**
 * Legacy incremental schema brought forward from pre–ADR-013 ad hoc migrations.
 * Uses column / DDL checks so it is safe on both fresh SCHEMA_SQL DBs and older files.
 */
export function upInitialBaseline(db: AegisDatabase): void {
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

  migrateObservationsCheckConstraint(db);
}

export const migration001: Migration = {
  version: 1,
  name: 'initial_baseline',
  up: upInitialBaseline,
};

/**
 * Admin-only data migration formalized as part of migration 001 (ADR-009 D-11, ADR-013 §4).
 * Delegates to `migrateSourcePaths` — idempotent; safe to run on every admin startup.
 */
export function runInitialBaselineSourcePathMigration(repo: Repository, projectRoot: string): void {
  migrateSourcePaths(repo, projectRoot);
}
