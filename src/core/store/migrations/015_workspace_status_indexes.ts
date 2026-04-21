import type { AegisDatabase } from '../database.js';
import type { Migration } from './types.js';

/** ADR-015 Task 015-11: support workspace_status/read-model scans on large tables. */
export function upWorkspaceStatusIndexes(db: AegisDatabase): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_compile_log_created_at ON compile_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_proposal_evidence_observation ON proposal_evidence(observation_id);
  `);
}

export const migration015: Migration = {
  version: 15,
  name: 'workspace_status_indexes',
  up: upWorkspaceStatusIndexes,
};
