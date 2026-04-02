export { migration001, runInitialBaselineSourcePathMigration } from './001_initial_baseline.js';
export { migration002, upAddAuditMeta } from './002_add_audit_meta.js';
export { migration003, upAddDocGapEventType } from './003_add_doc_gap_event_type.js';
export { ensureSchemaMigrationsTable, runMigrations } from './runner.js';
export type { Migration } from './types.js';

import { migration001 } from './001_initial_baseline.js';
import { migration002 } from './002_add_audit_meta.js';
import { migration003 } from './003_add_doc_gap_event_type.js';

/** Registered migrations in version order (append new migrations here). */
export const ALL_MIGRATIONS = [migration001, migration002, migration003];
