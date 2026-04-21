import { describe, expect, it } from 'vitest';
import {
  isFileAnchoredSourceStale,
  listStaleFileAnchoredDocIds,
  SOURCE_SYNC_STALE_WARNING_DAYS,
  sourceSyncStalenessWarningsForDocuments,
} from './source-sync-staleness.js';
import type { Document } from './types.js';

function doc(partial: Partial<Document> & Pick<Document, 'doc_id' | 'title' | 'ownership'>): Document {
  return {
    kind: 'guideline',
    content: 'c',
    content_hash: 'h',
    status: 'approved',
    template_origin: null,
    source_refs_json: null,
    source_synced_at: null,
    created_at: 't',
    updated_at: 't',
    ...partial,
  };
}

describe('source-sync-staleness (ADR-014)', () => {
  const now = new Date('2026-06-01T12:00:00.000Z').getTime();

  it('treats missing source_synced_at as stale for file-anchored docs with path', () => {
    const d = doc({
      doc_id: 'a',
      title: 'A',
      ownership: 'file-anchored',
      source_path: 'x.md',
      source_synced_at: null,
    });
    expect(isFileAnchoredSourceStale(d, 90, now)).toBe(true);
  });

  it('is not stale when within threshold', () => {
    const d = doc({
      doc_id: 'b',
      title: 'B',
      ownership: 'file-anchored',
      source_path: 'x.md',
      source_synced_at: '2026-05-01T12:00:00.000Z',
    });
    expect(isFileAnchoredSourceStale(d, 90, now)).toBe(false);
  });

  it('is stale when older than threshold', () => {
    const d = doc({
      doc_id: 'c',
      title: 'C',
      ownership: 'file-anchored',
      source_path: 'x.md',
      source_synced_at: '2025-01-01T00:00:00.000Z',
    });
    expect(isFileAnchoredSourceStale(d, 90, now)).toBe(true);
  });

  it('treats single file anchor in source_refs_json (no source_path) as ADR-014 path (015-10)', () => {
    const d = doc({
      doc_id: 'json-file',
      title: 'JF',
      ownership: 'file-anchored',
      source_path: null,
      source_refs_json: JSON.stringify([{ asset_path: 'a.md', anchor_type: 'file', anchor_value: '' }]),
      source_synced_at: null,
    });
    expect(isFileAnchoredSourceStale(d, 90, now)).toBe(true);
  });

  it('does not flag single section anchor ref for ADR-014 whole-file staleness', () => {
    const d = doc({
      doc_id: 'sec-only',
      title: 'Sec',
      ownership: 'file-anchored',
      source_path: null,
      source_refs_json: JSON.stringify([{ asset_path: 'a.md', anchor_type: 'section', anchor_value: '## X' }]),
      source_synced_at: null,
    });
    expect(isFileAnchoredSourceStale(d, 90, now)).toBe(false);
  });

  it('ignores multi-source refs for ADR-014 operational staleness (015-10)', () => {
    const d = doc({
      doc_id: 'ms',
      title: 'MS',
      ownership: 'file-anchored',
      source_path: 'a.md',
      source_refs_json: JSON.stringify([
        { asset_path: 'a.md', anchor_type: 'file', anchor_value: '' },
        { asset_path: 'b.md', anchor_type: 'file', anchor_value: '' },
      ]),
      source_synced_at: null,
    });
    expect(isFileAnchoredSourceStale(d, 90, now)).toBe(false);
  });

  it('ignores standalone docs even with source_path', () => {
    const d = doc({
      doc_id: 'd',
      title: 'D',
      ownership: 'standalone',
      source_path: 'x.md',
      source_synced_at: null,
    });
    expect(isFileAnchoredSourceStale(d, 90, now)).toBe(false);
  });

  it('listStaleFileAnchoredDocIds returns sorted doc_ids', () => {
    const docs = [
      doc({
        doc_id: 'z',
        title: 'Z',
        ownership: 'file-anchored',
        source_path: 'a',
        source_synced_at: '2000-01-01T00:00:00.000Z',
      }),
      doc({
        doc_id: 'm',
        title: 'M',
        ownership: 'file-anchored',
        source_path: 'b',
        source_synced_at: '2000-01-01T00:00:00.000Z',
      }),
    ];
    expect(listStaleFileAnchoredDocIds(docs, 90, now)).toEqual(['m', 'z']);
  });

  it('sourceSyncStalenessWarningsForDocuments is sorted by doc_id', () => {
    const docs = [
      doc({
        doc_id: 'b',
        title: 'B',
        ownership: 'file-anchored',
        source_path: 'x',
        source_synced_at: null,
      }),
      doc({
        doc_id: 'a',
        title: 'A',
        ownership: 'file-anchored',
        source_path: 'y',
        source_synced_at: null,
      }),
    ];
    const w = sourceSyncStalenessWarningsForDocuments(docs, SOURCE_SYNC_STALE_WARNING_DAYS, now);
    expect(w).toHaveLength(2);
    expect(w[0]).toContain("'a'");
    expect(w[1]).toContain("'b'");
  });
});
