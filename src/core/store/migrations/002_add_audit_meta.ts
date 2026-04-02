import type { AegisDatabase } from '../database.js';
import type { Migration } from './types.js';

/**
 * ADR-012 Phase 1: `compile_log.audit_meta` for delivery_stats, budget_utilization, etc.
 * Idempotent: safe if the column already exists (fresh SCHEMA_SQL or legacy 001).
 */
export function upAddAuditMeta(db: AegisDatabase): void {
  const cols = db.pragma('table_info(compile_log)') as Array<{ name: string }>;
  if (cols.length === 0) return;
  if (cols.some((c) => c.name === 'audit_meta')) return;
  db.exec('ALTER TABLE compile_log ADD COLUMN audit_meta TEXT');
}

export const migration002: Migration = {
  version: 2,
  name: 'add_audit_meta',
  up: upAddAuditMeta,
};
