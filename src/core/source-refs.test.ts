import { describe, expect, it } from 'vitest';
import {
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
