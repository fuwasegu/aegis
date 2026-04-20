import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PENDING_CONTENT_PLACEHOLDER } from '../types.js';
import {
  type AegisDatabase,
  AlreadyInitializedError,
  CycleDetectedError,
  createDatabase,
  createInMemoryDatabase,
  Repository,
} from './index.js';

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('Repository', () => {
  let db: AegisDatabase;
  let repo: Repository;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
  });

  describe('KnowledgeMeta', () => {
    it('initializes with version 0', () => {
      const meta = repo.getKnowledgeMeta();
      expect(meta.current_version).toBe(0);
    });

    it('reports not initialized when version is 0', () => {
      expect(repo.isInitialized()).toBe(false);
    });
  });

  describe('INV-1: Canonical consistency', () => {
    it('getApprovedDocuments returns only approved docs', () => {
      repo.insertDocument({
        doc_id: 'doc1',
        title: 'T1',
        kind: 'guideline',
        content: 'c1',
        content_hash: hash('c1'),
        status: 'approved',
      });
      repo.insertDocument({
        doc_id: 'doc2',
        title: 'T2',
        kind: 'guideline',
        content: 'c2',
        content_hash: hash('c2'),
        status: 'draft',
      });
      repo.insertDocument({
        doc_id: 'doc3',
        title: 'T3',
        kind: 'guideline',
        content: 'c3',
        content_hash: hash('c3'),
        status: 'proposed',
      });

      const docs = repo.getApprovedDocuments();
      expect(docs).toHaveLength(1);
      expect(docs[0].doc_id).toBe('doc1');
    });
  });

  describe('INV-2: DAG constraint (cycle detection)', () => {
    beforeEach(() => {
      repo.insertDocument({
        doc_id: 'a',
        title: 'A',
        kind: 'guideline',
        content: 'a',
        content_hash: hash('a'),
        status: 'approved',
      });
      repo.insertDocument({
        doc_id: 'b',
        title: 'B',
        kind: 'guideline',
        content: 'b',
        content_hash: hash('b'),
        status: 'approved',
      });
      repo.insertDocument({
        doc_id: 'c',
        title: 'C',
        kind: 'guideline',
        content: 'c',
        content_hash: hash('c'),
        status: 'approved',
      });
    });

    it('detects direct cycle', () => {
      repo.insertEdge({
        edge_id: 'e1',
        source_type: 'doc',
        source_value: 'a',
        target_doc_id: 'b',
        edge_type: 'doc_depends_on',
        priority: 100,
        specificity: 0,
        status: 'approved',
      });
      expect(repo.wouldCreateCycle('b', 'a')).toBe(true);
    });

    it('detects transitive cycle', () => {
      repo.insertEdge({
        edge_id: 'e1',
        source_type: 'doc',
        source_value: 'a',
        target_doc_id: 'b',
        edge_type: 'doc_depends_on',
        priority: 100,
        specificity: 0,
        status: 'approved',
      });
      repo.insertEdge({
        edge_id: 'e2',
        source_type: 'doc',
        source_value: 'b',
        target_doc_id: 'c',
        edge_type: 'doc_depends_on',
        priority: 100,
        specificity: 0,
        status: 'approved',
      });
      expect(repo.wouldCreateCycle('c', 'a')).toBe(true);
    });

    it('allows valid DAG edge', () => {
      repo.insertEdge({
        edge_id: 'e1',
        source_type: 'doc',
        source_value: 'a',
        target_doc_id: 'b',
        edge_type: 'doc_depends_on',
        priority: 100,
        specificity: 0,
        status: 'approved',
      });
      expect(repo.wouldCreateCycle('a', 'c')).toBe(false);
    });
  });

  describe('INV-3 & INV-4: Snapshot immutability and version monotonicity', () => {
    it('creates snapshot and increments version on approve', () => {
      const proposalId = 'prop1';
      repo.insertProposal({
        proposal_id: proposalId,
        proposal_type: 'bootstrap',
        payload: JSON.stringify({
          documents: [{ doc_id: 'doc1', title: 'T', kind: 'guideline', content: 'c', content_hash: hash('c') }],
          edges: [],
          layer_rules: [],
        }),
        status: 'pending',
        review_comment: null,
      });

      const result = repo.approveProposal(proposalId);
      expect(result.knowledge_version).toBe(1);
      expect(result.snapshot_id).toBeTruthy();

      const meta = repo.getKnowledgeMeta();
      expect(meta.current_version).toBe(1);
    });

    it('each approve creates a distinct snapshot with matching knowledge_version', () => {
      // Bootstrap to version 1
      repo.insertProposal({
        proposal_id: 'p-boot',
        proposal_type: 'bootstrap',
        payload: JSON.stringify({
          documents: [{ doc_id: 'doc1', title: 'T', kind: 'guideline', content: 'c1', content_hash: hash('c1') }],
          edges: [],
          layer_rules: [],
        }),
        status: 'pending',
        review_comment: null,
      });
      const v1 = repo.approveProposal('p-boot');

      // Update doc to version 2
      repo.insertProposal({
        proposal_id: 'p-upd',
        proposal_type: 'update_doc',
        payload: JSON.stringify({ doc_id: 'doc1', content: 'c2', content_hash: hash('c2') }),
        status: 'pending',
        review_comment: null,
      });
      const v2 = repo.approveProposal('p-upd');

      expect(v1.knowledge_version).toBe(1);
      expect(v2.knowledge_version).toBe(2);
      expect(v1.snapshot_id).not.toBe(v2.snapshot_id);
    });

    it('getCurrentSnapshot returns the snapshot for current version', () => {
      repo.insertProposal({
        proposal_id: 'p-boot',
        proposal_type: 'bootstrap',
        payload: JSON.stringify({
          documents: [{ doc_id: 'doc1', title: 'T', kind: 'guideline', content: 'c', content_hash: hash('c') }],
          edges: [],
          layer_rules: [],
        }),
        status: 'pending',
        review_comment: null,
      });
      const result = repo.approveProposal('p-boot');

      const snap = repo.getCurrentSnapshot();
      expect(snap).toBeDefined();
      expect(snap!.snapshot_id).toBe(result.snapshot_id);
      expect(snap!.knowledge_version).toBe(1);
    });

    it('getCurrentSnapshot returns undefined when not initialized', () => {
      expect(repo.getCurrentSnapshot()).toBeUndefined();
    });
  });

  describe('Transitive dependencies', () => {
    beforeEach(() => {
      repo.insertDocument({
        doc_id: 'root',
        title: 'Root',
        kind: 'guideline',
        content: 'r',
        content_hash: hash('r'),
        status: 'approved',
      });
      repo.insertDocument({
        doc_id: 'mid',
        title: 'Mid',
        kind: 'guideline',
        content: 'm',
        content_hash: hash('m'),
        status: 'approved',
      });
      repo.insertDocument({
        doc_id: 'leaf',
        title: 'Leaf',
        kind: 'pattern',
        content: 'l',
        content_hash: hash('l'),
        status: 'approved',
      });

      // root -> mid -> leaf
      repo.insertEdge({
        edge_id: 'e1',
        source_type: 'doc',
        source_value: 'root',
        target_doc_id: 'mid',
        edge_type: 'doc_depends_on',
        priority: 100,
        specificity: 0,
        status: 'approved',
      });
      repo.insertEdge({
        edge_id: 'e2',
        source_type: 'doc',
        source_value: 'mid',
        target_doc_id: 'leaf',
        edge_type: 'doc_depends_on',
        priority: 100,
        specificity: 0,
        status: 'approved',
      });
    });

    it('resolves full dependency chain', () => {
      const deps = repo.getTransitiveDependencies(['root']);
      const ids = deps.map((d) => d.doc_id);
      expect(ids).toContain('root');
      expect(ids).toContain('mid');
      expect(ids).toContain('leaf');
    });

    it('includes start nodes at depth 0', () => {
      const deps = repo.getTransitiveDependencies(['root']);
      const rootDep = deps.find((d) => d.doc_id === 'root');
      expect(rootDep?.depth).toBe(0);
    });
  });

  describe('Approve transaction', () => {
    it('rejects approving a non-pending proposal', () => {
      repo.insertProposal({
        proposal_id: 'p1',
        proposal_type: 'new_doc',
        payload: JSON.stringify({ doc_id: 'd1', title: 'T', kind: 'guideline', content: 'c', content_hash: hash('c') }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p1');

      // Try to approve again
      expect(() => repo.approveProposal('p1')).toThrow('not pending');
    });

    it('rejects bootstrap with cycle in doc_depends_on', () => {
      repo.insertProposal({
        proposal_id: 'p1',
        proposal_type: 'bootstrap',
        payload: JSON.stringify({
          documents: [
            { doc_id: 'a', title: 'A', kind: 'guideline', content: 'a', content_hash: hash('a') },
            { doc_id: 'b', title: 'B', kind: 'guideline', content: 'b', content_hash: hash('b') },
          ],
          edges: [
            {
              edge_id: 'e1',
              source_type: 'doc',
              source_value: 'a',
              target_doc_id: 'b',
              edge_type: 'doc_depends_on',
              priority: 100,
              specificity: 0,
            },
            {
              edge_id: 'e2',
              source_type: 'doc',
              source_value: 'b',
              target_doc_id: 'a',
              edge_type: 'doc_depends_on',
              priority: 100,
              specificity: 0,
            },
          ],
          layer_rules: [],
        }),
        status: 'pending',
        review_comment: null,
      });

      expect(() => repo.approveProposal('p1')).toThrow(CycleDetectedError);
    });

    it('rejects add_edge when target document does not exist', () => {
      repo.insertProposal({
        proposal_id: 'p-edge-no-doc',
        proposal_type: 'add_edge',
        payload: JSON.stringify({
          edge_id: 'e-orphan',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'nonexistent-doc',
          edge_type: 'path_requires',
          priority: 100,
          specificity: 0,
        }),
        status: 'pending',
        review_comment: null,
      });

      expect(() => repo.approveProposal('p-edge-no-doc')).toThrow(
        "Cannot add edge: target document 'nonexistent-doc' does not exist",
      );
    });

    it('rejects add_edge when target document is deprecated', () => {
      repo.insertProposal({
        proposal_id: 'p-boot-dep',
        proposal_type: 'bootstrap',
        payload: JSON.stringify({
          template_id: 'test',
          documents: [{ doc_id: 'dep-target', title: 'T', kind: 'guideline', content: 'c', content_hash: hash('c') }],
          edges: [],
          layer_rules: [],
        }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-boot-dep');

      repo.insertProposal({
        proposal_id: 'p-deprecate',
        proposal_type: 'deprecate',
        payload: JSON.stringify({ entity_type: 'document', entity_id: 'dep-target' }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-deprecate');

      repo.insertProposal({
        proposal_id: 'p-edge-dep',
        proposal_type: 'add_edge',
        payload: JSON.stringify({
          edge_id: 'e-dep',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'dep-target',
          edge_type: 'path_requires',
          priority: 100,
          specificity: 0,
        }),
        status: 'pending',
        review_comment: null,
      });

      expect(() => repo.approveProposal('p-edge-dep')).toThrow(
        "Cannot add edge: target document 'dep-target' is not approved",
      );
    });

    it('rejects add_edge when an approved edge already has the same routing', () => {
      repo.insertProposal({
        proposal_id: 'p-boot-path',
        proposal_type: 'bootstrap',
        payload: JSON.stringify({
          documents: [{ doc_id: 'doc-t', title: 'T', kind: 'guideline', content: 'c', content_hash: hash('c') }],
          edges: [
            {
              edge_id: 'e-existing',
              source_type: 'path',
              source_value: 'src/**',
              target_doc_id: 'doc-t',
              edge_type: 'path_requires',
              priority: 100,
              specificity: 0,
            },
          ],
          layer_rules: [],
        }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-boot-path');

      repo.insertProposal({
        proposal_id: 'p-dup-edge',
        proposal_type: 'add_edge',
        payload: JSON.stringify({
          edge_id: 'e-dup',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'doc-t',
          edge_type: 'path_requires',
          priority: 50,
          specificity: 0,
        }),
        status: 'pending',
        review_comment: null,
      });

      expect(() => repo.approveProposal('p-dup-edge')).toThrow(/an approved edge already exists/);
    });

    it('approve retarget_edge updates source_value', () => {
      repo.insertProposal({
        proposal_id: 'p-boot-rt',
        proposal_type: 'bootstrap',
        payload: JSON.stringify({
          documents: [{ doc_id: 'doc-rt', title: 'T', kind: 'guideline', content: 'c', content_hash: hash('c') }],
          edges: [
            {
              edge_id: 'e-rt',
              source_type: 'path',
              source_value: 'old/**',
              target_doc_id: 'doc-rt',
              edge_type: 'path_requires',
              priority: 100,
              specificity: 0,
            },
          ],
          layer_rules: [],
        }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-boot-rt');

      repo.insertProposal({
        proposal_id: 'p-retarget',
        proposal_type: 'retarget_edge',
        payload: JSON.stringify({ edge_id: 'e-rt', source_value: 'new/**' }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-retarget');

      const e = repo.getEdgeById('e-rt');
      expect(e?.source_value).toBe('new/**');
      expect(e?.target_doc_id).toBe('doc-rt');
    });

    it('rejects retarget_edge when no fields change', () => {
      repo.insertProposal({
        proposal_id: 'p-boot-rt2',
        proposal_type: 'bootstrap',
        payload: JSON.stringify({
          documents: [{ doc_id: 'doc-rt2', title: 'T', kind: 'guideline', content: 'c', content_hash: hash('c') }],
          edges: [
            {
              edge_id: 'e-rt2',
              source_type: 'path',
              source_value: 'x/**',
              target_doc_id: 'doc-rt2',
              edge_type: 'path_requires',
              priority: 100,
              specificity: 0,
            },
          ],
          layer_rules: [],
        }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-boot-rt2');

      repo.insertProposal({
        proposal_id: 'p-retarget-nc',
        proposal_type: 'retarget_edge',
        payload: JSON.stringify({ edge_id: 'e-rt2' }),
        status: 'pending',
        review_comment: null,
      });

      expect(() => repo.approveProposal('p-retarget-nc')).toThrow(/no change/);
    });

    it('rejects retarget_edge when routing would duplicate another approved edge', () => {
      repo.insertProposal({
        proposal_id: 'p-boot-2e',
        proposal_type: 'bootstrap',
        payload: JSON.stringify({
          documents: [{ doc_id: 'd-a', title: 'A', kind: 'guideline', content: 'a', content_hash: hash('a') }],
          edges: [
            {
              edge_id: 'e-a',
              source_type: 'path',
              source_value: 'src/a/**',
              target_doc_id: 'd-a',
              edge_type: 'path_requires',
              priority: 100,
              specificity: 0,
            },
            {
              edge_id: 'e-b',
              source_type: 'path',
              source_value: 'src/b/**',
              target_doc_id: 'd-a',
              edge_type: 'path_requires',
              priority: 100,
              specificity: 0,
            },
          ],
          layer_rules: [],
        }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-boot-2e');

      repo.insertProposal({
        proposal_id: 'p-rt-conflict',
        proposal_type: 'retarget_edge',
        payload: JSON.stringify({ edge_id: 'e-b', source_value: 'src/a/**' }),
        status: 'pending',
        review_comment: null,
      });

      expect(() => repo.approveProposal('p-rt-conflict')).toThrow(/an approved edge already exists/);
    });

    it('rejects retarget_edge doc_depends_on when it would create a cycle', () => {
      repo.insertProposal({
        proposal_id: 'p-boot-cycle',
        proposal_type: 'bootstrap',
        payload: JSON.stringify({
          documents: [
            { doc_id: 'dc-a', title: 'A', kind: 'guideline', content: 'a', content_hash: hash('a') },
            { doc_id: 'dc-b', title: 'B', kind: 'guideline', content: 'b', content_hash: hash('b') },
            { doc_id: 'dc-c', title: 'C', kind: 'guideline', content: 'c', content_hash: hash('c') },
            { doc_id: 'dc-d', title: 'D', kind: 'guideline', content: 'd', content_hash: hash('d') },
          ],
          edges: [
            {
              edge_id: 'e-dc-1',
              source_type: 'doc',
              source_value: 'dc-a',
              target_doc_id: 'dc-b',
              edge_type: 'doc_depends_on',
              priority: 100,
              specificity: 0,
            },
            {
              edge_id: 'e-dc-2',
              source_type: 'doc',
              source_value: 'dc-b',
              target_doc_id: 'dc-c',
              edge_type: 'doc_depends_on',
              priority: 100,
              specificity: 0,
            },
            {
              edge_id: 'e-dc-ret',
              source_type: 'doc',
              source_value: 'dc-c',
              target_doc_id: 'dc-d',
              edge_type: 'doc_depends_on',
              priority: 100,
              specificity: 0,
            },
          ],
          layer_rules: [],
        }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-boot-cycle');

      repo.insertProposal({
        proposal_id: 'p-rt-cycle',
        proposal_type: 'retarget_edge',
        payload: JSON.stringify({ edge_id: 'e-dc-ret', target_doc_id: 'dc-a' }),
        status: 'pending',
        review_comment: null,
      });

      expect(() => repo.approveProposal('p-rt-cycle')).toThrow(CycleDetectedError);
    });

    it('approve remove_edge deletes the edge', () => {
      repo.insertProposal({
        proposal_id: 'p-boot-rm',
        proposal_type: 'bootstrap',
        payload: JSON.stringify({
          documents: [{ doc_id: 'doc-rm', title: 'T', kind: 'guideline', content: 'c', content_hash: hash('c') }],
          edges: [
            {
              edge_id: 'e-rm',
              source_type: 'path',
              source_value: 'rm/**',
              target_doc_id: 'doc-rm',
              edge_type: 'path_requires',
              priority: 100,
              specificity: 0,
            },
          ],
          layer_rules: [],
        }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-boot-rm');

      repo.insertProposal({
        proposal_id: 'p-remove',
        proposal_type: 'remove_edge',
        payload: JSON.stringify({ edge_id: 'e-rm' }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-remove');

      expect(repo.getEdgeById('e-rm')).toBeUndefined();
    });

    it('rejects remove_edge when edge does not exist', () => {
      repo.insertProposal({
        proposal_id: 'p-rm-missing',
        proposal_type: 'remove_edge',
        payload: JSON.stringify({ edge_id: 'no-such-edge' }),
        status: 'pending',
        review_comment: null,
      });
      expect(() => repo.approveProposal('p-rm-missing')).toThrow(/does not exist/);
    });

    it('reject proposal records reason', () => {
      repo.insertProposal({
        proposal_id: 'p1',
        proposal_type: 'new_doc',
        payload: JSON.stringify({ doc_id: 'd1', title: 'T', kind: 'guideline', content: 'c', content_hash: hash('c') }),
        status: 'pending',
        review_comment: null,
      });

      repo.rejectProposal('p1', 'Not needed');
      const p = repo.getProposal('p1');
      expect(p?.status).toBe('rejected');
      expect(p?.review_comment).toBe('Not needed');
    });

    it('bootstrap on initialized project throws AlreadyInitializedError', () => {
      // First bootstrap succeeds
      repo.insertProposal({
        proposal_id: 'p-boot1',
        proposal_type: 'bootstrap',
        payload: JSON.stringify({
          documents: [{ doc_id: 'doc1', title: 'T', kind: 'guideline', content: 'c', content_hash: hash('c') }],
          edges: [],
          layer_rules: [],
        }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-boot1');
      expect(repo.isInitialized()).toBe(true);

      // Second bootstrap must fail
      repo.insertProposal({
        proposal_id: 'p-boot2',
        proposal_type: 'bootstrap',
        payload: JSON.stringify({
          documents: [{ doc_id: 'doc2', title: 'T2', kind: 'guideline', content: 'c2', content_hash: hash('c2') }],
          edges: [],
          layer_rules: [],
        }),
        status: 'pending',
        review_comment: null,
      });
      expect(() => repo.approveProposal('p-boot2')).toThrow(AlreadyInitializedError);
    });

    it('update_doc on non-existent document throws error', () => {
      // Bootstrap first to get initialized
      repo.insertProposal({
        proposal_id: 'p-boot',
        proposal_type: 'bootstrap',
        payload: JSON.stringify({
          documents: [{ doc_id: 'doc1', title: 'T', kind: 'guideline', content: 'c', content_hash: hash('c') }],
          edges: [],
          layer_rules: [],
        }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-boot');

      // Try to update a doc that doesn't exist
      repo.insertProposal({
        proposal_id: 'p-upd',
        proposal_type: 'update_doc',
        payload: JSON.stringify({ doc_id: 'nonexistent', content: 'new', content_hash: hash('new') }),
        status: 'pending',
        review_comment: null,
      });
      expect(() => repo.approveProposal('p-upd')).toThrow('not found');
    });

    it('deprecate on non-existent entity throws error', () => {
      // Bootstrap first
      repo.insertProposal({
        proposal_id: 'p-boot',
        proposal_type: 'bootstrap',
        payload: JSON.stringify({
          documents: [{ doc_id: 'doc1', title: 'T', kind: 'guideline', content: 'c', content_hash: hash('c') }],
          edges: [],
          layer_rules: [],
        }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-boot');

      // Try to deprecate a doc that doesn't exist
      repo.insertProposal({
        proposal_id: 'p-dep',
        proposal_type: 'deprecate',
        payload: JSON.stringify({ entity_type: 'document', entity_id: 'nonexistent' }),
        status: 'pending',
        review_comment: null,
      });
      expect(() => repo.approveProposal('p-dep')).toThrow('not found or not approved');
    });

    it('deprecate on already-deprecated entity throws error', () => {
      // Bootstrap
      repo.insertProposal({
        proposal_id: 'p-boot',
        proposal_type: 'bootstrap',
        payload: JSON.stringify({
          documents: [{ doc_id: 'doc1', title: 'T', kind: 'guideline', content: 'c', content_hash: hash('c') }],
          edges: [],
          layer_rules: [],
        }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-boot');

      // Deprecate doc1
      repo.insertProposal({
        proposal_id: 'p-dep1',
        proposal_type: 'deprecate',
        payload: JSON.stringify({ entity_type: 'document', entity_id: 'doc1' }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-dep1');

      // Try to deprecate again - should fail because status is no longer 'approved'
      repo.insertProposal({
        proposal_id: 'p-dep2',
        proposal_type: 'deprecate',
        payload: JSON.stringify({ entity_type: 'document', entity_id: 'doc1' }),
        status: 'pending',
        review_comment: null,
      });
      expect(() => repo.approveProposal('p-dep2')).toThrow('not found or not approved');
    });

    it('deprecate document deletes tag_mappings for that doc', () => {
      repo.insertProposal({
        proposal_id: 'p-boot',
        proposal_type: 'bootstrap',
        payload: JSON.stringify({
          documents: [{ doc_id: 'doc1', title: 'T', kind: 'guideline', content: 'c', content_hash: hash('c') }],
          edges: [],
          layer_rules: [],
        }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-boot');
      repo.upsertTagMapping({ tag: 'routing', doc_id: 'doc1', confidence: 1, source: 'manual' });
      expect(repo.getTagsForDocument('doc1')).toHaveLength(1);

      repo.insertProposal({
        proposal_id: 'p-dep',
        proposal_type: 'deprecate',
        payload: JSON.stringify({ entity_type: 'document', entity_id: 'doc1' }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-dep');
      expect(repo.getTagsForDocument('doc1')).toHaveLength(0);
    });

    it('deprecate with replaced_by_doc_id records replacement on deprecated document', () => {
      repo.insertProposal({
        proposal_id: 'p-boot',
        proposal_type: 'bootstrap',
        payload: JSON.stringify({
          documents: [
            { doc_id: 'old-d', title: 'Old', kind: 'guideline', content: 'a', content_hash: hash('a') },
            { doc_id: 'new-d', title: 'New', kind: 'guideline', content: 'b', content_hash: hash('b') },
          ],
          edges: [],
          layer_rules: [],
        }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-boot');
      repo.upsertTagMapping({ tag: 't', doc_id: 'old-d', confidence: 1, source: 'manual' });

      repo.insertProposal({
        proposal_id: 'p-dep',
        proposal_type: 'deprecate',
        payload: JSON.stringify({
          entity_type: 'document',
          entity_id: 'old-d',
          replaced_by_doc_id: 'new-d',
        }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-dep');

      const oldDoc = repo.getDocumentById('old-d');
      expect(oldDoc?.status).toBe('deprecated');
      expect(oldDoc?.replaced_by_doc_id).toBe('new-d');
      expect(repo.getTagsForDocument('old-d')).toHaveLength(0);
    });

    it('deprecate rejects replaced_by_doc_id that is not an approved document', () => {
      repo.insertProposal({
        proposal_id: 'p-boot',
        proposal_type: 'bootstrap',
        payload: JSON.stringify({
          documents: [{ doc_id: 'doc1', title: 'T', kind: 'guideline', content: 'c', content_hash: hash('c') }],
          edges: [],
          layer_rules: [],
        }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-boot');

      repo.insertProposal({
        proposal_id: 'p-dep-bad',
        proposal_type: 'deprecate',
        payload: JSON.stringify({
          entity_type: 'document',
          entity_id: 'doc1',
          replaced_by_doc_id: 'missing-doc',
        }),
        status: 'pending',
        review_comment: null,
      });
      expect(() => repo.approveProposal('p-dep-bad')).toThrow("replaced_by_doc_id 'missing-doc' must reference");
    });

    it('deprecate rejects replaced_by_doc_id for non-document entity', () => {
      repo.insertProposal({
        proposal_id: 'p-boot',
        proposal_type: 'bootstrap',
        payload: JSON.stringify({
          documents: [{ doc_id: 'doc1', title: 'T', kind: 'guideline', content: 'c', content_hash: hash('c') }],
          edges: [
            {
              edge_id: 'e1',
              source_type: 'path',
              source_value: 'src/**',
              target_doc_id: 'doc1',
              edge_type: 'path_requires',
              priority: 100,
              specificity: 0,
            },
          ],
          layer_rules: [],
        }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-boot');

      repo.insertProposal({
        proposal_id: 'p-dep-edge',
        proposal_type: 'deprecate',
        payload: JSON.stringify({
          entity_type: 'edge',
          entity_id: 'e1',
          replaced_by_doc_id: 'doc1',
        }),
        status: 'pending',
        review_comment: null,
      });
      expect(() => repo.approveProposal('p-dep-edge')).toThrow('replaced_by_doc_id is only valid');
    });

    it('deprecate rejects replaced_by_doc_id equal to deprecated id', () => {
      repo.insertProposal({
        proposal_id: 'p-boot',
        proposal_type: 'bootstrap',
        payload: JSON.stringify({
          documents: [{ doc_id: 'doc1', title: 'T', kind: 'guideline', content: 'c', content_hash: hash('c') }],
          edges: [],
          layer_rules: [],
        }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-boot');

      repo.insertProposal({
        proposal_id: 'p-dep-self',
        proposal_type: 'deprecate',
        payload: JSON.stringify({
          entity_type: 'document',
          entity_id: 'doc1',
          replaced_by_doc_id: 'doc1',
        }),
        status: 'pending',
        review_comment: null,
      });
      expect(() => repo.approveProposal('p-dep-self')).toThrow('cannot equal the deprecated document id');
    });
  });

  describe('source_path support', () => {
    it('inserts and retrieves document with source_path', () => {
      repo.insertDocument({
        doc_id: 'sp-doc',
        title: 'SP',
        kind: 'guideline',
        content: 'c',
        content_hash: hash('c'),
        status: 'approved',
        template_origin: null,
        source_path: '/path/to/file.md',
      });

      const doc = repo.getDocumentById('sp-doc');
      expect(doc?.source_path).toBe('/path/to/file.md');
    });

    it('inserts document with null source_path', () => {
      repo.insertDocument({
        doc_id: 'no-sp',
        title: 'NoSP',
        kind: 'guideline',
        content: 'c',
        content_hash: hash('c'),
        status: 'approved',
        template_origin: null,
        source_path: null,
      });

      const doc = repo.getDocumentById('no-sp');
      expect(doc?.source_path).toBeNull();
    });

    it('getFileAnchoredDocuments returns only approved file-anchored docs', () => {
      repo.insertDocument({
        doc_id: 'anchored',
        title: 'Anchored',
        kind: 'guideline',
        content: 'c1',
        content_hash: hash('c1'),
        status: 'approved',
        ownership: 'file-anchored',
        template_origin: null,
        source_path: '/a.md',
      });
      repo.insertDocument({
        doc_id: 'standalone-with-sp',
        title: 'Standalone with source_path',
        kind: 'guideline',
        content: 'c2',
        content_hash: hash('c2'),
        status: 'approved',
        ownership: 'standalone',
        template_origin: null,
        source_path: '/b.md',
      });
      repo.insertDocument({
        doc_id: 'standalone-no-sp',
        title: 'Standalone no source_path',
        kind: 'guideline',
        content: 'c3',
        content_hash: hash('c3'),
        status: 'approved',
        ownership: 'standalone',
        template_origin: null,
        source_path: null,
      });
      repo.insertDocument({
        doc_id: 'anchored-deprecated',
        title: 'Deprecated anchored',
        kind: 'guideline',
        content: 'c4',
        content_hash: hash('c4'),
        status: 'deprecated',
        ownership: 'file-anchored',
        template_origin: null,
        source_path: '/c.md',
      });

      const result = repo.getFileAnchoredDocuments();
      expect(result).toHaveLength(1);
      expect(result[0].doc_id).toBe('anchored');
    });

    it('_applyUpdateDoc updates deprecated doc to approved', () => {
      repo.insertDocument({
        doc_id: 'dep-doc',
        title: 'Deprecated',
        kind: 'guideline',
        content: 'old',
        content_hash: hash('old'),
        status: 'deprecated',
        template_origin: null,
        source_path: null,
      });

      repo.insertProposal({
        proposal_id: 'p-reactivate',
        proposal_type: 'update_doc',
        payload: JSON.stringify({ doc_id: 'dep-doc', content: 'new', content_hash: hash('new') }),
        status: 'pending',
        review_comment: null,
      });

      repo.approveProposal('p-reactivate');
      const doc = repo.getDocumentById('dep-doc');
      expect(doc?.status).toBe('approved');
      expect(doc?.content).toBe('new');
      expect(doc?.replaced_by_doc_id ?? null).toBeNull();
    });

    it('update_doc clears replaced_by_doc_id after deprecate with replacement', () => {
      repo.insertProposal({
        proposal_id: 'p-boot',
        proposal_type: 'bootstrap',
        payload: JSON.stringify({
          documents: [
            { doc_id: 'old-d', title: 'Old', kind: 'guideline', content: 'a', content_hash: hash('a') },
            { doc_id: 'new-d', title: 'New', kind: 'guideline', content: 'b', content_hash: hash('b') },
          ],
          edges: [],
          layer_rules: [],
        }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-boot');

      repo.insertProposal({
        proposal_id: 'p-dep',
        proposal_type: 'deprecate',
        payload: JSON.stringify({
          entity_type: 'document',
          entity_id: 'old-d',
          replaced_by_doc_id: 'new-d',
        }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-dep');
      expect(repo.getDocumentById('old-d')?.replaced_by_doc_id).toBe('new-d');

      repo.insertProposal({
        proposal_id: 'p-revive',
        proposal_type: 'update_doc',
        payload: JSON.stringify({ doc_id: 'old-d', content: 'revived', content_hash: hash('revived') }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-revive');
      const revived = repo.getDocumentById('old-d');
      expect(revived?.status).toBe('approved');
      expect(revived?.replaced_by_doc_id ?? null).toBeNull();
    });

    it('_applyUpdateDoc supports source_path in payload', () => {
      repo.insertDocument({
        doc_id: 'upd-sp',
        title: 'T',
        kind: 'guideline',
        content: 'c',
        content_hash: hash('c'),
        status: 'approved',
        template_origin: null,
        source_path: null,
      });

      repo.insertProposal({
        proposal_id: 'p-upd-sp',
        proposal_type: 'update_doc',
        payload: JSON.stringify({
          doc_id: 'upd-sp',
          content: 'new',
          content_hash: hash('new'),
          source_path: '/new/path.md',
        }),
        status: 'pending',
        review_comment: null,
      });

      repo.approveProposal('p-upd-sp');
      const doc = repo.getDocumentById('upd-sp');
      expect(doc?.source_path).toBe('/new/path.md');
    });

    it('rejects update_doc approval when modification sets file-anchored without source_path', () => {
      repo.insertDocument({
        doc_id: 'own-mismatch',
        title: 'T',
        kind: 'guideline',
        content: 'c',
        content_hash: hash('c'),
        status: 'approved',
        ownership: 'standalone',
        template_origin: null,
        source_path: null,
      });

      repo.insertProposal({
        proposal_id: 'p-own-bad',
        proposal_type: 'update_doc',
        payload: JSON.stringify({
          doc_id: 'own-mismatch',
          content: 'new',
          content_hash: hash('new'),
        }),
        status: 'pending',
        review_comment: null,
      });

      expect(() => repo.approveProposal('p-own-bad', { ownership: 'file-anchored' })).toThrow(
        /requires a non-empty source_path/,
      );
    });

    it('rejects update_doc approval when modification sets invalid ownership', () => {
      repo.insertDocument({
        doc_id: 'own-typo',
        title: 'T',
        kind: 'guideline',
        content: 'c',
        content_hash: hash('c'),
        status: 'approved',
        ownership: 'standalone',
        template_origin: null,
        source_path: null,
      });

      repo.insertProposal({
        proposal_id: 'p-own-typo',
        proposal_type: 'update_doc',
        payload: JSON.stringify({
          doc_id: 'own-typo',
          content: 'new',
          content_hash: hash('new'),
        }),
        status: 'pending',
        review_comment: null,
      });

      expect(() => repo.approveProposal('p-own-typo', { ownership: 'file_anchored' })).toThrow('Invalid ownership');
    });

    it('rejects new_doc when payload requests file-anchored without source_path', () => {
      repo.insertProposal({
        proposal_id: 'p-new-anchor',
        proposal_type: 'new_doc',
        payload: JSON.stringify({
          doc_id: 'bad-new',
          title: 'T',
          kind: 'guideline',
          content: 'c',
          content_hash: hash('c'),
          ownership: 'file-anchored',
        }),
        status: 'pending',
        review_comment: null,
      });

      expect(() => repo.approveProposal('p-new-anchor')).toThrow(/requires a non-empty source_path/);
    });

    it('rejects source_path outside project when projectRoot is provided (approve)', () => {
      const root = mkdtempSync(join(tmpdir(), 'aegis-repo-'));
      try {
        repo.insertProposal({
          proposal_id: 'p-out',
          proposal_type: 'new_doc',
          payload: JSON.stringify({
            doc_id: 'out-doc',
            title: 'O',
            kind: 'guideline',
            content: 'c',
            content_hash: hash('c'),
          }),
          status: 'pending',
          review_comment: null,
        });
        const outside = join(root, '..', 'totally-outside-partner', 'x.md');
        expect(() => repo.approveProposal('p-out', { source_path: outside }, root)).toThrow(/outside/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('normalizes source_path to repo-relative when projectRoot is provided (approve)', () => {
      const root = mkdtempSync(join(tmpdir(), 'aegis-repo-'));
      try {
        writeFileSync(join(root, 'in-root.md'), '# x');
        repo.insertProposal({
          proposal_id: 'p-rel',
          proposal_type: 'new_doc',
          payload: JSON.stringify({
            doc_id: 'rel-doc',
            title: 'R',
            kind: 'guideline',
            content: 'c',
            content_hash: hash('c'),
          }),
          status: 'pending',
          review_comment: null,
        });
        repo.approveProposal('p-rel', { source_path: join(root, 'in-root.md') }, root);
        const doc = repo.getDocumentById('rel-doc');
        expect(doc?.source_path).toBe('in-root.md');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('new_doc approve sets source_synced_at only when disk file matches payload at approve (ADR-014)', () => {
      const root = mkdtempSync(join(tmpdir(), 'aegis-newdoc-'));
      try {
        const rel = 'docs/n.md';
        const body = 'hello';
        mkdirSync(join(root, 'docs'), { recursive: true });
        writeFileSync(join(root, rel), body, 'utf-8');
        repo.insertProposal({
          proposal_id: 'p-new-sync',
          proposal_type: 'new_doc',
          payload: JSON.stringify({
            doc_id: 'new-sync-doc',
            title: 'S',
            kind: 'guideline',
            content: body,
            content_hash: hash(body),
            ownership: 'file-anchored',
            source_path: rel,
          }),
          status: 'pending',
          review_comment: null,
        });
        repo.approveProposal('p-new-sync', undefined, root);
        expect(repo.getDocumentById('new-sync-doc')?.source_synced_at).toBeTruthy();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('new_doc approve does not set source_synced_at when disk file differs from payload (ADR-014)', () => {
      const root = mkdtempSync(join(tmpdir(), 'aegis-newdoc2-'));
      try {
        const rel = 'docs/changed.md';
        mkdirSync(join(root, 'docs'), { recursive: true });
        writeFileSync(join(root, rel), 'on disk', 'utf-8');
        repo.insertProposal({
          proposal_id: 'p-new-mismatch',
          proposal_type: 'new_doc',
          payload: JSON.stringify({
            doc_id: 'mis-doc',
            title: 'M',
            kind: 'guideline',
            content: 'in proposal',
            content_hash: hash('in proposal'),
            ownership: 'file-anchored',
            source_path: rel,
          }),
          status: 'pending',
          review_comment: null,
        });
        repo.approveProposal('p-new-mismatch', undefined, root);
        expect(repo.getDocumentById('mis-doc')?.source_synced_at).toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('new_doc approve without projectRoot leaves source_synced_at null for file-anchored (ADR-014)', () => {
      repo.insertProposal({
        proposal_id: 'p-new-noroot',
        proposal_type: 'new_doc',
        payload: JSON.stringify({
          doc_id: 'noroot-doc',
          title: 'N',
          kind: 'guideline',
          content: 'c',
          content_hash: hash('c'),
          ownership: 'file-anchored',
          source_path: 'whatever.md',
        }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-new-noroot');
      expect(repo.getDocumentById('noroot-doc')?.source_synced_at).toBeNull();
    });

    it('update_doc approve does not overwrite source_synced_at for file-anchored docs (ADR-014)', () => {
      repo.insertProposal({
        proposal_id: 'p-boot-fa',
        proposal_type: 'bootstrap',
        payload: JSON.stringify({
          documents: [
            {
              doc_id: 'fa-upd',
              title: 'FA',
              kind: 'guideline',
              content: 'body',
              content_hash: hash('body'),
              ownership: 'file-anchored',
              source_path: 'z.md',
              template_origin: null,
            },
          ],
          edges: [],
          layer_rules: [],
        }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-boot-fa');
      db.prepare(`UPDATE documents SET source_synced_at = ? WHERE doc_id = ?`).run(
        '2000-01-01T00:00:00.000Z',
        'fa-upd',
      );

      repo.insertProposal({
        proposal_id: 'p-upd-fa',
        proposal_type: 'update_doc',
        payload: JSON.stringify({
          doc_id: 'fa-upd',
          content: 'new body',
          content_hash: hash('new body'),
        }),
        status: 'pending',
        review_comment: null,
      });
      repo.approveProposal('p-upd-fa');
      expect(repo.getDocumentById('fa-upd')?.source_synced_at).toBe('2000-01-01T00:00:00.000Z');
    });

    it('_applyModifications allows source_path for new_doc and update_doc', () => {
      repo.insertProposal({
        proposal_id: 'p-mod',
        proposal_type: 'new_doc',
        payload: JSON.stringify({
          doc_id: 'mod-doc',
          title: 'T',
          kind: 'guideline',
          content: 'c',
          content_hash: hash('c'),
        }),
        status: 'pending',
        review_comment: null,
      });

      repo.approveProposal('p-mod', { source_path: '/modified/path.md' });
      const doc = repo.getDocumentById('mod-doc');
      expect(doc?.source_path).toBe('/modified/path.md');
    });

    it('update_doc approve applies tag mappings when tags are present', () => {
      repo.insertDocument({
        doc_id: 'tag-upd',
        title: 'T',
        kind: 'guideline',
        content: 'c',
        content_hash: hash('c'),
        status: 'approved',
        template_origin: null,
        source_path: null,
      });

      repo.insertProposal({
        proposal_id: 'p-tag-upd',
        proposal_type: 'update_doc',
        payload: JSON.stringify({
          doc_id: 'tag-upd',
          content: 'new',
          content_hash: hash('new'),
          tags: ['auth', 'security'],
        }),
        status: 'pending',
        review_comment: null,
      });

      repo.approveProposal('p-tag-upd');
      const tags = repo.getTagsForDocument('tag-upd');
      expect(tags.map((t) => t.tag).sort()).toEqual(['auth', 'security']);
    });

    it('rejects update_doc approval when content is placeholder', () => {
      repo.insertDocument({
        doc_id: 'placeholder-doc',
        title: 'T',
        kind: 'guideline',
        content: 'original',
        content_hash: hash('original'),
        status: 'approved',
        template_origin: null,
        source_path: null,
      });

      repo.insertProposal({
        proposal_id: 'p-placeholder',
        proposal_type: 'update_doc',
        payload: JSON.stringify({
          doc_id: 'placeholder-doc',
          content: PENDING_CONTENT_PLACEHOLDER,
          content_hash: hash(PENDING_CONTENT_PLACEHOLDER),
        }),
        status: 'pending',
        review_comment: null,
      });

      expect(() => repo.approveProposal('p-placeholder')).toThrow('content is a placeholder');
    });

    it('allows update_doc approval when placeholder is overwritten via modifications', () => {
      repo.insertDocument({
        doc_id: 'placeholder-doc2',
        title: 'T',
        kind: 'guideline',
        content: 'original',
        content_hash: hash('original'),
        status: 'approved',
        template_origin: null,
        source_path: null,
      });

      repo.insertProposal({
        proposal_id: 'p-placeholder2',
        proposal_type: 'update_doc',
        payload: JSON.stringify({
          doc_id: 'placeholder-doc2',
          content: PENDING_CONTENT_PLACEHOLDER,
          content_hash: hash(PENDING_CONTENT_PLACEHOLDER),
        }),
        status: 'pending',
        review_comment: null,
      });

      const result = repo.approveProposal('p-placeholder2', { content: 'Real content here' });
      expect(result.knowledge_version).toBeGreaterThan(0);
      const doc = repo.getDocumentById('placeholder-doc2');
      expect(doc?.content).toBe('Real content here');
    });
  });

  describe('countActionableObservations', () => {
    it('returns zeros when no observations exist', () => {
      const counts = repo.countActionableObservations();
      expect(counts).toEqual({ pending: 0, skipped: 0 });
    });

    it('counts pending observations (unanalyzed)', () => {
      for (let i = 0; i < 3; i++) {
        repo.insertObservation({
          observation_id: `obs-${i}`,
          event_type: 'compile_miss',
          payload: JSON.stringify({ target_files: ['a.ts'], review_comment: 'miss' }),
          related_compile_id: null,
          related_snapshot_id: null,
        });
      }
      const counts = repo.countActionableObservations();
      expect(counts).toEqual({ pending: 3, skipped: 0 });
    });

    it('counts skipped observations (analyzed but no proposal)', () => {
      for (let i = 0; i < 2; i++) {
        repo.insertObservation({
          observation_id: `obs-skip-${i}`,
          event_type: 'compile_miss',
          payload: JSON.stringify({ target_files: ['a.ts'], review_comment: 'miss' }),
          related_compile_id: null,
          related_snapshot_id: null,
        });
      }
      repo.markObservationsAnalyzed(['obs-skip-0', 'obs-skip-1']);
      const counts = repo.countActionableObservations();
      expect(counts).toEqual({ pending: 0, skipped: 2 });
    });

    it('excludes proposed observations (analyzed with proposal evidence)', () => {
      repo.insertObservation({
        observation_id: 'obs-proposed',
        event_type: 'compile_miss',
        payload: JSON.stringify({ target_files: ['a.ts'], review_comment: 'miss' }),
        related_compile_id: null,
        related_snapshot_id: null,
      });
      repo.markObservationsAnalyzed(['obs-proposed']);
      repo.insertProposal({
        proposal_id: 'p1',
        proposal_type: 'add_edge',
        payload: '{}',
        status: 'pending',
        review_comment: null,
      });
      repo.insertProposalEvidence('p1', 'obs-proposed');

      const counts = repo.countActionableObservations();
      expect(counts).toEqual({ pending: 0, skipped: 0 });
    });

    it('excludes archived observations', () => {
      for (let i = 0; i < 3; i++) {
        repo.insertObservation({
          observation_id: `obs-arch-${i}`,
          event_type: 'compile_miss',
          payload: JSON.stringify({ target_files: ['a.ts'], review_comment: 'miss' }),
          related_compile_id: null,
          related_snapshot_id: null,
        });
      }

      const before = repo.countActionableObservations();
      expect(before.pending).toBe(3);

      // Simulate archival by marking analyzed + archiving via SQL
      repo.markObservationsAnalyzed(['obs-arch-0', 'obs-arch-1', 'obs-arch-2']);
      // Use the underlying db to set archived_at directly for reliable testing
      (repo as any).db
        .prepare("UPDATE observations SET archived_at = datetime('now') WHERE observation_id LIKE 'obs-arch-%'")
        .run();

      const counts = repo.countActionableObservations();
      expect(counts).toEqual({ pending: 0, skipped: 0 });
    });
  });

  describe('claimUnanalyzedObservations (file-backed)', () => {
    let tmpDir: string;
    let dbPath: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'aegis-claim-'));
      dbPath = join(tmpDir, 'x.db');
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('second DB connection cannot claim rows already claimed by the first', async () => {
      const db0 = await createDatabase(dbPath);
      const r0 = new Repository(db0);
      r0.insertObservation({
        observation_id: 'o-dual-claim',
        event_type: 'compile_miss',
        payload: JSON.stringify({ target_files: ['a.ts'], review_comment: 'x' }),
        related_compile_id: null,
        related_snapshot_id: null,
      });
      db0.close();

      const dbA = await createDatabase(dbPath);
      const dbB = await createDatabase(dbPath);
      const rA = new Repository(dbA);
      const rB = new Repository(dbB);

      const claimedA = rA.claimUnanalyzedObservations('compile_miss', 50);
      const claimedB = rB.claimUnanalyzedObservations('compile_miss', 50);

      expect(claimedA.map((o) => o.observation_id)).toEqual(['o-dual-claim']);
      expect(claimedB).toHaveLength(0);

      dbA.close();
      dbB.close();
    });
  });

  describe('Proposal bundle (ADR-015)', () => {
    it('preflight succeeds and approve applies ordered new_doc then add_edge with single version bump', () => {
      repo.insertDocument({
        doc_id: 'anchor',
        title: 'A',
        kind: 'guideline',
        content: 'c',
        content_hash: hash('c'),
        status: 'approved',
      });

      const bundleId = 'bundle-test-1';
      repo.insertProposal({
        proposal_id: 'p-edge',
        proposal_type: 'add_edge',
        payload: JSON.stringify({
          edge_id: 'e-bundle-1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'nd1',
          edge_type: 'path_requires',
          priority: 100,
          specificity: 0,
        }),
        status: 'pending',
        review_comment: null,
        bundle_id: bundleId,
      });
      repo.insertProposal({
        proposal_id: 'p-new',
        proposal_type: 'new_doc',
        payload: JSON.stringify({
          doc_id: 'nd1',
          title: 'N',
          kind: 'guideline',
          content: 'nc',
          content_hash: hash('nc'),
        }),
        status: 'pending',
        review_comment: null,
        bundle_id: bundleId,
      });

      const pf = repo.preflightProposalBundle(bundleId);
      expect(pf.ok).toBe(true);
      expect(pf.leaves.every((l) => l.ok)).toBe(true);
      expect(pf.ordered_proposal_ids[0]).toBe('p-new');
      expect(pf.ordered_proposal_ids[1]).toBe('p-edge');

      const v0 = repo.getKnowledgeMeta().current_version;
      const out = repo.approveProposalBundle(bundleId);
      const v1 = repo.getKnowledgeMeta().current_version;
      expect(v1).toBe(v0 + 1);
      expect(out.knowledge_version).toBe(v1);

      expect(repo.getProposal('p-new')?.status).toBe('approved');
      expect(repo.getProposal('p-edge')?.status).toBe('approved');
      expect(repo.getDocumentById('nd1')?.status).toBe('approved');
      expect(repo.getEdgeById('e-bundle-1')?.status).toBe('approved');
    });

    it('preflight and approve retarget_edge for doc-typed source in a bundle', () => {
      for (const id of ['d1', 'd2', 'd3']) {
        repo.insertDocument({
          doc_id: id,
          title: id,
          kind: 'guideline',
          content: 'c',
          content_hash: hash('c'),
          status: 'approved',
        });
      }
      repo.insertEdge({
        edge_id: 'e-rt-doc',
        source_type: 'doc',
        source_value: 'd1',
        target_doc_id: 'd2',
        edge_type: 'doc_depends_on',
        priority: 5,
        specificity: 0,
        status: 'approved',
      });
      const bundleId = 'bundle-rt-doc-src';
      repo.insertProposal({
        proposal_id: 'p-rt-doc',
        proposal_type: 'retarget_edge',
        payload: JSON.stringify({ edge_id: 'e-rt-doc', source_value: 'd3' }),
        status: 'pending',
        review_comment: null,
        bundle_id: bundleId,
      });

      const pf = repo.preflightProposalBundle(bundleId);
      expect(pf.ok).toBe(true);

      repo.approveProposalBundle(bundleId);
      const e = repo.getEdgeById('e-rt-doc');
      expect(e?.source_value).toBe('d3');
      expect(e?.source_type).toBe('doc');
      expect(e?.target_doc_id).toBe('d2');
    });

    it('preflight isolates each leaf when ordering fails so a valid new_doc still reports ok beside a broken add_edge', () => {
      const bundleId = 'bundle-order-fail-mixed';
      repo.insertProposal({
        proposal_id: 'p-new-iso',
        proposal_type: 'new_doc',
        payload: JSON.stringify({
          doc_id: 'nd-iso-mix',
          title: 'Isolates',
          kind: 'guideline',
          content: 'x',
          content_hash: hash('x'),
        }),
        status: 'pending',
        review_comment: null,
        bundle_id: bundleId,
      });
      repo.insertProposal({
        proposal_id: 'p-edge-bad',
        proposal_type: 'add_edge',
        payload: JSON.stringify({
          edge_id: 'e-mix-bad',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'not-in-canon',
          edge_type: 'path_requires',
          priority: 100,
          specificity: 0,
        }),
        status: 'pending',
        review_comment: null,
        bundle_id: bundleId,
      });
      const pf = repo.preflightProposalBundle(bundleId);
      expect(pf.ok).toBe(false);
      expect(pf.ordering_error).toBeTruthy();
      expect(pf.leaves).toHaveLength(2);
      const leafNew = pf.leaves.find((l) => l.proposal_id === 'p-new-iso');
      const leafEdge = pf.leaves.find((l) => l.proposal_id === 'p-edge-bad');
      expect(leafNew?.ok).toBe(true);
      expect(leafEdge?.ok).toBe(false);
    });

    it('preflight returns ordering_error when add_edge target is missing from Canonical and bundle', () => {
      const bundleId = 'bundle-bad';
      repo.insertProposal({
        proposal_id: 'p-edge-only',
        proposal_type: 'add_edge',
        payload: JSON.stringify({
          edge_id: 'e-no-doc',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'missing-doc',
          edge_type: 'path_requires',
          priority: 100,
          specificity: 0,
        }),
        status: 'pending',
        review_comment: null,
        bundle_id: bundleId,
      });

      const pf = repo.preflightProposalBundle(bundleId);
      expect(pf.ok).toBe(false);
      expect(pf.ordering_error).toBeTruthy();
      expect(pf.leaves.every((l) => !l.ok)).toBe(true);
      expect(() => repo.approveProposalBundle(bundleId)).toThrow();
    });

    it('preflight returns ordering_error when add_edge has source_type doc but source document is missing', () => {
      repo.insertDocument({
        doc_id: 'target-only',
        title: 'T',
        kind: 'guideline',
        content: 'c',
        content_hash: hash('c'),
        status: 'approved',
      });
      const bundleId = 'bundle-missing-src-doc';
      repo.insertProposal({
        proposal_id: 'p-doc-edge',
        proposal_type: 'add_edge',
        payload: JSON.stringify({
          edge_id: 'e-doc-src',
          source_type: 'doc',
          source_value: 'no-such-doc',
          target_doc_id: 'target-only',
          edge_type: 'doc_depends_on',
          priority: 100,
          specificity: 0,
        }),
        status: 'pending',
        review_comment: null,
        bundle_id: bundleId,
      });

      const pf = repo.preflightProposalBundle(bundleId);
      expect(pf.ok).toBe(false);
      expect(pf.ordering_error).toBeTruthy();
      expect(() => repo.approveProposalBundle(bundleId)).toThrow();
    });

    it('preflight and approve succeed when doc_depends_on source doc is created by new_doc in the same bundle', () => {
      repo.insertDocument({
        doc_id: 'tgt-anchor',
        title: 'T',
        kind: 'guideline',
        content: 'c',
        content_hash: hash('c'),
        status: 'approved',
      });
      const bundleId = 'bundle-doc-src-chain';
      repo.insertProposal({
        proposal_id: 'p-new-src',
        proposal_type: 'new_doc',
        payload: JSON.stringify({
          doc_id: 'src-bundle',
          title: 'S',
          kind: 'guideline',
          content: 's',
          content_hash: hash('s'),
        }),
        status: 'pending',
        review_comment: null,
        bundle_id: bundleId,
      });
      repo.insertProposal({
        proposal_id: 'p-edge-dd',
        proposal_type: 'add_edge',
        payload: JSON.stringify({
          edge_id: 'e-dd-1',
          source_type: 'doc',
          source_value: 'src-bundle',
          target_doc_id: 'tgt-anchor',
          edge_type: 'doc_depends_on',
          priority: 10,
          specificity: 0,
        }),
        status: 'pending',
        review_comment: null,
        bundle_id: bundleId,
      });

      const pf = repo.preflightProposalBundle(bundleId);
      expect(pf.ok).toBe(true);
      expect(pf.ordered_proposal_ids[0]).toBe('p-new-src');
      expect(pf.ordered_proposal_ids[1]).toBe('p-edge-dd');
      repo.approveProposalBundle(bundleId);
      expect(repo.getEdgeById('e-dd-1')?.status).toBe('approved');
      expect(repo.getEdgeById('e-dd-1')?.source_type).toBe('doc');
      expect(repo.getEdgeById('e-dd-1')?.source_value).toBe('src-bundle');
    });

    it('bundle orders update_doc on deprecated doc before add_edge that references it as doc source', () => {
      repo.insertDocument({
        doc_id: 'src-dep',
        title: 'Was dep',
        kind: 'guideline',
        content: 'old',
        content_hash: hash('old'),
        status: 'deprecated',
      });
      repo.insertDocument({
        doc_id: 'tgt-a',
        title: 'Anchor',
        kind: 'guideline',
        content: 'c',
        content_hash: hash('c'),
        status: 'approved',
      });
      const bundleId = 'bundle-upd-then-edge';
      repo.insertProposal({
        proposal_id: 'p-upd-dep',
        proposal_type: 'update_doc',
        payload: JSON.stringify({
          doc_id: 'src-dep',
          content: 'revived',
          content_hash: hash('revived'),
        }),
        status: 'pending',
        review_comment: null,
        bundle_id: bundleId,
      });
      repo.insertProposal({
        proposal_id: 'p-edge-after',
        proposal_type: 'add_edge',
        payload: JSON.stringify({
          edge_id: 'e-after-upd',
          source_type: 'doc',
          source_value: 'src-dep',
          target_doc_id: 'tgt-a',
          edge_type: 'doc_depends_on',
          priority: 5,
          specificity: 0,
        }),
        status: 'pending',
        review_comment: null,
        bundle_id: bundleId,
      });

      const pf = repo.preflightProposalBundle(bundleId);
      expect(pf.ok).toBe(true);
      expect(pf.ordered_proposal_ids[0]).toBe('p-upd-dep');
      expect(pf.ordered_proposal_ids[1]).toBe('p-edge-after');

      repo.approveProposalBundle(bundleId);
      expect(repo.getDocumentById('src-dep')?.status).toBe('approved');
      expect(repo.getEdgeById('e-after-upd')?.status).toBe('approved');
    });

    it('reject approveProposal when proposal has bundle_id', () => {
      repo.insertProposal({
        proposal_id: 'p-bundled',
        proposal_type: 'new_doc',
        payload: JSON.stringify({
          doc_id: 'solo',
          title: 'S',
          kind: 'guideline',
          content: 'z',
          content_hash: hash('z'),
        }),
        status: 'pending',
        review_comment: null,
        bundle_id: 'b-x',
      });
      expect(() => repo.approveProposal('p-bundled')).toThrow('approveProposalBundle');
    });

    it('preflight rolls back partial mutations when the second leaf fails', () => {
      const bundleId = 'bundle-partial-fail';
      repo.insertProposal({
        proposal_id: 'p-new-doc-only',
        proposal_type: 'new_doc',
        payload: JSON.stringify({
          doc_id: 'okdoc',
          title: 'Ok',
          kind: 'guideline',
          content: 'x',
          content_hash: hash('x'),
        }),
        status: 'pending',
        review_comment: null,
        bundle_id: bundleId,
      });
      repo.insertProposal({
        proposal_id: 'p-update-ph',
        proposal_type: 'update_doc',
        payload: JSON.stringify({
          doc_id: 'okdoc',
          content: PENDING_CONTENT_PLACEHOLDER,
          content_hash: hash(PENDING_CONTENT_PLACEHOLDER),
        }),
        status: 'pending',
        review_comment: null,
        bundle_id: bundleId,
      });

      const pf = repo.preflightProposalBundle(bundleId);
      expect(pf.ok).toBe(false);
      expect(pf.leaves).toHaveLength(2);
      expect(pf.leaves[0].ok).toBe(true);
      expect(pf.leaves[1].ok).toBe(false);
      expect(pf.leaves[1].error).toContain('placeholder');
      expect(repo.getDocumentById('okdoc')).toBeUndefined();
    });

    it('preflight continues validating later leaves after a leaf fails', () => {
      const bundleId = 'bundle-three-leaf';
      repo.insertProposal({
        proposal_id: 'p-1-new',
        proposal_type: 'new_doc',
        payload: JSON.stringify({
          doc_id: 'tri',
          title: 'T',
          kind: 'guideline',
          content: 'a',
          content_hash: hash('a'),
        }),
        status: 'pending',
        review_comment: null,
        bundle_id: bundleId,
      });
      repo.insertProposal({
        proposal_id: 'p-2-upd',
        proposal_type: 'update_doc',
        payload: JSON.stringify({
          doc_id: 'tri',
          content: PENDING_CONTENT_PLACEHOLDER,
          content_hash: hash(PENDING_CONTENT_PLACEHOLDER),
        }),
        status: 'pending',
        review_comment: null,
        bundle_id: bundleId,
      });
      repo.insertProposal({
        proposal_id: 'p-3-edge',
        proposal_type: 'add_edge',
        payload: JSON.stringify({
          edge_id: 'e-tri',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'tri',
          edge_type: 'path_requires',
          priority: 100,
          specificity: 0,
        }),
        status: 'pending',
        review_comment: null,
        bundle_id: bundleId,
      });

      const pf = repo.preflightProposalBundle(bundleId);
      expect(pf.leaves).toHaveLength(3);
      expect(pf.leaves[0].ok).toBe(true);
      expect(pf.leaves[1].ok).toBe(false);
      expect(pf.leaves[2].ok).toBe(true);
      expect(pf.ok).toBe(false);
    });

    it('preflight returns leaf error for invalid JSON payload', () => {
      const bundleId = 'bundle-json';
      repo.insertProposal({
        proposal_id: 'p-json-bad',
        proposal_type: 'new_doc',
        payload: '{"doc_id": broken',
        status: 'pending',
        review_comment: null,
        bundle_id: bundleId,
      });

      const pf = repo.preflightProposalBundle(bundleId);
      expect(pf.leaves).toHaveLength(1);
      expect(pf.leaves[0].ok).toBe(false);
      expect(pf.leaves[0].error).toContain('JSON');
    });

    it('preflight returns leaf error when source_path escapes projectRoot', () => {
      const root = mkdtempSync(join(tmpdir(), 'aegis-bundle-pf-'));
      try {
        const bundleId = 'bundle-escape';
        repo.insertProposal({
          proposal_id: 'p-esc',
          proposal_type: 'new_doc',
          payload: JSON.stringify({
            doc_id: 'esc-doc',
            title: 'E',
            kind: 'guideline',
            content: 'c',
            content_hash: hash('c'),
            ownership: 'file-anchored',
            source_path: join(root, '..', 'outside-secret', 'x.md'),
          }),
          status: 'pending',
          review_comment: null,
          bundle_id: bundleId,
        });

        const pf = repo.preflightProposalBundle(bundleId, root);
        expect(pf.leaves).toHaveLength(1);
        expect(pf.leaves[0].ok).toBe(false);
        expect(pf.leaves[0].error).toMatch(/outside|project/i);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('preflight: invalid JSON leaf does not mask a valid sibling leaf result', () => {
      const bundleId = 'bundle-mixed-json';
      repo.insertProposal({
        proposal_id: 'p-x',
        proposal_type: 'new_doc',
        payload: 'not-json{',
        status: 'pending',
        review_comment: null,
        bundle_id: bundleId,
      });
      repo.insertProposal({
        proposal_id: 'p-y',
        proposal_type: 'new_doc',
        payload: JSON.stringify({
          doc_id: 'mixed-ok',
          title: 'M',
          kind: 'guideline',
          content: 'mm',
          content_hash: hash('mm'),
        }),
        status: 'pending',
        review_comment: null,
        bundle_id: bundleId,
      });

      const pf = repo.preflightProposalBundle(bundleId);
      expect(pf.leaves).toHaveLength(2);
      expect(pf.leaves[0].ok).toBe(false);
      expect(pf.leaves[0].error).toMatch(/JSON/i);
      expect(pf.leaves[1].ok).toBe(true);
      expect(pf.ok).toBe(false);
    });

    it('reject bundle mixing deprecate(document) with update_doc on the same doc', () => {
      repo.insertDocument({
        doc_id: 'dep-mix',
        title: 'D',
        kind: 'guideline',
        content: 'c',
        content_hash: hash('c'),
        status: 'approved',
      });
      const bundleId = 'bundle-dep-upd';
      repo.insertProposal({
        proposal_id: 'p-dep-m',
        proposal_type: 'deprecate',
        payload: JSON.stringify({ entity_type: 'document', entity_id: 'dep-mix' }),
        status: 'pending',
        review_comment: null,
        bundle_id: bundleId,
      });
      repo.insertProposal({
        proposal_id: 'p-up-m',
        proposal_type: 'update_doc',
        payload: JSON.stringify({
          doc_id: 'dep-mix',
          content: 'new body',
          content_hash: hash('new body'),
        }),
        status: 'pending',
        review_comment: null,
        bundle_id: bundleId,
      });

      const pf = repo.preflightProposalBundle(bundleId);
      expect(pf.ordering_error).toMatch(/Bundle conflict/i);
      expect(() => repo.approveProposalBundle(bundleId)).toThrow(/Bundle conflict/i);
    });

    it('reject bundle mixing deprecate(document) with add_edge whose doc source is that document', () => {
      repo.insertDocument({
        doc_id: 'anchor-ae',
        title: 'A',
        kind: 'guideline',
        content: 'c',
        content_hash: hash('c'),
        status: 'approved',
      });
      repo.insertDocument({
        doc_id: 'src-ae',
        title: 'S',
        kind: 'guideline',
        content: 's',
        content_hash: hash('s'),
        status: 'approved',
      });
      const bundleId = 'bundle-dep-add-doc-src';
      repo.insertProposal({
        proposal_id: 'p-dep-ae',
        proposal_type: 'deprecate',
        payload: JSON.stringify({ entity_type: 'document', entity_id: 'src-ae' }),
        status: 'pending',
        review_comment: null,
        bundle_id: bundleId,
      });
      repo.insertProposal({
        proposal_id: 'p-ae',
        proposal_type: 'add_edge',
        payload: JSON.stringify({
          edge_id: 'e-dep-src',
          source_type: 'doc',
          source_value: 'src-ae',
          target_doc_id: 'anchor-ae',
          edge_type: 'doc_depends_on',
          priority: 1,
          specificity: 0,
        }),
        status: 'pending',
        review_comment: null,
        bundle_id: bundleId,
      });

      const pf = repo.preflightProposalBundle(bundleId);
      expect(pf.ordering_error).toMatch(/Bundle conflict/i);
      expect(() => repo.approveProposalBundle(bundleId)).toThrow(/Bundle conflict/i);
    });

    it('reject bundle mixing deprecate(document) with retarget_edge that still uses that document as doc source', () => {
      repo.insertDocument({
        doc_id: 'anchor-rt',
        title: 'A',
        kind: 'guideline',
        content: 'c',
        content_hash: hash('c'),
        status: 'approved',
      });
      repo.insertDocument({
        doc_id: 'src-rt',
        title: 'S',
        kind: 'guideline',
        content: 's',
        content_hash: hash('s'),
        status: 'approved',
      });
      repo.insertDocument({
        doc_id: 'other-rt',
        title: 'O',
        kind: 'guideline',
        content: 'o',
        content_hash: hash('o'),
        status: 'approved',
      });
      repo.insertEdge({
        edge_id: 'e-rt-dep',
        source_type: 'doc',
        source_value: 'src-rt',
        target_doc_id: 'anchor-rt',
        edge_type: 'doc_depends_on',
        priority: 1,
        specificity: 0,
        status: 'approved',
      });
      const bundleId = 'bundle-dep-rt-src';
      repo.insertProposal({
        proposal_id: 'p-dep-rt',
        proposal_type: 'deprecate',
        payload: JSON.stringify({ entity_type: 'document', entity_id: 'src-rt' }),
        status: 'pending',
        review_comment: null,
        bundle_id: bundleId,
      });
      repo.insertProposal({
        proposal_id: 'p-rt',
        proposal_type: 'retarget_edge',
        payload: JSON.stringify({ edge_id: 'e-rt-dep', target_doc_id: 'other-rt' }),
        status: 'pending',
        review_comment: null,
        bundle_id: bundleId,
      });

      const pf = repo.preflightProposalBundle(bundleId);
      expect(pf.ordering_error).toMatch(/Bundle conflict/i);
      expect(() => repo.approveProposalBundle(bundleId)).toThrow(/Bundle conflict/i);
    });
  });

  describe('Adapter Meta', () => {
    it('returns undefined when no meta is set', () => {
      expect(repo.getAdapterMeta()).toBeUndefined();
    });

    it('upserts and retrieves adapter meta', () => {
      repo.upsertAdapterMeta('1.0.0');
      const meta = repo.getAdapterMeta();
      expect(meta).toBeDefined();
      expect(meta!.deployed_version).toBe('1.0.0');
      expect(meta!.deployed_at).toBeTruthy();
    });

    it('updates version on re-upsert', () => {
      repo.upsertAdapterMeta('1.0.0');
      repo.upsertAdapterMeta('2.0.0');
      const meta = repo.getAdapterMeta();
      expect(meta!.deployed_version).toBe('2.0.0');
    });
  });

  describe('Co-change cache (ADR-015 Task 015-08)', () => {
    it('persistCoChangeCache replaces rows and advances last_processed_commit together', () => {
      expect(repo.getCoChangeLastProcessedCommit()).toBeNull();

      repo.persistCoChangeCache(
        [
          {
            code_pattern: 'src/**',
            doc_pattern: 'docs/**',
            co_change_count: 2,
            total_code_changes: 2,
            confidence: 1,
          },
        ],
        new Map([['src/**', 2]]),
        'deadbeef',
        'fp-one',
      );

      expect(repo.listCoChangePatterns()).toHaveLength(1);
      expect(repo.getCoChangeLastProcessedCommit()).toBe('deadbeef');
      expect(repo.getCoChangeKbFingerprint()).toBe('fp-one');
      expect(repo.listCoChangeCodeTotals().get('src/**')).toBe(2);

      repo.persistCoChangeCache([], new Map(), 'cafe', 'fp-two');
      expect(repo.listCoChangePatterns()).toHaveLength(0);
      expect(repo.getCoChangeLastProcessedCommit()).toBe('cafe');
      expect(repo.getCoChangeKbFingerprint()).toBe('fp-two');
      expect(repo.listCoChangeCodeTotals().size).toBe(0);
    });

    it('clearCoChangeCache wipes patterns and meta pointers', () => {
      repo.persistCoChangeCache(
        [
          {
            code_pattern: 'a/**',
            doc_pattern: 'b/**',
            co_change_count: 1,
            total_code_changes: 1,
            confidence: 1,
          },
        ],
        new Map([['a/**', 1]]),
        'abc',
        'fp',
      );
      repo.clearCoChangeCache();
      expect(repo.listCoChangePatterns()).toHaveLength(0);
      expect(repo.listCoChangeCodeTotals().size).toBe(0);
      expect(repo.getCoChangeLastProcessedCommit()).toBeNull();
      expect(repo.getCoChangeKbFingerprint()).toBeNull();
    });
  });
});
