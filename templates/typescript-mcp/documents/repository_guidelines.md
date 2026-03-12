# Repository & Data Store Guidelines

## SQLite as the Single Source of Truth

All persistent state lives in SQLite. No secondary caches or file-based storage for Canonical data.

## Transaction Discipline

- **Approve operations** must execute steps 1-7 (verify → mutate → cycle check → status update → version increment → snapshot → commit) in a single transaction.
- Use `db.transaction(...)` wrapper for any operation that touches multiple tables.
- Never let a partial mutation reach a committed state.

## Content-Addressable Hashing

- `content_hash` is always computed server-side from `content` using SHA-256.
- Never accept client-provided hashes. Always recompute.
- Snapshot IDs are SHA-256 hashes of normalized approved documents + edges + layer_rules.

## Repository as the Data Access Layer

- All SQL lives in `repository.ts`. No raw SQL elsewhere in the codebase.
- The Repository exposes typed methods (e.g., `getApprovedDocumentsByIds`, `insertObservation`).
- Core modules depend on Repository's interface, not on SQLite directly.

## Snapshot Management

- Snapshots are created only when Canonical changes (approve/deprecate).
- Snapshots use copy semantics: `snapshot_docs`, `snapshot_edges`, `snapshot_layer_rules` are immutable copies.
- `knowledge_version` increments on every structural or content change.

## DAG Integrity

- `doc_depends_on` edges must form a DAG. Cycle detection uses recursive CTE.
- Approve rejects any edge that would create a cycle.
- Maximum traversal depth is 10 (safety limit).

## Observation Layer

- Observations are append-only with automatic timestamps.
- `analyzed_at` marks whether an observation has been processed by the automation pipeline.
- Pessimistic claim pattern: mark observations as analyzed before yielding to async analyzers, rollback on failure.
