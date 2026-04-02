import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { AegisDatabase, createInMemoryDatabase } from '../database.js';
import { migrateObservationsCheckConstraint } from './001_initial_baseline.js';
import { ALL_MIGRATIONS, runMigrations, upAddAuditMeta, upAddDocGapEventType } from './index.js';

describe('schema migrations (ADR-013)', () => {
  it('records migrations 001–003 on first open', async () => {
    const db = await createInMemoryDatabase();
    const rows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as {
      version: number;
      name: string;
    }[];
    expect(rows).toEqual([
      { version: 1, name: 'initial_baseline' },
      { version: 2, name: 'add_audit_meta' },
      { version: 3, name: 'add_doc_gap_event_type' },
    ]);
  });

  it('runMigrations is idempotent on the same connection', async () => {
    const db = await createInMemoryDatabase();
    runMigrations(db, ALL_MIGRATIONS);
    const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: number;
    }[];
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3]);
  });

  it('applies baseline DDL including compile_log.audit_meta', async () => {
    const db = await createInMemoryDatabase();
    const cols = db.pragma('table_info(compile_log)') as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'audit_meta')).toBe(true);
  });

  it('upAddAuditMeta adds audit_meta when compile_log predates the column', async () => {
    const SQL = await initSqlJs();
    const raw = new SQL.Database();
    raw.run('PRAGMA foreign_keys = ON');
    raw.exec(`
      CREATE TABLE snapshots (snapshot_id TEXT PRIMARY KEY, knowledge_version INTEGER NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO snapshots VALUES ('s1', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      CREATE TABLE compile_log (
        compile_id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL REFERENCES snapshots(snapshot_id),
        request TEXT NOT NULL,
        base_doc_ids TEXT NOT NULL,
        expanded_doc_ids TEXT,
        created_at TEXT NOT NULL
      );
    `);
    const db = new AegisDatabase(raw, null, SQL);
    upAddAuditMeta(db);
    const cols = db.pragma('table_info(compile_log)') as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'audit_meta')).toBe(true);
  });

  it('migrateObservationsCheckConstraint succeeds when proposal_evidence FK references observations', async () => {
    const SQL = await initSqlJs();
    const raw = new SQL.Database();
    raw.run('PRAGMA foreign_keys = ON');
    raw.exec(`
      CREATE TABLE proposals (
        proposal_id     TEXT PRIMARY KEY,
        proposal_type   TEXT NOT NULL,
        payload         TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        review_comment  TEXT,
        created_at      TEXT NOT NULL,
        resolved_at     TEXT
      );
      CREATE TABLE observations (
        observation_id      TEXT PRIMARY KEY,
        event_type          TEXT NOT NULL
                            CHECK (event_type IN ('compile_miss', 'review_correction',
                                                  'pr_merged', 'manual_note')),
        payload             TEXT NOT NULL,
        related_compile_id  TEXT,
        related_snapshot_id TEXT,
        created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        archived_at         TEXT,
        analyzed_at         TEXT
      );
      CREATE TABLE proposal_evidence (
        proposal_id     TEXT NOT NULL REFERENCES proposals(proposal_id),
        observation_id  TEXT NOT NULL REFERENCES observations(observation_id),
        PRIMARY KEY (proposal_id, observation_id)
      );
      INSERT INTO proposals (proposal_id, proposal_type, payload, status, created_at)
        VALUES ('p1', 'bootstrap', '{}', 'pending', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      INSERT INTO observations (observation_id, event_type, payload, created_at)
        VALUES ('o1', 'compile_miss', '{}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      INSERT INTO proposal_evidence VALUES ('p1', 'o1');
    `);
    const db = new AegisDatabase(raw, null, SQL);
    expect(() => migrateObservationsCheckConstraint(db)).not.toThrow();
    const master = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='observations'").get() as {
      sql: string;
    };
    expect(master.sql).toContain('document_import');
    const count = db.prepare('SELECT COUNT(*) as c FROM proposal_evidence').get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('upAddDocGapEventType adds doc_gap_detected to observations CHECK when predating', async () => {
    const SQL = await initSqlJs();
    const raw = new SQL.Database();
    raw.run('PRAGMA foreign_keys = ON');
    raw.exec(`
      CREATE TABLE proposals (
        proposal_id     TEXT PRIMARY KEY,
        proposal_type   TEXT NOT NULL,
        payload         TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        review_comment  TEXT,
        created_at      TEXT NOT NULL,
        resolved_at     TEXT
      );
      CREATE TABLE observations (
        observation_id      TEXT PRIMARY KEY,
        event_type          TEXT NOT NULL
                            CHECK (event_type IN ('compile_miss', 'review_correction',
                                                  'pr_merged', 'manual_note', 'document_import')),
        payload             TEXT NOT NULL,
        related_compile_id  TEXT,
        related_snapshot_id TEXT,
        created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        archived_at         TEXT,
        analyzed_at         TEXT
      );
      CREATE TABLE proposal_evidence (
        proposal_id     TEXT NOT NULL REFERENCES proposals(proposal_id),
        observation_id  TEXT NOT NULL REFERENCES observations(observation_id),
        PRIMARY KEY (proposal_id, observation_id)
      );
      INSERT INTO observations (observation_id, event_type, payload, created_at)
        VALUES ('o1', 'compile_miss', '{}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `);
    const db = new AegisDatabase(raw, null, SQL);
    upAddDocGapEventType(db);
    const master = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='observations'").get() as {
      sql: string;
    };
    expect(master.sql).toContain('doc_gap_detected');
  });
});
