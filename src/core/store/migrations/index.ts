import { migration001 } from './001_initial_baseline.js';

export type { Migration } from './types.js';
export { runMigrations, ensureSchemaMigrationsTable } from './runner.js';
export { migration001, runInitialBaselineSourcePathMigration } from './001_initial_baseline.js';

/** Registered migrations in version order (append new migrations here). */
export const ALL_MIGRATIONS = [migration001];
