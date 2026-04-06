import type { AegisDatabase } from '../database.js';
import type { Migration } from './types.js';

/**
 * ADR-014 Phase 2: `documents.source_synced_at` — last time sync_docs confirmed hash match vs source file.
 */
export function upAddSourceSyncedAt(db: AegisDatabase): void {
  const cols = db.pragma('table_info(documents)') as Array<{ name: string }>;
  if (cols.length === 0) return;
  if (cols.some((c) => c.name === 'source_synced_at')) return;

  db.exec('ALTER TABLE documents ADD COLUMN source_synced_at TEXT');
}

export const migration006: Migration = {
  version: 6,
  name: 'add_source_synced_at',
  up: upAddSourceSyncedAt,
};
