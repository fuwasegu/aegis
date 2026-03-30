import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createInMemoryDatabase, Repository } from './store/index.js';
import {
  migrateSourcePaths,
  normalizeSourcePath,
  resolveSourcePath,
  validateInsideProject,
} from './paths.js';

describe('normalizeSourcePath', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aegis-paths-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('converts absolute path inside project to relative', () => {
    const filePath = join(tmpDir, 'src/foo.ts');
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(filePath, 'content');

    const result = normalizeSourcePath(filePath, tmpDir);
    expect(result).toBe('src/foo.ts');
  });

  it('keeps already-relative path as-is (idempotent)', () => {
    const result = normalizeSourcePath('src/foo.ts', tmpDir);
    expect(result).toBe('src/foo.ts');
  });

  it('throws for path outside project root', () => {
    expect(() => normalizeSourcePath('/etc/passwd', tmpDir)).toThrow('outside the project root');
  });

  it('handles non-existent file path (normalize without realpath)', () => {
    const result = normalizeSourcePath(join(tmpDir, 'nonexistent/file.ts'), tmpDir);
    expect(result).toBe('nonexistent/file.ts');
  });
});

describe('resolveSourcePath', () => {
  it('resolves repo-relative to absolute', () => {
    const result = resolveSourcePath('src/foo.ts', '/project');
    expect(result).toBe('/project/src/foo.ts');
  });

  it('throws on path traversal (../../etc/passwd)', () => {
    expect(() => resolveSourcePath('../../etc/passwd', '/project')).toThrow('outside the project root');
  });

  it('throws on absolute-looking relative path', () => {
    expect(() => resolveSourcePath('../outside/file.ts', '/project')).toThrow('outside the project root');
  });
});

describe('validateInsideProject', () => {
  it('accepts path inside project', () => {
    expect(() => validateInsideProject('/project/src/foo.ts', '/project')).not.toThrow();
  });

  it('accepts exact project root', () => {
    expect(() => validateInsideProject('/project', '/project')).not.toThrow();
  });

  it('rejects path outside project', () => {
    expect(() => validateInsideProject('/other/foo.ts', '/project')).toThrow('outside the project root');
  });

  it('rejects path that is a prefix but not a child', () => {
    // /project-extra is not inside /project
    expect(() => validateInsideProject('/project-extra/foo.ts', '/project')).toThrow('outside the project root');
  });
});

describe('migrateSourcePaths', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aegis-migrate-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('converts absolute paths inside projectRoot to relative', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);

    repo.insertDocument({
      doc_id: 'doc1',
      title: 'Doc 1',
      kind: 'guideline',
      content: 'content',
      content_hash: 'hash1',
      status: 'approved',
      template_origin: null,
      source_path: join(tmpDir, 'src/file.ts'),
    });

    migrateSourcePaths(repo, tmpDir);

    const doc = repo.getDocumentById('doc1');
    expect(doc!.source_path).toBe('src/file.ts');
  });

  it('sets NULL for absolute paths outside projectRoot', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);

    repo.insertDocument({
      doc_id: 'doc2',
      title: 'Doc 2',
      kind: 'guideline',
      content: 'content',
      content_hash: 'hash2',
      status: 'approved',
      template_origin: null,
      source_path: '/totally/different/path.ts',
    });

    migrateSourcePaths(repo, tmpDir);

    const doc = repo.getDocumentById('doc2');
    expect(doc!.source_path).toBeNull();
  });

  it('skips already-relative paths (idempotent)', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);

    repo.insertDocument({
      doc_id: 'doc3',
      title: 'Doc 3',
      kind: 'guideline',
      content: 'content',
      content_hash: 'hash3',
      status: 'approved',
      template_origin: null,
      source_path: 'src/already-relative.ts',
    });

    migrateSourcePaths(repo, tmpDir);

    const doc = repo.getDocumentById('doc3');
    expect(doc!.source_path).toBe('src/already-relative.ts');
  });

  it('nullifies relative paths that traverse outside project root', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);

    repo.insertDocument({
      doc_id: 'traversal-doc',
      title: 'Traversal',
      kind: 'guideline',
      content: 'content',
      content_hash: 'hashT',
      status: 'approved',
      template_origin: null,
      source_path: '../../etc/passwd',
    });

    migrateSourcePaths(repo, tmpDir);

    const doc = repo.getDocumentById('traversal-doc');
    expect(doc!.source_path).toBeNull();
  });

  it('handles all document statuses (not just approved)', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);

    repo.insertDocument({
      doc_id: 'draft-doc',
      title: 'Draft',
      kind: 'guideline',
      content: 'content',
      content_hash: 'hashd',
      status: 'draft',
      template_origin: null,
      source_path: join(tmpDir, 'draft.ts'),
    });

    migrateSourcePaths(repo, tmpDir);

    const doc = repo.getDocumentById('draft-doc');
    expect(doc!.source_path).toBe('draft.ts');
  });
});
