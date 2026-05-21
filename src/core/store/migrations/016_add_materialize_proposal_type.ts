import type { AegisDatabase } from '../database.js';
import type { Migration } from './types.js';

/**
 * ADR-018: Add `materialize` proposal type for source-native lane.
 * Rebuilds `proposals` so CHECK allows the new value.
 * Idempotent: skips when CREATE stmt already lists `materialize`.
 */
export function upAddMaterializeProposalType(db: AegisDatabase): void {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'proposals'`).get() as
    | { sql: string }
    | undefined;
  if (!row?.sql) return;
  if (row.sql.includes('materialize')) return;

  const pe = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='proposal_evidence'").get() as
    | { '1': number }
    | undefined;
  if (pe) {
    db.exec(`
      CREATE TABLE _proposal_evidence_migration_backup_016 AS SELECT * FROM proposal_evidence;
      DROP TABLE proposal_evidence;
    `);
  }

  db.exec(`
CREATE TABLE proposals_new (
    proposal_id     TEXT PRIMARY KEY,
    proposal_type   TEXT NOT NULL
                    CHECK (proposal_type IN ('add_edge', 'update_doc', 'new_doc',
                                             'deprecate', 'bootstrap', 'retarget_edge', 'remove_edge',
                                             'materialize')),
    payload         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
    review_comment  TEXT,
    bundle_id       TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    resolved_at     TEXT
);
INSERT INTO proposals_new SELECT * FROM proposals;
DROP TABLE proposals;
ALTER TABLE proposals_new RENAME TO proposals;
`);

  if (pe) {
    db.exec(`
      CREATE TABLE proposal_evidence (
          proposal_id     TEXT NOT NULL REFERENCES proposals(proposal_id),
          observation_id  TEXT NOT NULL REFERENCES observations(observation_id),
          PRIMARY KEY (proposal_id, observation_id)
      );
      INSERT INTO proposal_evidence SELECT * FROM _proposal_evidence_migration_backup_016;
      DROP TABLE _proposal_evidence_migration_backup_016;
    `);
  }
}

export const migration016: Migration = {
  version: 16,
  name: 'add_materialize_proposal_type',
  up: upAddMaterializeProposalType,
};
