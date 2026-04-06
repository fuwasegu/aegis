import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { AegisDatabase, createInMemoryDatabase } from '../database.js';
import { migrateObservationsCheckConstraint } from './001_initial_baseline.js';
import {
  ALL_MIGRATIONS,
  runMigrations,
  upAddAuditMeta,
  upAddDocGapEventType,
  upAddDocumentsOwnership,
  upExpandProposalTypeEdgeMutations,
} from './index.js';

describe('schema migrations (ADR-013)', () => {
  it('records migrations 001–005 on first open', async () => {
    const db = await createInMemoryDatabase();
    const rows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as {
      version: number;
      name: string;
    }[];
    expect(rows).toEqual([
      { version: 1, name: 'initial_baseline' },
      { version: 2, name: 'add_audit_meta' },
      { version: 3, name: 'add_doc_gap_event_type' },
      { version: 4, name: 'add_documents_ownership' },
      { version: 5, name: 'expand_proposal_type_edge_mutations' },
    ]);
  });

  it('runMigrations is idempotent on the same connection', async () => {
    const db = await createInMemoryDatabase();
    runMigrations(db, ALL_MIGRATIONS);
    const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: number;
    }[];
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5]);
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

  it('upExpandProposalTypeEdgeMutations rebuilds proposals CHECK when predating retarget/remove_edge', async () => {
    const SQL = await initSqlJs();
    const raw = new SQL.Database();
    raw.run('PRAGMA foreign_keys = ON');
    raw.exec(`
      CREATE TABLE proposals (
        proposal_id     TEXT PRIMARY KEY,
        proposal_type   TEXT NOT NULL
                        CHECK (proposal_type IN ('add_edge', 'update_doc', 'new_doc',
                                                 'deprecate', 'bootstrap')),
        payload         TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
        review_comment  TEXT,
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        resolved_at     TEXT
      );
      INSERT INTO proposals (proposal_id, proposal_type, payload, status)
        VALUES ('p1', 'bootstrap', '{}', 'pending');
    `);
    const db = new AegisDatabase(raw, null, SQL);
    upExpandProposalTypeEdgeMutations(db);
    const master = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='proposals'").get() as {
      sql: string;
    };
    expect(master.sql).toContain('retarget_edge');
    expect(master.sql).toContain('remove_edge');
    const count = db.prepare('SELECT COUNT(*) as c FROM proposals WHERE proposal_id = ?').get('p1') as { c: number };
    expect(count.c).toBe(1);
  });

  it('upExpandProposalTypeEdgeMutations succeeds with proposal_evidence rows (FK on)', async () => {
    const SQL = await initSqlJs();
    const raw = new SQL.Database();
    raw.run('PRAGMA foreign_keys = ON');
    raw.exec(`
      CREATE TABLE proposals (
        proposal_id     TEXT PRIMARY KEY,
        proposal_type   TEXT NOT NULL
                        CHECK (proposal_type IN ('add_edge', 'update_doc', 'new_doc',
                                                 'deprecate', 'bootstrap')),
        payload         TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
        review_comment  TEXT,
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        resolved_at     TEXT
      );
      CREATE TABLE observations (
        observation_id      TEXT PRIMARY KEY,
        event_type          TEXT NOT NULL,
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
      INSERT INTO proposals (proposal_id, proposal_type, payload, status)
        VALUES ('p1', 'bootstrap', '{}', 'pending');
      INSERT INTO observations (observation_id, event_type, payload, created_at)
        VALUES ('o1', 'compile_miss', '{}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      INSERT INTO proposal_evidence (proposal_id, observation_id) VALUES ('p1', 'o1');
    `);
    const db = new AegisDatabase(raw, null, SQL);
    expect(() => upExpandProposalTypeEdgeMutations(db)).not.toThrow();
    const master = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='proposals'").get() as {
      sql: string;
    };
    expect(master.sql).toContain('retarget_edge');
    const ev = db
      .prepare('SELECT proposal_id, observation_id FROM proposal_evidence WHERE proposal_id = ?')
      .get('p1') as { proposal_id: string; observation_id: string };
    expect(ev.observation_id).toBe('o1');
  });

  it('upAddDocumentsOwnership adds ownership when documents predates ADR-010', async () => {
    const SQL = await initSqlJs();
    const raw = new SQL.Database();
    raw.run('PRAGMA foreign_keys = ON');
    raw.exec(`
      CREATE TABLE documents (
        doc_id          TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        kind            TEXT NOT NULL,
        content         TEXT NOT NULL,
        content_hash    TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'approved',
        template_origin TEXT,
        source_path     TEXT,
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      INSERT INTO documents (doc_id, title, kind, content, content_hash, status, source_path)
        VALUES ('a', 'A', 'guideline', 'c', 'h', 'approved', 'docs/x.md');
      INSERT INTO documents (doc_id, title, kind, content, content_hash, status, source_path)
        VALUES ('b', 'B', 'guideline', 'c2', 'h2', 'approved', NULL);
    `);
    const db = new AegisDatabase(raw, null, SQL);
    upAddDocumentsOwnership(db);
    const rowA = db.prepare("SELECT ownership FROM documents WHERE doc_id = 'a'").get() as { ownership: string };
    const rowB = db.prepare("SELECT ownership FROM documents WHERE doc_id = 'b'").get() as { ownership: string };
    expect(rowA.ownership).toBe('file-anchored');
    expect(rowB.ownership).toBe('standalone');
  });
});
