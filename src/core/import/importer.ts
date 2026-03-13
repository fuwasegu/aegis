/**
 * Document Importer
 *
 * Reads a Markdown file (with optional YAML frontmatter) and produces
 * ProposalDrafts for importing it into Canonical Knowledge.
 *
 * Supported frontmatter fields:
 *   id, title, kind, tags, requires
 *
 * If frontmatter is absent, metadata is inferred from the filename.
 */

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import type { ProposalDraft, DocumentKind } from '../types.js';

const VALID_KINDS: DocumentKind[] = ['guideline', 'pattern', 'constraint', 'template', 'reference'];

export interface ImportedDoc {
  doc_id: string;
  title: string;
  kind: DocumentKind;
  content: string;
  content_hash: string;
  tags: string[];
  requires: string[];
}

export interface ImportResult {
  doc: ImportedDoc;
  drafts: ProposalDraft[];
}

interface FrontmatterData {
  id?: string;
  title?: string;
  kind?: string;
  tags?: string[];
  requires?: string[];
}

/**
 * Parse YAML frontmatter delimited by `---`.
 * Returns the parsed data and the body after the frontmatter.
 */
export function parseFrontmatter(raw: string): { data: FrontmatterData; body: string } {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('---')) {
    return { data: {}, body: raw };
  }

  const end = trimmed.indexOf('\n---', 3);
  if (end === -1) {
    return { data: {}, body: raw };
  }

  const yamlBlock = trimmed.slice(3, end).trim();
  const body = trimmed.slice(end + 4).replace(/^\n/, '');

  try {
    const parsed = yaml.load(yamlBlock) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') {
      return { data: {}, body };
    }

    const data: FrontmatterData = {};
    if (typeof parsed.id === 'string') data.id = parsed.id;
    if (typeof parsed.title === 'string') data.title = parsed.title;
    if (typeof parsed.kind === 'string') data.kind = parsed.kind;
    if (Array.isArray(parsed.tags)) data.tags = parsed.tags.filter((t): t is string => typeof t === 'string');
    if (Array.isArray(parsed.requires)) data.requires = parsed.requires.filter((r): r is string => typeof r === 'string');

    return { data, body };
  } catch {
    return { data: {}, body };
  }
}

function deriveDocId(filePath: string): string {
  const name = basename(filePath, extname(filePath));
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/_+/g, '_');
}

function titleCase(id: string): string {
  return id
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Import a Markdown file and produce proposal drafts.
 *
 * Overrides take precedence over frontmatter, which takes precedence over defaults.
 */
export function importDocument(
  filePath: string,
  overrides?: { doc_id?: string; title?: string; kind?: DocumentKind },
): ImportResult {
  const raw = readFileSync(filePath, 'utf-8');
  const { data, body } = parseFrontmatter(raw);

  const doc_id = overrides?.doc_id ?? data.id ?? deriveDocId(filePath);
  const title = overrides?.title ?? data.title ?? titleCase(doc_id);
  const rawKind = overrides?.kind ?? data.kind ?? 'reference';
  const kind: DocumentKind = VALID_KINDS.includes(rawKind as DocumentKind)
    ? (rawKind as DocumentKind)
    : 'reference';
  const tags = data.tags ?? [];
  const requires = data.requires ?? [];

  const content = body || raw;
  const content_hash = createHash('sha256').update(content).digest('hex');

  const doc: ImportedDoc = { doc_id, title, kind, content, content_hash, tags, requires };

  const drafts: ProposalDraft[] = [];

  // new_doc proposal (no evidence since this is a direct import, not from an observation)
  drafts.push({
    proposal_type: 'new_doc',
    payload: {
      doc_id,
      title,
      kind,
      content,
      content_hash,
    },
    evidence_observation_ids: [],
  });

  // add_edge proposals for `requires`
  for (const targetDocId of requires) {
    drafts.push({
      proposal_type: 'add_edge',
      payload: {
        source_type: 'doc',
        source_value: doc_id,
        target_doc_id: targetDocId,
        edge_type: 'doc_depends_on',
        priority: 100,
      },
      evidence_observation_ids: [],
    });
  }

  return { doc, drafts };
}
