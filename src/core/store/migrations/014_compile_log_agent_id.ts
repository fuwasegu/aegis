import type { AegisDatabase } from '../database.js';
import type { Migration } from './types.js';

/** ADR-015 Task 015-11: optional self-reported agent id per compile_context invocation. */
export function upCompileLogAgentId(db: AegisDatabase): void {
  const cols = db.pragma('table_info(compile_log)') as Array<{ name: string }>;
  if (cols.length === 0) return;
  if (cols.some((c) => c.name === 'agent_id')) return;

  db.exec('ALTER TABLE compile_log ADD COLUMN agent_id TEXT');
}

export const migration014: Migration = {
  version: 14,
  name: 'compile_log_agent_id',
  up: upCompileLogAgentId,
};
