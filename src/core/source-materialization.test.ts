import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { materializeAnchoredContent } from './source-materialization.js';
import type { SourceRef } from './types.js';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

describe('source-materialization (016-02)', () => {
  let projectRoot: string;

  beforeAll(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'aegis-mat-'));
    mkdirSync(join(projectRoot, 'docs'), { recursive: true });

    // Markdown file with sections
    writeFileSync(
      join(projectRoot, 'docs/guide.md'),
      ['# Guide', '', '## Auth', 'Auth body line 1', 'Auth body line 2', '', '## Database', 'DB body line 1', ''].join(
        '\n',
      ),
    );

    // Plain file for line-range tests
    writeFileSync(join(projectRoot, 'docs/lines.txt'), ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n'));

    // CRLF file
    writeFileSync(join(projectRoot, 'docs/crlf.txt'), 'a\r\nb\r\nc\r\nd\r\n');

    // UTF-8 file
    writeFileSync(
      join(projectRoot, 'docs/utf8.md'),
      ['## 認証', '日本語のコンテンツ', '絵文字テスト 🎉', ''].join('\n'),
    );

    // Markdown with duplicate headings
    writeFileSync(
      join(projectRoot, 'docs/dup-heading.md'),
      ['## Auth', 'First auth section', '', '## Auth', 'Second auth section', ''].join('\n'),
    );

    // File outside project root for traversal test
    writeFileSync(join(projectRoot, '..', 'outside-aegis-test.txt'), 'secret');
  });

  afterAll(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------
  // Section anchor
  // ---------------------------------------------------------------

  describe('section anchor', () => {
    it('returns body for existing ## heading', () => {
      const ref: SourceRef = { asset_path: 'docs/guide.md', anchor_type: 'section', anchor_value: '## Auth' };
      const r = materializeAnchoredContent({ projectRoot, source_path: 'docs/guide.md', source_ref: ref });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.materialization_kind).toBe('markdown-section');
      expect(r.content).toContain('Auth body line 1');
      expect(r.content).toContain('Auth body line 2');
      // heading line itself is NOT in body (splitMarkdownSections contract)
      expect(r.content).not.toContain('## Auth');
      expect(r.content_hash).toBe(sha256(r.content));
    });

    it('returns missing_anchor for non-existent heading', () => {
      const ref: SourceRef = { asset_path: 'docs/guide.md', anchor_type: 'section', anchor_value: '## Missing' };
      const r = materializeAnchoredContent({ projectRoot, source_path: 'docs/guide.md', source_ref: ref });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.kind).toBe('missing_anchor');
    });

    it('returns unsupported_shape for # Title (non-## heading)', () => {
      const ref: SourceRef = { asset_path: 'docs/guide.md', anchor_type: 'section', anchor_value: '# Guide' };
      const r = materializeAnchoredContent({ projectRoot, source_path: 'docs/guide.md', source_ref: ref });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.kind).toBe('unsupported_shape');
    });

    it('returns ambiguous_anchor for duplicate ## headings', () => {
      const ref: SourceRef = { asset_path: 'docs/dup-heading.md', anchor_type: 'section', anchor_value: '## Auth' };
      const r = materializeAnchoredContent({ projectRoot, source_path: 'docs/dup-heading.md', source_ref: ref });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.kind).toBe('ambiguous_anchor');
      expect(r.detail).toContain('2 times');
    });

    it('stable hash for UTF-8 content', () => {
      const ref: SourceRef = { asset_path: 'docs/utf8.md', anchor_type: 'section', anchor_value: '## 認証' };
      const r = materializeAnchoredContent({ projectRoot, source_path: 'docs/utf8.md', source_ref: ref });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.content).toContain('日本語のコンテンツ');
      expect(r.content_hash).toBe(sha256(r.content));
      // Hash is deterministic across calls
      const r2 = materializeAnchoredContent({ projectRoot, source_path: 'docs/utf8.md', source_ref: ref });
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.content_hash).toBe(r.content_hash);
    });
  });

  // ---------------------------------------------------------------
  // Lines anchor
  // ---------------------------------------------------------------

  describe('lines anchor', () => {
    it('returns correct lines for valid range (1-based inclusive)', () => {
      const ref: SourceRef = { asset_path: 'docs/lines.txt', anchor_type: 'lines', anchor_value: '1-3' };
      const r = materializeAnchoredContent({ projectRoot, source_path: 'docs/lines.txt', source_ref: ref });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.materialization_kind).toBe('line-range');
      expect(r.content).toBe('line1\nline2\nline3');
      expect(r.content_hash).toBe(sha256(r.content));
    });

    it('returns invalid_range for reversed range (3-1)', () => {
      const ref: SourceRef = { asset_path: 'docs/lines.txt', anchor_type: 'lines', anchor_value: '3-1' };
      const r = materializeAnchoredContent({ projectRoot, source_path: 'docs/lines.txt', source_ref: ref });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.kind).toBe('invalid_range');
    });

    it('returns invalid_range for zero-based start (0-2)', () => {
      const ref: SourceRef = { asset_path: 'docs/lines.txt', anchor_type: 'lines', anchor_value: '0-2' };
      const r = materializeAnchoredContent({ projectRoot, source_path: 'docs/lines.txt', source_ref: ref });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.kind).toBe('invalid_range');
    });

    it('returns invalid_range for non-numeric value (abc)', () => {
      const ref: SourceRef = { asset_path: 'docs/lines.txt', anchor_type: 'lines', anchor_value: 'abc' };
      const r = materializeAnchoredContent({ projectRoot, source_path: 'docs/lines.txt', source_ref: ref });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.kind).toBe('invalid_range');
    });

    it('returns invalid_range when end exceeds file length', () => {
      const ref: SourceRef = { asset_path: 'docs/lines.txt', anchor_type: 'lines', anchor_value: '1-999' };
      const r = materializeAnchoredContent({ projectRoot, source_path: 'docs/lines.txt', source_ref: ref });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.kind).toBe('invalid_range');
    });

    it('normalizes CRLF to LF before slicing', () => {
      const ref: SourceRef = { asset_path: 'docs/crlf.txt', anchor_type: 'lines', anchor_value: '1-2' };
      const r = materializeAnchoredContent({ projectRoot, source_path: 'docs/crlf.txt', source_ref: ref });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.content).toBe('a\nb');
      expect(r.content).not.toContain('\r');
    });
  });

  // ---------------------------------------------------------------
  // Unsupported shapes
  // ---------------------------------------------------------------

  describe('unsupported shapes', () => {
    it('returns unsupported_shape for anchor_type "file"', () => {
      const ref: SourceRef = { asset_path: 'docs/guide.md', anchor_type: 'file', anchor_value: '' };
      const r = materializeAnchoredContent({ projectRoot, source_path: 'docs/guide.md', source_ref: ref });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.kind).toBe('unsupported_shape');
    });
  });

  // ---------------------------------------------------------------
  // Unreadable source
  // ---------------------------------------------------------------

  describe('unreadable source', () => {
    it('returns unreadable_source for missing file', () => {
      const ref: SourceRef = { asset_path: 'no/such/file.md', anchor_type: 'section', anchor_value: '## X' };
      const r = materializeAnchoredContent({ projectRoot, source_path: 'no/such/file.md', source_ref: ref });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.kind).toBe('unreadable_source');
    });

    it('returns unreadable_source for path traversal outside project root', () => {
      const ref: SourceRef = { asset_path: '../outside-aegis-test.txt', anchor_type: 'lines', anchor_value: '1-1' };
      const r = materializeAnchoredContent({ projectRoot, source_path: '../outside-aegis-test.txt', source_ref: ref });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.kind).toBe('unreadable_source');
      expect(r.detail).toContain('escapes project root');
    });
  });
});
