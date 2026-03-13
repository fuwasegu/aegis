import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { parseFrontmatter, importDocument } from './importer.js';

const TMP_DIR = join(process.cwd(), '.tmp-test', 'import');

function setupTmpDir() {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
}

describe('parseFrontmatter', () => {
  it('parses valid frontmatter', () => {
    const raw = `---
id: error-handling
title: Error Handling Guide
kind: guideline
tags: [validation, error_handling]
requires: [api-conventions]
---
# Error Handling

Always use custom error classes.`;

    const { data, body } = parseFrontmatter(raw);
    expect(data.id).toBe('error-handling');
    expect(data.title).toBe('Error Handling Guide');
    expect(data.kind).toBe('guideline');
    expect(data.tags).toEqual(['validation', 'error_handling']);
    expect(data.requires).toEqual(['api-conventions']);
    expect(body).toContain('# Error Handling');
    expect(body).not.toContain('---');
  });

  it('returns empty data when no frontmatter', () => {
    const raw = '# Just a document\n\nSome content.';
    const { data, body } = parseFrontmatter(raw);
    expect(data).toEqual({});
    expect(body).toBe(raw);
  });

  it('handles partial frontmatter (missing closing ---)', () => {
    const raw = '---\nid: broken\nSome content without closing';
    const { data, body } = parseFrontmatter(raw);
    expect(data).toEqual({});
    expect(body).toBe(raw);
  });

  it('handles empty frontmatter', () => {
    const raw = '---\n---\nContent after empty frontmatter.';
    const { data, body } = parseFrontmatter(raw);
    expect(data).toEqual({});
    expect(body).toBe('Content after empty frontmatter.');
  });

  it('ignores non-string id/title/kind', () => {
    const raw = `---
id: 123
title: true
---
Body`;
    const { data } = parseFrontmatter(raw);
    expect(data.id).toBeUndefined();
    expect(data.title).toBeUndefined();
  });
});

describe('importDocument', () => {
  it('imports file with full frontmatter', () => {
    setupTmpDir();
    const filePath = join(TMP_DIR, 'my-guide.md');
    writeFileSync(filePath, `---
id: my-guide
title: My Guide
kind: guideline
requires: [base-doc]
---
# Guide Content

Follow this guide.`);

    const result = importDocument(filePath);
    expect(result.doc.doc_id).toBe('my-guide');
    expect(result.doc.title).toBe('My Guide');
    expect(result.doc.kind).toBe('guideline');
    expect(result.doc.requires).toEqual(['base-doc']);
    expect(result.doc.content).toContain('# Guide Content');
    expect(result.doc.content_hash).toMatch(/^[a-f0-9]{64}$/);

    expect(result.drafts).toHaveLength(2);
    expect(result.drafts[0].proposal_type).toBe('new_doc');
    expect(result.drafts[1].proposal_type).toBe('add_edge');
    expect(result.drafts[1].payload).toMatchObject({
      source_type: 'doc',
      source_value: 'my-guide',
      target_doc_id: 'base-doc',
      edge_type: 'doc_depends_on',
    });
  });

  it('imports file without frontmatter (derives from filename)', () => {
    setupTmpDir();
    const filePath = join(TMP_DIR, 'Error-Handling.md');
    writeFileSync(filePath, '# Error Handling\n\nContent here.');

    const result = importDocument(filePath);
    expect(result.doc.doc_id).toBe('error-handling');
    expect(result.doc.title).toBe('Error Handling');
    expect(result.doc.kind).toBe('reference');
    expect(result.doc.requires).toEqual([]);
    expect(result.drafts).toHaveLength(1);
  });

  it('overrides take precedence over frontmatter', () => {
    setupTmpDir();
    const filePath = join(TMP_DIR, 'doc.md');
    writeFileSync(filePath, `---
id: original-id
title: Original Title
kind: pattern
---
Content`);

    const result = importDocument(filePath, {
      doc_id: 'override-id',
      title: 'Override Title',
      kind: 'constraint',
    });
    expect(result.doc.doc_id).toBe('override-id');
    expect(result.doc.title).toBe('Override Title');
    expect(result.doc.kind).toBe('constraint');
  });

  it('handles invalid kind gracefully (falls back to reference)', () => {
    setupTmpDir();
    const filePath = join(TMP_DIR, 'bad-kind.md');
    writeFileSync(filePath, `---
kind: invalid_kind
---
Content`);

    const result = importDocument(filePath);
    expect(result.doc.kind).toBe('reference');
  });

  it('creates multiple edge drafts for multiple requires', () => {
    setupTmpDir();
    const filePath = join(TMP_DIR, 'multi-dep.md');
    writeFileSync(filePath, `---
id: multi-dep
requires: [dep-a, dep-b, dep-c]
---
Content`);

    const result = importDocument(filePath);
    expect(result.drafts).toHaveLength(4); // 1 new_doc + 3 add_edge
    const edgeDrafts = result.drafts.filter(d => d.proposal_type === 'add_edge');
    expect(edgeDrafts.map(d => d.payload.target_doc_id)).toEqual(['dep-a', 'dep-b', 'dep-c']);
  });
});
