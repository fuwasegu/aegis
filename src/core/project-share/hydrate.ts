/**
 * ADR-017: share-hydrate — rebuild a replica DB from a shared bundle.
 *
 * Reads `manifest.json` + `canonical.json` from the bundle directory,
 * validates integrity (bundle_sha256 + per-document content_hash),
 * constructs a fresh DB on a temp path, then atomically swaps it into
 * the target location.
 *
 * Phase 1: whole-file replacement — no incremental merge.
 * Operational state (observations, proposals, compile_log, adapter_meta) is NOT preserved.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import { createDatabase } from '../store/database.js';
import { Repository } from '../store/repository.js';
import type { DocOwnership, DocumentKind } from '../types.js';

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_SPIN_MS = 5;
const LOCK_STALE_MS = 30_000;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

/**
 * Acquire the same advisory lock used by AegisDatabase for multi-process safety.
 * Returns a release function.
 */
function acquireAdvisoryLock(dbPath: string): () => void {
  const lockPath = `${dbPath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          /* already removed */
        }
      };
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        const lockAge = Date.now() - statSync(lockPath).mtimeMs;
        if (lockAge > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        /* lock file disappeared between checks — retry */
      }
      if (Date.now() > deadline) {
        throw new Error(`Aegis DB lock acquisition timed out: ${lockPath}`);
      }
      Atomics.wait(WAIT_BUFFER, 0, 0, LOCK_SPIN_MS);
    }
  }
}

/**
 * Lightweight read-only check: is the DB at `dbPath` initialized?
 * Opens the file directly via sql.js without going through createDatabase
 * (which would acquire the advisory lock and run write migrations).
 */
async function isDbInitialized(dbPath: string): Promise<boolean> {
  try {
    const SQL = await initSqlJs();
    const buffer = readFileSync(dbPath);
    const rawDb = new SQL.Database(new Uint8Array(buffer));
    try {
      const result = rawDb.exec('SELECT current_version FROM knowledge_meta WHERE id = 1');
      if (result.length === 0 || result[0].values.length === 0) return false;
      return (result[0].values[0][0] as number) >= 1;
    } finally {
      rawDb.close();
    }
  } catch {
    return false;
  }
}

import type {
  BundleDocument,
  BundleEdge,
  BundleLayerRule,
  BundleTagMapping,
  SharedCanonicalBundleV1,
  SharedCanonicalManifestV1,
} from './types.js';

export interface ShareHydrateResult {
  snapshot_id: string;
  knowledge_version: number;
  counts: {
    documents: number;
    edges: number;
    layer_rules: number;
    tag_mappings: number;
  };
}

export interface ShareHydrateOptions {
  /** Path to the bundle directory containing manifest.json and canonical.json. */
  bundleDir: string;
  /** Target DB file path. */
  targetDbPath: string;
  /** Allow overwriting an existing initialized DB. */
  replace: boolean;
}

/**
 * Hydrate a replica DB from a shared canonical bundle.
 *
 * @throws If manifest/bundle files are missing, integrity checks fail,
 *         or target DB exists without --replace.
 */
export async function shareHydrate(opts: ShareHydrateOptions): Promise<ShareHydrateResult> {
  const { bundleDir, targetDbPath, replace } = opts;

  // ---- 1. Read manifest ----
  const manifestPath = join(bundleDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }
  const manifestRaw = readFileSync(manifestPath, 'utf-8');
  const manifest: SharedCanonicalManifestV1 = JSON.parse(manifestRaw);
  if (manifest.format_version !== 1) {
    throw new Error(`Unsupported manifest format_version: ${manifest.format_version}`);
  }

  // ---- 2. Read bundle ----
  const bundlePath = join(bundleDir, manifest.bundle_file);
  if (!existsSync(bundlePath)) {
    throw new Error(`Bundle file not found: ${bundlePath}`);
  }
  const bundleRaw = readFileSync(bundlePath, 'utf-8');

  // ---- 3. Validate bundle integrity ----
  const computedSha256 = createHash('sha256').update(bundleRaw, 'utf-8').digest('hex');
  if (computedSha256 !== manifest.bundle_sha256) {
    throw new Error(`Bundle SHA-256 mismatch: expected ${manifest.bundle_sha256}, got ${computedSha256}`);
  }

  const bundle: SharedCanonicalBundleV1 = JSON.parse(bundleRaw);
  if (bundle.format_version !== 1) {
    throw new Error(`Unsupported bundle format_version: ${bundle.format_version}`);
  }
  if (bundle.snapshot_id !== manifest.snapshot_id) {
    throw new Error(`Snapshot ID mismatch: manifest says ${manifest.snapshot_id}, bundle says ${bundle.snapshot_id}`);
  }
  if (bundle.knowledge_version !== manifest.knowledge_version) {
    throw new Error(
      `Knowledge version mismatch: manifest says ${manifest.knowledge_version}, bundle says ${bundle.knowledge_version}`,
    );
  }

  // Validate per-document content_hash
  for (const doc of bundle.documents) {
    const expectedHash = createHash('sha256').update(doc.content, 'utf-8').digest('hex');
    if (expectedHash !== doc.content_hash) {
      throw new Error(
        `Content hash mismatch for document "${doc.doc_id}": expected ${expectedHash}, got ${doc.content_hash}`,
      );
    }
  }

  // ---- 4. Build temp DB (before acquiring target lock) ----
  const targetDir = dirname(targetDbPath);
  mkdirSync(targetDir, { recursive: true });

  // Use a unique temp path per invocation to avoid collisions between
  // concurrent hydrate processes targeting the same DB.
  const tempDbPath = `${targetDbPath}.hydrate-${randomUUID()}.tmp`;

  try {
    const db = await createDatabase(tempDbPath);
    const repo = new Repository(db);

    repo.runInTransaction(() => {
      // Set knowledge_version
      db.prepare('UPDATE knowledge_meta SET current_version = ?, last_updated_at = ? WHERE id = 1').run(
        bundle.knowledge_version,
        new Date().toISOString(),
      );

      // Insert documents
      insertDocuments(repo, bundle.documents);

      // Insert edges
      insertEdges(repo, bundle.edges);

      // Insert layer rules
      insertLayerRules(repo, bundle.layer_rules);

      // Insert tag mappings
      insertTagMappings(repo, bundle.tag_mappings);

      // Insert snapshot
      insertSnapshot(db, bundle);
    });

    db.close();

    // ---- 5. Guard + atomic swap under advisory lock ----
    // Acquire the same lock that AegisDatabase uses so that:
    //  (a) the --replace guard is race-free (no TOCTOU)
    //  (b) readers always see either old or new DB (POSIX rename is atomic)
    const releaseLock = acquireAdvisoryLock(targetDbPath);
    try {
      // Check initialization state *under lock* using a lightweight
      // read-only sql.js open (no schema writes, no createDatabase lock).
      if (existsSync(targetDbPath) && !replace) {
        if (await isDbInitialized(targetDbPath)) {
          throw new Error(
            `Target DB is initialized: ${targetDbPath}. Use --replace to overwrite. ` +
              'WARNING: local operational state (observations, proposals, compile_log) will be lost.',
          );
        }
      }

      // POSIX rename() atomically replaces the destination when both paths
      // are on the same filesystem, so readers never see a missing target.
      renameSync(tempDbPath, targetDbPath);
    } finally {
      releaseLock();
    }
  } catch (err) {
    // Clean up temp DB on failure (build or swap phase)
    if (existsSync(tempDbPath)) {
      unlinkSync(tempDbPath);
    }
    throw err;
  }

  return {
    snapshot_id: bundle.snapshot_id,
    knowledge_version: bundle.knowledge_version,
    counts: {
      documents: bundle.documents.length,
      edges: bundle.edges.length,
      layer_rules: bundle.layer_rules.length,
      tag_mappings: bundle.tag_mappings.length,
    },
  };
}

// ---- Internal helpers ----

function insertDocuments(repo: Repository, docs: BundleDocument[]): void {
  for (const doc of docs) {
    repo.insertDocument({
      doc_id: doc.doc_id,
      title: doc.title,
      kind: doc.kind as DocumentKind,
      content: doc.content,
      content_hash: doc.content_hash,
      status: 'approved',
      ownership: doc.ownership as DocOwnership,
      template_origin: doc.template_origin,
      source_path: doc.source_path,
      source_refs_json: doc.source_refs_json,
      source_synced_at: null,
      replaced_by_doc_id: null,
    });
  }
}

function insertEdges(repo: Repository, edges: BundleEdge[]): void {
  for (const edge of edges) {
    repo.insertEdge({
      edge_id: edge.edge_id,
      source_type: edge.source_type as 'path' | 'layer' | 'command' | 'doc',
      source_value: edge.source_value,
      target_doc_id: edge.target_doc_id,
      edge_type: edge.edge_type as 'path_requires' | 'layer_requires' | 'command_requires' | 'doc_depends_on',
      priority: edge.priority,
      specificity: edge.specificity,
      status: 'approved',
    });
  }
}

function insertLayerRules(repo: Repository, rules: BundleLayerRule[]): void {
  for (const rule of rules) {
    repo.insertLayerRule({
      rule_id: rule.rule_id,
      path_pattern: rule.path_pattern,
      layer_name: rule.layer_name,
      priority: rule.priority,
      specificity: rule.specificity,
      status: 'approved',
    });
  }
}

function insertTagMappings(repo: Repository, mappings: BundleTagMapping[]): void {
  for (const tm of mappings) {
    repo.upsertTagMapping({
      tag: tm.tag,
      doc_id: tm.doc_id,
      confidence: tm.confidence,
      source: tm.source,
    });
  }
}

function insertSnapshot(db: import('../store/database.js').AegisDatabase, bundle: SharedCanonicalBundleV1): void {
  // Insert snapshot row
  db.prepare('INSERT INTO snapshots (snapshot_id, knowledge_version) VALUES (?, ?)').run(
    bundle.snapshot_id,
    bundle.knowledge_version,
  );

  // snapshot_docs
  const insertDoc = db.prepare('INSERT INTO snapshot_docs (snapshot_id, doc_id, content_hash) VALUES (?, ?, ?)');
  for (const doc of bundle.documents) {
    insertDoc.run(bundle.snapshot_id, doc.doc_id, doc.content_hash);
  }

  // snapshot_edges
  const insertEdge = db.prepare(
    'INSERT INTO snapshot_edges (snapshot_id, edge_id, source_type, source_value, target_doc_id, edge_type, priority, specificity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const edge of bundle.edges) {
    insertEdge.run(
      bundle.snapshot_id,
      edge.edge_id,
      edge.source_type,
      edge.source_value,
      edge.target_doc_id,
      edge.edge_type,
      edge.priority,
      edge.specificity,
    );
  }

  // snapshot_layer_rules
  const insertRule = db.prepare(
    'INSERT INTO snapshot_layer_rules (snapshot_id, rule_id, path_pattern, layer_name, priority, specificity) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const rule of bundle.layer_rules) {
    insertRule.run(
      bundle.snapshot_id,
      rule.rule_id,
      rule.path_pattern,
      rule.layer_name,
      rule.priority,
      rule.specificity,
    );
  }
}
