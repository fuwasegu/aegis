import type { AegisDatabase } from '../database.js';
import type { Migration } from './types.js';

/**
 * ADR-015 Task 015-10: `documents.source_refs_json` — JSON array of repo assets (N:M mapping).
 */
export function upAddSourceRefsJson(db: AegisDatabase): void {
  const cols = db.pragma('table_info(documents)') as Array<{ name: string }>;
  if (cols.length === 0) return;
  if (cols.some((c) => c.name === 'source_refs_json')) return;

  db.exec('ALTER TABLE documents ADD COLUMN source_refs_json TEXT');
}

export const migration013: Migration = {
  version: 13,
  name: 'add_source_refs_json',
  up: upAddSourceRefsJson,
};
