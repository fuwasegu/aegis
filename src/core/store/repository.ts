/**
 * Canonical Knowledge Repository
 * Enforces INV-1 through INV-6 from プロジェクト計画v2.md §6.1
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { normalizeSourcePath, resolveSourcePath } from '../paths.js';
import {
  type CanonicalVersion,
  type CoChangePatternRow,
  type CompileLog,
  type DocOwnership,
  type Document,
  type Edge,
  type EdgeSourceType,
  type EdgeType,
  type EntityStatus,
  type InitManifest,
  type KnowledgeMeta,
  type LayerRule,
  type Observation,
  PENDING_CONTENT_PLACEHOLDER,
  type Proposal,
  type ProposalBundlePreflightLeaf,
  type ProposalBundlePreflightResult,
  type ProposalStatus,
  type ProposalType,
  type Snapshot,
  type TagMapping,
} from '../types.js';
import type { AegisDatabase } from './database.js';
import { orderPendingBundleProposals } from './proposal-bundle-order.js';

const DOC_OWNERSHIP_SET = new Set<DocOwnership>(['file-anchored', 'standalone', 'derived']);

/** Validates payload / modification ownership strings (legacy DBs may lack schema CHECK). */
function normalizeDocOwnership(raw: unknown): DocOwnership {
  if (typeof raw !== 'string' || !DOC_OWNERSHIP_SET.has(raw as DocOwnership)) {
    throw new Error(
      `Invalid ownership: must be one of ${[...DOC_OWNERSHIP_SET].join(', ')} (got ${JSON.stringify(raw)})`,
    );
  }
  return raw as DocOwnership;
}

/** ADR-010: file-anchored docs participate in sync_docs and require a concrete source_path. */
function assertOwnershipSourcePathInvariant(ownership: DocOwnership, sourcePath: string | null | undefined): void {
  if (ownership === 'file-anchored') {
    if (sourcePath == null || String(sourcePath).trim() === '') {
      throw new Error("Invalid document state: ownership 'file-anchored' requires a non-empty source_path");
    }
  }
}

export class CycleDetectedError extends Error {
  constructor(sourceDocId: string, targetDocId: string) {
    super(`Adding edge ${sourceDocId} -> ${targetDocId} would create a cycle in doc_depends_on graph`);
    this.name = 'CycleDetectedError';
  }
}

export class AlreadyInitializedError extends Error {
  constructor() {
    super('Project is already initialized (knowledge_version >= 1)');
    this.name = 'AlreadyInitializedError';
  }
}

export class Repository {
  constructor(private db: AegisDatabase) {}

  runInTransaction(fn: () => void): void {
    this.db.transaction(fn)();
  }

  // ============================================================
  // Knowledge Meta
  // ============================================================

  getKnowledgeMeta(): KnowledgeMeta {
    return this.db.prepare('SELECT * FROM knowledge_meta WHERE id = 1').get() as KnowledgeMeta;
  }

  private incrementVersion(): number {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE knowledge_meta SET current_version = current_version + 1, last_updated_at = ? WHERE id = 1')
      .run(now);
    return this.getKnowledgeMeta().current_version;
  }

  // ============================================================
  // Documents (INV-1: only status='approved' in Read path)
  // ============================================================

  getApprovedDocuments(): Document[] {
    return this.db.prepare('SELECT * FROM documents WHERE status = ?').all('approved') as Document[];
  }

  getApprovedDocumentsByIds(docIds: string[]): Document[] {
    if (docIds.length === 0) return [];
    const placeholders = docIds.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT * FROM documents WHERE doc_id IN (${placeholders}) AND status = 'approved'`)
      .all(...docIds) as Document[];
  }

  insertDocument(doc: Omit<Document, 'created_at' | 'updated_at'>): void {
    const ownership = normalizeDocOwnership(doc.ownership ?? 'standalone');
    const sourcePath = doc.source_path ?? null;
    assertOwnershipSourcePathInvariant(ownership, sourcePath);
    this.db
      .prepare(`
      INSERT INTO documents (doc_id, title, kind, content, content_hash, status, ownership, template_origin, source_path, source_synced_at, replaced_by_doc_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        doc.doc_id,
        doc.title,
        doc.kind,
        doc.content,
        doc.content_hash,
        doc.status,
        ownership,
        doc.template_origin ?? null,
        sourcePath,
        doc.source_synced_at ?? null,
        doc.replaced_by_doc_id ?? null,
      );
  }

  /** ADR-014: mark file-anchored docs as verified in sync with on-disk source (hash match). */
  touchDocumentsSourceSyncedAt(docIds: string[]): void {
    if (docIds.length === 0) return;
    const placeholders = docIds.map(() => '?').join(', ');
    this.db
      .prepare(
        `UPDATE documents SET source_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE doc_id IN (${placeholders})`,
      )
      .run(...docIds);
  }

  getDocumentById(docId: string): Document | undefined {
    return this.db.prepare('SELECT * FROM documents WHERE doc_id = ?').get(docId) as Document | undefined;
  }

  getFileAnchoredDocuments(): Document[] {
    return this.db
      .prepare("SELECT * FROM documents WHERE ownership = 'file-anchored' AND status = 'approved'")
      .all() as Document[];
  }

  /** ADR-015 Task 015-07: Level-3 linked-artifact fingerprint baseline (JSON object string). */
  getStalenessBaseline(docId: string): string | null {
    const row = this.db.prepare('SELECT fingerprint_json FROM staleness_baselines WHERE doc_id = ?').get(docId) as
      | { fingerprint_json: string }
      | undefined;
    return row?.fingerprint_json ?? null;
  }

  upsertStalenessBaseline(docId: string, fingerprintJson: string): void {
    this.db
      .prepare(
        `
      INSERT INTO staleness_baselines (doc_id, fingerprint_json, updated_at)
      VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(doc_id) DO UPDATE SET
        fingerprint_json = excluded.fingerprint_json,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `,
      )
      .run(docId, fingerprintJson);
  }

  setDocumentTemplateOrigin(docId: string, origin: string): void {
    this.db.prepare('UPDATE documents SET template_origin = ? WHERE doc_id = ?').run(origin, docId);
  }

  getDocumentsByTemplateOrigin(templateId: string): Document[] {
    return this.db
      .prepare("SELECT * FROM documents WHERE template_origin LIKE ? AND status = 'approved'")
      .all(`${templateId}:%`) as Document[];
  }

  updateDocumentStatus(docId: string, status: EntityStatus): void {
    this.db
      .prepare("UPDATE documents SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE doc_id = ?")
      .run(status, docId);
  }

  // ============================================================
  // Edges
  // ============================================================

  getApprovedEdges(): Edge[] {
    return this.db.prepare('SELECT * FROM edges WHERE status = ?').all('approved') as Edge[];
  }

  getApprovedEdgesByType(edgeType: EdgeType): Edge[] {
    return this.db
      .prepare('SELECT * FROM edges WHERE edge_type = ? AND status = ?')
      .all(edgeType, 'approved') as Edge[];
  }

  getApprovedEdgesBySourceType(sourceType: EdgeSourceType): Edge[] {
    return this.db
      .prepare('SELECT * FROM edges WHERE source_type = ? AND status = ?')
      .all(sourceType, 'approved') as Edge[];
  }

  insertEdge(edge: Omit<Edge, 'created_at'>): void {
    this.db
      .prepare(`
      INSERT INTO edges (edge_id, source_type, source_value, target_doc_id, edge_type, priority, specificity, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        edge.edge_id,
        edge.source_type,
        edge.source_value,
        edge.target_doc_id,
        edge.edge_type,
        edge.priority,
        edge.specificity,
        edge.status,
      );
  }

  getEdgeById(edgeId: string): Edge | undefined {
    return this.db.prepare('SELECT * FROM edges WHERE edge_id = ?').get(edgeId) as Edge | undefined;
  }

  // ============================================================
  // Layer Rules
  // ============================================================

  getApprovedLayerRules(): LayerRule[] {
    return this.db.prepare('SELECT * FROM layer_rules WHERE status = ?').all('approved') as LayerRule[];
  }

  insertLayerRule(rule: Omit<LayerRule, 'created_at'>): void {
    this.db
      .prepare(`
      INSERT INTO layer_rules (rule_id, path_pattern, layer_name, priority, specificity, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
      .run(rule.rule_id, rule.path_pattern, rule.layer_name, rule.priority, rule.specificity, rule.status);
  }

  // ============================================================
  // DAG Constraint (INV-2: cycle detection)
  // ============================================================

  /**
   * Check if adding an edge source_doc_id -> target_doc_id would create a cycle.
   * Uses recursive CTE per §6.4.
   */
  wouldCreateCycle(sourceDocId: string, targetDocId: string): boolean {
    const result = this.db
      .prepare(`
      WITH RECURSIVE reachable(doc_id) AS (
        SELECT ?
        UNION
        SELECT e.target_doc_id
        FROM reachable r
        JOIN edges e ON e.source_type = 'doc'
                    AND e.source_value = r.doc_id
                    AND e.edge_type = 'doc_depends_on'
                    AND e.status = 'approved'
      )
      SELECT EXISTS (
        SELECT 1 FROM reachable WHERE doc_id = ?
      ) as has_cycle
    `)
      .get(targetDocId, sourceDocId) as { has_cycle: number };
    return result.has_cycle === 1;
  }

  /**
   * Like `wouldCreateCycle` but ignores one `doc_depends_on` edge (for retarget_edge).
   */
  private wouldCreateCycleForDocEdgeExcluding(
    excludeEdgeId: string,
    sourceDocId: string,
    targetDocId: string,
  ): boolean {
    const result = this.db
      .prepare(`
      WITH RECURSIVE reachable(doc_id) AS (
        SELECT ?
        UNION
        SELECT e.target_doc_id
        FROM reachable r
        JOIN edges e ON e.source_type = 'doc'
                    AND e.source_value = r.doc_id
                    AND e.edge_type = 'doc_depends_on'
                    AND e.status = 'approved'
                    AND e.edge_id != ?
      )
      SELECT EXISTS (
        SELECT 1 FROM reachable WHERE doc_id = ?
      ) as has_cycle
    `)
      .get(targetDocId, excludeEdgeId, sourceDocId) as { has_cycle: number };
    return result.has_cycle === 1;
  }

  /**
   * Get transitive closure of doc_depends_on from a set of starting doc_ids.
   * Max depth 10 per §3.2 Step 4.
   */
  getTransitiveDependencies(startDocIds: string[]): { doc_id: string; depth: number }[] {
    if (startDocIds.length === 0) return [];

    // Wrapped in a transaction to hold the file lock for the entire TEMP TABLE
    // lifecycle, preventing mid-operation reloads that would destroy the temp table.
    let results: { doc_id: string; depth: number }[] = [];
    this.db.transaction(() => {
      const tempTableName = `_temp_start_${Date.now()}`;
      this.db.exec(`CREATE TEMP TABLE ${tempTableName} (doc_id TEXT PRIMARY KEY)`);
      const insertTemp = this.db.prepare(`INSERT OR IGNORE INTO temp.${tempTableName} (doc_id) VALUES (?)`);
      for (const id of startDocIds) {
        insertTemp.run(id);
      }

      results = this.db
        .prepare(`
        WITH RECURSIVE dep_chain(doc_id, depth) AS (
          SELECT doc_id, 0 FROM temp.${tempTableName}
          UNION
          SELECT e.target_doc_id, dc.depth + 1
          FROM dep_chain dc
          JOIN edges e ON e.source_type = 'doc'
                      AND e.source_value = dc.doc_id
                      AND e.edge_type = 'doc_depends_on'
                      AND e.status = 'approved'
          WHERE dc.depth < 10
        )
        SELECT doc_id, MIN(depth) as depth
        FROM dep_chain
        GROUP BY doc_id
        ORDER BY depth ASC
      `)
        .all() as { doc_id: string; depth: number }[];

      this.db.exec(`DROP TABLE temp.${tempTableName}`);
    })();
    return results;
  }

  // ============================================================
  // Observations
  // ============================================================

  insertObservation(obs: Omit<Observation, 'created_at' | 'archived_at' | 'analyzed_at'>): string {
    this.db
      .prepare(`
      INSERT INTO observations (observation_id, event_type, payload, related_compile_id, related_snapshot_id)
      VALUES (?, ?, ?, ?, ?)
    `)
      .run(obs.observation_id, obs.event_type, obs.payload, obs.related_compile_id, obs.related_snapshot_id);
    return obs.observation_id;
  }

  /** Dedupe diagnostics: same payload already present (unarchived), including analyzed rows. */
  hasUnarchivedObservationWithExactPayload(eventType: string, payload: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM observations WHERE event_type = ? AND payload = ? AND archived_at IS NULL LIMIT 1`)
      .get(eventType, payload);
    return row !== undefined;
  }

  getObservation(observationId: string): Observation | undefined {
    return this.db.prepare('SELECT * FROM observations WHERE observation_id = ?').get(observationId) as
      | Observation
      | undefined;
  }

  getUnanalyzedObservations(eventType: string, limit = 50): Observation[] {
    return this.db
      .prepare(`
      SELECT o.* FROM observations o
      WHERE o.event_type = ?
        AND o.archived_at IS NULL
        AND o.analyzed_at IS NULL
      ORDER BY o.created_at ASC
      LIMIT ?
    `)
      .all(eventType, limit) as Observation[];
  }

  /**
   * All non-archived observations for a given event type (e.g. compile_miss impact simulation).
   */
  listObservationsByEventType(eventType: string): Observation[] {
    return this.db
      .prepare(`SELECT * FROM observations WHERE event_type = ? AND archived_at IS NULL ORDER BY created_at ASC`)
      .all(eventType) as Observation[];
  }

  /**
   * Atomically claim up to `limit` pending observations for processing.
   * SELECT candidates and conditional UPDATE run inside a single DB transaction
   * so concurrent processes (separate file-backed connections) cannot claim the same rows.
   * Returns rows as claimed (with `analyzed_at` set).
   */
  claimUnanalyzedObservations(eventType: string, limit = 50): Observation[] {
    return this.db.transaction(() => {
      const candidates = this.db
        .prepare(`
        SELECT o.* FROM observations o
        WHERE o.event_type = ?
          AND o.archived_at IS NULL
          AND o.analyzed_at IS NULL
        ORDER BY o.created_at ASC
        LIMIT ?
      `)
        .all(eventType, limit) as Observation[];

      if (candidates.length === 0) return [];

      const now = new Date().toISOString();
      const stmt = this.db.prepare(
        'UPDATE observations SET analyzed_at = ? WHERE observation_id = ? AND analyzed_at IS NULL',
      );

      const claimed: Observation[] = [];
      for (const o of candidates) {
        const { changes } = stmt.run(now, o.observation_id);
        if (changes > 0) {
          claimed.push({ ...o, analyzed_at: now });
        }
      }
      return claimed;
    })();
  }

  /** Full pending count (no LIMIT); use for maintenance previews and backlog metrics. */
  countUnanalyzedObservations(eventType: string): number {
    const row = this.db
      .prepare(
        `
      SELECT COUNT(*) as cnt FROM observations o
      WHERE o.event_type = ?
        AND o.archived_at IS NULL
        AND o.analyzed_at IS NULL
    `,
      )
      .get(eventType) as { cnt: number };
    return row.cnt;
  }

  markObservationsAnalyzed(observationIds: string[]): void {
    if (observationIds.length === 0) return;
    const now = new Date().toISOString();
    const stmt = this.db.prepare('UPDATE observations SET analyzed_at = ? WHERE observation_id = ?');
    for (const id of observationIds) {
      stmt.run(now, id);
    }
  }

  resetObservationsAnalyzed(observationIds: string[]): void {
    if (observationIds.length === 0) return;
    const stmt = this.db.prepare('UPDATE observations SET analyzed_at = NULL WHERE observation_id = ?');
    for (const id of observationIds) {
      stmt.run(id);
    }
  }

  countActionableObservations(): { pending: number; skipped: number } {
    const row = this.db
      .prepare(
        `
      SELECT
        SUM(CASE WHEN sub.outcome = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN sub.outcome = 'skipped' THEN 1 ELSE 0 END) AS skipped
      FROM (
        SELECT
          CASE
            WHEN o.analyzed_at IS NULL THEN 'pending'
            WHEN COUNT(pe.proposal_id) > 0 THEN 'proposed'
            ELSE 'skipped'
          END AS outcome
        FROM observations o
        LEFT JOIN proposal_evidence pe ON pe.observation_id = o.observation_id
        WHERE o.archived_at IS NULL
        GROUP BY o.observation_id
      ) sub
    `,
      )
      .get() as { pending: number | null; skipped: number | null };
    return { pending: row.pending ?? 0, skipped: row.skipped ?? 0 };
  }

  listObservations(
    filters: {
      event_type?: string;
      outcome?: 'proposed' | 'skipped' | 'pending';
    },
    limit = 20,
    offset = 0,
  ): { observations: Array<Observation & { outcome: 'proposed' | 'skipped' | 'pending' }>; total: number } {
    const baseFrom = `
      FROM observations o
      LEFT JOIN proposal_evidence pe ON pe.observation_id = o.observation_id`;

    const conditions: string[] = ['o.archived_at IS NULL'];
    const params: unknown[] = [];

    if (filters.event_type) {
      conditions.push('o.event_type = ?');
      params.push(filters.event_type);
    }

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

    const groupedSelect = `
      SELECT o.*,
        CASE
          WHEN o.analyzed_at IS NULL THEN 'pending'
          WHEN COUNT(pe.proposal_id) > 0 THEN 'proposed'
          ELSE 'skipped'
        END AS outcome
      ${baseFrom}${whereClause}
      GROUP BY o.observation_id`;

    if (filters.outcome) {
      const countSql = `SELECT COUNT(*) as total FROM (${groupedSelect}) sub WHERE sub.outcome = ?`;
      const selectSql = `${groupedSelect} HAVING outcome = ? ORDER BY o.created_at DESC LIMIT ? OFFSET ?`;
      const { total } = this.db.prepare(countSql).get(...params, filters.outcome) as { total: number };
      const observations = this.db.prepare(selectSql).all(...params, filters.outcome, limit, offset) as Array<
        Observation & { outcome: 'proposed' | 'skipped' | 'pending' }
      >;
      return { observations, total };
    }

    const countSql = `SELECT COUNT(DISTINCT o.observation_id) as total ${baseFrom}${whereClause}`;
    const selectSql = `${groupedSelect} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`;
    const { total } = this.db.prepare(countSql).get(...params) as { total: number };
    const observations = this.db.prepare(selectSql).all(...params, limit, offset) as Array<
      Observation & { outcome: 'proposed' | 'skipped' | 'pending' }
    >;
    return { observations, total };
  }

  // ============================================================
  // Proposals
  // ============================================================

  insertProposal(proposal: Omit<Proposal, 'created_at' | 'resolved_at'>): string {
    this.db
      .prepare(`
      INSERT INTO proposals (proposal_id, proposal_type, payload, status, review_comment, bundle_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
      .run(
        proposal.proposal_id,
        proposal.proposal_type,
        proposal.payload,
        proposal.status,
        proposal.review_comment,
        proposal.bundle_id ?? null,
      );
    return proposal.proposal_id;
  }

  insertProposalEvidence(proposalId: string, observationId: string): void {
    this.db
      .prepare(`
      INSERT INTO proposal_evidence (proposal_id, observation_id) VALUES (?, ?)
    `)
      .run(proposalId, observationId);
  }

  getProposal(proposalId: string): Proposal | undefined {
    return this.db.prepare('SELECT * FROM proposals WHERE proposal_id = ?').get(proposalId) as Proposal | undefined;
  }

  listProposals(status?: ProposalStatus, limit = 20, offset = 0): { proposals: Proposal[]; total: number } {
    let countSql = 'SELECT COUNT(*) as total FROM proposals';
    let selectSql = 'SELECT * FROM proposals';
    const params: unknown[] = [];

    if (status) {
      countSql += ' WHERE status = ?';
      selectSql += ' WHERE status = ?';
      params.push(status);
    }

    selectSql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';

    const { total } = this.db.prepare(countSql).get(...params) as { total: number };
    const proposals = this.db.prepare(selectSql).all(...params, limit, offset) as Proposal[];
    return { proposals, total };
  }

  getProposalEvidence(proposalId: string): Observation[] {
    return this.db
      .prepare(`
      SELECT o.* FROM observations o
      JOIN proposal_evidence pe ON pe.observation_id = o.observation_id
      WHERE pe.proposal_id = ?
    `)
      .all(proposalId) as Observation[];
  }

  /**
   * Get all pending proposals of a given type.
   * Used by ProposeService to check for global semantic duplicates.
   */
  getPendingProposalsByType(proposalType: string): Proposal[] {
    return this.db
      .prepare(`
      SELECT * FROM proposals
      WHERE proposal_type = ?
        AND status = 'pending'
    `)
      .all(proposalType) as Proposal[];
  }

  /** Pending proposals that share the same ADR-015 bundle id (all-or-nothing approval). */
  listPendingProposalsByBundle(bundleId: string): Proposal[] {
    return this.db
      .prepare(
        `
      SELECT * FROM proposals
      WHERE bundle_id = ?
        AND status = 'pending'
      ORDER BY created_at ASC
    `,
      )
      .all(bundleId) as Proposal[];
  }

  countPendingProposals(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM proposals WHERE status = 'pending'").get() as {
      cnt: number;
    };
    return row.cnt;
  }

  // ============================================================
  // Snapshot (INV-3: INSERT ONLY, INV-4: monotonic version)
  // ============================================================

  /**
   * Create a snapshot of current approved state.
   * Content-addressable hash includes ALL fields that affect compile_context results,
   * plus the knowledge_version to ensure each approve produces a distinct snapshot.
   * Every approve MUST produce a new snapshot row (no skipping on hash collision).
   */
  createSnapshot(): Snapshot {
    const docs = this.getApprovedDocuments();
    const edges = this.getApprovedEdges();
    const rules = this.getApprovedLayerRules();
    const version = this.getKnowledgeMeta().current_version;

    // Hash includes ALL fields that affect compile_context output,
    // plus knowledge_version to guarantee uniqueness per approve
    const content = JSON.stringify({
      knowledge_version: version,
      docs: docs
        .map((d) => ({ doc_id: d.doc_id, title: d.title, kind: d.kind, content_hash: d.content_hash }))
        .sort((a, b) => a.doc_id.localeCompare(b.doc_id)),
      edges: edges
        .map((e) => ({
          edge_id: e.edge_id,
          source_type: e.source_type,
          source_value: e.source_value,
          target_doc_id: e.target_doc_id,
          edge_type: e.edge_type,
          priority: e.priority,
          specificity: e.specificity,
        }))
        .sort((a, b) => a.edge_id.localeCompare(b.edge_id)),
      rules: rules
        .map((r) => ({
          rule_id: r.rule_id,
          path_pattern: r.path_pattern,
          layer_name: r.layer_name,
          priority: r.priority,
          specificity: r.specificity,
        }))
        .sort((a, b) => a.rule_id.localeCompare(b.rule_id)),
    });
    const snapshotId = createHash('sha256').update(content).digest('hex');

    // Insert snapshot (knowledge_version in hash guarantees no collision across approves)
    this.db.prepare('INSERT INTO snapshots (snapshot_id, knowledge_version) VALUES (?, ?)').run(snapshotId, version);

    // Copy docs
    const insertDoc = this.db.prepare('INSERT INTO snapshot_docs (snapshot_id, doc_id, content_hash) VALUES (?, ?, ?)');
    for (const doc of docs) {
      insertDoc.run(snapshotId, doc.doc_id, doc.content_hash);
    }

    // Copy edges
    const insertEdge = this.db.prepare(
      'INSERT INTO snapshot_edges (snapshot_id, edge_id, source_type, source_value, target_doc_id, edge_type, priority, specificity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const edge of edges) {
      insertEdge.run(
        snapshotId,
        edge.edge_id,
        edge.source_type,
        edge.source_value,
        edge.target_doc_id,
        edge.edge_type,
        edge.priority,
        edge.specificity,
      );
    }

    // Copy layer rules
    const insertRule = this.db.prepare(
      'INSERT INTO snapshot_layer_rules (snapshot_id, rule_id, path_pattern, layer_name, priority, specificity) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const rule of rules) {
      insertRule.run(snapshotId, rule.rule_id, rule.path_pattern, rule.layer_name, rule.priority, rule.specificity);
    }

    return { snapshot_id: snapshotId, knowledge_version: version, created_at: new Date().toISOString() };
  }

  getCurrentSnapshot(): Snapshot | undefined {
    const meta = this.getKnowledgeMeta();
    if (meta.current_version === 0) return undefined;
    // Every knowledge_version has exactly one snapshot (guaranteed by approve transaction)
    return this.db.prepare('SELECT * FROM snapshots WHERE knowledge_version = ?').get(meta.current_version) as
      | Snapshot
      | undefined;
  }

  getSnapshotById(snapshotId: string): Snapshot | undefined {
    return this.db.prepare('SELECT * FROM snapshots WHERE snapshot_id = ?').get(snapshotId) as Snapshot | undefined;
  }

  // ============================================================
  // Compile Log (INV-5: audit completeness)
  // ============================================================

  insertCompileLog(log: Omit<CompileLog, 'created_at'>): void {
    this.db
      .prepare(`
      INSERT INTO compile_log (compile_id, snapshot_id, request, base_doc_ids, expanded_doc_ids, audit_meta)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
      .run(log.compile_id, log.snapshot_id, log.request, log.base_doc_ids, log.expanded_doc_ids, log.audit_meta);
  }

  getCompileLog(compileId: string): CompileLog | undefined {
    return this.db.prepare('SELECT * FROM compile_log WHERE compile_id = ?').get(compileId) as CompileLog | undefined;
  }

  countApprovedDocuments(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM documents WHERE status = 'approved'").get() as {
      cnt: number;
    };
    return row.cnt;
  }

  countApprovedEdges(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM edges WHERE status = 'approved'").get() as { cnt: number };
    return row.cnt;
  }

  /**
   * All compile_log rows for usage aggregates (request / base + expanded doc ids / audit_meta).
   * Admin observability only. Full-table read: cost grows with compile_log row count (future: SQL aggregates or sampling).
   */
  listCompileLogStatsRows(): Array<{
    compile_id: string;
    request: string;
    base_doc_ids: string;
    expanded_doc_ids: string | null;
    audit_meta: string | null;
  }> {
    return this.db
      .prepare('SELECT compile_id, request, base_doc_ids, expanded_doc_ids, audit_meta FROM compile_log')
      .all() as Array<{
      compile_id: string;
      request: string;
      base_doc_ids: string;
      expanded_doc_ids: string | null;
      audit_meta: string | null;
    }>;
  }

  /**
   * Tag mappings that do not resolve to an approved document (missing doc or non-approved status).
   */
  countOrphanedTagMappings(): number {
    const row = this.db
      .prepare(
        `
      SELECT COUNT(*) AS cnt FROM tag_mappings tm
      WHERE NOT EXISTS (
        SELECT 1 FROM documents d WHERE d.doc_id = tm.doc_id AND d.status = 'approved'
      )
    `,
      )
      .get() as { cnt: number };
    return row.cnt;
  }

  listOrphanedTagMappingSamples(limit: number): Array<{ tag: string; doc_id: string }> {
    return this.db
      .prepare(
        `
      SELECT tm.tag, tm.doc_id FROM tag_mappings tm
      WHERE NOT EXISTS (
        SELECT 1 FROM documents d WHERE d.doc_id = tm.doc_id AND d.status = 'approved'
      )
      ORDER BY tm.tag ASC, tm.doc_id ASC
      LIMIT ?
    `,
      )
      .all(limit) as Array<{ tag: string; doc_id: string }>;
  }

  /** Returns ALL documents with source_path (any status). Used for source_path migration. */
  getAllDocumentsWithSourcePath(): Document[] {
    return this.db.prepare('SELECT * FROM documents WHERE source_path IS NOT NULL').all() as Document[];
  }

  /** Update source_path for a single document. Used for source_path migration. */
  updateDocumentSourcePath(docId: string, sourcePath: string | null): void {
    this.db.prepare('UPDATE documents SET source_path = ? WHERE doc_id = ?').run(sourcePath, docId);
  }

  // ============================================================
  // Init Manifest
  // ============================================================

  isInitialized(): boolean {
    return this.getKnowledgeMeta().current_version >= 1;
  }

  getInitManifest(): InitManifest | undefined {
    return this.db.prepare('SELECT * FROM init_manifest WHERE id = 1').get() as InitManifest | undefined;
  }

  insertInitManifest(manifest: Omit<InitManifest, 'id' | 'created_at'>): void {
    this.db
      .prepare(`
      INSERT INTO init_manifest (id, template_id, template_version, preview_hash,
        stack_detection, selected_profile, placeholders, initial_snapshot_id, seed_counts)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        manifest.template_id,
        manifest.template_version,
        manifest.preview_hash,
        manifest.stack_detection,
        manifest.selected_profile,
        manifest.placeholders,
        manifest.initial_snapshot_id,
        manifest.seed_counts,
      );
  }

  // ============================================================
  // Approve Transaction (§6.3)
  // Single transaction: validate → mutate → version++ → snapshot
  // ============================================================

  /**
   * Apply Canonical mutations for an approved proposal payload (no status / version / snapshot).
   * Used by {@link approveProposal} and bundle approve/preflight.
   */
  private _applyCanonicalMutationFromPayload(
    proposalId: string,
    proposalType: ProposalType,
    payload: Record<string, unknown>,
    projectRoot?: string,
  ): void {
    if (proposalType === 'bootstrap') {
      if (this.isInitialized()) {
        throw new AlreadyInitializedError();
      }
      this._applyBootstrap(payload as Parameters<Repository['_applyBootstrap']>[0]);
      return;
    }
    if (proposalType === 'add_edge') {
      this._applyAddEdge(payload as Omit<Edge, 'created_at' | 'status'>);
      return;
    }
    if (proposalType === 'retarget_edge') {
      this._applyRetargetEdge(payload);
      return;
    }
    if (proposalType === 'remove_edge') {
      this._applyRemoveEdge(payload);
      return;
    }
    if (proposalType === 'new_doc') {
      this._applyNewDoc(payload as Omit<Document, 'created_at' | 'updated_at' | 'status'>, projectRoot);
      if (Array.isArray(payload.tags) && payload.tags.length > 0 && payload.doc_id) {
        for (const tag of payload.tags as string[]) {
          this.upsertTagMapping({ tag, doc_id: payload.doc_id as string, confidence: 1.0, source: 'manual' });
        }
      }
      return;
    }
    if (proposalType === 'update_doc') {
      if (payload.content === PENDING_CONTENT_PLACEHOLDER) {
        throw new Error(
          `Cannot approve update_doc proposal '${proposalId}': content is a placeholder. ` +
            'Provide actual content via modifications when approving.',
        );
      }
      this._applyUpdateDoc(payload as Parameters<Repository['_applyUpdateDoc']>[0]);
      if (Array.isArray(payload.tags) && payload.tags.length > 0 && payload.doc_id) {
        for (const tag of payload.tags as string[]) {
          this.upsertTagMapping({ tag, doc_id: payload.doc_id as string, confidence: 1.0, source: 'manual' });
        }
      }
      return;
    }
    if (proposalType === 'deprecate') {
      this._applyDeprecate(payload as Parameters<Repository['_applyDeprecate']>[0]);
      return;
    }
    throw new Error(`Unsupported proposal_type for approval: ${proposalType}`);
  }

  approveProposal(proposalId: string, modifications?: Record<string, unknown>, projectRoot?: string): CanonicalVersion {
    return this.db.transaction(() => {
      const proposal = this.getProposal(proposalId);
      if (!proposal) throw new Error(`Proposal ${proposalId} not found`);
      if (proposal.status !== 'pending')
        throw new Error(`Proposal ${proposalId} is not pending (status: ${proposal.status})`);
      if (proposal.bundle_id != null && String(proposal.bundle_id).trim() !== '') {
        throw new Error(
          `Proposal ${proposalId} belongs to bundle '${proposal.bundle_id}'. ` +
            'Use approveProposalBundle(bundle_id) for all-or-nothing approval.',
        );
      }

      const payload = JSON.parse(proposal.payload) as Record<string, unknown>;

      // Apply admin modifications to payload before mutation
      if (modifications && Object.keys(modifications).length > 0) {
        this._applyModifications(payload, proposal.proposal_type as ProposalType, modifications);
        // Persist modified payload so get_proposal returns the actually-approved content
        this.db
          .prepare('UPDATE proposals SET payload = ? WHERE proposal_id = ?')
          .run(JSON.stringify(payload), proposalId);
      }

      if (projectRoot) {
        this._normalizeStoredSourcePathsForApprove(payload, proposal.proposal_type as ProposalType, projectRoot);
        this.db
          .prepare('UPDATE proposals SET payload = ? WHERE proposal_id = ?')
          .run(JSON.stringify(payload), proposalId);
      }

      this._applyCanonicalMutationFromPayload(proposalId, proposal.proposal_type as ProposalType, payload, projectRoot);

      // Update proposal status
      const now = new Date().toISOString();
      this.db
        .prepare('UPDATE proposals SET status = ?, resolved_at = ? WHERE proposal_id = ?')
        .run('approved', now, proposalId);

      // INV-4: increment version
      const newVersion = this.incrementVersion();

      // Create snapshot
      const snapshot = this.createSnapshot();

      return { knowledge_version: newVersion, snapshot_id: snapshot.snapshot_id };
    })();
  }

  /**
   * Applies one proposal's mutation against current Canonical state for preflight (never throws).
   */
  private _preflightLeafApply(p: Proposal, projectRoot?: string): ProposalBundlePreflightLeaf {
    try {
      const payload = JSON.parse(p.payload) as Record<string, unknown>;
      if (projectRoot) {
        this._normalizeStoredSourcePathsForApprove(payload, p.proposal_type as ProposalType, projectRoot);
      }
      this._applyCanonicalMutationFromPayload(p.proposal_id, p.proposal_type as ProposalType, payload, projectRoot);
      return { proposal_id: p.proposal_id, proposal_type: p.proposal_type, ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        proposal_id: p.proposal_id,
        proposal_type: p.proposal_type,
        ok: false,
        error: msg,
      };
    }
  }

  /**
   * Dry-run: validate every pending proposal in the bundle against current Canonical state,
   * applying mutations under a SAVEPOINT then rolling back (no knowledge_version / snapshot).
   * When topological ordering fails, each JSON-valid leaf is still simulated in isolation
   * (SAVEPOINT per leaf) so independent failures surface per proposal while `ordering_error` explains the bundle.
   */
  preflightProposalBundle(bundleId: string, projectRoot?: string): ProposalBundlePreflightResult {
    return this.db.transaction(() => {
      const pending = this.listPendingProposalsByBundle(bundleId);
      if (pending.length === 0) {
        throw new Error(`No pending proposals for bundle_id '${bundleId}'`);
      }

      type ParseOk = { ok: true };
      type ParseFail = { ok: false; error: string };
      const parseById = new Map<string, ParseOk | ParseFail>();
      for (const p of pending) {
        try {
          JSON.parse(p.payload);
          parseById.set(p.proposal_id, { ok: true });
        } catch {
          parseById.set(p.proposal_id, {
            ok: false,
            error: `Invalid JSON in proposal payload for ${p.proposal_id}`,
          });
        }
      }

      const validForOrdering = pending.filter((p) => parseById.get(p.proposal_id)!.ok);

      if (validForOrdering.length === 0) {
        const leaves: ProposalBundlePreflightLeaf[] = pending.map((p) => {
          const pr = parseById.get(p.proposal_id)! as ParseFail;
          return {
            proposal_id: p.proposal_id,
            proposal_type: p.proposal_type,
            ok: false,
            error: pr.error,
          };
        });
        return {
          bundle_id: bundleId,
          ordered_proposal_ids: [],
          leaves,
          ok: false,
          ordering_error: 'All proposals in the bundle have invalid JSON payloads',
        };
      }

      let ordered: Proposal[] | undefined;
      let orderingError: string | undefined;
      try {
        ordered = orderPendingBundleProposals(this, validForOrdering);
      } catch (e) {
        orderingError = e instanceof Error ? e.message : String(e);
      }

      if (orderingError !== undefined || ordered === undefined) {
        const isoSp = 'aegis_bundle_pf_iso';
        this.db.exec(`SAVEPOINT ${isoSp}`);
        const isoById = new Map<string, ProposalBundlePreflightLeaf>();
        try {
          for (const p of validForOrdering) {
            isoById.set(p.proposal_id, this._preflightLeafApply(p, projectRoot));
            this.db.exec(`ROLLBACK TO SAVEPOINT ${isoSp}`);
          }
        } finally {
          this.db.exec(`RELEASE SAVEPOINT ${isoSp}`);
        }

        const leaves: ProposalBundlePreflightLeaf[] = pending.map((p) => {
          const pr = parseById.get(p.proposal_id)!;
          if (!pr.ok) {
            return {
              proposal_id: p.proposal_id,
              proposal_type: p.proposal_type,
              ok: false,
              error: pr.error,
            };
          }
          const row = isoById.get(p.proposal_id);
          if (!row) {
            return {
              proposal_id: p.proposal_id,
              proposal_type: p.proposal_type,
              ok: false,
              error: 'internal: missing isolated preflight row',
            };
          }
          return row;
        });
        return {
          bundle_id: bundleId,
          ordered_proposal_ids: [],
          leaves,
          ok: false,
          ordering_error: orderingError ?? 'ordering failed',
        };
      }

      const orderedProposals = ordered;

      const sp = 'aegis_bundle_preflight';
      this.db.exec(`SAVEPOINT ${sp}`);
      try {
        const simById = new Map<string, ProposalBundlePreflightLeaf>();

        for (const p of orderedProposals) {
          simById.set(p.proposal_id, this._preflightLeafApply(p, projectRoot));
          // Note: mutations accumulate in the SAVEPOINT until ROLLBACK TO below;
          // each call applies on top of prior proposals' effects (ordered bundle simulation).
        }

        this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);

        const leaves: ProposalBundlePreflightLeaf[] = pending.map((p) => {
          const pr = parseById.get(p.proposal_id)!;
          if (!pr.ok) {
            return {
              proposal_id: p.proposal_id,
              proposal_type: p.proposal_type,
              ok: false,
              error: pr.error,
            };
          }
          const row = simById.get(p.proposal_id);
          if (!row) {
            return {
              proposal_id: p.proposal_id,
              proposal_type: p.proposal_type,
              ok: false,
              error: 'internal: missing preflight simulation row',
            };
          }
          return row;
        });

        const ok = leaves.every((l) => l.ok);
        return {
          bundle_id: bundleId,
          ordered_proposal_ids: orderedProposals.map((p) => p.proposal_id),
          leaves,
          ok,
        };
      } catch (e) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
        throw e;
      }
    })();
  }

  /**
   * ADR-015: Approve every pending proposal in the bundle in one transaction — one knowledge_version bump and one snapshot.
   */
  approveProposalBundle(bundleId: string, projectRoot?: string): CanonicalVersion {
    return this.db.transaction(() => {
      const pending = this.listPendingProposalsByBundle(bundleId);
      if (pending.length === 0) {
        throw new Error(`No pending proposals for bundle_id '${bundleId}'`);
      }

      const ordered = orderPendingBundleProposals(this, pending);

      for (const p of ordered) {
        const fresh = this.getProposal(p.proposal_id);
        if (!fresh || fresh.status !== 'pending') {
          throw new Error(`Proposal ${p.proposal_id} is no longer pending (concurrent modification?)`);
        }
        if (fresh.bundle_id !== bundleId) {
          throw new Error(
            `Proposal ${p.proposal_id} bundle_id mismatch (expected '${bundleId}', got '${fresh.bundle_id}')`,
          );
        }

        const payload = JSON.parse(fresh.payload) as Record<string, unknown>;
        if (projectRoot) {
          this._normalizeStoredSourcePathsForApprove(payload, fresh.proposal_type as ProposalType, projectRoot);
          this.db
            .prepare('UPDATE proposals SET payload = ? WHERE proposal_id = ?')
            .run(JSON.stringify(payload), fresh.proposal_id);
        }

        this._applyCanonicalMutationFromPayload(
          fresh.proposal_id,
          fresh.proposal_type as ProposalType,
          payload,
          projectRoot,
        );

        const now = new Date().toISOString();
        this.db
          .prepare('UPDATE proposals SET status = ?, resolved_at = ? WHERE proposal_id = ?')
          .run('approved', now, fresh.proposal_id);
      }

      const newVersion = this.incrementVersion();
      const snapshot = this.createSnapshot();
      return { knowledge_version: newVersion, snapshot_id: snapshot.snapshot_id };
    })();
  }

  rejectProposal(proposalId: string, reason: string): void {
    const proposal = this.getProposal(proposalId);
    if (!proposal) throw new Error(`Proposal ${proposalId} not found`);
    if (proposal.status !== 'pending') throw new Error(`Proposal ${proposalId} is not pending`);

    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE proposals SET status = ?, review_comment = ?, resolved_at = ? WHERE proposal_id = ?')
      .run('rejected', reason, now, proposalId);

    // Reset analyzed_at on evidence observations so they can be re-analyzed
    const evidenceObs = this.getProposalEvidence(proposalId);
    this.resetObservationsAnalyzed(evidenceObs.map((o) => o.observation_id));
  }

  // ============================================================
  // Private: Apply proposal mutations
  // ============================================================

  /**
   * Apply admin modifications to proposal payload.
   * Only whitelisted fields per proposal_type are allowed.
   */
  private _applyModifications(
    payload: Record<string, unknown>,
    proposalType: ProposalType,
    modifications: Record<string, unknown>,
  ): void {
    const allowedFields: Record<string, string[]> = {
      new_doc: ['title', 'content', 'kind', 'source_path', 'ownership'],
      update_doc: ['title', 'content', 'source_path', 'ownership'],
      add_edge: ['priority', 'source_value', 'target_doc_id'],
      retarget_edge: ['source_value', 'target_doc_id'],
      remove_edge: [],
      deprecate: ['replaced_by_doc_id'],
      bootstrap: [],
    };
    const allowed = allowedFields[proposalType] ?? [];
    for (const key of Object.keys(modifications)) {
      if (!allowed.includes(key)) {
        throw new Error(`Modification field '${key}' is not allowed for proposal type '${proposalType}'`);
      }
    }
    for (const [key, value] of Object.entries(modifications)) {
      payload[key] = value;
    }
    // Re-derive content_hash whenever content is present to prevent hash/content mismatch
    if (typeof payload.content === 'string') {
      payload.content_hash = createHash('sha256').update(payload.content).digest('hex');
    }
  }

  /**
   * ADR-009: store repo-relative source_path and reject workspace escape (same as import_doc).
   * When `projectRoot` is omitted, paths are not rewritten (unit tests / legacy callers).
   */
  private _normalizeStoredSourcePathsForApprove(
    payload: Record<string, unknown>,
    proposalType: ProposalType,
    projectRoot: string,
  ): void {
    const norm = (sp: string) => normalizeSourcePath(sp, projectRoot);

    if (proposalType === 'new_doc' || proposalType === 'update_doc') {
      const sp = payload.source_path;
      if (typeof sp === 'string' && sp.length > 0) {
        payload.source_path = norm(sp);
      }
      return;
    }

    if (proposalType === 'bootstrap') {
      const docs = payload.documents;
      if (!Array.isArray(docs)) return;
      for (const raw of docs) {
        if (!raw || typeof raw !== 'object') continue;
        const d = raw as Record<string, unknown>;
        const sp = d.source_path;
        if (typeof sp === 'string' && sp.length > 0) {
          d.source_path = norm(sp);
        }
      }
    }
  }

  private _applyBootstrap(payload: {
    documents: Omit<Document, 'created_at' | 'updated_at'>[];
    edges: Omit<Edge, 'created_at'>[];
    layer_rules: Omit<LayerRule, 'created_at'>[];
  }): void {
    for (const doc of payload.documents) {
      this.insertDocument({ ...doc, status: 'approved' });
    }
    for (const edge of payload.edges) {
      // INV-2: cycle check for doc_depends_on
      if (edge.edge_type === 'doc_depends_on') {
        if (this.wouldCreateCycle(edge.source_value, edge.target_doc_id)) {
          throw new CycleDetectedError(edge.source_value, edge.target_doc_id);
        }
      }
      this.insertEdge({ ...edge, status: 'approved' });
    }
    for (const rule of payload.layer_rules) {
      this.insertLayerRule({ ...rule, status: 'approved' });
    }
  }

  private _applyAddEdge(payload: Omit<Edge, 'created_at' | 'status'>): void {
    const targetDoc = this.getDocumentById(payload.target_doc_id);
    if (!targetDoc) {
      throw new Error(
        `Cannot add edge: target document '${payload.target_doc_id}' does not exist. ` +
          'If there is a pending new_doc proposal for this document, approve it first.',
      );
    }
    if (targetDoc.status !== 'approved') {
      throw new Error(
        `Cannot add edge: target document '${payload.target_doc_id}' is not approved (status: ${targetDoc.status}). ` +
          'Approve or reactivate the document first.',
      );
    }
    if (payload.source_type === 'doc') {
      if (typeof payload.source_value !== 'string' || payload.source_value.length === 0) {
        throw new Error('Cannot add edge: doc source requires non-empty `source_value` (source document id).');
      }
      const sourceDoc = this.getDocumentById(payload.source_value);
      if (!sourceDoc) {
        throw new Error(
          `Cannot add edge: source document '${payload.source_value}' does not exist. ` +
            'If there is a pending new_doc proposal for this document, approve it first.',
        );
      }
      if (sourceDoc.status !== 'approved') {
        throw new Error(
          `Cannot add edge: source document '${payload.source_value}' is not approved (status: ${sourceDoc.status}). ` +
            'Approve or reactivate the document first.',
        );
      }
    }
    if (payload.edge_type === 'doc_depends_on') {
      if (this.wouldCreateCycle(payload.source_value, payload.target_doc_id)) {
        throw new CycleDetectedError(payload.source_value, payload.target_doc_id);
      }
    }
    const dup = this._findConflictingApprovedEdge(payload.edge_id, {
      source_type: payload.source_type,
      source_value: payload.source_value,
      target_doc_id: payload.target_doc_id,
      edge_type: payload.edge_type,
    });
    if (dup) {
      throw new Error(
        `Cannot add edge: an approved edge already exists for ` +
          `${payload.source_type}:${payload.source_value} → ${payload.target_doc_id} (${payload.edge_type}): '${dup.edge_id}'`,
      );
    }
    this.insertEdge({ ...payload, status: 'approved' });
  }

  /**
   * Another approved edge (excluding `excludeEdgeId`) with the same routing key is a duplicate.
   */
  private _findConflictingApprovedEdge(
    excludeEdgeId: string,
    key: {
      source_type: EdgeSourceType;
      source_value: string;
      target_doc_id: string;
      edge_type: EdgeType;
    },
  ): Edge | undefined {
    const rows = this.db
      .prepare(
        `SELECT * FROM edges WHERE status = 'approved'
           AND edge_id != ?
           AND source_type = ? AND source_value = ? AND target_doc_id = ? AND edge_type = ?`,
      )
      .all(excludeEdgeId, key.source_type, key.source_value, key.target_doc_id, key.edge_type) as Edge[];
    return rows[0];
  }

  private _applyRetargetEdge(payload: Record<string, unknown>): void {
    const edgeId = payload.edge_id;
    if (typeof edgeId !== 'string' || edgeId.length === 0) {
      throw new Error("retarget_edge: 'edge_id' is required");
    }
    const existing = this.getEdgeById(edgeId);
    if (!existing) {
      throw new Error(`retarget_edge: edge '${edgeId}' does not exist`);
    }
    if (existing.status !== 'approved') {
      throw new Error(`retarget_edge: edge '${edgeId}' is not approved (status: ${existing.status})`);
    }
    let newSource = existing.source_value;
    let newTarget = existing.target_doc_id;
    if (typeof payload.source_value === 'string') {
      newSource = payload.source_value;
    }
    if (typeof payload.target_doc_id === 'string') {
      newTarget = payload.target_doc_id;
    }
    if (newSource === existing.source_value && newTarget === existing.target_doc_id) {
      throw new Error(`retarget_edge: no change for edge '${edgeId}'`);
    }
    if (existing.source_type === 'doc') {
      if (typeof newSource !== 'string' || newSource.length === 0) {
        throw new Error(`retarget_edge: doc source requires non-empty source document id`);
      }
      const sourceDoc = this.getDocumentById(newSource);
      if (!sourceDoc) {
        throw new Error(`retarget_edge: source document '${newSource}' does not exist`);
      }
      if (sourceDoc.status !== 'approved') {
        throw new Error(`retarget_edge: source document '${newSource}' is not approved (status: ${sourceDoc.status})`);
      }
    }
    if (newTarget !== existing.target_doc_id) {
      const targetDoc = this.getDocumentById(newTarget);
      if (!targetDoc) {
        throw new Error(`retarget_edge: target document '${newTarget}' does not exist`);
      }
      if (targetDoc.status !== 'approved') {
        throw new Error(`retarget_edge: target document '${newTarget}' is not approved (status: ${targetDoc.status})`);
      }
    }
    if (existing.edge_type === 'doc_depends_on') {
      if (this.wouldCreateCycleForDocEdgeExcluding(edgeId, newSource, newTarget)) {
        throw new CycleDetectedError(newSource, newTarget);
      }
    }
    const dup = this._findConflictingApprovedEdge(edgeId, {
      source_type: existing.source_type,
      source_value: newSource,
      target_doc_id: newTarget,
      edge_type: existing.edge_type,
    });
    if (dup) {
      throw new Error(
        `retarget_edge: an approved edge already exists for ` +
          `${existing.source_type}:${newSource} → ${newTarget} (${existing.edge_type}): '${dup.edge_id}'`,
      );
    }
    this.db
      .prepare('UPDATE edges SET source_value = ?, target_doc_id = ? WHERE edge_id = ?')
      .run(newSource, newTarget, edgeId);
  }

  private _applyRemoveEdge(payload: Record<string, unknown>): void {
    const edgeId = payload.edge_id;
    if (typeof edgeId !== 'string' || edgeId.length === 0) {
      throw new Error("remove_edge: 'edge_id' is required");
    }
    const existing = this.getEdgeById(edgeId);
    if (!existing) {
      throw new Error(`remove_edge: edge '${edgeId}' does not exist`);
    }
    if (existing.status !== 'approved') {
      throw new Error(`remove_edge: edge '${edgeId}' is not approved (status: ${existing.status})`);
    }
    this.db.prepare('DELETE FROM edges WHERE edge_id = ?').run(edgeId);
  }

  /**
   * ADR-014: `source_synced_at` means on-disk source was verified (hash == approved content_hash).
   * Approve-time check avoids marking "verified" when the file changed during proposal pending.
   */
  private _sourceSyncedAtIfApproveMatchesDisk(
    ownership: DocOwnership,
    sourcePath: string | null,
    contentHash: string,
    projectRoot: string | undefined,
  ): string | null {
    if (ownership !== 'file-anchored' || !sourcePath?.trim() || !projectRoot) {
      return null;
    }
    try {
      const abs = resolveSourcePath(sourcePath, projectRoot);
      if (!existsSync(abs)) {
        return null;
      }
      const fileContent = readFileSync(abs, 'utf-8');
      const fileHash = createHash('sha256').update(fileContent).digest('hex');
      return fileHash === contentHash ? new Date().toISOString() : null;
    } catch {
      return null;
    }
  }

  private _applyNewDoc(payload: Omit<Document, 'created_at' | 'updated_at' | 'status'>, projectRoot?: string): void {
    const sourcePath = payload.source_path ?? null;
    let ownership: DocOwnership;
    if (payload.ownership !== undefined && payload.ownership !== null) {
      ownership = normalizeDocOwnership(payload.ownership);
    } else {
      ownership = sourcePath ? 'file-anchored' : 'standalone';
    }
    assertOwnershipSourcePathInvariant(ownership, sourcePath);
    const sourceSyncedAt = this._sourceSyncedAtIfApproveMatchesDisk(
      ownership,
      sourcePath,
      payload.content_hash,
      projectRoot,
    );
    this.insertDocument({
      ...payload,
      ownership,
      template_origin: payload.template_origin ?? null,
      source_path: sourcePath,
      status: 'approved',
      source_synced_at: sourceSyncedAt,
    });
  }

  private _applyUpdateDoc(payload: {
    doc_id: string;
    content: string;
    content_hash: string;
    title?: string;
    source_path?: string | null;
    ownership?: string;
  }): void {
    const existing = this.getDocumentById(payload.doc_id);
    if (!existing) {
      throw new Error(`Cannot update document '${payload.doc_id}': not found`);
    }

    const mergedSourcePath = payload.source_path !== undefined ? payload.source_path : existing.source_path;
    const mergedOwnership =
      payload.ownership !== undefined
        ? normalizeDocOwnership(payload.ownership)
        : normalizeDocOwnership(existing.ownership);
    assertOwnershipSourcePathInvariant(mergedOwnership, mergedSourcePath);

    const sets: string[] = [
      'content = ?',
      'content_hash = ?',
      "status = 'approved'",
      'replaced_by_doc_id = NULL',
      "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
    ];
    const params: unknown[] = [payload.content, payload.content_hash];
    if (payload.title) {
      sets.push('title = ?');
      params.push(payload.title);
    }
    if (payload.source_path !== undefined) {
      sets.push('source_path = ?');
      params.push(payload.source_path);
    }
    if (payload.ownership !== undefined) {
      sets.push('ownership = ?');
      params.push(mergedOwnership);
    }
    // source_synced_at: only refresh via sync_docs hash match (ADR-014). Approving arbitrary
    // update_doc (review_correction, etc.) must not mask staleness.
    if (mergedOwnership !== 'file-anchored' || !mergedSourcePath || String(mergedSourcePath).trim() === '') {
      sets.push('source_synced_at = NULL');
    }
    params.push(payload.doc_id);
    this.db.prepare(`UPDATE documents SET ${sets.join(', ')} WHERE doc_id = ?`).run(...params);
  }

  private _applyDeprecate(payload: {
    entity_type: 'document' | 'edge' | 'layer_rule';
    entity_id: string;
    replaced_by_doc_id?: string;
  }): void {
    const rawReplace = payload.replaced_by_doc_id;
    const replacedBy = typeof rawReplace === 'string' && rawReplace.trim() !== '' ? rawReplace.trim() : undefined;

    if (replacedBy !== undefined && payload.entity_type !== 'document') {
      throw new Error('replaced_by_doc_id is only valid when deprecating a document');
    }
    if (replacedBy !== undefined && replacedBy === payload.entity_id) {
      throw new Error('replaced_by_doc_id cannot equal the deprecated document id');
    }
    if (replacedBy !== undefined) {
      const repl = this.getDocumentById(replacedBy);
      if (!repl || repl.status !== 'approved') {
        throw new Error(`replaced_by_doc_id '${replacedBy}' must reference an approved document`);
      }
    }

    const table =
      payload.entity_type === 'document' ? 'documents' : payload.entity_type === 'edge' ? 'edges' : 'layer_rules';
    const idCol =
      payload.entity_type === 'document' ? 'doc_id' : payload.entity_type === 'edge' ? 'edge_id' : 'rule_id';

    // Verify target exists and is approved
    const existing = this.db
      .prepare(`SELECT ${idCol} FROM ${table} WHERE ${idCol} = ? AND status = 'approved'`)
      .get(payload.entity_id);
    if (!existing) {
      throw new Error(`Cannot deprecate ${payload.entity_type} '${payload.entity_id}': not found or not approved`);
    }

    if (payload.entity_type === 'document') {
      this.db.prepare('DELETE FROM tag_mappings WHERE doc_id = ?').run(payload.entity_id);
      if (replacedBy !== undefined) {
        this.db
          .prepare(
            `UPDATE documents SET status = 'deprecated', replaced_by_doc_id = ?, ` +
              `updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE doc_id = ?`,
          )
          .run(replacedBy, payload.entity_id);
      } else {
        this.db
          .prepare(
            `UPDATE documents SET status = 'deprecated', replaced_by_doc_id = NULL, ` +
              `updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE doc_id = ?`,
          )
          .run(payload.entity_id);
      }
    } else {
      this.db.prepare(`UPDATE ${table} SET status = 'deprecated' WHERE ${idCol} = ?`).run(payload.entity_id);
    }
  }

  // ============================================================
  // Tag Mappings (outside Canonical DAG — direct CRUD)
  // ============================================================

  upsertTagMapping(mapping: Omit<TagMapping, 'created_at'>): void {
    this.db
      .prepare(`
      INSERT OR REPLACE INTO tag_mappings (tag, doc_id, confidence, source)
      VALUES (?, ?, ?, ?)
    `)
      .run(mapping.tag, mapping.doc_id, mapping.confidence, mapping.source);
  }

  setTagMappings(tag: string, mappings: Array<Omit<TagMapping, 'tag' | 'created_at'>>): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM tag_mappings WHERE tag = ?').run(tag);
      const stmt = this.db.prepare(`
        INSERT INTO tag_mappings (tag, doc_id, confidence, source)
        VALUES (?, ?, ?, ?)
      `);
      for (const m of mappings) {
        stmt.run(tag, m.doc_id, m.confidence, m.source);
      }
    })();
  }

  getTagMappings(tag: string): TagMapping[] {
    return this.db
      .prepare(`
      SELECT * FROM tag_mappings
      WHERE tag = ?
      ORDER BY confidence DESC, doc_id ASC
    `)
      .all(tag) as TagMapping[];
  }

  getDocumentsByTags(tags: string[]): Array<{
    doc_id: string;
    matched_tags: string[];
    max_confidence: number;
    avg_confidence: number;
  }> {
    if (tags.length === 0) return [];

    const placeholders = tags.map(() => '?').join(',');
    const rows = this.db
      .prepare(`
      SELECT
        tm.doc_id,
        GROUP_CONCAT(tm.tag ORDER BY tm.tag ASC) as matched_tags,
        MAX(tm.confidence) as max_confidence,
        AVG(tm.confidence) as avg_confidence
      FROM tag_mappings tm
      JOIN documents d ON d.doc_id = tm.doc_id AND d.status = 'approved'
      WHERE tm.tag IN (${placeholders})
      GROUP BY tm.doc_id
      ORDER BY max_confidence DESC, tm.doc_id ASC
    `)
      .all(...tags) as Array<{
      doc_id: string;
      matched_tags: string;
      max_confidence: number;
      avg_confidence: number;
    }>;

    return rows.map((r) => ({
      doc_id: r.doc_id,
      matched_tags: r.matched_tags.split(','),
      max_confidence: r.max_confidence,
      avg_confidence: r.avg_confidence,
    }));
  }

  getTagsForDocument(docId: string): TagMapping[] {
    return this.db
      .prepare(`
      SELECT * FROM tag_mappings
      WHERE doc_id = ?
      ORDER BY confidence DESC, tag ASC
    `)
      .all(docId) as TagMapping[];
  }

  deleteTagMapping(tag: string, docId: string): void {
    this.db.prepare('DELETE FROM tag_mappings WHERE tag = ? AND doc_id = ?').run(tag, docId);
  }

  deleteTagMappings(tag: string): void {
    this.db.prepare('DELETE FROM tag_mappings WHERE tag = ?').run(tag);
  }

  /**
   * Distinct tags that have at least one mapping to an **approved** document.
   * Matches {@link getDocumentsByTags} eligibility so intent expansion and `aegis_get_known_tags`
   * do not advertise tags that cannot resolve to any document.
   */
  getAllTags(): string[] {
    const rows = this.db
      .prepare(`
      SELECT DISTINCT tm.tag
      FROM tag_mappings tm
      JOIN documents d ON d.doc_id = tm.doc_id AND d.status = 'approved'
      ORDER BY tm.tag ASC
    `)
      .all() as Array<{ tag: string }>;
    return rows.map((r) => r.tag);
  }

  /**
   * Archive observations older than the given number of days.
   * Per ADR-003 D-7, only archives observations that:
   * - Have no archived_at yet
   * - Are analyzed (analyzed_at IS NOT NULL)
   * - Have no linked pending proposals (all resolved or no proposals at all)
   * - Were created more than `days` days ago
   */
  archiveOldObservations(days: number): number {
    const result = this.db
      .prepare(`
      UPDATE observations
      SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE archived_at IS NULL
        AND analyzed_at IS NOT NULL
        AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ? || ' days')
        AND NOT EXISTS (
          SELECT 1 FROM proposal_evidence pe
          JOIN proposals p ON p.proposal_id = pe.proposal_id
          WHERE pe.observation_id = observations.observation_id
            AND p.status = 'pending'
        )
    `)
      .run(days);
    return result.changes;
  }

  /** Same eligibility predicate as {@link archiveOldObservations}, without mutating. */
  countObservationsEligibleForArchive(days: number): number {
    const row = this.db
      .prepare(
        `
      SELECT COUNT(*) as cnt FROM observations
      WHERE archived_at IS NULL
        AND analyzed_at IS NOT NULL
        AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ? || ' days')
        AND NOT EXISTS (
          SELECT 1 FROM proposal_evidence pe
          JOIN proposals p ON p.proposal_id = pe.proposal_id
          WHERE pe.observation_id = observations.observation_id
            AND p.status = 'pending'
        )
    `,
      )
      .get(days) as { cnt: number };
    return row.cnt;
  }

  getArchivedObservationCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM observations WHERE archived_at IS NOT NULL').get() as {
      cnt: number;
    };
    return row.cnt;
  }

  // ============================================================
  // Adapter Meta (outside Canonical, no approval)
  // ============================================================

  getAdapterMeta(): { deployed_version: string; deployed_at: string } | undefined {
    return this.db.prepare('SELECT deployed_version, deployed_at FROM adapter_meta WHERE id = 1').get() as
      | { deployed_version: string; deployed_at: string }
      | undefined;
  }

  upsertAdapterMeta(version: string): void {
    this.db
      .prepare(
        `INSERT INTO adapter_meta (id, deployed_version, deployed_at)
         VALUES (1, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(id) DO UPDATE SET
           deployed_version = excluded.deployed_version,
           deployed_at = excluded.deployed_at`,
      )
      .run(version);
  }

  // ============================================================
  // Co-change cache (ADR-015 Task 015-08, operational metadata)
  // ============================================================

  getCoChangeLastProcessedCommit(): string | null {
    try {
      const row = this.db.prepare('SELECT last_processed_commit FROM co_change_meta WHERE id = 1').get() as
        | { last_processed_commit: string | null }
        | undefined;
      return row?.last_processed_commit ?? null;
    } catch {
      return null;
    }
  }

  getCoChangeKbFingerprint(): string | null {
    try {
      const row = this.db.prepare('SELECT kb_paths_fingerprint FROM co_change_meta WHERE id = 1').get() as
        | { kb_paths_fingerprint: string | null }
        | undefined;
      return row?.kb_paths_fingerprint ?? null;
    } catch {
      return null;
    }
  }

  setCoChangeLastProcessedCommit(sha: string | null): void {
    this.db
      .prepare(
        `INSERT INTO co_change_meta (id, last_processed_commit, updated_at)
         VALUES (1, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(id) DO UPDATE SET
           last_processed_commit = excluded.last_processed_commit,
           updated_at = excluded.updated_at`,
      )
      .run(sha);
  }

  listCoChangePatterns(): CoChangePatternRow[] {
    return this.db
      .prepare(
        `SELECT code_pattern, doc_pattern, co_change_count, total_code_changes, confidence
         FROM co_change_patterns
         ORDER BY code_pattern ASC, doc_pattern ASC`,
      )
      .all() as CoChangePatternRow[];
  }

  /** Per code_pattern counts including code-only commits (incremental co-change correctness). */
  listCoChangeCodeTotals(): Map<string, number> {
    try {
      const rows = this.db
        .prepare(`SELECT code_pattern, code_commit_count FROM co_change_code_totals ORDER BY code_pattern ASC`)
        .all() as Array<{ code_pattern: string; code_commit_count: number }>;
      return new Map(rows.map((r) => [r.code_pattern, r.code_commit_count]));
    } catch {
      return new Map();
    }
  }

  replaceCoChangePatterns(rows: CoChangePatternRow[]): void {
    const del = this.db.prepare('DELETE FROM co_change_patterns');
    const ins = this.db.prepare(
      `INSERT INTO co_change_patterns (
         code_pattern, doc_pattern, co_change_count, total_code_changes, confidence, updated_at
       ) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    );
    const tx = this.db.transaction(() => {
      del.run();
      for (const r of rows) {
        ins.run(r.code_pattern, r.doc_pattern, r.co_change_count, r.total_code_changes, r.confidence);
      }
    });
    tx();
  }

  /**
   * Atomically replace pattern rows, code-pattern totals, and advance `last_processed_commit`.
   */
  persistCoChangeCache(
    rows: CoChangePatternRow[],
    codeCommitTotals: Map<string, number>,
    lastProcessedCommit: string,
    kbPathsFingerprint: string,
  ): void {
    const delP = this.db.prepare('DELETE FROM co_change_patterns');
    const insP = this.db.prepare(
      `INSERT INTO co_change_patterns (
         code_pattern, doc_pattern, co_change_count, total_code_changes, confidence, updated_at
       ) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    );
    const delT = this.db.prepare('DELETE FROM co_change_code_totals');
    const insT = this.db.prepare(
      `INSERT INTO co_change_code_totals (code_pattern, code_commit_count, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    );
    const upd = this.db.prepare(
      `UPDATE co_change_meta
       SET last_processed_commit = ?,
           kb_paths_fingerprint = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = 1`,
    );
    const sortedTotals = [...codeCommitTotals.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const tx = this.db.transaction(() => {
      delP.run();
      delT.run();
      for (const r of rows) {
        insP.run(r.code_pattern, r.doc_pattern, r.co_change_count, r.total_code_changes, r.confidence);
      }
      for (const [pattern, cnt] of sortedTotals) {
        insT.run(pattern, cnt);
      }
      upd.run(lastProcessedCommit, kbPathsFingerprint);
    });
    tx();
  }

  /** Clear cache rows and meta pointers (no approved KB sources). */
  clearCoChangeCache(): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM co_change_patterns').run();
      this.db.prepare('DELETE FROM co_change_code_totals').run();
      this.db
        .prepare(
          `UPDATE co_change_meta
           SET last_processed_commit = NULL,
               kb_paths_fingerprint = NULL,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = 1`,
        )
        .run();
    });
    tx();
  }

  searchArchivedObservations(
    eventType?: string,
    limit = 50,
    offset = 0,
  ): { observations: Observation[]; total: number } {
    const conditions = ['archived_at IS NOT NULL'];
    const params: unknown[] = [];

    if (eventType) {
      conditions.push('event_type = ?');
      params.push(eventType);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const { total } = this.db.prepare(`SELECT COUNT(*) as total FROM observations ${where}`).get(...params) as {
      total: number;
    };

    const observations = this.db
      .prepare(`SELECT * FROM observations ${where} ORDER BY archived_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Observation[];

    return { observations, total };
  }
}
