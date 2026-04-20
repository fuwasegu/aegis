import type { AegisDatabase } from '../database.js';
import type { Migration } from './types.js';

/** ADR-015 Task 015-08: invalidate co-change cache when approved source_path set changes. */
export function upCoChangeKbFingerprint(db: AegisDatabase): void {
  db.exec(`
    ALTER TABLE co_change_meta ADD COLUMN kb_paths_fingerprint TEXT;
  `);
}

export const migration011: Migration = {
  version: 11,
  name: 'co_change_kb_fingerprint',
  up: upCoChangeKbFingerprint,
};
