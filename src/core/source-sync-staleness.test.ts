import { describe, expect, it } from 'vitest';
import {
  isFileAnchoredSourceStale,
  listStaleFileAnchoredDocIds,
  SOURCE_SYNC_STALE_WARNING_DAYS,
  sourceSyncStalenessWarningsForDocuments,
} from './source-sync-staleness.js';
import type { Document } from './types.js';

function doc(partial: Partial<Document> & Pick<Document, 'doc_id' | 'title' | 'ownership' | 'source_path'>): Document {
  return {
    kind: 'guideline',
    content: 'c',
    content_hash: 'h',
    status: 'approved',
    template_origin: null,
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
