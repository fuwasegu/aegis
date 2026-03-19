/**
 * Canonical Knowledge Repository
 * Enforces INV-1 through INV-6 from プロジェクト計画v2.md §6.1
 */

import { createHash } from 'node:crypto';
import type {
  CanonicalVersion,
  CompileLog,
  Document,
  Edge,
  EdgeSourceType,
  EdgeType,
  EntityStatus,
  InitManifest,
  KnowledgeMeta,
  LayerRule,
  Observation,
  Proposal,
  ProposalStatus,
  ProposalType,
  Snapshot,
  TagMapping,
} from '../types.js';
import type { AegisDatabase } from './database.js';

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
    this.db
      .prepare(`
      INSERT INTO documents (doc_id, title, kind, content, content_hash, status, template_origin, source_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        doc.doc_id,
        doc.title,
        doc.kind,
        doc.content,
        doc.content_hash,
        doc.status,
        doc.template_origin ?? null,
        doc.source_path ?? null,
      );
  }

  getDocumentById(docId: string): Document | undefined {
    return this.db.prepare('SELECT * FROM documents WHERE doc_id = ?').get(docId) as Document | undefined;
  }

  getDocumentsWithSourcePath(): Document[] {
    return this.db
      .prepare("SELECT * FROM documents WHERE source_path IS NOT NULL AND status = 'approved'")
      .all() as Document[];
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
      INSERT INTO proposals (proposal_id, proposal_type, payload, status, review_comment)
      VALUES (?, ?, ?, ?, ?)
    `)
      .run(proposal.proposal_id, proposal.proposal_type, proposal.payload, proposal.status, proposal.review_comment);
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
      INSERT INTO compile_log (compile_id, snapshot_id, request, base_doc_ids, expanded_doc_ids)
      VALUES (?, ?, ?, ?, ?)
    `)
      .run(log.compile_id, log.snapshot_id, log.request, log.base_doc_ids, log.expanded_doc_ids);
  }

  getCompileLog(compileId: string): CompileLog | undefined {
    return this.db.prepare('SELECT * FROM compile_log WHERE compile_id = ?').get(compileId) as CompileLog | undefined;
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

  approveProposal(proposalId: string, modifications?: Record<string, unknown>): CanonicalVersion {
    return this.db.transaction(() => {
      const proposal = this.getProposal(proposalId);
      if (!proposal) throw new Error(`Proposal ${proposalId} not found`);
      if (proposal.status !== 'pending')
        throw new Error(`Proposal ${proposalId} is not pending (status: ${proposal.status})`);

      const payload = JSON.parse(proposal.payload);

      // Apply admin modifications to payload before mutation
      if (modifications && Object.keys(modifications).length > 0) {
        this._applyModifications(payload, proposal.proposal_type as ProposalType, modifications);
        // Persist modified payload so get_proposal returns the actually-approved content
        this.db
          .prepare('UPDATE proposals SET payload = ? WHERE proposal_id = ?')
          .run(JSON.stringify(payload), proposalId);
      }

      if (proposal.proposal_type === 'bootstrap') {
        // Re-init guard: bootstrap is only allowed on uninitialized projects
        if (this.isInitialized()) {
          throw new AlreadyInitializedError();
        }
        this._applyBootstrap(payload);
      } else if (proposal.proposal_type === 'add_edge') {
        this._applyAddEdge(payload);
      } else if (proposal.proposal_type === 'new_doc') {
        this._applyNewDoc(payload);
        if (Array.isArray(payload.tags) && payload.tags.length > 0 && payload.doc_id) {
          for (const tag of payload.tags as string[]) {
            this.upsertTagMapping({ tag, doc_id: payload.doc_id as string, confidence: 1.0, source: 'manual' });
          }
        }
      } else if (proposal.proposal_type === 'update_doc') {
        this._applyUpdateDoc(payload);
        if (Array.isArray(payload.tags) && payload.tags.length > 0 && payload.doc_id) {
          for (const tag of payload.tags as string[]) {
            this.upsertTagMapping({ tag, doc_id: payload.doc_id as string, confidence: 1.0, source: 'manual' });
          }
        }
      } else if (proposal.proposal_type === 'deprecate') {
        this._applyDeprecate(payload);
      }

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
      new_doc: ['title', 'content', 'kind', 'source_path'],
      update_doc: ['title', 'content', 'source_path'],
      add_edge: ['priority', 'source_value', 'target_doc_id'],
      deprecate: [],
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
    if (payload.edge_type === 'doc_depends_on') {
      if (this.wouldCreateCycle(payload.source_value, payload.target_doc_id)) {
        throw new CycleDetectedError(payload.source_value, payload.target_doc_id);
      }
    }
    this.insertEdge({ ...payload, status: 'approved' });
  }

  private _applyNewDoc(payload: Omit<Document, 'created_at' | 'updated_at' | 'status'>): void {
    this.insertDocument({
      ...payload,
      template_origin: payload.template_origin ?? null,
      source_path: payload.source_path ?? null,
      status: 'approved',
    });
  }

  private _applyUpdateDoc(payload: {
    doc_id: string;
    content: string;
    content_hash: string;
    title?: string;
    source_path?: string;
  }): void {
    const existing = this.db.prepare('SELECT doc_id FROM documents WHERE doc_id = ?').get(payload.doc_id);
    if (!existing) {
      throw new Error(`Cannot update document '${payload.doc_id}': not found`);
    }

    const sets: string[] = [
      'content = ?',
      'content_hash = ?',
      "status = 'approved'",
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
    params.push(payload.doc_id);
    this.db.prepare(`UPDATE documents SET ${sets.join(', ')} WHERE doc_id = ?`).run(...params);
  }

  private _applyDeprecate(payload: { entity_type: 'document' | 'edge' | 'layer_rule'; entity_id: string }): void {
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

    this.db.prepare(`UPDATE ${table} SET status = 'deprecated' WHERE ${idCol} = ?`).run(payload.entity_id);
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

  getAllTags(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT tag FROM tag_mappings ORDER BY tag ASC').all() as Array<{
      tag: string;
    }>;
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
