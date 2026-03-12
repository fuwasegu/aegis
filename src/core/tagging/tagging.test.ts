import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createInMemoryDatabase, Repository } from '../store/index.js';
import type { IntentTagger } from './tagger.js';
import type { IntentTag } from '../types.js';

// ============================================================
// FakeTagger (test double)
// ============================================================

class FakeTagger implements IntentTagger {
  constructor(private tagMap: Record<string, IntentTag[]> = {}) {}

  async extractTags(plan: string): Promise<IntentTag[]> {
    return this.tagMap[plan] ?? [];
  }
}

// ============================================================
// Repository: Tag Mappings CRUD
// ============================================================

describe('Repository - Tag Mappings', () => {
  let db: Database.Database;
  let repo: Repository;

  beforeEach(() => {
    db = createInMemoryDatabase();
    repo = new Repository(db);

    repo.insertDocument({
      doc_id: 'auth-guide',
      title: 'Authentication Guide',
      kind: 'guideline',
      content: 'How to implement auth',
      content_hash: 'hash1',
      status: 'approved',
    });
    repo.insertDocument({
      doc_id: 'security-pattern',
      title: 'Security Patterns',
      kind: 'pattern',
      content: 'Security best practices',
      content_hash: 'hash2',
      status: 'approved',
    });
    repo.insertDocument({
      doc_id: 'payment-guide',
      title: 'Payment Guide',
      kind: 'guideline',
      content: 'Payment integration',
      content_hash: 'hash3',
      status: 'approved',
    });
  });

  describe('upsertTagMapping', () => {
    it('inserts new tag mapping', () => {
      repo.upsertTagMapping({ tag: 'auth', doc_id: 'auth-guide', confidence: 0.95, source: 'slm' });

      const mappings = repo.getTagMappings('auth');
      expect(mappings).toHaveLength(1);
      expect(mappings[0].tag).toBe('auth');
      expect(mappings[0].doc_id).toBe('auth-guide');
      expect(mappings[0].confidence).toBe(0.95);
      expect(mappings[0].source).toBe('slm');
      expect(mappings[0].created_at).toBeTruthy();
    });

    it('updates existing mapping (upsert semantics)', () => {
      repo.upsertTagMapping({ tag: 'auth', doc_id: 'auth-guide', confidence: 0.8, source: 'slm' });
      repo.upsertTagMapping({ tag: 'auth', doc_id: 'auth-guide', confidence: 0.95, source: 'manual' });

      const mappings = repo.getTagMappings('auth');
      expect(mappings).toHaveLength(1);
      expect(mappings[0].confidence).toBe(0.95);
      expect(mappings[0].source).toBe('manual');
    });
  });

  describe('setTagMappings', () => {
    it('replaces all mappings for a tag atomically', () => {
      repo.upsertTagMapping({ tag: 'auth', doc_id: 'auth-guide', confidence: 0.8, source: 'manual' });

      repo.setTagMappings('auth', [
        { doc_id: 'auth-guide', confidence: 0.95, source: 'slm' },
        { doc_id: 'security-pattern', confidence: 0.7, source: 'slm' },
      ]);

      const mappings = repo.getTagMappings('auth');
      expect(mappings).toHaveLength(2);
      expect(mappings[0].doc_id).toBe('auth-guide');
      expect(mappings[0].confidence).toBe(0.95);
      expect(mappings[1].doc_id).toBe('security-pattern');
      expect(mappings[1].confidence).toBe(0.7);
    });

    it('deletes old mappings not in new batch', () => {
      repo.setTagMappings('auth', [
        { doc_id: 'auth-guide', confidence: 0.9, source: 'slm' },
        { doc_id: 'security-pattern', confidence: 0.8, source: 'slm' },
      ]);
      repo.setTagMappings('auth', [
        { doc_id: 'auth-guide', confidence: 0.95, source: 'slm' },
      ]);

      const mappings = repo.getTagMappings('auth');
      expect(mappings).toHaveLength(1);
      expect(mappings[0].doc_id).toBe('auth-guide');
    });

    it('handles empty array (deletes all)', () => {
      repo.upsertTagMapping({ tag: 'auth', doc_id: 'auth-guide', confidence: 0.9, source: 'slm' });
      repo.setTagMappings('auth', []);

      expect(repo.getTagMappings('auth')).toEqual([]);
    });
  });

  describe('getTagMappings', () => {
    it('returns mappings sorted by confidence DESC, doc_id ASC', () => {
      repo.upsertTagMapping({ tag: 'auth', doc_id: 'auth-guide', confidence: 0.7, source: 'slm' });
      repo.upsertTagMapping({ tag: 'auth', doc_id: 'security-pattern', confidence: 0.95, source: 'slm' });
      repo.upsertTagMapping({ tag: 'auth', doc_id: 'payment-guide', confidence: 0.6, source: 'slm' });

      const mappings = repo.getTagMappings('auth');
      expect(mappings.map(m => m.doc_id)).toEqual([
        'security-pattern', 'auth-guide', 'payment-guide',
      ]);
    });

    it('deterministic tiebreaker on equal confidence', () => {
      repo.upsertTagMapping({ tag: 'test', doc_id: 'payment-guide', confidence: 0.8, source: 'slm' });
      repo.upsertTagMapping({ tag: 'test', doc_id: 'auth-guide', confidence: 0.8, source: 'slm' });

      const mappings = repo.getTagMappings('test');
      expect(mappings.map(m => m.doc_id)).toEqual(['auth-guide', 'payment-guide']);
    });

    it('returns empty array for unknown tag', () => {
      expect(repo.getTagMappings('nonexistent')).toEqual([]);
    });
  });

  describe('getDocumentsByTags', () => {
    beforeEach(() => {
      repo.upsertTagMapping({ tag: 'auth', doc_id: 'auth-guide', confidence: 0.95, source: 'slm' });
      repo.upsertTagMapping({ tag: 'security', doc_id: 'auth-guide', confidence: 0.8, source: 'slm' });
      repo.upsertTagMapping({ tag: 'security', doc_id: 'security-pattern', confidence: 0.9, source: 'slm' });
      repo.upsertTagMapping({ tag: 'payment', doc_id: 'payment-guide', confidence: 0.85, source: 'slm' });
    });

    it('aggregates documents matching multiple tags', () => {
      const results = repo.getDocumentsByTags(['auth', 'security']);
      expect(results).toHaveLength(2);

      const authGuide = results.find(r => r.doc_id === 'auth-guide')!;
      expect(authGuide.matched_tags).toEqual(['auth', 'security']);
      expect(authGuide.max_confidence).toBe(0.95);
      expect(authGuide.avg_confidence).toBeCloseTo(0.875, 2);

      const secPattern = results.find(r => r.doc_id === 'security-pattern')!;
      expect(secPattern.matched_tags).toEqual(['security']);
      expect(secPattern.max_confidence).toBe(0.9);
    });

    it('sorts by max_confidence DESC, doc_id ASC', () => {
      const results = repo.getDocumentsByTags(['auth', 'security']);
      expect(results[0].doc_id).toBe('auth-guide');      // 0.95
      expect(results[1].doc_id).toBe('security-pattern'); // 0.9
    });

    it('excludes non-approved documents', () => {
      repo.insertDocument({
        doc_id: 'draft-doc',
        title: 'Draft',
        kind: 'guideline',
        content: 'wip',
        content_hash: 'hash-d',
        status: 'draft',
      });
      repo.upsertTagMapping({ tag: 'auth', doc_id: 'draft-doc', confidence: 0.99, source: 'slm' });

      const results = repo.getDocumentsByTags(['auth']);
      expect(results.map(r => r.doc_id)).not.toContain('draft-doc');
    });

    it('excludes deprecated documents', () => {
      repo.insertDocument({
        doc_id: 'old-doc',
        title: 'Deprecated',
        kind: 'guideline',
        content: 'old',
        content_hash: 'hash-o',
        status: 'deprecated',
      });
      repo.upsertTagMapping({ tag: 'auth', doc_id: 'old-doc', confidence: 0.99, source: 'slm' });

      const results = repo.getDocumentsByTags(['auth']);
      expect(results.map(r => r.doc_id)).not.toContain('old-doc');
    });

    it('returns empty array for empty tags input', () => {
      expect(repo.getDocumentsByTags([])).toEqual([]);
    });

    it('returns empty array for unknown tags', () => {
      expect(repo.getDocumentsByTags(['nonexistent'])).toEqual([]);
    });
  });

  describe('getTagsForDocument', () => {
    it('returns all tags sorted by confidence DESC, tag ASC', () => {
      repo.upsertTagMapping({ tag: 'auth', doc_id: 'auth-guide', confidence: 0.7, source: 'slm' });
      repo.upsertTagMapping({ tag: 'security', doc_id: 'auth-guide', confidence: 0.95, source: 'slm' });
      repo.upsertTagMapping({ tag: 'api', doc_id: 'auth-guide', confidence: 0.6, source: 'manual' });

      const tags = repo.getTagsForDocument('auth-guide');
      expect(tags.map(t => t.tag)).toEqual(['security', 'auth', 'api']);
    });

    it('returns empty array for document with no tags', () => {
      expect(repo.getTagsForDocument('payment-guide')).toEqual([]);
    });
  });

  describe('deleteTagMapping', () => {
    it('deletes specific tag-doc mapping', () => {
      repo.upsertTagMapping({ tag: 'auth', doc_id: 'auth-guide', confidence: 0.9, source: 'slm' });
      repo.upsertTagMapping({ tag: 'auth', doc_id: 'security-pattern', confidence: 0.8, source: 'slm' });

      repo.deleteTagMapping('auth', 'auth-guide');

      const mappings = repo.getTagMappings('auth');
      expect(mappings).toHaveLength(1);
      expect(mappings[0].doc_id).toBe('security-pattern');
    });
  });

  describe('deleteTagMappings', () => {
    it('deletes all mappings for a tag without affecting other tags', () => {
      repo.upsertTagMapping({ tag: 'auth', doc_id: 'auth-guide', confidence: 0.9, source: 'slm' });
      repo.upsertTagMapping({ tag: 'auth', doc_id: 'security-pattern', confidence: 0.8, source: 'slm' });
      repo.upsertTagMapping({ tag: 'security', doc_id: 'security-pattern', confidence: 0.85, source: 'slm' });

      repo.deleteTagMappings('auth');

      expect(repo.getTagMappings('auth')).toEqual([]);
      expect(repo.getTagMappings('security')).toHaveLength(1);
    });
  });

  describe('getAllTags', () => {
    it('returns all unique tags sorted alphabetically', () => {
      repo.upsertTagMapping({ tag: 'security', doc_id: 'auth-guide', confidence: 0.9, source: 'slm' });
      repo.upsertTagMapping({ tag: 'auth', doc_id: 'auth-guide', confidence: 0.9, source: 'slm' });
      repo.upsertTagMapping({ tag: 'auth', doc_id: 'security-pattern', confidence: 0.8, source: 'slm' });
      repo.upsertTagMapping({ tag: 'payment', doc_id: 'payment-guide', confidence: 0.85, source: 'slm' });

      expect(repo.getAllTags()).toEqual(['auth', 'payment', 'security']);
    });

    it('returns empty array when no tags exist', () => {
      expect(repo.getAllTags()).toEqual([]);
    });
  });
});

// ============================================================
// IntentTagger Port
// ============================================================

describe('IntentTagger Port', () => {
  describe('FakeTagger', () => {
    it('returns predefined tags for known plan text', async () => {
      const tagger = new FakeTagger({
        'Add user authentication': [
          { tag: 'auth', confidence: 0.95 },
          { tag: 'security', confidence: 0.8 },
        ],
      });

      const tags = await tagger.extractTags('Add user authentication');
      expect(tags).toHaveLength(2);
      expect(tags[0]).toEqual({ tag: 'auth', confidence: 0.95 });
      expect(tags[1]).toEqual({ tag: 'security', confidence: 0.8 });
    });

    it('returns empty array for unknown plan text', async () => {
      const tagger = new FakeTagger({
        'known': [{ tag: 'x', confidence: 1.0 }],
      });
      expect(await tagger.extractTags('unknown')).toEqual([]);
    });
  });
});

// ============================================================
// Tagger + Repository Integration
// ============================================================

describe('Tagger + Repository Integration', () => {
  let db: Database.Database;
  let repo: Repository;
  let tagger: IntentTagger;

  beforeEach(() => {
    db = createInMemoryDatabase();
    repo = new Repository(db);

    repo.insertDocument({
      doc_id: 'auth-guide', title: 'Auth', kind: 'guideline',
      content: 'auth', content_hash: 'h1', status: 'approved',
    });
    repo.insertDocument({
      doc_id: 'security-pattern', title: 'Security', kind: 'pattern',
      content: 'sec', content_hash: 'h2', status: 'approved',
    });

    repo.setTagMappings('auth', [
      { doc_id: 'auth-guide', confidence: 0.95, source: 'slm' },
    ]);
    repo.setTagMappings('security', [
      { doc_id: 'auth-guide', confidence: 0.8, source: 'slm' },
      { doc_id: 'security-pattern', confidence: 0.9, source: 'slm' },
    ]);

    tagger = new FakeTagger({
      'Add user authentication': [
        { tag: 'auth', confidence: 0.95, reasoning: 'Auth-related task' },
        { tag: 'security', confidence: 0.8, reasoning: 'Security implications' },
      ],
    });
  });

  it('extract tags → resolve documents via tag_mappings', async () => {
    const tags = await tagger.extractTags('Add user authentication');
    const docs = repo.getDocumentsByTags(tags.map(t => t.tag));

    expect(docs).toHaveLength(2);
    expect(docs[0].doc_id).toBe('auth-guide');
    expect(docs[0].matched_tags).toEqual(['auth', 'security']);
    expect(docs[1].doc_id).toBe('security-pattern');
    expect(docs[1].matched_tags).toEqual(['security']);
  });

  it('same tags produce identical results (deterministic)', async () => {
    const tags = await tagger.extractTags('Add user authentication');
    const tagNames = tags.map(t => t.tag);

    const result1 = repo.getDocumentsByTags(tagNames);
    const result2 = repo.getDocumentsByTags(tagNames);

    expect(result1).toEqual(result2);
  });

  it('unknown plan produces no documents', async () => {
    const tags = await tagger.extractTags('Unknown task');
    const docs = repo.getDocumentsByTags(tags.map(t => t.tag));

    expect(docs).toEqual([]);
  });
});
