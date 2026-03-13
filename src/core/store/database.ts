/**
 * Database initialization and access
 * Corresponds to プロジェクト計画v2.md §5.1
 */

import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema.js';

export function createDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Apply schema
  db.exec(SCHEMA_SQL);

  // Migrations for existing databases
  applyMigrations(db);

  // Initialize knowledge_meta if not exists
  const meta = db.prepare('SELECT id FROM knowledge_meta WHERE id = 1').get();
  if (!meta) {
    db.prepare('INSERT INTO knowledge_meta (id, current_version) VALUES (1, 0)').run();
  }

  return db;
}

/**
 * Additive migrations for columns added after initial schema.
 * Each migration is idempotent: checks column existence before ALTER.
 */
function applyMigrations(db: Database.Database): void {
  const hasColumn = (table: string, column: string): boolean => {
    const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    return cols.some((c) => c.name === column);
  };

  // Migration 1: observations.analyzed_at (automation pipeline)
  if (!hasColumn('observations', 'analyzed_at')) {
    db.exec('ALTER TABLE observations ADD COLUMN analyzed_at TEXT');
  }
}

export function createInMemoryDatabase(): Database.Database {
  return createDatabase(':memory:');
}
