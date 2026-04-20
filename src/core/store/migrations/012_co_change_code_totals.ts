import type { AegisDatabase } from '../database.js';
import type { Migration } from './types.js';

/**
 * Per code_pattern commit totals (includes code-only commits) for incremental co-change accuracy.
 */
export function upCoChangeCodeTotals(db: AegisDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS co_change_code_totals (
        code_pattern         TEXT PRIMARY KEY,
        code_commit_count    INTEGER NOT NULL,
        updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
}

export const migration012: Migration = {
  version: 12,
  name: 'co_change_code_totals',
  up: upCoChangeCodeTotals,
};
