import type { AegisDatabase } from '../database.js';
import type { Migration } from './types.js';

/**
 * ADR-015: allow `doc_gap_detected` in observations.event_type CHECK.
 * Idempotent: skips if the constraint already includes doc_gap_detected.
 */
export function upAddDocGapEventType(db: AegisDatabase): void {
  const rows = db.pragma('table_info(observations)') as Array<{ name: string }>;
  if (rows.length === 0) return;

  const sqlRows = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='observations'").get() as
    | { sql: string }
    | undefined;
  if (!sqlRows?.sql) return;
  if (sqlRows.sql.includes('doc_gap_detected')) return;

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
                                                  'pr_merged', 'manual_note', 'document_import',
                                                  'doc_gap_detected')),
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

export const migration003: Migration = {
  version: 3,
  name: 'add_doc_gap_event_type',
  up: upAddDocGapEventType,
};
