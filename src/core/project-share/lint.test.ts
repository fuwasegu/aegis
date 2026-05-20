import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lintParseResult, shareLint } from './lint.js';
import type { SharedSourceParseResult } from './source-types.js';

let sourceDir: string;

beforeEach(() => {
  sourceDir = mkdtempSync(join(tmpdir(), 'aegis-lint-'));
});

afterEach(() => {
  rmSync(sourceDir, { recursive: true, force: true });
});

// -- Helpers ----------------------------------------------------------

function writeDoc(docId: string, frontmatter: Record<string, string | null>, body: string): void {
  mkdirSync(join(sourceDir, 'documents'), { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v === null ? 'null' : v}`)
    .join('\n');
  writeFileSync(join(sourceDir, 'documents', `${docId}.md`), `---\n${fm}\n---\n${body}`);
}

function writeEdgeFile(filename: string, edges: unknown[]): void {
  mkdirSync(join(sourceDir, 'edges'), { recursive: true });
  writeFileSync(join(sourceDir, 'edges', filename), JSON.stringify(edges, null, 2));
}

function writeLayerRules(rules: unknown[]): void {
  writeFileSync(join(sourceDir, 'layer-rules.json'), JSON.stringify(rules, null, 2));
}

function writeTagMappings(mappings: unknown[]): void {
  writeFileSync(join(sourceDir, 'tag-mappings.json'), JSON.stringify(mappings, null, 2));
}

// -- Tests ------------------------------------------------------------

describe('shareLint', () => {
  describe('valid source tree', () => {
    it('returns ok=true with counts for a valid tree', () => {
      writeDoc(
        'arch-guide',
        {
          doc_id: 'arch-guide',
          title: 'Architecture Guide',
          kind: 'guideline',
          ownership: 'standalone',
        },
        'Body content here.',
      );

      writeEdgeFile('path-requires.json', [
        { edge_id: 'e1', source_value: 'src/**', target_doc_id: 'arch-guide', priority: 1, specificity: 1 },
      ]);

      writeLayerRules([{ rule_id: 'r1', path_pattern: 'src/**', layer_name: 'core', priority: 1, specificity: 1 }]);

      writeTagMappings([{ tag: 'architecture', doc_id: 'arch-guide', confidence: 0.9, source: 'manual' }]);

      const result = shareLint(sourceDir);
      expect(result.ok).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.counts).toEqual({
        documents: 1,
        edges: 1,
        layer_rules: 1,
        tag_mappings: 1,
      });
    });

    it('returns ok=true for empty source directory', () => {
      // Just an empty directory — no documents, edges, etc.
      const result = shareLint(sourceDir);
      expect(result.ok).toBe(true);
      expect(result.counts.documents).toBe(0);
    });
  });

  describe('parse errors', () => {
    it('reports malformed Markdown', () => {
      mkdirSync(join(sourceDir, 'documents'), { recursive: true });
      writeFileSync(join(sourceDir, 'documents', 'bad.md'), 'no frontmatter here');

      const result = shareLint(sourceDir);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.message.includes('frontmatter'))).toBe(true);
    });

    it('reports malformed JSON in edges', () => {
      mkdirSync(join(sourceDir, 'edges'), { recursive: true });
      writeFileSync(join(sourceDir, 'edges', 'path-requires.json'), '{ broken json');

      const result = shareLint(sourceDir);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.message.includes('malformed JSON'))).toBe(true);
    });

    it('reports required field missing in document', () => {
      writeDoc(
        'incomplete',
        {
          doc_id: 'incomplete',
          title: 'Test',
          kind: 'guideline',
          ownership: '', // invalid — empty
        },
        'Body',
      );

      const result = shareLint(sourceDir);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.location.includes('ownership'))).toBe(true);
    });
  });

  describe('duplicate IDs', () => {
    it('detects duplicate doc_id via lintParseResult', () => {
      // FS enforces filename==doc_id so shareLint can't produce dups from disk.
      // Test the lint logic directly with a synthetic parse result.
      const parsed: SharedSourceParseResult = {
        documents: [
          {
            doc_id: 'dup',
            title: 'First',
            kind: 'guideline',
            ownership: 'standalone',
            source_path: null,
            source_refs_json: null,
            template_origin: null,
            content: 'A',
          },
          {
            doc_id: 'dup',
            title: 'Second',
            kind: 'guideline',
            ownership: 'standalone',
            source_path: null,
            source_refs_json: null,
            template_origin: null,
            content: 'B',
          },
        ],
        edges: [],
        layer_rules: [],
        tag_mappings: [],
        errors: [],
      };

      const result = lintParseResult(parsed);
      expect(result.ok).toBe(false);
      const dupErrors = result.errors.filter((e) => e.message.includes('duplicate doc_id'));
      expect(dupErrors).toHaveLength(1);
      expect(dupErrors[0].message).toContain('dup');
    });

    it('detects duplicate doc_id across files with different filenames', () => {
      // alias.md has doc_id: real → filename mismatch AND duplicate doc_id
      writeDoc(
        'real',
        {
          doc_id: 'real',
          title: 'Real',
          kind: 'guideline',
          ownership: 'standalone',
        },
        'First',
      );

      // Manually write alias.md with doc_id: real (filename mismatch)
      mkdirSync(join(sourceDir, 'documents'), { recursive: true });
      writeFileSync(
        join(sourceDir, 'documents', 'alias.md'),
        '---\ndoc_id: real\ntitle: Alias\nkind: guideline\nownership: standalone\n---\nSecond',
      );

      const result = shareLint(sourceDir);
      expect(result.ok).toBe(false);
      const dupErrors = result.errors.filter((e) => e.message.includes('duplicate doc_id'));
      expect(dupErrors).toHaveLength(1);
      expect(dupErrors[0].message).toContain('real');
    });

    it('detects duplicate edge_id across files', () => {
      writeDoc(
        'target',
        {
          doc_id: 'target',
          title: 'Target',
          kind: 'guideline',
          ownership: 'standalone',
        },
        'Target doc',
      );

      writeEdgeFile('path-requires.json', [
        { edge_id: 'dup-edge', source_value: 'src/**', target_doc_id: 'target', priority: 1, specificity: 1 },
      ]);
      writeEdgeFile('layer-requires.json', [
        { edge_id: 'dup-edge', source_value: 'core', target_doc_id: 'target', priority: 1, specificity: 1 },
      ]);

      const result = shareLint(sourceDir);
      expect(result.ok).toBe(false);
      const dupErrors = result.errors.filter((e) => e.message.includes('duplicate edge_id'));
      expect(dupErrors).toHaveLength(1);
      expect(dupErrors[0].message).toContain('dup-edge');
    });

    it('detects duplicate rule_id', () => {
      writeLayerRules([
        { rule_id: 'dup-rule', path_pattern: 'a/**', layer_name: 'core', priority: 1, specificity: 1 },
        { rule_id: 'dup-rule', path_pattern: 'b/**', layer_name: 'infra', priority: 2, specificity: 2 },
      ]);

      const result = shareLint(sourceDir);
      expect(result.ok).toBe(false);
      const dupErrors = result.errors.filter((e) => e.message.includes('duplicate rule_id'));
      expect(dupErrors).toHaveLength(1);
      expect(dupErrors[0].message).toContain('dup-rule');
    });
  });

  describe('dangling references', () => {
    it('detects edge referencing non-existent document', () => {
      writeDoc(
        'real-doc',
        {
          doc_id: 'real-doc',
          title: 'Real',
          kind: 'guideline',
          ownership: 'standalone',
        },
        'Content',
      );

      writeEdgeFile('path-requires.json', [
        { edge_id: 'e1', source_value: 'src/**', target_doc_id: 'real-doc', priority: 1, specificity: 1 },
        { edge_id: 'e2', source_value: 'lib/**', target_doc_id: 'ghost-doc', priority: 1, specificity: 1 },
      ]);

      const result = shareLint(sourceDir);
      expect(result.ok).toBe(false);
      const danglingErrors = result.errors.filter((e) => e.message.includes('non-existent document'));
      expect(danglingErrors).toHaveLength(1);
      expect(danglingErrors[0].message).toContain('ghost-doc');
      expect(danglingErrors[0].message).toContain('e2');
    });

    it('detects tag_mapping referencing non-existent document', () => {
      writeDoc(
        'known-doc',
        {
          doc_id: 'known-doc',
          title: 'Known',
          kind: 'guideline',
          ownership: 'standalone',
        },
        'Content',
      );

      writeTagMappings([
        { tag: 'ok-tag', doc_id: 'known-doc', confidence: 0.9, source: 'manual' },
        { tag: 'bad-tag', doc_id: 'missing-doc', confidence: 0.8, source: 'slm' },
      ]);

      const result = shareLint(sourceDir);
      expect(result.ok).toBe(false);
      const danglingErrors = result.errors.filter((e) => e.message.includes('non-existent document'));
      expect(danglingErrors).toHaveLength(1);
      expect(danglingErrors[0].message).toContain('missing-doc');
      expect(danglingErrors[0].message).toContain('bad-tag');
    });

    it('multiple dangling references are all reported', () => {
      // No documents at all — edges and tag_mappings both dangle
      writeEdgeFile('path-requires.json', [
        { edge_id: 'e1', source_value: 'a/**', target_doc_id: 'phantom-a', priority: 1, specificity: 1 },
        { edge_id: 'e2', source_value: 'b/**', target_doc_id: 'phantom-b', priority: 1, specificity: 1 },
      ]);
      writeTagMappings([{ tag: 't1', doc_id: 'phantom-a', confidence: 0.5, source: 'slm' }]);

      const result = shareLint(sourceDir);
      expect(result.ok).toBe(false);
      const danglingErrors = result.errors.filter((e) => e.message.includes('non-existent document'));
      expect(danglingErrors).toHaveLength(3); // 2 edges + 1 tag_mapping
    });
  });

  describe('source directory does not exist', () => {
    it('reports error for missing directory', () => {
      const result = shareLint(`/tmp/aegis-lint-nonexistent-${Date.now()}-${Math.random()}`);
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});
