import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSharedSource } from './source-parser.js';

let sourceDir: string;

beforeEach(() => {
  sourceDir = mkdtempSync(join(tmpdir(), 'aegis-source-parser-'));
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

describe('parseSharedSource', () => {
  describe('happy path — full source tree', () => {
    it('parses a complete shared source directory', () => {
      writeDoc(
        'architecture-guide',
        {
          doc_id: 'architecture-guide',
          title: 'Architecture Guide',
          kind: 'guideline',
          ownership: 'file-anchored',
          source_path: 'docs/architecture-guide.md',
        },
        'This is the architecture guide.\n',
      );

      writeDoc(
        'testing-patterns',
        {
          doc_id: 'testing-patterns',
          title: 'Testing Patterns',
          kind: 'pattern',
          ownership: 'standalone',
        },
        'Testing content.\n',
      );

      writeEdgeFile('path-requires.json', [
        {
          edge_id: 'e-arch-domain',
          source_value: 'src/domain/**',
          target_doc_id: 'architecture-guide',
          priority: 1,
          specificity: 10,
        },
      ]);

      writeEdgeFile('command-requires.json', [
        {
          edge_id: 'e-cmd-review',
          source_value: 'review',
          target_doc_id: 'testing-patterns',
          priority: 5,
          specificity: 1,
        },
      ]);

      writeLayerRules([
        {
          rule_id: 'r-domain',
          path_pattern: 'src/domain/**',
          layer_name: 'domain',
          priority: 1,
          specificity: 10,
        },
      ]);

      writeTagMappings([
        {
          tag: 'architecture',
          doc_id: 'architecture-guide',
          confidence: 0.9,
          source: 'manual',
        },
      ]);

      const result = parseSharedSource(sourceDir);

      expect(result.errors).toEqual([]);
      expect(result.documents).toHaveLength(2);
      expect(result.edges).toHaveLength(2);
      expect(result.layer_rules).toHaveLength(1);
      expect(result.tag_mappings).toHaveLength(1);

      // Verify document fields
      const archDoc = result.documents.find((d) => d.doc_id === 'architecture-guide')!;
      expect(archDoc.title).toBe('Architecture Guide');
      expect(archDoc.kind).toBe('guideline');
      expect(archDoc.ownership).toBe('file-anchored');
      expect(archDoc.source_path).toBe('docs/architecture-guide.md');
      expect(archDoc.content).toBe('This is the architecture guide.\n');

      const testDoc = result.documents.find((d) => d.doc_id === 'testing-patterns')!;
      expect(testDoc.source_path).toBeNull();

      // Verify edge source_type derived from filename
      const pathEdge = result.edges.find((e) => e.edge_id === 'e-arch-domain')!;
      expect(pathEdge.source_type).toBe('path');
      expect(pathEdge.edge_type).toBe('path_requires');

      const cmdEdge = result.edges.find((e) => e.edge_id === 'e-cmd-review')!;
      expect(cmdEdge.source_type).toBe('command');
      expect(cmdEdge.edge_type).toBe('command_requires');

      // Verify layer rule
      expect(result.layer_rules[0].rule_id).toBe('r-domain');

      // Verify tag mapping
      expect(result.tag_mappings[0].tag).toBe('architecture');
      expect(result.tag_mappings[0].source).toBe('manual');
    });
  });

  describe('content_hash is not in parser contract', () => {
    it('does not include content_hash in parsed documents', () => {
      writeDoc(
        'test-doc',
        {
          doc_id: 'test-doc',
          title: 'Test',
          kind: 'guideline',
          ownership: 'standalone',
        },
        'body',
      );

      const result = parseSharedSource(sourceDir);
      expect(result.errors).toEqual([]);
      const doc = result.documents[0];
      expect(doc).not.toHaveProperty('content_hash');
    });
  });

  describe('document parsing errors', () => {
    it('reports missing frontmatter', () => {
      mkdirSync(join(sourceDir, 'documents'), { recursive: true });
      writeFileSync(join(sourceDir, 'documents', 'no-fm.md'), 'just some text without frontmatter');

      const result = parseSharedSource(sourceDir);
      expect(result.documents).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].file).toBe('documents/no-fm.md');
      expect(result.errors[0].location).toBe('frontmatter');
      expect(result.errors[0].message).toContain('frontmatter');
    });

    it('reports missing required frontmatter fields', () => {
      writeDoc(
        'incomplete',
        {
          doc_id: 'incomplete',
          title: 'Incomplete',
        } as Record<string, string | null>,
        'body',
      );

      const result = parseSharedSource(sourceDir);
      expect(result.documents).toHaveLength(0);
      expect(result.errors.some((e) => e.message.includes('kind'))).toBe(true);
      expect(result.errors.some((e) => e.message.includes('ownership'))).toBe(true);
    });

    it('reports invalid kind', () => {
      writeDoc(
        'bad-kind',
        {
          doc_id: 'bad-kind',
          title: 'Bad Kind',
          kind: 'unknown-kind',
          ownership: 'standalone',
        },
        'body',
      );

      const result = parseSharedSource(sourceDir);
      expect(result.documents).toHaveLength(0);
      expect(result.errors[0].message).toContain('invalid kind');
    });

    it('reports invalid ownership', () => {
      writeDoc(
        'bad-own',
        {
          doc_id: 'bad-own',
          title: 'Bad Ownership',
          kind: 'guideline',
          ownership: 'bogus',
        },
        'body',
      );

      const result = parseSharedSource(sourceDir);
      expect(result.documents).toHaveLength(0);
      expect(result.errors[0].message).toContain('invalid ownership');
    });

    it('detects doc_id / filename mismatch', () => {
      mkdirSync(join(sourceDir, 'documents'), { recursive: true });
      writeFileSync(
        join(sourceDir, 'documents', 'wrong-name.md'),
        '---\ndoc_id: correct-id\ntitle: T\nkind: guideline\nownership: standalone\n---\nbody',
      );

      const result = parseSharedSource(sourceDir);
      expect(result.documents).toHaveLength(0);
      expect(result.errors[0].message).toContain('does not match doc_id');
    });

    it('rejects non-.md files in documents/', () => {
      mkdirSync(join(sourceDir, 'documents'), { recursive: true });
      writeFileSync(join(sourceDir, 'documents', 'readme.txt'), 'text file');

      const result = parseSharedSource(sourceDir);
      expect(result.documents).toHaveLength(0);
      expect(result.errors[0].message).toContain('unexpected file extension');
    });

    it('reports invalid YAML in frontmatter', () => {
      mkdirSync(join(sourceDir, 'documents'), { recursive: true });
      writeFileSync(join(sourceDir, 'documents', 'bad-yaml.md'), '---\n: invalid yaml {{{\ntitle: T\n---\nbody');

      const result = parseSharedSource(sourceDir);
      expect(result.documents).toHaveLength(0);
      expect(result.errors.some((e) => e.message.includes('invalid YAML'))).toBe(true);
    });

    it('rejects numeric doc_id', () => {
      mkdirSync(join(sourceDir, 'documents'), { recursive: true });
      writeFileSync(
        join(sourceDir, 'documents', '42.md'),
        '---\ndoc_id: 42\ntitle: Numeric\nkind: guideline\nownership: standalone\n---\nbody',
      );

      const result = parseSharedSource(sourceDir);
      expect(result.documents).toHaveLength(0);
      expect(
        result.errors.some((e) => e.location === 'frontmatter.doc_id' && e.message.includes('must be a string')),
      ).toBe(true);
    });

    it('rejects numeric title', () => {
      mkdirSync(join(sourceDir, 'documents'), { recursive: true });
      writeFileSync(
        join(sourceDir, 'documents', 'num-title.md'),
        '---\ndoc_id: num-title\ntitle: 7\nkind: guideline\nownership: standalone\n---\nbody',
      );

      const result = parseSharedSource(sourceDir);
      expect(result.documents).toHaveLength(0);
      expect(
        result.errors.some((e) => e.location === 'frontmatter.title' && e.message.includes('must be a string')),
      ).toBe(true);
    });
  });

  describe('edge parsing errors', () => {
    it('rejects unsupported edge filename', () => {
      writeEdgeFile('custom-edges.json', []);

      const result = parseSharedSource(sourceDir);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('unsupported edge file');
    });

    it('reports malformed JSON in edge file', () => {
      mkdirSync(join(sourceDir, 'edges'), { recursive: true });
      writeFileSync(join(sourceDir, 'edges', 'path-requires.json'), '{ invalid json');

      const result = parseSharedSource(sourceDir);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('malformed JSON');
    });

    it('reports non-array JSON in edge file', () => {
      mkdirSync(join(sourceDir, 'edges'), { recursive: true });
      writeFileSync(join(sourceDir, 'edges', 'path-requires.json'), '{"not": "array"}');

      const result = parseSharedSource(sourceDir);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('expected a JSON array');
    });

    it('reports missing required fields in edge entry with file and location separated', () => {
      writeEdgeFile('path-requires.json', [{ edge_id: 'e1' }]);

      const result = parseSharedSource(sourceDir);
      expect(result.edges).toHaveLength(0);
      const svErr = result.errors.find((e) => e.message.includes('source_value'))!;
      expect(svErr.file).toBe('edges/path-requires.json');
      expect(svErr.location).toBe('[0].source_value');
    });

    it('reports conflicting edge_type with file-derived type', () => {
      writeEdgeFile('path-requires.json', [
        {
          edge_id: 'e1',
          source_value: 'src/**',
          target_doc_id: 'doc1',
          edge_type: 'command_requires',
          priority: 1,
          specificity: 1,
        },
      ]);

      const result = parseSharedSource(sourceDir);
      expect(result.edges).toHaveLength(0);
      expect(result.errors.some((e) => e.message.includes('conflicts with file-derived type'))).toBe(true);
      expect(result.errors[0].file).toBe('edges/path-requires.json');
    });

    it('rejects source_type field in edge entries (file-derived only)', () => {
      writeEdgeFile('path-requires.json', [
        {
          edge_id: 'e1',
          source_value: 'src/**',
          target_doc_id: 'doc1',
          source_type: 'path',
          priority: 1,
          specificity: 1,
        },
      ]);

      const result = parseSharedSource(sourceDir);
      expect(result.edges).toHaveLength(0);
      expect(result.errors.some((e) => e.location === '[0].source_type' && e.message.includes('must not appear'))).toBe(
        true,
      );
    });

    it('accepts edge entry without source_type or edge_type (both derived)', () => {
      writeEdgeFile('layer-requires.json', [
        {
          edge_id: 'e1',
          source_value: 'domain',
          target_doc_id: 'doc1',
          priority: 1,
          specificity: 1,
        },
      ]);

      const result = parseSharedSource(sourceDir);
      expect(result.errors).toEqual([]);
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0].source_type).toBe('layer');
      expect(result.edges[0].edge_type).toBe('layer_requires');
    });
  });

  describe('layer-rules.json errors', () => {
    it('reports malformed JSON', () => {
      writeFileSync(join(sourceDir, 'layer-rules.json'), 'not json');

      const result = parseSharedSource(sourceDir);
      expect(result.errors[0].file).toBe('layer-rules.json');
      expect(result.errors[0].message).toContain('malformed JSON');
    });

    it('reports non-array', () => {
      writeLayerRules({} as unknown as unknown[]);

      const result = parseSharedSource(sourceDir);
      expect(result.errors[0].message).toContain('expected a JSON array');
    });

    it('reports missing fields with file and location separated', () => {
      writeLayerRules([{ rule_id: 'r1' }]);

      const result = parseSharedSource(sourceDir);
      expect(result.layer_rules).toHaveLength(0);
      const ppErr = result.errors.find((e) => e.message.includes('path_pattern'))!;
      expect(ppErr.file).toBe('layer-rules.json');
      expect(ppErr.location).toBe('[0].path_pattern');
    });
  });

  describe('tag-mappings.json errors', () => {
    it('reports malformed JSON', () => {
      writeFileSync(join(sourceDir, 'tag-mappings.json'), '{broken');

      const result = parseSharedSource(sourceDir);
      expect(result.errors[0].file).toBe('tag-mappings.json');
      expect(result.errors[0].message).toContain('malformed JSON');
    });

    it('reports invalid source value with location', () => {
      writeTagMappings([{ tag: 'test', doc_id: 'doc1', confidence: 0.5, source: 'invalid' }]);

      const result = parseSharedSource(sourceDir);
      expect(result.tag_mappings).toHaveLength(0);
      expect(result.errors[0].message).toContain('invalid source');
      expect(result.errors[0].file).toBe('tag-mappings.json');
      expect(result.errors[0].location).toBe('[0].source');
    });
  });

  describe('unknown top-level entries', () => {
    it('reports unknown files and directories at top level', () => {
      writeFileSync(join(sourceDir, 'random-file.txt'), 'stuff');
      mkdirSync(join(sourceDir, 'unknown-dir'));
      writeFileSync(join(sourceDir, 'unknown-dir', 'foo.json'), '{}');

      const result = parseSharedSource(sourceDir);
      const unknownErrors = result.errors.filter((e) => e.message.includes('unknown top-level'));
      expect(unknownErrors).toHaveLength(2);
    });
  });

  describe('non-existent source directory', () => {
    it('returns error for non-existent directory', () => {
      const result = parseSharedSource('/tmp/definitely-does-not-exist-' + Date.now());
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toMatch(/does not exist|cannot stat|ENOENT/);
      expect(result.errors[0].location).toBe('$');
    });
  });

  describe('empty source directory', () => {
    it('parses empty directory without errors', () => {
      const result = parseSharedSource(sourceDir);
      expect(result.documents).toHaveLength(0);
      expect(result.edges).toHaveLength(0);
      expect(result.layer_rules).toHaveLength(0);
      expect(result.tag_mappings).toHaveLength(0);
      expect(result.errors).toEqual([]);
    });
  });

  describe('all four edge file types', () => {
    it('correctly maps each edge file to source_type and edge_type', () => {
      writeEdgeFile('path-requires.json', [
        { edge_id: 'e1', source_value: 'src/**', target_doc_id: 'd1', priority: 1, specificity: 1 },
      ]);
      writeEdgeFile('layer-requires.json', [
        { edge_id: 'e2', source_value: 'domain', target_doc_id: 'd2', priority: 1, specificity: 1 },
      ]);
      writeEdgeFile('command-requires.json', [
        { edge_id: 'e3', source_value: 'review', target_doc_id: 'd3', priority: 1, specificity: 1 },
      ]);
      writeEdgeFile('doc-depends-on.json', [
        { edge_id: 'e4', source_value: 'd1', target_doc_id: 'd4', priority: 1, specificity: 1 },
      ]);

      const result = parseSharedSource(sourceDir);
      expect(result.errors).toEqual([]);
      expect(result.edges).toHaveLength(4);

      const byId = Object.fromEntries(result.edges.map((e) => [e.edge_id, e]));
      expect(byId.e1.source_type).toBe('path');
      expect(byId.e1.edge_type).toBe('path_requires');
      expect(byId.e2.source_type).toBe('layer');
      expect(byId.e2.edge_type).toBe('layer_requires');
      expect(byId.e3.source_type).toBe('command');
      expect(byId.e3.edge_type).toBe('command_requires');
      expect(byId.e4.source_type).toBe('doc');
      expect(byId.e4.edge_type).toBe('doc_depends_on');
    });
  });

  describe('document with optional fields', () => {
    it('parses source_refs_json and template_origin', () => {
      writeDoc(
        'with-extras',
        {
          doc_id: 'with-extras',
          title: 'With Extras',
          kind: 'reference',
          ownership: 'derived',
          template_origin: 'base-template',
          source_refs_json: '[{"asset_path":"a.ts","anchor_type":"file","anchor_value":"*"}]',
        },
        'content',
      );

      const result = parseSharedSource(sourceDir);
      expect(result.errors).toEqual([]);
      const doc = result.documents[0];
      expect(doc.template_origin).toBe('base-template');
      expect(doc.source_refs_json).toBe('[{"asset_path":"a.ts","anchor_type":"file","anchor_value":"*"}]');
    });
  });

  describe('wrong-kind top-level entries', () => {
    it('reports error when documents is a file instead of directory', () => {
      writeFileSync(join(sourceDir, 'documents'), 'not a directory');

      const result = parseSharedSource(sourceDir);
      expect(result.errors.some((e) => e.file === 'documents' && e.message.includes('expected a directory'))).toBe(
        true,
      );
    });

    it('reports error when edges is a file instead of directory', () => {
      writeFileSync(join(sourceDir, 'edges'), 'not a directory');

      const result = parseSharedSource(sourceDir);
      expect(result.errors.some((e) => e.file === 'edges' && e.message.includes('expected a directory'))).toBe(true);
    });

    it('reports error when layer-rules.json is a directory', () => {
      mkdirSync(join(sourceDir, 'layer-rules.json'));

      const result = parseSharedSource(sourceDir);
      expect(result.errors.some((e) => e.file === 'layer-rules.json' && e.message.includes('expected a file'))).toBe(
        true,
      );
    });

    it('reports error when tag-mappings.json is a directory', () => {
      mkdirSync(join(sourceDir, 'tag-mappings.json'));

      const result = parseSharedSource(sourceDir);
      expect(result.errors.some((e) => e.file === 'tag-mappings.json' && e.message.includes('expected a file'))).toBe(
        true,
      );
    });
  });

  describe('deterministic ordering', () => {
    it('returns documents in lexical order by doc_id', () => {
      writeDoc(
        'zebra-doc',
        {
          doc_id: 'zebra-doc',
          title: 'Zebra',
          kind: 'guideline',
          ownership: 'standalone',
        },
        'z',
      );
      writeDoc(
        'alpha-doc',
        {
          doc_id: 'alpha-doc',
          title: 'Alpha',
          kind: 'guideline',
          ownership: 'standalone',
        },
        'a',
      );
      writeDoc(
        'middle-doc',
        {
          doc_id: 'middle-doc',
          title: 'Middle',
          kind: 'guideline',
          ownership: 'standalone',
        },
        'm',
      );

      const result = parseSharedSource(sourceDir);
      expect(result.errors).toEqual([]);
      expect(result.documents.map((d) => d.doc_id)).toEqual(['alpha-doc', 'middle-doc', 'zebra-doc']);
    });

    it('returns edges in deterministic order (by edge file, then by array index)', () => {
      writeEdgeFile('path-requires.json', [
        { edge_id: 'e-path-2', source_value: 'b/**', target_doc_id: 'd1', priority: 1, specificity: 1 },
        { edge_id: 'e-path-1', source_value: 'a/**', target_doc_id: 'd1', priority: 1, specificity: 1 },
      ]);
      writeEdgeFile('command-requires.json', [
        { edge_id: 'e-cmd-1', source_value: 'review', target_doc_id: 'd1', priority: 1, specificity: 1 },
      ]);

      const result = parseSharedSource(sourceDir);
      expect(result.errors).toEqual([]);
      // command-requires.json < path-requires.json lexically
      expect(result.edges.map((e) => e.edge_id)).toEqual(['e-cmd-1', 'e-path-2', 'e-path-1']);
    });
  });

  describe('YAML frontmatter edge cases', () => {
    it('handles quoted "null" as literal string, not null', () => {
      mkdirSync(join(sourceDir, 'documents'), { recursive: true });
      writeFileSync(
        join(sourceDir, 'documents', 'quoted-null.md'),
        '---\ndoc_id: quoted-null\ntitle: "null"\nkind: guideline\nownership: standalone\n---\nbody',
      );

      const result = parseSharedSource(sourceDir);
      expect(result.errors).toEqual([]);
      expect(result.documents[0].title).toBe('null');
    });
  });

  describe('location field in errors', () => {
    it('every error has a location field', () => {
      // Create a variety of error conditions
      writeFileSync(join(sourceDir, 'unknown.txt'), 'x');
      mkdirSync(join(sourceDir, 'documents'), { recursive: true });
      writeFileSync(join(sourceDir, 'documents', 'no-fm.md'), 'no frontmatter');

      const result = parseSharedSource(sourceDir);
      for (const err of result.errors) {
        expect(err.location).toBeDefined();
        expect(typeof err.location).toBe('string');
        expect(err.location.length).toBeGreaterThan(0);
      }
    });

    it('includes location for frontmatter validation errors', () => {
      writeDoc(
        'bad-kind',
        {
          doc_id: 'bad-kind',
          title: 'Bad',
          kind: 'invalid',
          ownership: 'standalone',
        },
        'body',
      );

      const result = parseSharedSource(sourceDir);
      expect(result.errors[0].location).toBe('frontmatter.kind');
    });

    it('includes location for edge field errors', () => {
      writeEdgeFile('path-requires.json', [
        { edge_id: 'e1', source_value: 'src/**', target_doc_id: 'd1', priority: 'not-a-number', specificity: 1 },
      ]);

      const result = parseSharedSource(sourceDir);
      expect(result.errors[0].file).toBe('edges/path-requires.json');
      expect(result.errors[0].location).toBe('[0].priority');
    });

    it('includes location for tag mapping field errors', () => {
      writeTagMappings([{ tag: '', doc_id: 'doc1', confidence: 0.5, source: 'manual' }]);

      const result = parseSharedSource(sourceDir);
      expect(result.errors[0].file).toBe('tag-mappings.json');
      expect(result.errors[0].location).toBe('[0].tag');
    });
  });

  describe('content_hash rejection', () => {
    it('rejects content_hash in frontmatter as forbidden field', () => {
      mkdirSync(join(sourceDir, 'documents'), { recursive: true });
      writeFileSync(
        join(sourceDir, 'documents', 'has-hash.md'),
        '---\ndoc_id: has-hash\ntitle: Has Hash\nkind: guideline\nownership: standalone\ncontent_hash: abc123\n---\nbody',
      );

      const result = parseSharedSource(sourceDir);
      expect(result.documents).toHaveLength(0);
      expect(
        result.errors.some((e) => e.location === 'frontmatter.content_hash' && e.message.includes('must not appear')),
      ).toBe(true);
    });
  });

  describe('source_refs_json validation', () => {
    it('rejects scalar source_refs_json', () => {
      mkdirSync(join(sourceDir, 'documents'), { recursive: true });
      writeFileSync(
        join(sourceDir, 'documents', 'scalar-refs.md'),
        '---\ndoc_id: scalar-refs\ntitle: T\nkind: guideline\nownership: standalone\nsource_refs_json: 42\n---\nbody',
      );

      const result = parseSharedSource(sourceDir);
      expect(result.documents).toHaveLength(0);
      expect(
        result.errors.some((e) => e.location === 'frontmatter.source_refs_json' && e.message.includes('JSON array')),
      ).toBe(true);
    });

    it('rejects object source_refs_json', () => {
      mkdirSync(join(sourceDir, 'documents'), { recursive: true });
      writeFileSync(
        join(sourceDir, 'documents', 'obj-refs.md'),
        '---\ndoc_id: obj-refs\ntitle: T\nkind: guideline\nownership: standalone\nsource_refs_json: \'{"not":"array"}\'\n---\nbody',
      );

      const result = parseSharedSource(sourceDir);
      expect(result.documents).toHaveLength(0);
      expect(
        result.errors.some((e) => e.location === 'frontmatter.source_refs_json' && e.message.includes('JSON array')),
      ).toBe(true);
    });

    it('accepts valid JSON array source_refs_json', () => {
      writeDoc(
        'valid-refs',
        {
          doc_id: 'valid-refs',
          title: 'Valid',
          kind: 'guideline',
          ownership: 'standalone',
          source_refs_json: '[{"asset_path":"a.ts","anchor_type":"file","anchor_value":"*"}]',
        },
        'body',
      );

      const result = parseSharedSource(sourceDir);
      expect(result.errors).toEqual([]);
      expect(result.documents[0].source_refs_json).toBe(
        '[{"asset_path":"a.ts","anchor_type":"file","anchor_value":"*"}]',
      );
    });
  });

  describe('file-anchored invariant', () => {
    it('rejects file-anchored without source_path or source_refs_json', () => {
      writeDoc(
        'anchored-no-path',
        {
          doc_id: 'anchored-no-path',
          title: 'Anchored',
          kind: 'guideline',
          ownership: 'file-anchored',
        },
        'body',
      );

      const result = parseSharedSource(sourceDir);
      expect(result.documents).toHaveLength(0);
      expect(
        result.errors.some((e) => e.location === 'frontmatter.ownership' && e.message.includes('file-anchored')),
      ).toBe(true);
    });

    it('accepts file-anchored with source_path', () => {
      writeDoc(
        'anchored-with-path',
        {
          doc_id: 'anchored-with-path',
          title: 'Anchored',
          kind: 'guideline',
          ownership: 'file-anchored',
          source_path: 'docs/guide.md',
        },
        'body',
      );

      const result = parseSharedSource(sourceDir);
      expect(result.errors).toEqual([]);
      expect(result.documents).toHaveLength(1);
    });
  });

  describe('broken symlink handling', () => {
    it('does not throw on broken symlink in documents/', () => {
      mkdirSync(join(sourceDir, 'documents'), { recursive: true });
      symlinkSync('/tmp/nonexistent-target-' + Date.now(), join(sourceDir, 'documents', 'broken.md'));

      const result = parseSharedSource(sourceDir);
      expect(result.documents).toHaveLength(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.file === 'documents/broken.md')).toBe(true);
    });
  });
});
