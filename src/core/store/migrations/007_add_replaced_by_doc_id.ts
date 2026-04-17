import type { AegisDatabase } from '../database.js';
import type { Migration } from './types.js';

/**
 * ADR-014 Phase 3: `documents.replaced_by_doc_id` — optional superseding doc when status is `deprecated`.
 */
export function upAddReplacedByDocId(db: AegisDatabase): void {
  const cols = db.pragma('table_info(documents)') as Array<{ name: string }>;
  if (cols.length === 0) return;
  if (cols.some((c) => c.name === 'replaced_by_doc_id')) return;

  db.exec('ALTER TABLE documents ADD COLUMN replaced_by_doc_id TEXT REFERENCES documents(doc_id)');
}

export const migration007: Migration = {
  version: 7,
  name: 'add_replaced_by_doc_id',
  up: upAddReplacedByDocId,
};
