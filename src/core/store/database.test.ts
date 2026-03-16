import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from './database.js';
import { Repository } from './repository.js';

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function insertApprovedDoc(repo: Repository, id: string, title: string): void {
  repo.insertDocument({
    doc_id: id,
    title,
    kind: 'guideline',
    content: `content-${id}`,
    content_hash: hash(`content-${id}`),
    status: 'approved',
  });
}

describe('AegisDatabase file-backed multi-instance', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aegis-db-test-'));
    dbPath = join(tmpDir, 'aegis.db');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Cross-process read visibility ──────────────────────────

  it('instance B sees writes from instance A via stale reload', async () => {
    const dbA = await createDatabase(dbPath);
    const dbB = await createDatabase(dbPath);
    const repoA = new Repository(dbA);
    const repoB = new Repository(dbB);

    insertApprovedDoc(repoA, 'doc-a', 'Doc A');

    const docs = repoB.getApprovedDocuments();
    expect(docs).toHaveLength(1);
    expect(docs[0].doc_id).toBe('doc-a');
  });

  it('instance A sees writes from instance B (bidirectional)', async () => {
    const dbA = await createDatabase(dbPath);
    const dbB = await createDatabase(dbPath);
    const repoA = new Repository(dbA);
    const repoB = new Repository(dbB);

    insertApprovedDoc(repoA, 'doc-a', 'Doc A');
    insertApprovedDoc(repoB, 'doc-b', 'Doc B');

    const docsFromA = repoA.getApprovedDocuments();
    expect(docsFromA.map((d) => d.doc_id).sort()).toEqual(['doc-a', 'doc-b']);

    const docsFromB = repoB.getApprovedDocuments();
    expect(docsFromB.map((d) => d.doc_id).sort()).toEqual(['doc-a', 'doc-b']);
  });

  // ── Sequential transaction safety ─────────────────────────

  it('sequential transactions from different instances do not lose data', async () => {
    const dbA = await createDatabase(dbPath);
    const dbB = await createDatabase(dbPath);
    const repoA = new Repository(dbA);
    const repoB = new Repository(dbB);

    repoA.runInTransaction(() => {
      insertApprovedDoc(repoA, 'doc-a', 'Doc A');
    });

    repoB.runInTransaction(() => {
      insertApprovedDoc(repoB, 'doc-b', 'Doc B');
    });

    const docsFromA = repoA.getApprovedDocuments();
    expect(docsFromA).toHaveLength(2);
    expect(docsFromA.map((d) => d.doc_id).sort()).toEqual(['doc-a', 'doc-b']);
  });

  // ── Overlapping writer safety (the core regression test) ──

  it('overlapping single-statement writes do not lose data', async () => {
    const dbA = await createDatabase(dbPath);
    const dbB = await createDatabase(dbPath);
    const repoA = new Repository(dbA);
    const repoB = new Repository(dbB);

    // Interleaved non-transactional writes
    insertApprovedDoc(repoA, 'doc-1', 'Doc 1');
    insertApprovedDoc(repoB, 'doc-2', 'Doc 2');
    insertApprovedDoc(repoA, 'doc-3', 'Doc 3');
    insertApprovedDoc(repoB, 'doc-4', 'Doc 4');

    const docs = repoA.getApprovedDocuments();
    expect(docs).toHaveLength(4);
    expect(docs.map((d) => d.doc_id).sort()).toEqual(['doc-1', 'doc-2', 'doc-3', 'doc-4']);
  });

  it('transaction after non-transactional writes preserves all data', async () => {
    const dbA = await createDatabase(dbPath);
    const dbB = await createDatabase(dbPath);
    const repoA = new Repository(dbA);
    const repoB = new Repository(dbB);

    insertApprovedDoc(repoA, 'doc-a', 'Doc A');

    repoB.runInTransaction(() => {
      insertApprovedDoc(repoB, 'doc-b1', 'Doc B1');
      insertApprovedDoc(repoB, 'doc-b2', 'Doc B2');
    });

    const allDocs = repoA.getApprovedDocuments();
    expect(allDocs).toHaveLength(3);
    expect(allDocs.map((d) => d.doc_id).sort()).toEqual(['doc-a', 'doc-b1', 'doc-b2']);
  });

  // ── close() safety ────────────────────────────────────────

  it('read-only instance close() does not roll back the database', async () => {
    const dbA = await createDatabase(dbPath);
    const repoA = new Repository(dbA);

    insertApprovedDoc(repoA, 'doc-a', 'Doc A');

    const dbReadOnly = await createDatabase(dbPath);
    const repoReadOnly = new Repository(dbReadOnly);
    expect(repoReadOnly.getApprovedDocuments()).toHaveLength(1);

    insertApprovedDoc(repoA, 'doc-b', 'Doc B');

    dbReadOnly.close();

    const dbC = await createDatabase(dbPath);
    const repoC = new Repository(dbC);
    const allDocs = repoC.getApprovedDocuments();
    expect(allDocs).toHaveLength(2);
    expect(allDocs.map((d) => d.doc_id).sort()).toEqual(['doc-a', 'doc-b']);
  });

  // ── Knowledge version consistency ─────────────────────────

  it('knowledge_version increments survive cross-instance writes', async () => {
    const dbA = await createDatabase(dbPath);
    const dbB = await createDatabase(dbPath);
    const repoA = new Repository(dbA);
    const repoB = new Repository(dbB);

    expect(repoA.getKnowledgeMeta().current_version).toBe(0);

    insertApprovedDoc(repoA, 'doc-a', 'Doc A');
    insertApprovedDoc(repoB, 'doc-b', 'Doc B');

    const versionFromA = repoA.getKnowledgeMeta().current_version;
    const versionFromB = repoB.getKnowledgeMeta().current_version;
    expect(versionFromA).toBe(versionFromB);
  });

  // ── TEMP TABLE / transitive dependency safety ─────────────

  it('getTransitiveDependencies works on file-backed DB', async () => {
    const db = await createDatabase(dbPath);
    const repo = new Repository(db);

    insertApprovedDoc(repo, 'root', 'Root');
    insertApprovedDoc(repo, 'dep-1', 'Dep 1');
    insertApprovedDoc(repo, 'dep-2', 'Dep 2');

    repo.insertEdge({
      edge_id: 'e1',
      source_type: 'doc',
      source_value: 'root',
      target_doc_id: 'dep-1',
      edge_type: 'doc_depends_on',
      priority: 0,
      specificity: 0,
      status: 'approved',
    });
    repo.insertEdge({
      edge_id: 'e2',
      source_type: 'doc',
      source_value: 'dep-1',
      target_doc_id: 'dep-2',
      edge_type: 'doc_depends_on',
      priority: 0,
      specificity: 0,
      status: 'approved',
    });

    const deps = repo.getTransitiveDependencies(['root']);
    expect(deps.map((d) => d.doc_id).sort()).toEqual(['dep-1', 'dep-2', 'root']);
  });

  it('getTransitiveDependencies works across instances on same file', async () => {
    const dbA = await createDatabase(dbPath);
    const repoA = new Repository(dbA);

    insertApprovedDoc(repoA, 'root', 'Root');
    insertApprovedDoc(repoA, 'dep-1', 'Dep 1');
    repoA.insertEdge({
      edge_id: 'e1',
      source_type: 'doc',
      source_value: 'root',
      target_doc_id: 'dep-1',
      edge_type: 'doc_depends_on',
      priority: 0,
      specificity: 0,
      status: 'approved',
    });

    const dbB = await createDatabase(dbPath);
    const repoB = new Repository(dbB);

    const deps = repoB.getTransitiveDependencies(['root']);
    expect(deps.map((d) => d.doc_id).sort()).toEqual(['dep-1', 'root']);
  });

  // ── Stale prepared statement safety ───────────────────────

  it('prepared statement survives a reload triggered by another read', async () => {
    const dbA = await createDatabase(dbPath);
    const dbB = await createDatabase(dbPath);
    const repoA = new Repository(dbA);

    insertApprovedDoc(repoA, 'doc-existing', 'Existing');

    // Prepare a statement on dbA (binds to current generation)
    const stmt = dbA.prepare(
      'INSERT INTO documents (doc_id, title, kind, content, content_hash, status) VALUES (?, ?, ?, ?, ?, ?)',
    );

    // Another instance writes, making dbA's file stale
    const repoB = new Repository(dbB);
    insertApprovedDoc(repoB, 'doc-from-b', 'From B');

    // A read on dbA triggers reloadIfStale(), replacing the connection
    const docs = repoA.getApprovedDocuments();
    expect(docs).toHaveLength(2);

    // Now use the originally-prepared statement — should auto re-prepare, not crash
    stmt.run('doc-from-stmt', 'From Stmt', 'guideline', 'c', hash('c'), 'approved');

    const allDocs = repoA.getApprovedDocuments();
    expect(allDocs).toHaveLength(3);
    expect(allDocs.map((d) => d.doc_id).sort()).toEqual(['doc-existing', 'doc-from-b', 'doc-from-stmt']);
  });

  it('prepared get() survives a reload triggered by another operation', async () => {
    const dbA = await createDatabase(dbPath);
    const dbB = await createDatabase(dbPath);
    const repoA = new Repository(dbA);

    insertApprovedDoc(repoA, 'doc-a', 'Doc A');

    // Prepare a SELECT statement on dbA
    const stmt = dbA.prepare('SELECT * FROM documents WHERE doc_id = ?');

    // Another instance writes, making dbA stale
    const repoB = new Repository(dbB);
    insertApprovedDoc(repoB, 'doc-b', 'Doc B');

    // Trigger reload via a different read
    repoA.getApprovedDocuments();

    // The originally-prepared SELECT should auto re-prepare and work
    const row = stmt.get('doc-a');
    expect(row).toBeDefined();
    expect(row.doc_id).toBe('doc-a');
  });

  it('get() sees external writes without any intervening operation on same instance', async () => {
    const dbA = await createDatabase(dbPath);
    const dbB = await createDatabase(dbPath);
    const repoA = new Repository(dbA);

    insertApprovedDoc(repoA, 'doc-a', 'Doc A');

    // Prepare SELECT on dbA, then external write — NO other dbA operation in between
    const stmt = dbA.prepare('SELECT * FROM documents WHERE status = ?');

    const repoB = new Repository(dbB);
    insertApprovedDoc(repoB, 'doc-b', 'Doc B');

    // Direct call — must see both docs
    const rows = stmt.all('approved');
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.doc_id).sort()).toEqual(['doc-a', 'doc-b']);
  });

  it('get() returns fresh row without intervening operation', async () => {
    const dbA = await createDatabase(dbPath);
    const dbB = await createDatabase(dbPath);

    dbA
      .prepare('INSERT INTO documents (doc_id, title, kind, content, content_hash, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run('doc-a', 'Old Title', 'guideline', 'old', hash('old'), 'approved');

    // Prepare a SELECT, then external update — no intervening dbA operation
    const stmt = dbA.prepare('SELECT * FROM documents WHERE doc_id = ?');

    const repoB = new Repository(dbB);
    repoB.runInTransaction(() => {
      dbB.prepare('UPDATE documents SET title = ? WHERE doc_id = ?').run('New Title', 'doc-a');
    });

    const row = stmt.get('doc-a');
    expect(row).toBeDefined();
    expect(row.title).toBe('New Title');
  });
});
