import type { AegisDatabase } from '../database.js';

/**
 * SQLite schema migration (ADR-013). Only `up` is supported — no down migrations.
 */
export interface Migration {
  version: number;
  name: string;
  up(db: AegisDatabase): void;
}
