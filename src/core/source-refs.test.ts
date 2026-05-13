import { describe, expect, it } from 'vitest';
import {
  classifyReconcileMode,
  normalizeStoredSourceRefsPayloadStrict,
  parseSourceRefsJson,
  primaryAssetPathForHashSync,
  serializeSourceRefs,
  sourceRefCountFromDocument,
  validateSourceRef,
} from './source-refs.js';
import type { Document } from './types.js';

describe('source-refs (015-10)', () => {
  it('parses valid JSON rows', () => {
    const j = JSON.stringify([
      { asset_path: 'docs/a.md', anchor_type: 'file', anchor_value: '' },
      { asset_path: 'src/x.ts', anchor_type: 'lines', anchor_value: '1-9' },
    ]);
    expect(parseSourceRefsJson(j)).toHaveLength(2);
  });

  it('serializeSourceRefs is deterministic across key order', () => {
    const a = serializeSourceRefs([
      { asset_path: 'z.md', anchor_type: 'file', anchor_value: '' },
      { asset_path: 'a.md', anchor_type: 'file', anchor_value: '' },
    ]);
    const b = serializeSourceRefs([
      { asset_path: 'a.md', anchor_type: 'file', anchor_value: '' },
      { asset_path: 'z.md', anchor_type: 'file', anchor_value: '' },
    ]);
    expect(a).toBe(b);
    expect(JSON.parse(a) as unknown[]).toHaveLength(2);
  });

  it('primaryAssetPathForHashSync returns null when legacy source_path and ref name two distinct assets', () => {
    const d = {
      source_path: 'legacy.md',
      source_refs_json: JSON.stringify([{ asset_path: 'only.md', anchor_type: 'file', anchor_value: '' }]),
    } as Pick<Document, 'source_path' | 'source_refs_json'>;
    expect(primaryAssetPathForHashSync(d)).toBeNull();
    expect(sourceRefCountFromDocument(d)).toBe(2);
  });

  it('primaryAssetPathForHashSync dedupes legacy path matching the sole file ref', () => {
    const d = {
      source_path: 'same.md',
      source_refs_json: JSON.stringify([{ asset_path: 'same.md', anchor_type: 'file', anchor_value: '' }]),
    } as Pick<Document, 'source_path' | 'source_refs_json'>;
    expect(sourceRefCountFromDocument(d)).toBe(1);
    expect(primaryAssetPathForHashSync(d)).toBe('same.md');
  });

  it('primaryAssetPathForHashSync returns null for single non-file anchor (no whole-file hash sync)', () => {
    const d = {
      source_path: null,
      source_refs_json: JSON.stringify([{ asset_path: 'docs/a.md', anchor_type: 'section', anchor_value: '## Auth' }]),
    } as Pick<Document, 'source_path' | 'source_refs_json'>;
    expect(primaryAssetPathForHashSync(d)).toBeNull();
  });

  it('primaryAssetPathForHashSync uses legacy source_path when it matches sole asset with slice refs', () => {
    const d = {
      source_path: 'guide.md',
      source_refs_json: JSON.stringify([
        { asset_path: 'guide.md', anchor_type: 'section', anchor_value: '## A' },
        { asset_path: 'guide.md', anchor_type: 'lines', anchor_value: '1-2' },
      ]),
    } as Pick<Document, 'source_path' | 'source_refs_json'>;
    expect(sourceRefCountFromDocument(d)).toBe(1);
    expect(primaryAssetPathForHashSync(d)).toBe('guide.md');
  });

  it('primaryAssetPathForHashSync returns sole asset when file + section refs share one asset (no legacy)', () => {
    const d = {
      source_path: null,
      source_refs_json: JSON.stringify([
        { asset_path: 'doc.md', anchor_type: 'file', anchor_value: '' },
        { asset_path: 'doc.md', anchor_type: 'section', anchor_value: '## Auth' },
      ]),
    } as Pick<Document, 'source_path' | 'source_refs_json'>;
    expect(sourceRefCountFromDocument(d)).toBe(1);
    expect(primaryAssetPathForHashSync(d)).toBe('doc.md');
  });

  it('primaryAssetPathForHashSync returns sole asset when file + lines refs share one asset (no legacy)', () => {
    const d = {
      source_path: null,
      source_refs_json: JSON.stringify([
        { asset_path: 'x.ts', anchor_type: 'file', anchor_value: '' },
        { asset_path: 'x.ts', anchor_type: 'lines', anchor_value: '1-9' },
      ]),
    } as Pick<Document, 'source_path' | 'source_refs_json'>;
    expect(sourceRefCountFromDocument(d)).toBe(1);
    expect(primaryAssetPathForHashSync(d)).toBe('x.ts');
  });

  it('sourceRefCountFromDocument counts refs or falls back to source_path', () => {
    expect(
      sourceRefCountFromDocument({
        source_path: 'a.md',
        source_refs_json: null,
      } as Pick<Document, 'source_path' | 'source_refs_json'>),
    ).toBe(1);
    expect(
      sourceRefCountFromDocument({
        source_path: null,
        source_refs_json: JSON.stringify([
          { asset_path: 'a.md', anchor_type: 'file', anchor_value: '' },
          { asset_path: 'b.md', anchor_type: 'file', anchor_value: '' },
        ]),
      } as Pick<Document, 'source_path' | 'source_refs_json'>),
    ).toBe(2);
    expect(
      sourceRefCountFromDocument({
        source_path: 'primary.md',
        source_refs_json: JSON.stringify([{ asset_path: 'secondary.md', anchor_type: 'file', anchor_value: '' }]),
      } as Pick<Document, 'source_path' | 'source_refs_json'>),
    ).toBe(2);
    expect(
      sourceRefCountFromDocument({
        source_path: null,
        source_refs_json: JSON.stringify([
          { asset_path: 'a.md', anchor_type: 'section', anchor_value: '## H' },
          { asset_path: 'a.md', anchor_type: 'lines', anchor_value: '1-5' },
        ]),
      } as Pick<Document, 'source_path' | 'source_refs_json'>),
    ).toBe(1);
  });

  it('validateSourceRef rejects bad anchor types', () => {
    expect(() => validateSourceRef({ asset_path: 'x', anchor_type: 'nope', anchor_value: '' })).toThrow(/anchor_type/);
  });

  it('normalizeStoredSourceRefsPayloadStrict rejects malformed JSON', () => {
    expect(() => normalizeStoredSourceRefsPayloadStrict('{not json', '/tmp')).toThrow(/invalid JSON/);
  });

  it('validateSourceRef requires anchor_value for section/lines', () => {
    expect(() => validateSourceRef({ asset_path: 'x', anchor_type: 'section', anchor_value: '' })).toThrow(
      /anchor_value/,
    );
    expect(() => validateSourceRef({ asset_path: 'x', anchor_type: 'lines', anchor_value: '  ' })).toThrow(
      /anchor_value/,
    );
  });
});

describe('classifyReconcileMode (ADR-016)', () => {
  const doc = (overrides: Partial<Document>): Pick<Document, 'ownership' | 'source_path' | 'source_refs_json'> => ({
    ownership: 'file-anchored',
    source_path: null,
    source_refs_json: null,
    ...overrides,
  });

  it('returns untracked for standalone ownership', () => {
    expect(classifyReconcileMode(doc({ ownership: 'standalone' }))).toBe('untracked');
  });

  it('returns untracked for derived ownership', () => {
    expect(classifyReconcileMode(doc({ ownership: 'derived' }))).toBe('untracked');
  });

  it('returns hash-sync for single file anchor via source_path', () => {
    expect(classifyReconcileMode(doc({ source_path: 'docs/a.md' }))).toBe('hash-sync');
  });

  it('returns hash-sync for single file anchor via source_refs_json', () => {
    const refs = JSON.stringify([{ asset_path: 'docs/a.md', anchor_type: 'file', anchor_value: '' }]);
    expect(classifyReconcileMode(doc({ source_refs_json: refs }))).toBe('hash-sync');
  });

  it('returns hash-sync for source_path + file anchor on same asset', () => {
    const refs = JSON.stringify([{ asset_path: 'docs/a.md', anchor_type: 'file', anchor_value: '' }]);
    expect(classifyReconcileMode(doc({ source_path: 'docs/a.md', source_refs_json: refs }))).toBe('hash-sync');
  });

  it('returns anchor-sync for single section anchor', () => {
    const refs = JSON.stringify([{ asset_path: 'docs/a.md', anchor_type: 'section', anchor_value: '## Heading' }]);
    expect(classifyReconcileMode(doc({ source_refs_json: refs }))).toBe('anchor-sync');
  });

  it('returns anchor-sync for single lines anchor', () => {
    const refs = JSON.stringify([{ asset_path: 'docs/a.md', anchor_type: 'lines', anchor_value: '1-10' }]);
    expect(classifyReconcileMode(doc({ source_refs_json: refs }))).toBe('anchor-sync');
  });

  it('returns semantic-review for multi-source docs (2 distinct assets)', () => {
    const refs = JSON.stringify([
      { asset_path: 'docs/a.md', anchor_type: 'file', anchor_value: '' },
      { asset_path: 'docs/b.md', anchor_type: 'file', anchor_value: '' },
    ]);
    expect(classifyReconcileMode(doc({ source_refs_json: refs }))).toBe('semantic-review');
  });

  it('returns semantic-review for multiple slice anchors on same asset (no file anchor)', () => {
    const refs = JSON.stringify([
      { asset_path: 'docs/a.md', anchor_type: 'section', anchor_value: '## A' },
      { asset_path: 'docs/a.md', anchor_type: 'section', anchor_value: '## B' },
    ]);
    expect(classifyReconcileMode(doc({ source_refs_json: refs }))).toBe('semantic-review');
  });

  it('returns hash-sync when file + section coexist on same asset with source_path', () => {
    const refs = JSON.stringify([
      { asset_path: 'docs/a.md', anchor_type: 'file', anchor_value: '' },
      { asset_path: 'docs/a.md', anchor_type: 'section', anchor_value: '## X' },
    ]);
    expect(classifyReconcileMode(doc({ source_path: 'docs/a.md', source_refs_json: refs }))).toBe('hash-sync');
  });

  it('returns semantic-review for file-anchored doc with no refs and no source_path', () => {
    expect(classifyReconcileMode(doc({}))).toBe('semantic-review');
  });

  it('returns semantic-review when source_refs_json contains invalid rows alongside valid section ref', () => {
    // One valid section + one invalid row → parseSourceRefsJson drops the bogus row,
    // but classifyReconcileMode detects the drop and falls back to semantic-review.
    const refs = JSON.stringify([
      { asset_path: 'docs/a.md', anchor_type: 'section', anchor_value: '## A' },
      { asset_path: 'docs/b.md', anchor_type: 'bogus', anchor_value: 'x' },
    ]);
    expect(classifyReconcileMode(doc({ source_refs_json: refs }))).toBe('semantic-review');
  });
});
