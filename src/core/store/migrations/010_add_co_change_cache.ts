import type { AegisDatabase } from '../database.js';
import type { Migration } from './types.js';

/**
 * ADR-015 Task 015-08: co-change cache (operational metadata, maintenance-built).
 */
export function upAddCoChangeCache(db: AegisDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS co_change_meta (
        id                      INTEGER PRIMARY KEY CHECK (id = 1),
        last_processed_commit   TEXT,
        updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS co_change_patterns (
        code_pattern          TEXT NOT NULL,
        doc_pattern           TEXT NOT NULL,
        co_change_count       INTEGER NOT NULL,
        total_code_changes    INTEGER NOT NULL,
        confidence            REAL NOT NULL,
        updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (code_pattern, doc_pattern)
    );

    CREATE INDEX IF NOT EXISTS idx_co_change_patterns_code ON co_change_patterns(code_pattern);

    INSERT OR IGNORE INTO co_change_meta (id, last_processed_commit) VALUES (1, NULL);
  `);
}

export const migration010: Migration = {
  version: 10,
  name: 'add_co_change_cache',
  up: upAddCoChangeCache,
};
