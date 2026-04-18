import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Document, Edge } from '../types.js';
import {
  collectSemanticStalenessFindings,
  extractTsExportedSymbols,
  findRenameCandidatePath,
  linkedPathsForDoc,
  listRepoRelativeFiles,
  SEMANTIC_STALENESS_ALGORITHM_VERSION,
  stableStringifyFingerprints,
} from './staleness.js';

function hashUtf8(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

describe('optimization/staleness (ADR-015 Task 015-07)', () => {
  it('extractTsExportedSymbols collects deterministic exported-like names', () => {
    const src = `
export function Alpha() {}
export class Beta {}
export const Gamma = 1;
export interface Delta {}
`;
    expect(extractTsExportedSymbols(src)).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma']);
  });

  it('extractTsExportedSymbols parses export { ... } lists', () => {
    expect(extractTsExportedSymbols(`export { One, Two as T2 } from './mod';\n`)).toEqual(['One', 'Two']);
  });

  it('extractTsExportedSymbols ignores non-exported top-level declarations', () => {
    expect(extractTsExportedSymbols(`function Internal() {}\nexport function Pub() {}\n`)).toEqual(['Pub']);
  });

  it('Level 1 reports hash mismatch for file-anchored doc', () => {
    const root = mkdtempSync(join(tmpdir(), 'aegis-stale-'));
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs/x.md'), 'on disk', 'utf-8');

    const doc: Document = {
      doc_id: 'd1',
      title: 'T',
      kind: 'guideline',
      content: 'canonical body',
      content_hash: hashUtf8('canonical body'),
      status: 'approved',
      ownership: 'file-anchored',
      template_origin: null,
      source_path: 'docs/x.md',
      source_synced_at: null,
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
    };

    const r = collectSemanticStalenessFindings({
      docs: [doc],
      edges: [],
      projectRoot: root,
      getBaseline: () => null,
      persistLevel3Baselines: false,
    });

    expect(r.findings.some((f) => f.level === 1 && f.kind === 'hash_mismatch')).toBe(true);
    expect(r.findings[0]?.algorithm_version).toBe(SEMANTIC_STALENESS_ALGORITHM_VERSION);
  });

  it('Level 2 reports missing source_path and rename candidate when hash matches elsewhere', () => {
    const root = mkdtempSync(join(tmpdir(), 'aegis-stale-'));
    mkdirSync(join(root, 'docs'), { recursive: true });
    const body = 'same bytes';
    const h = hashUtf8(body);
    writeFileSync(join(root, 'docs/new.md'), body, 'utf-8');

    const doc: Document = {
      doc_id: 'd-miss',
      title: 'T',
      kind: 'guideline',
      content: body,
      content_hash: h,
      status: 'approved',
      ownership: 'file-anchored',
      template_origin: null,
      source_path: 'docs/old.md',
      source_synced_at: null,
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
    };

    const files = listRepoRelativeFiles(root);
    expect(findRenameCandidatePath(root, files, h)).toBe('docs/new.md');

    const r = collectSemanticStalenessFindings({
      docs: [doc],
      edges: [],
      projectRoot: root,
      getBaseline: () => null,
      persistLevel3Baselines: false,
    });

    expect(r.findings.some((f) => f.kind === 'source_missing')).toBe(true);
    expect(r.findings.some((f) => f.kind === 'rename_candidate' && f.rename_candidate_path === 'docs/new.md')).toBe(
      true,
    );
  });

  it('Level 3 detects symbol drift vs baseline', () => {
    const root = mkdtempSync(join(tmpdir(), 'aegis-stale-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/mod.ts'), `export function Keep() {}\nexport function Gone() {}\n`, 'utf-8');

    const doc: Document = {
      doc_id: 'guide',
      title: 'G',
      kind: 'guideline',
      content: 'x',
      content_hash: hashUtf8('x'),
      status: 'approved',
      ownership: 'standalone',
      template_origin: null,
      source_path: null,
      source_synced_at: null,
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
    };

    const edges: Edge[] = [
      {
        edge_id: 'e1',
        source_type: 'path',
        source_value: 'src/**/*.ts',
        target_doc_id: 'guide',
        edge_type: 'path_requires',
        priority: 10,
        specificity: 10,
        status: 'approved',
        created_at: '2020-01-01T00:00:00.000Z',
      },
    ];

    const relFiles = listRepoRelativeFiles(root);
    expect(linkedPathsForDoc('guide', edges, relFiles)).toEqual(['src/mod.ts']);

    const prevSyms = extractTsExportedSymbols(`export function Keep() {}\nexport function Gone() {}\n`);
    const prevJson = stableStringifyFingerprints({
      'src/mod.ts': `sym:${hashUtf8(prevSyms.join('\n'))}`,
    });

    writeFileSync(join(root, 'src/mod.ts'), `export function Keep() {}\n`, 'utf-8');

    const r = collectSemanticStalenessFindings({
      docs: [doc],
      edges,
      projectRoot: root,
      getBaseline: (id) => (id === 'guide' ? prevJson : null),
      persistLevel3Baselines: false,
    });

    expect(r.findings.some((f) => f.level === 3 && f.kind === 'symbol_drift')).toBe(true);
  });

  it('Level 3 establishes baseline when none exists (no drift findings)', () => {
    const root = mkdtempSync(join(tmpdir(), 'aegis-stale-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/a.ts'), 'export const X = 1;\n', 'utf-8');

    const doc: Document = {
      doc_id: 'g2',
      title: 'G',
      kind: 'guideline',
      content: 'x',
      content_hash: hashUtf8('x'),
      status: 'approved',
      ownership: 'standalone',
      template_origin: null,
      source_path: null,
      source_synced_at: null,
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
    };

    const edges: Edge[] = [
      {
        edge_id: 'e1',
        source_type: 'path',
        source_value: 'src/*.ts',
        target_doc_id: 'g2',
        edge_type: 'path_requires',
        priority: 10,
        specificity: 10,
        status: 'approved',
        created_at: '2020-01-01T00:00:00.000Z',
      },
    ];

    const r = collectSemanticStalenessFindings({
      docs: [doc],
      edges,
      projectRoot: root,
      getBaseline: () => null,
      persistLevel3Baselines: true,
    });

    expect(r.findings).toHaveLength(0);
    expect(r.baselineUpserts.some((b) => b.doc_id === 'g2')).toBe(true);
  });
});
