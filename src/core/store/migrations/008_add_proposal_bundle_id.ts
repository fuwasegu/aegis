import type { AegisDatabase } from '../database.js';
import type { Migration } from './types.js';

/**
 * ADR-015: optional `bundle_id` groups pending proposals for all-or-nothing approval.
 */
export function upAddProposalBundleId(db: AegisDatabase): void {
  const cols = db.pragma('table_info(proposals)') as Array<{ name: string }>;
  if (cols.length === 0) return;
  if (cols.some((c) => c.name === 'bundle_id')) return;

  db.exec('ALTER TABLE proposals ADD COLUMN bundle_id TEXT');
}

export const migration008: Migration = {
  version: 8,
  name: 'add_proposal_bundle_id',
  up: upAddProposalBundleId,
};
