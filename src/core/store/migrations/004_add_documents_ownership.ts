import type { AegisDatabase } from '../database.js';
import type { Migration } from './types.js';

/**
 * ADR-010 Phase 1: `documents.ownership` for reconcile policy (sync_docs targets file-anchored).
 * Idempotent: skips when column already exists (e.g. fresh SCHEMA_SQL or legacy migration 001).
 */
export function upAddDocumentsOwnership(db: AegisDatabase): void {
  const cols = db.pragma('table_info(documents)') as Array<{ name: string }>;
  if (cols.length === 0) return;
  if (cols.some((c) => c.name === 'ownership')) return;

  db.exec("ALTER TABLE documents ADD COLUMN ownership TEXT NOT NULL DEFAULT 'standalone'");
  db.exec("UPDATE documents SET ownership = 'file-anchored' WHERE source_path IS NOT NULL");
}

export const migration004: Migration = {
  version: 4,
  name: 'add_documents_ownership',
  up: upAddDocumentsOwnership,
};
