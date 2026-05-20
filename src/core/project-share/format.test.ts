import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shareFormat } from './format.js';

let sourceDir: string;

beforeEach(() => {
  sourceDir = mkdtempSync(join(tmpdir(), 'aegis-format-'));
});

afterEach(() => {
  rmSync(sourceDir, { recursive: true, force: true });
});

// -- Helpers ----------------------------------------------------------

function writeDoc(docId: string, content: string): void {
  mkdirSync(join(sourceDir, 'documents'), { recursive: true });
  writeFileSync(join(sourceDir, 'documents', `${docId}.md`), content);
}

function readDoc(docId: string): string {
  return readFileSync(join(sourceDir, 'documents', `${docId}.md`), 'utf-8');
}

function writeEdgeFile(filename: string, content: string): void {
  mkdirSync(join(sourceDir, 'edges'), { recursive: true });
  writeFileSync(join(sourceDir, 'edges', filename), content);
}

function readEdgeFile(filename: string): string {
  return readFileSync(join(sourceDir, 'edges', filename), 'utf-8');
}

function writeLayerRules(content: string): void {
  writeFileSync(join(sourceDir, 'layer-rules.json'), content);
}

function readLayerRules(): string {
  return readFileSync(join(sourceDir, 'layer-rules.json'), 'utf-8');
}

function writeTagMappings(content: string): void {
  writeFileSync(join(sourceDir, 'tag-mappings.json'), content);
}

function readTagMappings(): string {
  return readFileSync(join(sourceDir, 'tag-mappings.json'), 'utf-8');
}

// -- Tests ------------------------------------------------------------

describe('shareFormat', () => {
  it('throws on non-existent source directory', () => {
    expect(() => shareFormat('/tmp/non-existent-dir-xxx')).toThrow('does not exist');
  });

  describe('documents', () => {
    it('normalizes frontmatter key order', () => {
      // Write with scrambled key order
      writeDoc(
        'my-doc',
        '---\nownership: standalone\ntitle: My Doc\nkind: guideline\ndoc_id: my-doc\n---\nBody text.\n',
      );

      const result = shareFormat(sourceDir);
      expect(result.files_changed).toBe(1);

      const formatted = readDoc('my-doc');
      // Keys should be in canonical order: doc_id, title, kind, ownership
      const lines = formatted.split('\n');
      const keyLines = lines.slice(1, 5); // After first ---
      expect(keyLines[0]).toMatch(/^doc_id:/);
      expect(keyLines[1]).toMatch(/^title:/);
      expect(keyLines[2]).toMatch(/^kind:/);
      expect(keyLines[3]).toMatch(/^ownership:/);
    });

    it('strips null-valued optional fields', () => {
      writeDoc(
        'my-doc',
        '---\ndoc_id: my-doc\ntitle: My Doc\nkind: guideline\nownership: standalone\nsource_path: null\ntemplate_origin: null\n---\nBody.\n',
      );

      shareFormat(sourceDir);
      const formatted = readDoc('my-doc');
      expect(formatted).not.toContain('source_path');
      expect(formatted).not.toContain('template_origin');
    });

    it('preserves non-null optional fields', () => {
      writeDoc(
        'my-doc',
        '---\ndoc_id: my-doc\ntitle: My Doc\nkind: guideline\nownership: file-anchored\nsource_path: docs/guide.md\n---\nBody.\n',
      );

      shareFormat(sourceDir);
      const formatted = readDoc('my-doc');
      expect(formatted).toContain('source_path: docs/guide.md');
    });

    it('normalizes source_refs_json: sorts refs and fixes key order', () => {
      // Refs in reverse order with scrambled keys
      const refs = JSON.stringify([
        { anchor_value: '', anchor_type: 'file', asset_path: 'z.ts' },
        { anchor_value: '', anchor_type: 'file', asset_path: 'a.ts' },
      ]);
      writeDoc(
        'my-doc',
        `---\ndoc_id: my-doc\ntitle: T\nkind: guideline\nownership: file-anchored\nsource_refs_json: '${refs}'\n---\nBody.\n`,
      );

      shareFormat(sourceDir);
      const formatted = readDoc('my-doc');
      // Should be sorted by asset_path ASC with canonical key order
      const expected = JSON.stringify([
        { asset_path: 'a.ts', anchor_type: 'file', anchor_value: '' },
        { asset_path: 'z.ts', anchor_type: 'file', anchor_value: '' },
      ]);
      expect(formatted).toContain(`source_refs_json: '${expected}'`);
    });

    it('normalizes source_refs_json: same output regardless of input form', () => {
      // JSON string form
      const refs = JSON.stringify([{ asset_path: 'a.ts', anchor_type: 'file', anchor_value: '' }]);
      writeDoc(
        'my-doc',
        `---\ndoc_id: my-doc\ntitle: T\nkind: guideline\nownership: file-anchored\nsource_refs_json: '${refs}'\n---\nBody.\n`,
      );

      shareFormat(sourceDir);
      const formatted = readDoc('my-doc');
      expect(formatted).toContain(`source_refs_json: '${refs}'`);
    });

    it('does not normalize source_refs_json with non-object elements (no silent data loss)', () => {
      const mixed = '[{"asset_path":"a.ts","anchor_type":"file","anchor_value":""},42]';
      writeDoc(
        'my-doc',
        `---\ndoc_id: my-doc\ntitle: T\nkind: guideline\nownership: file-anchored\nsource_refs_json: '${mixed}'\n---\nBody.\n`,
      );

      shareFormat(sourceDir);
      const formatted = readDoc('my-doc');
      // The non-object element should NOT be silently dropped
      expect(formatted).toContain('42');
    });

    it('preserves body content', () => {
      const body = '# Heading\n\nParagraph with **bold** and `code`.\n\n- item 1\n- item 2\n';
      writeDoc('my-doc', `---\ndoc_id: my-doc\ntitle: T\nkind: guideline\nownership: standalone\n---\n${body}`);

      shareFormat(sourceDir);
      const formatted = readDoc('my-doc');
      expect(formatted).toContain(body);
    });

    it('normalizes \\r\\n to \\n', () => {
      writeDoc(
        'my-doc',
        '---\r\ndoc_id: my-doc\r\ntitle: T\r\nkind: guideline\r\nownership: standalone\r\n---\r\nBody.\r\n',
      );

      shareFormat(sourceDir);
      const formatted = readDoc('my-doc');
      expect(formatted).not.toContain('\r');
    });

    it('ensures trailing newline', () => {
      writeDoc('my-doc', '---\ndoc_id: my-doc\ntitle: T\nkind: guideline\nownership: standalone\n---\nBody.');

      shareFormat(sourceDir);
      const formatted = readDoc('my-doc');
      expect(formatted.endsWith('\n')).toBe(true);
      expect(formatted.endsWith('\n\n')).toBe(false);
    });

    it('skips unparseable documents with warning', () => {
      writeDoc('bad-doc', 'no frontmatter here');

      const result = shareFormat(sourceDir);
      expect(result.files_changed).toBe(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('bad-doc');
    });

    it('handles frontmatter-only document (no body, no trailing newline after ---)', () => {
      writeDoc('fm-only', '---\ndoc_id: fm-only\ntitle: T\nkind: guideline\nownership: standalone\n---');

      const result = shareFormat(sourceDir);
      // Should not be skipped — parser accepts this form
      expect(result.warnings).toHaveLength(0);
      const formatted = readDoc('fm-only');
      expect(formatted).toContain('doc_id: fm-only');
      expect(formatted.endsWith('\n')).toBe(true);
    });

    it('skips broken symlink with warning instead of crashing', () => {
      mkdirSync(join(sourceDir, 'documents'), { recursive: true });
      symlinkSync('/tmp/nonexistent-target-' + Date.now(), join(sourceDir, 'documents', 'broken.md'));

      const result = shareFormat(sourceDir);
      expect(result.files_changed).toBe(0);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some((w) => w.includes('broken.md'))).toBe(true);
    });
  });

  describe('edges', () => {
    it('sorts by edge_id ASC and normalizes key order', () => {
      writeEdgeFile(
        'path-requires.json',
        JSON.stringify(
          [
            { specificity: 10, edge_id: 'e-z', source_value: 'z/**', target_doc_id: 'doc-z', priority: 1 },
            { specificity: 5, edge_id: 'e-a', source_value: 'a/**', target_doc_id: 'doc-a', priority: 2 },
          ],
          null,
          2,
        ),
      );

      const result = shareFormat(sourceDir);
      expect(result.files_changed).toBe(1);

      const formatted = JSON.parse(readEdgeFile('path-requires.json'));
      expect(formatted[0].edge_id).toBe('e-a');
      expect(formatted[1].edge_id).toBe('e-z');

      // Key order should be: edge_id, source_value, target_doc_id, priority, specificity
      const keys = Object.keys(formatted[0]);
      expect(keys).toEqual(['edge_id', 'source_value', 'target_doc_id', 'priority', 'specificity']);
    });

    it('preserves edge_type in canonical key position (lint detects mismatches)', () => {
      writeEdgeFile(
        'path-requires.json',
        JSON.stringify(
          [
            {
              edge_type: 'path_requires',
              specificity: 0,
              edge_id: 'e1',
              source_value: 'src/**',
              target_doc_id: 'doc-a',
              priority: 1,
            },
          ],
          null,
          2,
        ),
      );

      shareFormat(sourceDir);
      const formatted = JSON.parse(readEdgeFile('path-requires.json'));
      // edge_type should be preserved (not stripped) but placed after canonical keys
      expect(formatted[0].edge_type).toBe('path_requires');
      const keys = Object.keys(formatted[0]);
      expect(keys).toEqual(['edge_id', 'source_value', 'target_doc_id', 'priority', 'specificity', 'edge_type']);
    });

    it('ensures trailing newline on edge files', () => {
      writeEdgeFile(
        'path-requires.json',
        JSON.stringify([{ edge_id: 'e1', source_value: 's', target_doc_id: 'd', priority: 1, specificity: 0 }]),
      );

      shareFormat(sourceDir);
      const raw = readEdgeFile('path-requires.json');
      expect(raw.endsWith('\n')).toBe(true);
    });

    it('skips file with non-object array elements instead of silently dropping them', () => {
      const mixed = JSON.stringify([
        { edge_id: 'e1', source_value: 's', target_doc_id: 'd', priority: 1, specificity: 0 },
        42,
      ]);
      writeEdgeFile('path-requires.json', mixed);

      const result = shareFormat(sourceDir);
      expect(result.files_changed).toBe(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('path-requires.json');
      // File should be untouched
      expect(readEdgeFile('path-requires.json')).toBe(mixed);
    });
  });

  describe('layer-rules.json', () => {
    it('sorts by rule_id ASC and normalizes key order', () => {
      writeLayerRules(
        JSON.stringify(
          [
            { layer_name: 'infra', rule_id: 'r-z', path_pattern: 'infra/**', priority: 1, specificity: 5 },
            { layer_name: 'core', rule_id: 'r-a', path_pattern: 'core/**', priority: 2, specificity: 10 },
          ],
          null,
          2,
        ),
      );

      shareFormat(sourceDir);
      const formatted = JSON.parse(readLayerRules());
      expect(formatted[0].rule_id).toBe('r-a');
      expect(formatted[1].rule_id).toBe('r-z');

      const keys = Object.keys(formatted[0]);
      expect(keys).toEqual(['rule_id', 'path_pattern', 'layer_name', 'priority', 'specificity']);
    });
  });

  describe('tag-mappings.json', () => {
    it('sorts by tag ASC then doc_id ASC and normalizes key order', () => {
      writeTagMappings(
        JSON.stringify(
          [
            { doc_id: 'doc-b', tag: 'z-tag', confidence: 0.8, source: 'slm' },
            { doc_id: 'doc-a', tag: 'a-tag', confidence: 0.9, source: 'manual' },
            { doc_id: 'doc-b', tag: 'a-tag', confidence: 0.7, source: 'slm' },
          ],
          null,
          2,
        ),
      );

      shareFormat(sourceDir);
      const formatted = JSON.parse(readTagMappings());
      const pairs = formatted.map((tm: { tag: string; doc_id: string }) => `${tm.tag}:${tm.doc_id}`);
      expect(pairs).toEqual(['a-tag:doc-a', 'a-tag:doc-b', 'z-tag:doc-b']);

      const keys = Object.keys(formatted[0]);
      expect(keys).toEqual(['tag', 'doc_id', 'confidence', 'source']);
    });
  });

  describe('idempotency', () => {
    it('second run is no-op (0 files changed)', () => {
      writeDoc('my-doc', '---\nownership: standalone\ntitle: T\nkind: guideline\ndoc_id: my-doc\n---\nBody.\n');
      writeEdgeFile(
        'path-requires.json',
        JSON.stringify(
          [
            { specificity: 0, edge_id: 'e-b', source_value: 'b/**', target_doc_id: 'doc-b', priority: 2 },
            { specificity: 0, edge_id: 'e-a', source_value: 'a/**', target_doc_id: 'doc-a', priority: 1 },
          ],
          null,
          2,
        ),
      );
      writeLayerRules(
        JSON.stringify([{ layer_name: 'core', rule_id: 'r1', path_pattern: '**', priority: 1, specificity: 0 }]),
      );
      writeTagMappings(JSON.stringify([{ source: 'manual', doc_id: 'doc-a', tag: 'my-tag', confidence: 0.9 }]));

      // First run — should change files
      const run1 = shareFormat(sourceDir);
      expect(run1.files_changed).toBeGreaterThan(0);

      // Capture state after first run
      const doc1 = readDoc('my-doc');
      const edges1 = readEdgeFile('path-requires.json');
      const rules1 = readLayerRules();
      const tags1 = readTagMappings();

      // Second run — should be no-op
      const run2 = shareFormat(sourceDir);
      expect(run2.files_changed).toBe(0);
      expect(run2.files_unchanged).toBeGreaterThan(0);

      // Content should be byte-identical
      expect(readDoc('my-doc')).toBe(doc1);
      expect(readEdgeFile('path-requires.json')).toBe(edges1);
      expect(readLayerRules()).toBe(rules1);
      expect(readTagMappings()).toBe(tags1);
    });
  });

  describe('empty / missing directories', () => {
    it('handles empty source directory', () => {
      const result = shareFormat(sourceDir);
      expect(result.files_changed).toBe(0);
      expect(result.files_unchanged).toBe(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('handles source with only documents/', () => {
      writeDoc('my-doc', '---\ndoc_id: my-doc\ntitle: T\nkind: guideline\nownership: standalone\n---\nBody.\n');

      const result = shareFormat(sourceDir);
      // Already normalized — should be unchanged
      expect(result.files_unchanged).toBe(1);
    });
  });
});
