/**
 * ADR-018 Task 018-05: bootstrap shared source export.
 *
 * Reads approved Canonical Knowledge from the DB and writes
 * `aegis-share/source/` in the human-editable shared source format.
 */

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import type { Repository } from '../store/repository.js';
import type { Document, Edge, LayerRule, TagMapping } from '../types.js';

// -- Result type ---------------------------------------------------------

export interface SourceExportResult {
  counts: {
    documents: number;
    edges: number;
    layer_rules: number;
    tag_mappings: number;
  };
  warnings: string[];
}

// -- Deterministic helpers -----------------------------------------------

/** Locale-independent code-point comparator. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Reorder keys of an object to match a canonical order. */
function reorderKeys(obj: Record<string, unknown>, order: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const k of order) {
    if (k in obj) result[k] = obj[k];
  }
  for (const k of Object.keys(obj)) {
    if (!(k in result)) result[k] = obj[k];
  }
  return result;
}

// -- Key orders (match format.ts) ----------------------------------------

const FRONTMATTER_KEY_ORDER = [
  'doc_id',
  'title',
  'kind',
  'ownership',
  'source_path',
  'source_refs_json',
  'template_origin',
];
const EDGE_KEY_ORDER = ['edge_id', 'source_value', 'target_doc_id', 'priority', 'specificity'];
const LAYER_RULE_KEY_ORDER = ['rule_id', 'path_pattern', 'layer_name', 'priority', 'specificity'];
const TAG_MAPPING_KEY_ORDER = ['tag', 'doc_id', 'confidence', 'source'];
const SOURCE_REF_KEY_ORDER = ['asset_path', 'anchor_type', 'anchor_value'];

// -- Reverse mapping: source_type → edge filename ------------------------

const SOURCE_TYPE_TO_FILE: Record<string, string> = {
  path: 'path-requires.json',
  layer: 'layer-requires.json',
  command: 'command-requires.json',
  doc: 'doc-depends-on.json',
};

// -- Document serialization ----------------------------------------------

function serializeDocument(doc: Document): string {
  const fm: Record<string, unknown> = {
    doc_id: doc.doc_id,
    title: doc.title,
    kind: doc.kind,
    ownership: doc.ownership,
  };

  // Optional fields: only include if non-null
  if (doc.source_path != null) {
    fm.source_path = doc.source_path;
  }
  if (doc.source_refs_json != null) {
    // Normalize source_refs_json: parse, sort, reorder keys, re-serialize
    try {
      const parsed = JSON.parse(doc.source_refs_json);
      if (Array.isArray(parsed)) {
        const sorted = (parsed as Record<string, unknown>[])
          .slice()
          .sort((a, b) => {
            const ap = cmp(String(a.asset_path ?? ''), String(b.asset_path ?? ''));
            if (ap !== 0) return ap;
            const at = cmp(String(a.anchor_type ?? ''), String(b.anchor_type ?? ''));
            if (at !== 0) return at;
            return cmp(String(a.anchor_value ?? ''), String(b.anchor_value ?? ''));
          })
          .map((e) => reorderKeys(e, SOURCE_REF_KEY_ORDER));
        fm.source_refs_json = JSON.stringify(sorted);
      }
    } catch {
      fm.source_refs_json = doc.source_refs_json;
    }
  }
  if (doc.template_origin != null) {
    fm.template_origin = doc.template_origin;
  }

  // Build ordered frontmatter (canonical key order)
  const orderedFm = reorderKeys(fm, FRONTMATTER_KEY_ORDER);
  const lines: string[] = [];
  for (const [key, val] of Object.entries(orderedFm)) {
    const dumped = yaml.dump({ [key]: val }, { flowLevel: -1, lineWidth: -1, noRefs: true }).trimEnd();
    lines.push(dumped);
  }

  // Normalize CRLF → LF and ensure trailing newline (match format.ts conventions)
  const normalized = doc.content.replace(/\r\n/g, '\n');
  const body = normalized.endsWith('\n') ? normalized : `${normalized}\n`;
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

// -- Edge serialization --------------------------------------------------

function serializeEdges(edges: Edge[]): Map<string, string> {
  // Group by source_type → filename
  const groups = new Map<string, Record<string, unknown>[]>();

  for (const edge of edges) {
    const filename = SOURCE_TYPE_TO_FILE[edge.source_type];
    if (!filename) continue;

    const entry = reorderKeys(
      {
        edge_id: edge.edge_id,
        source_value: edge.source_value,
        target_doc_id: edge.target_doc_id,
        priority: edge.priority,
        specificity: edge.specificity,
      },
      EDGE_KEY_ORDER,
    );

    const list = groups.get(filename) ?? [];
    list.push(entry);
    groups.set(filename, list);
  }

  // Sort each group by edge_id, serialize
  const result = new Map<string, string>();
  for (const [filename, entries] of groups) {
    entries.sort((a, b) => cmp(String(a.edge_id), String(b.edge_id)));
    result.set(filename, `${JSON.stringify(entries, null, 2)}\n`);
  }

  return result;
}

// -- Layer rules serialization -------------------------------------------

function serializeLayerRules(rules: LayerRule[]): string {
  const entries = rules
    .slice()
    .sort((a, b) => cmp(a.rule_id, b.rule_id))
    .map((r) =>
      reorderKeys(
        {
          rule_id: r.rule_id,
          path_pattern: r.path_pattern,
          layer_name: r.layer_name,
          priority: r.priority,
          specificity: r.specificity,
        },
        LAYER_RULE_KEY_ORDER,
      ),
    );
  return `${JSON.stringify(entries, null, 2)}\n`;
}

// -- Tag mappings serialization ------------------------------------------

function serializeTagMappings(mappings: TagMapping[]): string {
  const entries = mappings
    .slice()
    .sort((a, b) => cmp(a.tag, b.tag) || cmp(a.doc_id, b.doc_id))
    .map((tm) =>
      reorderKeys(
        {
          tag: tm.tag,
          doc_id: tm.doc_id,
          confidence: tm.confidence,
          source: tm.source,
        },
        TAG_MAPPING_KEY_ORDER,
      ),
    );
  return `${JSON.stringify(entries, null, 2)}\n`;
}

// -- Public API ----------------------------------------------------------

/**
 * Export approved Canonical Knowledge as shared source files.
 *
 * All DB reads are pinned inside a single transaction.
 *
 * @param repo   Initialized Repository instance
 * @param outDir Output directory (default: `<projectRoot>/aegis-share/source`)
 */
export function shareSourceExport(repo: Repository, outDir: string): SourceExportResult {
  const warnings: string[] = [];

  // Transaction-pinned read
  const data = repo.runInTransactionReturn(() => {
    const meta = repo.getKnowledgeMeta();
    if (meta.current_version === 0) {
      throw new Error('Database is not initialized (knowledge_version = 0). Run aegis init first.');
    }

    return {
      docs: repo.getApprovedDocuments(),
      edges: repo.getApprovedEdges(),
      rules: repo.getApprovedLayerRules(),
      tagMappings: repo.getApprovedTagMappings(),
      pendingCount: repo.listProposals('pending', 0, 0).total,
    };
  });

  if (data.pendingCount > 0) {
    warnings.push(
      `${data.pendingCount} pending proposal(s) not yet approved — export reflects current approved state only.`,
    );
  }

  // Filter edges to only those referencing approved documents
  const approvedDocIds = new Set(data.docs.map((d) => d.doc_id));
  const validEdges = data.edges.filter((e) => {
    if (!approvedDocIds.has(e.target_doc_id)) {
      warnings.push(`Edge "${e.edge_id}" references deprecated/non-existent document "${e.target_doc_id}" — skipped.`);
      return false;
    }
    return true;
  });

  // Write to a temp directory first, then atomically swap (prevents data loss on failure)
  const tmpDir = `${outDir}.export-tmp-${Date.now()}`;
  try {
    const docsDir = join(tmpDir, 'documents');
    const edgesDir = join(tmpDir, 'edges');
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(edgesDir, { recursive: true });

    // Write documents (sorted by doc_id for deterministic output)
    const sortedDocs = data.docs.slice().sort((a, b) => cmp(a.doc_id, b.doc_id));
    for (const doc of sortedDocs) {
      // Guard against path traversal in doc_id
      if (doc.doc_id.includes('/') || doc.doc_id.includes('\\') || doc.doc_id.includes('..')) {
        throw new Error(
          `Cannot export document "${doc.doc_id}": doc_id contains path separator or traversal characters. ` +
            'Fix the doc_id in the database before exporting.',
        );
      }
      writeFileSync(join(docsDir, `${doc.doc_id}.md`), serializeDocument(doc), 'utf-8');
    }

    // Write edges
    const edgeFiles = serializeEdges(validEdges);
    for (const [filename, content] of edgeFiles) {
      writeFileSync(join(edgesDir, filename), content, 'utf-8');
    }

    // Write layer rules (only if non-empty)
    if (data.rules.length > 0) {
      writeFileSync(join(tmpDir, 'layer-rules.json'), serializeLayerRules(data.rules), 'utf-8');
    }

    // Write tag mappings (only if non-empty)
    if (data.tagMappings.length > 0) {
      writeFileSync(join(tmpDir, 'tag-mappings.json'), serializeTagMappings(data.tagMappings), 'utf-8');
    }

    // Atomic swap: remove old outDir, rename tmp to outDir
    mkdirSync(dirname(outDir), { recursive: true });
    if (existsSync(outDir)) {
      rmSync(outDir, { recursive: true, force: true });
    }
    renameSync(tmpDir, outDir);

    return {
      counts: {
        documents: sortedDocs.length,
        edges: validEdges.length,
        layer_rules: data.rules.length,
        tag_mappings: data.tagMappings.length,
      },
      warnings,
    };
  } catch (err) {
    // Clean up temp dir on failure
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    throw err;
  }
}
