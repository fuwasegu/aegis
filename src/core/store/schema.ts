/**
 * SQLite Schema Definition
 * Corresponds to プロジェクト計画v2.md §5.2, §5.3
 */

export const SCHEMA_SQL = `
-- ============================================================
-- Canonical Knowledge Layer
-- ============================================================

CREATE TABLE IF NOT EXISTS documents (
    doc_id          TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    kind            TEXT NOT NULL
                    CHECK (kind IN ('guideline', 'pattern', 'constraint', 'template', 'reference')),
    content         TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'proposed', 'approved', 'deprecated')),
    ownership       TEXT NOT NULL DEFAULT 'standalone'
                    CHECK (ownership IN ('file-anchored', 'standalone', 'derived')),
    template_origin TEXT,
    source_path     TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS edges (
    edge_id         TEXT PRIMARY KEY,
    source_type     TEXT NOT NULL
                    CHECK (source_type IN ('path', 'layer', 'command', 'doc')),
    source_value    TEXT NOT NULL,
    target_doc_id   TEXT NOT NULL REFERENCES documents(doc_id),
    edge_type       TEXT NOT NULL
                    CHECK (edge_type IN ('path_requires', 'layer_requires',
                                         'command_requires', 'doc_depends_on')),
    priority        INTEGER NOT NULL DEFAULT 100,
    specificity     INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'proposed', 'approved', 'deprecated')),
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS layer_rules (
    rule_id         TEXT PRIMARY KEY,
    path_pattern    TEXT NOT NULL,
    layer_name      TEXT NOT NULL,
    priority        INTEGER NOT NULL DEFAULT 100,
    specificity     INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'proposed', 'approved', 'deprecated')),
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================
-- Observation Layer
-- ============================================================

CREATE TABLE IF NOT EXISTS observations (
    observation_id      TEXT PRIMARY KEY,
    event_type          TEXT NOT NULL
                        CHECK (event_type IN ('compile_miss', 'review_correction',
                                              'pr_merged', 'manual_note', 'document_import',
                                              'doc_gap_detected')),
    payload             TEXT NOT NULL,
    related_compile_id  TEXT,
    related_snapshot_id TEXT,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    archived_at         TEXT,
    analyzed_at         TEXT                        -- set when automation pipeline processes this observation
);

-- ============================================================
-- Proposal Layer
-- ============================================================

CREATE TABLE IF NOT EXISTS proposals (
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

CREATE TABLE IF NOT EXISTS proposal_evidence (
    proposal_id     TEXT NOT NULL REFERENCES proposals(proposal_id),
    observation_id  TEXT NOT NULL REFERENCES observations(observation_id),
    PRIMARY KEY (proposal_id, observation_id)
);

-- ============================================================
-- Snapshot / Audit Layer
-- ============================================================

CREATE TABLE IF NOT EXISTS snapshots (
    snapshot_id     TEXT PRIMARY KEY,
    knowledge_version INTEGER NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS snapshot_docs (
    snapshot_id     TEXT NOT NULL REFERENCES snapshots(snapshot_id),
    doc_id          TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, doc_id)
);

CREATE TABLE IF NOT EXISTS snapshot_edges (
    snapshot_id     TEXT NOT NULL REFERENCES snapshots(snapshot_id),
    edge_id         TEXT NOT NULL,
    source_type     TEXT NOT NULL,
    source_value    TEXT NOT NULL,
    target_doc_id   TEXT NOT NULL,
    edge_type       TEXT NOT NULL,
    priority        INTEGER NOT NULL,
    specificity     INTEGER NOT NULL,
    PRIMARY KEY (snapshot_id, edge_id)
);

CREATE TABLE IF NOT EXISTS snapshot_layer_rules (
    snapshot_id     TEXT NOT NULL REFERENCES snapshots(snapshot_id),
    rule_id         TEXT NOT NULL,
    path_pattern    TEXT NOT NULL,
    layer_name      TEXT NOT NULL,
    priority        INTEGER NOT NULL,
    specificity     INTEGER NOT NULL,
    PRIMARY KEY (snapshot_id, rule_id)
);

CREATE TABLE IF NOT EXISTS compile_log (
    compile_id      TEXT PRIMARY KEY,
    snapshot_id     TEXT NOT NULL REFERENCES snapshots(snapshot_id),
    request         TEXT NOT NULL,
    base_doc_ids    TEXT NOT NULL,
    expanded_doc_ids TEXT,
    audit_meta        TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS knowledge_meta (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    current_version INTEGER NOT NULL DEFAULT 0,
    last_updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS init_manifest (
    id                  INTEGER PRIMARY KEY CHECK (id = 1),
    template_id         TEXT NOT NULL,
    template_version    TEXT NOT NULL,
    preview_hash        TEXT NOT NULL,
    stack_detection     TEXT NOT NULL,
    selected_profile    TEXT NOT NULL,
    placeholders        TEXT NOT NULL,
    initial_snapshot_id TEXT NOT NULL REFERENCES snapshots(snapshot_id),
    seed_counts         TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================
-- Tag Mappings (outside Canonical DAG)
-- ============================================================

CREATE TABLE IF NOT EXISTS tag_mappings (
    tag             TEXT NOT NULL,
    doc_id          TEXT NOT NULL REFERENCES documents(doc_id),
    confidence      REAL NOT NULL DEFAULT 1.0,
    source          TEXT NOT NULL DEFAULT 'slm'
                    CHECK (source IN ('slm', 'manual')),
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (tag, doc_id)
);

-- ============================================================
-- Adapter Meta (outside Canonical Knowledge, no approval workflow)
-- Same pattern as tag_mappings: operational metadata, direct CRUD.
-- ============================================================

CREATE TABLE IF NOT EXISTS adapter_meta (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    deployed_version  TEXT NOT NULL,
    deployed_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================
-- Indexes (§5.3)
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_documents_status    ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_kind      ON documents(kind);
CREATE INDEX IF NOT EXISTS idx_edges_type_status   ON edges(edge_type, status);
CREATE INDEX IF NOT EXISTS idx_edges_target        ON edges(target_doc_id);
CREATE INDEX IF NOT EXISTS idx_edges_source        ON edges(source_type, source_value);
CREATE INDEX IF NOT EXISTS idx_observations_type   ON observations(event_type);
CREATE INDEX IF NOT EXISTS idx_observations_snap   ON observations(related_snapshot_id);
CREATE INDEX IF NOT EXISTS idx_proposals_status    ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_tag_mappings_doc    ON tag_mappings(doc_id);
`;
