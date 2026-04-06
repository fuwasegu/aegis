import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
});
