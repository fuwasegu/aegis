import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOC_REFACTOR_ALGORITHM_VERSION } from '../core/optimization/doc-refactor.js';
import { type AegisDatabase, createInMemoryDatabase, Repository } from '../core/store/index.js';
import { buildObserveContent } from './server.js';
import { AegisService, ObserveValidationError, SurfaceViolationError } from './services.js';

const TEMPLATES_ROOT = join(import.meta.dirname, '../../templates');

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Creates a minimal laravel-ddd test template in the given dir. */
function createLaravelTestTemplate(dir: string): void {
  const templateDir = join(dir, 'laravel-ddd');
  mkdirSync(join(templateDir, 'documents'), { recursive: true });
  writeFileSync(
    join(templateDir, 'manifest.yaml'),
    `template_id: laravel-ddd
version: "0.1.0"
display_name: "Laravel DDD"
description: "Test template for Laravel DDD"

detect_signals:
  required:
    - type: file_exists
      path: composer.json
  boosters:
    - type: package_dependency
      file: composer.json
      key: require
      pattern: laravel
      weight: 50
  confidence_thresholds:
    high: 50
    medium: 10

placeholders:
  src_root:
    description: "Source root"
    required: true
    detect_strategy: first_match
    candidates:
      - app
      - src
    ambiguity_policy: first
    default: app

seed_documents:
  - doc_id: laravel-entity-guidelines
    title: "Entity Guidelines"
    kind: guideline
    file: entity.md

seed_edges:
  - source_type: path
    source_value: "{{src_root}}/Domain/**"
    target_doc_id: laravel-entity-guidelines
    edge_type: path_requires
    priority: 100

seed_layer_rules: []
`,
  );
  writeFileSync(join(templateDir, 'documents', 'entity.md'), '# Entity Guidelines\n\nDDD entity patterns.');
}

function createLaravelProject(root: string): void {
  writeFileSync(
    join(root, 'composer.json'),
    JSON.stringify({
      require: { 'laravel/framework': '^11.0' },
    }),
  );
  mkdirSync(join(root, 'app/Domain/User/Entities'), { recursive: true });
  mkdirSync(join(root, 'app/UseCases'), { recursive: true });
}

describe('AegisService — Surface Authorization', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let service: AegisService;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    service = new AegisService(repo, TEMPLATES_ROOT);
  });

  // ── 1. Agent Surface から approve/init_confirm を呼べない ──

  it('agent surface cannot call approve_proposal', () => {
    // Setup: create a proposal to approve
    repo.insertProposal({
      proposal_id: 'p1',
      proposal_type: 'new_doc',
      payload: JSON.stringify({ doc_id: 'd1', title: 'T', kind: 'guideline', content: 'c', content_hash: hash('c') }),
      status: 'pending',
      review_comment: null,
    });

    expect(() => service.approveProposal('p1', undefined, 'agent')).toThrow(SurfaceViolationError);
  });

  it('agent surface cannot call reject_proposal', () => {
    repo.insertProposal({
      proposal_id: 'p1',
      proposal_type: 'new_doc',
      payload: JSON.stringify({ doc_id: 'd1', title: 'T', kind: 'guideline', content: 'c', content_hash: hash('c') }),
      status: 'pending',
      review_comment: null,
    });

    expect(() => service.rejectProposal('p1', 'nope', 'agent')).toThrow(SurfaceViolationError);
  });

  it('agent surface cannot call init_confirm', () => {
    expect(() => service.initConfirm('some-hash', 'agent')).toThrow(SurfaceViolationError);
  });

  it('agent surface cannot call list_proposals', () => {
    expect(() => service.listProposals({}, 'agent')).toThrow(SurfaceViolationError);
  });

  it('agent surface cannot call get_proposal', () => {
    expect(() => service.getProposal('p1', 'agent')).toThrow(SurfaceViolationError);
  });

  it('agent surface can call init_detect (read-only preview)', () => {
    const preview = service.initDetect('/tmp', 'agent');
    expect(preview).toBeDefined();
    expect(typeof preview.preview_hash).toBe('string');
  });

  // ── Agent surface CAN call read-only and observation tools ──

  it('agent surface can call compile_context', async () => {
    // Uninitialized — should return warnings but not throw
    const result = await service.compileContext({ target_files: ['src/a.ts'] }, 'agent');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('agent surface can call observe', () => {
    const result = service.observe(
      {
        event_type: 'manual_note',
        payload: { content: 'test note' },
      },
      'agent',
    );
    expect(result.observation_id).toBeTruthy();
  });

  it('agent surface can call get_compile_audit', () => {
    // Non-existent compile_id — returns undefined, not throw
    const result = service.getCompileAudit('nonexistent', 'agent');
    expect(result).toBeUndefined();
  });

  it('agent surface can call get_known_tags (read-only)', () => {
    const result = service.getKnownTags('agent');
    expect(result.tags).toEqual([]);
    expect(result.knowledge_version).toBe(0);
    expect(result.tag_catalog_hash).toHaveLength(64);
  });

  it('agent surface can call workspace_status (read-only)', () => {
    const ws = service.workspaceStatus('agent');
    expect(ws.pending_proposal_count).toBe(0);
    expect(ws.window_hours).toBe(24);
    expect(ws.unresolved_misses).toEqual([]);
  });
});

describe('AegisService — getKnownTags', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let service: AegisService;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    service = new AegisService(repo, TEMPLATES_ROOT);
  });

  it('returns empty catalog with version 0 and deterministic SHA-256 hash', () => {
    const r = service.getKnownTags('agent');
    expect(r.tags).toEqual([]);
    expect(r.knowledge_version).toBe(0);
    expect(r.tag_catalog_hash).toBe(createHash('sha256').update(JSON.stringify([]), 'utf8').digest('hex'));
  });

  it('returns sorted distinct tags and changes hash when catalog changes', () => {
    repo.insertDocument({
      doc_id: 'd1',
      title: 'T',
      kind: 'guideline',
      content: 'c',
      content_hash: hash('c'),
      status: 'approved',
    });
    repo.upsertTagMapping({ tag: 'zebra', doc_id: 'd1', confidence: 1, source: 'manual' });
    repo.upsertTagMapping({ tag: 'alpha', doc_id: 'd1', confidence: 1, source: 'manual' });

    const r = service.getKnownTags('admin');
    expect(r.tags).toEqual(['alpha', 'zebra']);
    const expectedHash = createHash('sha256')
      .update(JSON.stringify(['alpha', 'zebra']), 'utf8')
      .digest('hex');
    expect(r.tag_catalog_hash).toBe(expectedHash);

    repo.upsertTagMapping({ tag: 'beta', doc_id: 'd1', confidence: 1, source: 'manual' });
    const r2 = service.getKnownTags('admin');
    expect(r2.tags).toEqual(['alpha', 'beta', 'zebra']);
    expect(r2.tag_catalog_hash).not.toBe(r.tag_catalog_hash);
  });

  it('returns knowledge_version alongside tag_catalog_hash from tags array only', () => {
    repo.insertProposal({
      proposal_id: 'boot',
      proposal_type: 'bootstrap',
      payload: JSON.stringify({
        documents: [{ doc_id: 'd1', title: 'T', kind: 'guideline', content: 'c', content_hash: hash('c') }],
        edges: [],
        layer_rules: [],
      }),
      status: 'pending',
      review_comment: null,
    });
    repo.approveProposal('boot');
    repo.upsertTagMapping({ tag: 't1', doc_id: 'd1', confidence: 1, source: 'manual' });

    const r1 = service.getKnownTags('agent');
    expect(r1.knowledge_version).toBe(1);
    expect(r1.tag_catalog_hash).toBe(
      createHash('sha256')
        .update(JSON.stringify(['t1']), 'utf8')
        .digest('hex'),
    );
  });

  it('does not list tags that only map to draft documents', () => {
    repo.insertDocument({
      doc_id: 'draft-doc',
      title: 'Draft',
      kind: 'guideline',
      content: 'wip',
      content_hash: hash('wip'),
      status: 'draft',
    });
    repo.upsertTagMapping({ tag: 'orphan-tag', doc_id: 'draft-doc', confidence: 1, source: 'manual' });

    const r = service.getKnownTags('admin');
    expect(r.tags).toEqual([]);
    expect(r.tag_catalog_hash).toBe(createHash('sha256').update(JSON.stringify([]), 'utf8').digest('hex'));
  });

  it('tag_catalog_hash distinguishes tag strings that differ only by embedded newlines', () => {
    repo.insertDocument({
      doc_id: 'd1',
      title: 'T',
      kind: 'guideline',
      content: 'c',
      content_hash: hash('c'),
      status: 'approved',
    });
    repo.upsertTagMapping({ tag: 'a', doc_id: 'd1', confidence: 1, source: 'manual' });
    repo.upsertTagMapping({ tag: 'b', doc_id: 'd1', confidence: 1, source: 'manual' });
    repo.upsertTagMapping({ tag: 'c', doc_id: 'd1', confidence: 1, source: 'manual' });

    const h1 = service.getKnownTags('agent').tag_catalog_hash;

    repo.deleteTagMappings('c');
    repo.upsertTagMapping({ tag: 'b\nc', doc_id: 'd1', confidence: 1, source: 'manual' });

    const h2 = service.getKnownTags('agent').tag_catalog_hash;

    expect(h1).not.toBe(h2);
  });
});

describe('AegisService — compile_context v2 contract', () => {
  let tmpDir: string;
  let templatesDir: string;
  let db: AegisDatabase;
  let repo: Repository;
  let service: AegisService;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aegis-svc-'));
    templatesDir = mkdtempSync(join(tmpdir(), 'aegis-tpl-'));
    createLaravelTestTemplate(templatesDir);
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    service = new AegisService(repo, templatesDir, null, [], false, tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(templatesDir, { recursive: true, force: true });
  });

  // ── 2. compile_context の request/response が v2 契約どおり ──

  it('compile_context returns v2-compliant response shape', async () => {
    createLaravelProject(tmpDir);

    // Initialize via service
    const preview = service.initDetect(tmpDir, 'admin');
    service.initConfirm(preview.preview_hash, 'admin');

    // Now compile
    const result = await service.compileContext(
      {
        target_files: ['app/Domain/User/UserEntity.php'],
      },
      'agent',
    );

    // v2 contract fields
    expect(result.compile_id).toBeTruthy();
    expect(result.snapshot_id).toBeTruthy();
    expect(result.knowledge_version).toBe(1);
    expect(result.base).toBeDefined();
    expect(result.base.documents).toBeInstanceOf(Array);
    expect(result.base.resolution_path).toBeInstanceOf(Array);
    expect(result.base.templates).toBeInstanceOf(Array);
    expect(result.warnings).toBeInstanceOf(Array);

    // Should have resolved some documents
    expect(result.base.documents.length).toBeGreaterThan(0);

    // Each document should have v2 delivery fields
    for (const doc of result.base.documents) {
      expect(doc.doc_id).toBeTruthy();
      expect(doc.title).toBeTruthy();
      expect(doc.kind).toBeTruthy();
      expect(doc.delivery).toBeDefined();
      expect(['inline', 'deferred', 'omitted']).toContain(doc.delivery);
      expect(doc.content_bytes).toBeGreaterThan(0);
      expect(doc.content_hash).toBeTruthy();
      if (doc.delivery === 'inline') {
        expect(doc.content).toBeTruthy();
      }
      if (doc.delivery === 'deferred') {
        expect(doc.source_path).toBeTruthy();
        expect(doc.content).toBeUndefined();
      }
    }

    // Resolution path should have edges
    expect(result.base.resolution_path.length).toBeGreaterThan(0);
    for (const edge of result.base.resolution_path) {
      expect(edge.edge_id).toBeTruthy();
      expect(edge.source_type).toBeTruthy();
      expect(edge.source_value).toBeTruthy();
      expect(edge.target_doc_id).toBeTruthy();
      expect(edge.edge_type).toBeTruthy();
    }

    expect(result.notices).toEqual([]);
  });

  it('auto default: source_path docs are deferred, content_mode=always overrides', async () => {
    createLaravelProject(tmpDir);

    const preview = service.initDetect(tmpDir, 'admin');
    service.initConfirm(preview.preview_hash, 'admin');

    // Import a doc with source_path (large enough to exceed auto inline threshold)
    const docPath = join(tmpDir, 'docs', 'arch.md');
    mkdirSync(join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(docPath, '# Architecture Guide\n\n'.repeat(200));

    const importResult = await service.importDoc(
      {
        file_path: docPath,
        doc_id: 'arch-guide',
        title: 'Architecture Guide',
        kind: 'guideline',
        edge_hints: [{ source_type: 'path' as const, source_value: 'app/**', edge_type: 'path_requires' as const }],
      },
      'admin',
    );
    for (const pid of importResult.proposal_ids) {
      service.approveProposal(pid, undefined, 'admin');
    }

    // Default (auto): large source_path doc → deferred
    const autoResult = await service.compileContext({ target_files: ['app/Domain/User/UserEntity.php'] }, 'agent');
    const deferredDoc = autoResult.base.documents.find((d: any) => d.doc_id === 'arch-guide');
    expect(deferredDoc).toBeDefined();
    expect(deferredDoc!.delivery).toBe('deferred');
    expect(deferredDoc!.content).toBeUndefined();
    expect(deferredDoc!.source_path).toBeTruthy();

    // Explicit always: same doc → inline
    const alwaysResult = await service.compileContext(
      { target_files: ['app/Domain/User/UserEntity.php'], content_mode: 'always' },
      'agent',
    );
    const inlineDoc = alwaysResult.base.documents.find((d: any) => d.doc_id === 'arch-guide');
    expect(inlineDoc).toBeDefined();
    expect(inlineDoc!.delivery).toBe('inline');
    expect(inlineDoc!.content).toBeTruthy();
  });
});

describe('AegisService — observe discriminated union', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let service: AegisService;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    service = new AegisService(repo, TEMPLATES_ROOT);
  });

  // ── 3. observe の discriminated union が崩れない ──

  it('compile_miss stores related_compile_id and related_snapshot_id', () => {
    const result = service.observe(
      {
        event_type: 'compile_miss',
        related_compile_id: 'cmp-001',
        related_snapshot_id: 'snap-001',
        payload: {
          target_files: ['src/a.ts'],
          review_comment: 'missing DDD guide',
        },
      },
      'agent',
    );

    // Verify stored observation
    const obs = db.prepare('SELECT * FROM observations WHERE observation_id = ?').get(result.observation_id) as any;
    expect(obs.event_type).toBe('compile_miss');
    expect(obs.related_compile_id).toBe('cmp-001');
    expect(obs.related_snapshot_id).toBe('snap-001');
    expect(JSON.parse(obs.payload).review_comment).toBe('missing DDD guide');
  });

  it('manual_note stores without related_compile_id', () => {
    const result = service.observe(
      {
        event_type: 'manual_note',
        payload: { content: 'Remember to add validation docs' },
      },
      'agent',
    );

    const obs = db.prepare('SELECT * FROM observations WHERE observation_id = ?').get(result.observation_id) as any;
    expect(obs.event_type).toBe('manual_note');
    expect(obs.related_compile_id).toBeNull();
    expect(obs.related_snapshot_id).toBeNull();
  });

  it('review_correction stores with optional related_snapshot_id', () => {
    const result = service.observe(
      {
        event_type: 'review_correction',
        related_snapshot_id: 'snap-002',
        payload: { file_path: 'src/User.ts', correction: 'Use value object for email' },
      },
      'agent',
    );

    const obs = db.prepare('SELECT * FROM observations WHERE observation_id = ?').get(result.observation_id) as any;
    expect(obs.event_type).toBe('review_correction');
    expect(obs.related_compile_id).toBeNull();
    expect(obs.related_snapshot_id).toBe('snap-002');
  });
});

describe('AegisService — Admin delegation', () => {
  let tmpDir: string;
  let templatesDir: string;
  let db: AegisDatabase;
  let repo: Repository;
  let service: AegisService;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aegis-admin-'));
    templatesDir = mkdtempSync(join(tmpdir(), 'aegis-tpl-'));
    createLaravelTestTemplate(templatesDir);
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    service = new AegisService(repo, templatesDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(templatesDir, { recursive: true, force: true });
  });

  // ── 4. Admin Surface の approve/reject が core に正しく委譲される ──

  it('approve_proposal via admin surface applies to Canonical', () => {
    createLaravelProject(tmpDir);

    // Init to get to version 1
    const preview = service.initDetect(tmpDir, 'admin');
    service.initConfirm(preview.preview_hash, 'admin');
    expect(repo.getKnowledgeMeta().current_version).toBe(1);

    // Create a new_doc proposal manually
    repo.insertProposal({
      proposal_id: 'p-new',
      proposal_type: 'new_doc',
      payload: JSON.stringify({
        doc_id: 'extra-doc',
        title: 'Extra Guidelines',
        kind: 'guideline',
        content: 'Extra content',
        content_hash: hash('Extra content'),
      }),
      status: 'pending',
      review_comment: null,
    });

    // Approve via admin surface
    const result = service.approveProposal('p-new', undefined, 'admin');
    expect(result.knowledge_version).toBe(2);
    expect(result.snapshot_id).toBeTruthy();

    // Verify document is now in Canonical
    const docs = repo.getApprovedDocuments();
    const extraDoc = docs.find((d) => d.doc_id === 'extra-doc');
    expect(extraDoc).toBeDefined();
    expect(extraDoc!.title).toBe('Extra Guidelines');
  });

  it('approve_proposal rejects proposals with bundle_id; preflight_proposal_bundle returns ordering_error', () => {
    repo.insertProposal({
      proposal_id: 'p-b',
      proposal_type: 'new_doc',
      payload: JSON.stringify({
        doc_id: 'bundled-only',
        title: 'B',
        kind: 'guideline',
        content: 'c',
        content_hash: hash('c'),
      }),
      status: 'pending',
      review_comment: null,
      bundle_id: 'admin-bundle',
    });
    expect(() => service.approveProposal('p-b', undefined, 'admin')).toThrow('approveProposalBundle');

    repo.insertProposal({
      proposal_id: 'p-edge-svc',
      proposal_type: 'add_edge',
      payload: JSON.stringify({
        edge_id: 'e-svc',
        source_type: 'path',
        source_value: 'src/**',
        target_doc_id: 'nope',
        edge_type: 'path_requires',
        priority: 100,
        specificity: 0,
      }),
      status: 'pending',
      review_comment: null,
      bundle_id: 'bad-order',
    });
    const pf = service.preflightProposalBundle('bad-order', 'admin');
    expect(pf.ok).toBe(false);
    expect(pf.ordering_error).toBeTruthy();
    expect(pf.leaves).toHaveLength(1);
  });

  it('reject_proposal via admin surface records reason', () => {
    repo.insertProposal({
      proposal_id: 'p-rej',
      proposal_type: 'new_doc',
      payload: JSON.stringify({
        doc_id: 'd1',
        title: 'T',
        kind: 'guideline',
        content: 'c',
        content_hash: hash('c'),
      }),
      status: 'pending',
      review_comment: null,
    });

    const result = service.rejectProposal('p-rej', 'Not needed yet', 'admin');
    expect(result.status).toBe('rejected');

    const proposal = repo.getProposal('p-rej');
    expect(proposal!.status).toBe('rejected');
    expect(proposal!.review_comment).toBe('Not needed yet');
  });

  it('list_proposals returns proposal summaries', () => {
    repo.insertProposal({
      proposal_id: 'p1',
      proposal_type: 'new_doc',
      payload: JSON.stringify({
        doc_id: 'd1',
        title: 'My Doc',
        kind: 'guideline',
        content: 'c',
        content_hash: hash('c'),
      }),
      status: 'pending',
      review_comment: null,
    });

    const result = service.listProposals({ status: 'pending' }, 'admin');
    expect(result.total).toBe(1);
    expect(result.proposals).toHaveLength(1);
    const p = result.proposals[0] as any;
    expect(p.proposal_id).toBe('p1');
    expect(p.summary).toContain('My Doc');
  });

  it('get_proposal returns full details with evidence', () => {
    // Create observation + proposal with evidence
    repo.insertObservation({
      observation_id: 'obs-1',
      event_type: 'compile_miss',
      payload: JSON.stringify({ review_comment: 'missing doc' }),
      related_compile_id: 'cmp-1',
      related_snapshot_id: 'snap-1',
    });
    repo.insertProposal({
      proposal_id: 'p1',
      proposal_type: 'add_edge',
      payload: JSON.stringify({
        source_type: 'path',
        source_value: 'src/**',
        target_doc_id: 'd1',
        edge_type: 'path_requires',
        priority: 100,
      }),
      status: 'pending',
      review_comment: null,
    });
    repo.insertProposalEvidence('p1', 'obs-1');

    const result = service.getProposal('p1', 'admin') as any;
    expect(result).toBeDefined();
    expect(result.proposal_id).toBe('p1');
    expect(result.payload.source_value).toBe('src/**');
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].observation_id).toBe('obs-1');
  });
});

// ============================================================
// Integration: init → compile_context → audit end-to-end
// ============================================================

describe('AegisService — Integration: separate admin/agent instances', () => {
  let tmpDir: string;
  let templatesDir: string;
  let db: AegisDatabase;
  let repo: Repository;
  let adminService: AegisService;
  let agentService: AegisService;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aegis-e2e-'));
    templatesDir = mkdtempSync(join(tmpdir(), 'aegis-tpl-'));
    createLaravelTestTemplate(templatesDir);
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    // Simulate separate processes: distinct AegisService instances sharing same DB
    adminService = new AegisService(repo, templatesDir);
    agentService = new AegisService(repo, templatesDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(templatesDir, { recursive: true, force: true });
  });

  it('full flow: admin init → agent compile → agent audit', async () => {
    createLaravelProject(tmpDir);

    // ── Step 1+2: init_detect + init_confirm (Admin Surface only) ──
    const preview = adminService.initDetect(tmpDir, 'admin');
    expect(preview.preview_hash).toBeTruthy();
    expect(preview.has_blocking_warnings).toBe(false);

    const initResult = adminService.initConfirm(preview.preview_hash, 'admin');
    expect(initResult.knowledge_version).toBe(1);
    expect(initResult.snapshot_id).toBeTruthy();

    // ── Step 3: compile_context (Agent Surface — separate instance) ──
    const compiled = await agentService.compileContext(
      {
        target_files: ['app/Domain/User/UserEntity.php'],
      },
      'agent',
    );

    expect(compiled.compile_id).toBeTruthy();
    expect(compiled.snapshot_id).toBe(initResult.snapshot_id);
    expect(compiled.knowledge_version).toBe(1);
    expect(compiled.base.documents.length).toBeGreaterThan(0);
    expect(compiled.base.resolution_path.length).toBeGreaterThan(0);
    expect(compiled.warnings).toHaveLength(0);
    expect(compiled.notices).toEqual([]);

    // ── Step 4: get_compile_audit (Agent Surface) ──
    const audit = agentService.getCompileAudit(compiled.compile_id, 'agent');
    expect(audit).toBeDefined();
    expect(audit!.compile_id).toBe(compiled.compile_id);
    expect(audit!.knowledge_version).toBe(1);

    const compiledDocIds = compiled.base.documents.map((d) => d.doc_id).sort();
    expect(audit!.base_doc_ids.sort()).toEqual(compiledDocIds);
  });

  it('init_detect on agent surface returns preview (read-only)', () => {
    createLaravelProject(tmpDir);
    const preview = agentService.initDetect(tmpDir, 'agent');
    expect(preview).toBeDefined();
    expect(preview.template_id).toBe('laravel-ddd');
  });

  it('cross-instance init_detect → init_confirm fails (previewCache not shared)', () => {
    createLaravelProject(tmpDir);

    // Admin instance 1 does init_detect
    const preview = adminService.initDetect(tmpDir, 'admin');

    // A DIFFERENT admin instance tries to confirm — cache miss
    const otherAdmin = new AegisService(repo, templatesDir);
    expect(() => otherAdmin.initConfirm(preview.preview_hash, 'admin')).toThrow(/No cached preview/);
  });

  it('compile_context after approve returns knowledge_version 2', async () => {
    createLaravelProject(tmpDir);

    // Admin: init
    const preview = adminService.initDetect(tmpDir, 'admin');
    adminService.initConfirm(preview.preview_hash, 'admin');

    // Admin: approve additional doc
    repo.insertProposal({
      proposal_id: 'p-extra',
      proposal_type: 'new_doc',
      payload: JSON.stringify({
        doc_id: 'extra-rules',
        title: 'Extra Rules',
        kind: 'guideline',
        content: 'Additional rules content',
        content_hash: hash('Additional rules content'),
      }),
      status: 'pending',
      review_comment: null,
    });
    adminService.approveProposal('p-extra', undefined, 'admin');

    // Agent: compile should reflect version 2
    const compiled = await agentService.compileContext(
      {
        target_files: ['app/Domain/User/UserEntity.php'],
      },
      'agent',
    );
    expect(compiled.knowledge_version).toBe(2);
  });

  it('agent observe → compile_miss creates traceable observation', async () => {
    createLaravelProject(tmpDir);

    // Admin: init
    const preview = adminService.initDetect(tmpDir, 'admin');
    adminService.initConfirm(preview.preview_hash, 'admin');

    // Agent: compile
    const compiled = await agentService.compileContext(
      {
        target_files: ['app/Domain/User/UserEntity.php'],
      },
      'agent',
    );

    // Agent: observe compile miss
    const obs = agentService.observe(
      {
        event_type: 'compile_miss',
        related_compile_id: compiled.compile_id,
        related_snapshot_id: compiled.snapshot_id,
        payload: {
          target_files: ['app/Domain/User/UserEntity.php'],
          review_comment: 'Missing validation rules document',
        },
      },
      'agent',
    );

    expect(obs.observation_id).toBeTruthy();
    const stored = db.prepare('SELECT * FROM observations WHERE observation_id = ?').get(obs.observation_id) as any;
    expect(stored.related_compile_id).toBe(compiled.compile_id);
    expect(stored.related_snapshot_id).toBe(compiled.snapshot_id);
  });
});

// ============================================================
// Fix 2: observe discriminated-union enforcement
// ============================================================

describe('AegisService — observe validation', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let service: AegisService;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    service = new AegisService(repo, TEMPLATES_ROOT);
  });

  it('compile_miss without related_compile_id throws ObserveValidationError', () => {
    expect(() =>
      service.observe(
        {
          event_type: 'compile_miss',
          related_snapshot_id: 'snap-001',
          payload: { target_files: ['src/a.ts'] },
        } as any,
        'agent',
      ),
    ).toThrow(ObserveValidationError);
  });

  it('compile_miss without related_snapshot_id throws ObserveValidationError', () => {
    expect(() =>
      service.observe(
        {
          event_type: 'compile_miss',
          related_compile_id: 'cmp-001',
          payload: { target_files: ['src/a.ts'] },
        } as any,
        'agent',
      ),
    ).toThrow(ObserveValidationError);
  });

  it('compile_miss with both IDs and valid payload succeeds', () => {
    const result = service.observe(
      {
        event_type: 'compile_miss',
        related_compile_id: 'cmp-001',
        related_snapshot_id: 'snap-001',
        payload: { target_files: ['src/a.ts'], review_comment: 'missing doc' },
      },
      'agent',
    );
    expect(result.observation_id).toBeTruthy();
  });

  it('manual_note without IDs succeeds', () => {
    const result = service.observe(
      {
        event_type: 'manual_note',
        payload: { content: 'just a note' },
      },
      'agent',
    );
    expect(result.observation_id).toBeTruthy();
  });

  it('doc_gap_detected with valid payload succeeds', () => {
    const result = service.observe(
      {
        event_type: 'doc_gap_detected',
        related_compile_id: 'cmp-1',
        related_snapshot_id: 'snap-1',
        payload: {
          gap_kind: 'content_gap',
          target_doc_id: 'some-doc',
          scope_patterns: ['src/**'],
          evidence_observation_ids: [],
          evidence_compile_ids: ['cmp-1'],
          metrics: {
            exposure_count: 1,
            content_gap_count: 1,
            distinct_clusters: 1,
            cohort_gap_rate: 0.1,
          },
          suggested_next_action: 'review_doc',
          algorithm_version: '0.1.0',
        },
      },
      'agent',
    );
    expect(result.observation_id).toBeTruthy();
  });

  it('doc_gap_detected without gap_kind throws ObserveValidationError', () => {
    expect(() =>
      service.observe(
        {
          event_type: 'doc_gap_detected',
          payload: { scope_patterns: ['src/**'] },
        } as any,
        'agent',
      ),
    ).toThrow(ObserveValidationError);
  });

  it('process_observations for doc_gap_detected creates no proposals', async () => {
    const result = service.observe(
      {
        event_type: 'doc_gap_detected',
        payload: {
          gap_kind: 'routing_gap',
          scope_patterns: ['**'],
          evidence_observation_ids: [],
          evidence_compile_ids: [],
          metrics: {
            exposure_count: 0,
            content_gap_count: 0,
            distinct_clusters: 0,
            cohort_gap_rate: 0,
          },
          suggested_next_action: 'create_doc',
          algorithm_version: '0.1.0-phase0',
        },
      },
      'agent',
    );
    expect(result.observation_id).toBeTruthy();
    const proc = await service.processObservations('doc_gap_detected', 'admin');
    expect(proc.proposals_created).toBe(0);
    const listed = service.listObservations({ event_type: 'doc_gap_detected' }, 'admin');
    expect(listed.total).toBe(1);
    expect(listed.observations[0].outcome).toBe('skipped');
    expect(listed.observations[0].review_comment).toBe('routing_gap → create_doc');
    const pl = listed.observations[0].payload;
    expect(pl).not.toBeNull();
    expect(pl?.gap_kind).toBe('routing_gap');
    expect(pl?.scope_patterns).toEqual(['**']);
    expect(pl?.evidence_observation_ids).toEqual([]);
    expect(pl?.evidence_compile_ids).toEqual([]);
    expect(pl?.metrics).toEqual({
      exposure_count: 0,
      content_gap_count: 0,
      distinct_clusters: 0,
      cohort_gap_rate: 0,
    });
    expect(pl?.suggested_next_action).toBe('create_doc');
    expect(pl?.algorithm_version).toBe('0.1.0-phase0');
  });
});

// ============================================================
// Fix 3: approve_proposal.modifications applied to payload
// ============================================================

describe('AegisService — approve with modifications', () => {
  let tmpDir: string;
  let templatesDir: string;
  let db: AegisDatabase;
  let repo: Repository;
  let service: AegisService;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aegis-mod-'));
    templatesDir = mkdtempSync(join(tmpdir(), 'aegis-tpl-'));
    createLaravelTestTemplate(templatesDir);
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    service = new AegisService(repo, templatesDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(templatesDir, { recursive: true, force: true });
  });

  it('modifications override payload fields before Canonical write', () => {
    createLaravelProject(tmpDir);
    const preview = service.initDetect(tmpDir, 'admin');
    service.initConfirm(preview.preview_hash, 'admin');

    const originalContent = 'Original content';
    const modifiedContent = 'Admin-corrected content';
    repo.insertProposal({
      proposal_id: 'p-mod',
      proposal_type: 'new_doc',
      payload: JSON.stringify({
        doc_id: 'mod-doc',
        title: 'Original Title',
        kind: 'guideline',
        content: originalContent,
        content_hash: hash(originalContent),
      }),
      status: 'pending',
      review_comment: null,
    });

    service.approveProposal(
      'p-mod',
      {
        title: 'Corrected Title',
        content: modifiedContent,
      },
      'admin',
    );

    const doc = repo.getApprovedDocuments().find((d) => d.doc_id === 'mod-doc');
    expect(doc).toBeDefined();
    expect(doc!.title).toBe('Corrected Title');
    expect(doc!.content).toBe(modifiedContent);
    // content_hash must be server-recomputed to match the modified content
    expect(doc!.content_hash).toBe(hash(modifiedContent));

    // Verify get_proposal returns the modified payload, not the original
    const approved = service.getProposal('p-mod', 'admin') as any;
    expect(approved.payload.title).toBe('Corrected Title');
    expect(approved.payload.content).toBe(modifiedContent);
    expect(approved.payload.content_hash).toBe(hash(modifiedContent));
  });

  it('disallowed modification field throws error', () => {
    createLaravelProject(tmpDir);
    const preview = service.initDetect(tmpDir, 'admin');
    service.initConfirm(preview.preview_hash, 'admin');

    repo.insertProposal({
      proposal_id: 'p-bad',
      proposal_type: 'new_doc',
      payload: JSON.stringify({
        doc_id: 'bad-doc',
        title: 'T',
        kind: 'guideline',
        content: 'c',
        content_hash: hash('c'),
      }),
      status: 'pending',
      review_comment: null,
    });

    expect(() =>
      service.approveProposal(
        'p-bad',
        {
          doc_id: 'injected-id',
        },
        'admin',
      ),
    ).toThrow("Modification field 'doc_id' is not allowed");
  });

  it('bootstrap proposal does not accept modifications', () => {
    // bootstrap proposals should reject any modifications
    repo.insertProposal({
      proposal_id: 'p-boot',
      proposal_type: 'bootstrap',
      payload: JSON.stringify({ documents: [], edges: [], layer_rules: [] }),
      status: 'pending',
      review_comment: null,
    });

    expect(() =>
      service.approveProposal(
        'p-boot',
        {
          title: 'hacked',
        },
        'admin',
      ),
    ).toThrow("not allowed for proposal type 'bootstrap'");
  });

  it('content_hash cannot be set directly via modifications', () => {
    createLaravelProject(tmpDir);
    const preview = service.initDetect(tmpDir, 'admin');
    service.initConfirm(preview.preview_hash, 'admin');

    repo.insertProposal({
      proposal_id: 'p-hash',
      proposal_type: 'new_doc',
      payload: JSON.stringify({
        doc_id: 'hash-doc',
        title: 'T',
        kind: 'guideline',
        content: 'original',
        content_hash: hash('original'),
      }),
      status: 'pending',
      review_comment: null,
    });

    expect(() =>
      service.approveProposal(
        'p-hash',
        {
          content_hash: 'deadbeef',
        },
        'admin',
      ),
    ).toThrow("Modification field 'content_hash' is not allowed");
  });
});

// ============================================================
// Fix 2 (round 2): observe payload structure validation per event_type
// ============================================================

describe('AegisService — observe payload validation', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let service: AegisService;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    service = new AegisService(repo, TEMPLATES_ROOT);
  });

  it('compile_miss without review_comment rejects', () => {
    expect(() =>
      service.observe(
        {
          event_type: 'compile_miss',
          related_compile_id: 'cmp-1',
          related_snapshot_id: 'snap-1',
          payload: { target_files: ['src/a.ts'] },
        } as any,
        'agent',
      ),
    ).toThrow('compile_miss payload requires review_comment');
  });

  it('compile_miss without target_files rejects', () => {
    expect(() =>
      service.observe(
        {
          event_type: 'compile_miss',
          related_compile_id: 'cmp-1',
          related_snapshot_id: 'snap-1',
          payload: { review_comment: 'missing doc' },
        } as any,
        'agent',
      ),
    ).toThrow('compile_miss payload requires non-empty target_files');
  });

  it('review_correction without file_path rejects', () => {
    expect(() =>
      service.observe(
        {
          event_type: 'review_correction',
          payload: { correction: 'Use value object' },
        } as any,
        'agent',
      ),
    ).toThrow('review_correction payload requires file_path');
  });

  it('review_correction without correction rejects', () => {
    expect(() =>
      service.observe(
        {
          event_type: 'review_correction',
          payload: { file_path: 'src/User.ts' },
        } as any,
        'agent',
      ),
    ).toThrow('review_correction payload requires correction');
  });

  it('pr_merged without pr_id rejects', () => {
    expect(() =>
      service.observe(
        {
          event_type: 'pr_merged',
          payload: { summary: 'Added auth', files_changed: ['src/auth.ts'] },
        } as any,
        'agent',
      ),
    ).toThrow('pr_merged payload requires pr_id');
  });

  it('pr_merged without files_changed rejects', () => {
    expect(() =>
      service.observe(
        {
          event_type: 'pr_merged',
          payload: { pr_id: 'PR-1', summary: 'Added auth' },
        } as any,
        'agent',
      ),
    ).toThrow('pr_merged payload requires non-empty files_changed');
  });

  it('manual_note without content rejects', () => {
    expect(() =>
      service.observe(
        {
          event_type: 'manual_note',
          payload: {},
        } as any,
        'agent',
      ),
    ).toThrow('manual_note payload requires content');
  });

  it('valid pr_merged observation succeeds', () => {
    const result = service.observe(
      {
        event_type: 'pr_merged',
        payload: { pr_id: 'PR-42', summary: 'Refactored auth', files_changed: ['src/auth.ts'] },
      } as any,
      'agent',
    );
    expect(result.observation_id).toBeTruthy();
  });

  it('valid review_correction observation succeeds', () => {
    const result = service.observe(
      {
        event_type: 'review_correction',
        payload: { file_path: 'src/User.ts', correction: 'Use value object for email' },
      } as any,
      'agent',
    );
    expect(result.observation_id).toBeTruthy();
  });

  it('review_correction with both target_doc_id and proposed_content succeeds', () => {
    const result = service.observe(
      {
        event_type: 'review_correction',
        payload: {
          file_path: 'src/User.ts',
          correction: 'Use value object for email',
          target_doc_id: 'auth-guide',
          proposed_content: 'Updated auth guide content',
        },
      } as any,
      'agent',
    );
    expect(result.observation_id).toBeTruthy();
  });

  it('review_correction with target_doc_id but no proposed_content rejects', () => {
    expect(() =>
      service.observe(
        {
          event_type: 'review_correction',
          payload: {
            file_path: 'src/User.ts',
            correction: 'Fix auth guide',
            target_doc_id: 'auth-guide',
          },
        } as any,
        'agent',
      ),
    ).toThrow('proposed_content required when target_doc_id is provided');
  });

  it('review_correction with proposed_content but no target_doc_id rejects', () => {
    expect(() =>
      service.observe(
        {
          event_type: 'review_correction',
          payload: {
            file_path: 'src/User.ts',
            correction: 'Fix something',
            proposed_content: 'New content',
          },
        } as any,
        'agent',
      ),
    ).toThrow('target_doc_id required when proposed_content is provided');
  });

  it('review_correction with empty target_doc_id rejects', () => {
    expect(() =>
      service.observe(
        {
          event_type: 'review_correction',
          payload: {
            file_path: 'src/User.ts',
            correction: 'Fix something',
            target_doc_id: '',
            proposed_content: 'New content',
          },
        } as any,
        'agent',
      ),
    ).toThrow('target_doc_id required when proposed_content is provided');
  });
});

// ============================================================
// ADR-008: compile_miss target_doc_id + list_observations
// ============================================================

describe('AegisService — compile_miss target_doc_id (ADR-008)', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let service: AegisService;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    service = new AegisService(repo, TEMPLATES_ROOT);
  });

  it('compile_miss with target_doc_id succeeds and stores it in payload', () => {
    const result = service.observe(
      {
        event_type: 'compile_miss',
        related_compile_id: 'cmp-1',
        related_snapshot_id: 'snap-1',
        payload: {
          target_files: ['src/a.ts'],
          review_comment: 'archived_at not documented',
          target_doc_id: 'ts-mcp-repository-guidelines',
        },
      },
      'agent',
    );
    expect(result.observation_id).toBeTruthy();
    const obs = db.prepare('SELECT * FROM observations WHERE observation_id = ?').get(result.observation_id) as any;
    const payload = JSON.parse(obs.payload);
    expect(payload.target_doc_id).toBe('ts-mcp-repository-guidelines');
    expect(payload.review_comment).toBe('archived_at not documented');
  });

  it('compile_miss without target_doc_id still succeeds (optional field)', () => {
    const result = service.observe(
      {
        event_type: 'compile_miss',
        related_compile_id: 'cmp-1',
        related_snapshot_id: 'snap-1',
        payload: {
          target_files: ['src/a.ts'],
          review_comment: 'some miss',
        },
      },
      'agent',
    );
    expect(result.observation_id).toBeTruthy();
  });

  it('compile_miss with non-string target_doc_id rejects', () => {
    expect(() =>
      service.observe(
        {
          event_type: 'compile_miss',
          related_compile_id: 'cmp-1',
          related_snapshot_id: 'snap-1',
          payload: {
            target_files: ['src/a.ts'],
            review_comment: 'miss',
            target_doc_id: 123,
          },
        } as any,
        'agent',
      ),
    ).toThrow('target_doc_id must be a string');
  });
});

describe('AegisService — list_observations (ADR-008)', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let service: AegisService;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    service = new AegisService(repo, TEMPLATES_ROOT);
  });

  it('requires admin surface', () => {
    expect(() => service.listObservations({}, 'agent')).toThrow(SurfaceViolationError);
  });

  it('returns pending observations (not yet analyzed)', () => {
    repo.insertObservation({
      observation_id: 'obs-pending',
      event_type: 'compile_miss',
      payload: JSON.stringify({ review_comment: 'pending miss', target_files: ['a.ts'] }),
      related_compile_id: 'cmp-1',
      related_snapshot_id: 'snap-1',
    });

    const result = service.listObservations({ outcome: 'pending' }, 'admin');
    expect(result.total).toBe(1);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].outcome).toBe('pending');
    expect(result.observations[0].review_comment).toBe('pending miss');
    expect(result.observations[0].payload).toEqual({
      review_comment: 'pending miss',
      target_files: ['a.ts'],
    });
  });

  it('returns null payload and derived triage fields when stored payload is not valid JSON', () => {
    repo.insertObservation({
      observation_id: 'obs-bad-json',
      event_type: 'compile_miss',
      payload: '{not valid json',
      related_compile_id: 'cmp-1',
      related_snapshot_id: 'snap-1',
    });

    const result = service.listObservations({}, 'admin');
    expect(result.total).toBe(1);
    const row = result.observations[0];
    expect(row.payload).toBeNull();
    expect(row.review_comment).toBeNull();
    expect(row.target_doc_id).toBeNull();
    expect(row.target_files).toBeNull();
    expect(row.observation_id).toBe('obs-bad-json');
    expect(row.event_type).toBe('compile_miss');
  });

  it('returns skipped observations (analyzed but no proposal)', () => {
    repo.insertObservation({
      observation_id: 'obs-skipped',
      event_type: 'compile_miss',
      payload: JSON.stringify({
        review_comment: 'skipped miss',
        target_files: ['a.ts'],
        target_doc_id: 'some-doc',
      }),
      related_compile_id: 'cmp-1',
      related_snapshot_id: 'snap-1',
    });
    repo.markObservationsAnalyzed(['obs-skipped']);

    const result = service.listObservations({ outcome: 'skipped' }, 'admin');
    expect(result.total).toBe(1);
    expect(result.observations[0].outcome).toBe('skipped');
    expect(result.observations[0].target_doc_id).toBe('some-doc');
  });

  it('returns related_compile_id, related_snapshot_id, and target_files', () => {
    repo.insertObservation({
      observation_id: 'obs-full',
      event_type: 'compile_miss',
      payload: JSON.stringify({
        review_comment: 'needs more docs',
        target_files: ['src/a.ts', 'src/b.ts'],
        target_doc_id: 'my-doc',
      }),
      related_compile_id: 'cmp-full',
      related_snapshot_id: 'snap-full',
    });

    const result = service.listObservations({}, 'admin');
    expect(result.observations).toHaveLength(1);
    const obs = result.observations[0];
    expect(obs.related_compile_id).toBe('cmp-full');
    expect(obs.related_snapshot_id).toBe('snap-full');
    expect(obs.target_files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(obs.target_doc_id).toBe('my-doc');
  });

  it('returns null target_files when payload has no target_files', () => {
    repo.insertObservation({
      observation_id: 'obs-note',
      event_type: 'manual_note',
      payload: JSON.stringify({ content: 'a note' }),
      related_compile_id: null,
      related_snapshot_id: null,
    });

    const result = service.listObservations({}, 'admin');
    const obs = result.observations[0];
    expect(obs.target_files).toBeNull();
    expect(obs.related_compile_id).toBeNull();
    expect(obs.related_snapshot_id).toBeNull();
  });

  it('returns proposed observations (analyzed with proposal evidence)', () => {
    repo.insertObservation({
      observation_id: 'obs-proposed',
      event_type: 'compile_miss',
      payload: JSON.stringify({ review_comment: 'proposed miss', target_files: ['a.ts'], missing_doc: 'doc-x' }),
      related_compile_id: 'cmp-1',
      related_snapshot_id: 'snap-1',
    });
    repo.markObservationsAnalyzed(['obs-proposed']);
    repo.insertProposal({
      proposal_id: 'p-1',
      proposal_type: 'add_edge',
      payload: JSON.stringify({
        source_type: 'path',
        source_value: 'src/**',
        target_doc_id: 'doc-x',
        edge_type: 'path_requires',
      }),
      status: 'pending',
      review_comment: null,
    });
    repo.insertProposalEvidence('p-1', 'obs-proposed');

    const result = service.listObservations({ outcome: 'proposed' }, 'admin');
    expect(result.total).toBe(1);
    expect(result.observations[0].outcome).toBe('proposed');
  });

  it('filters by event_type', () => {
    repo.insertObservation({
      observation_id: 'obs-miss',
      event_type: 'compile_miss',
      payload: JSON.stringify({ review_comment: 'miss', target_files: ['a.ts'] }),
      related_compile_id: 'cmp-1',
      related_snapshot_id: 'snap-1',
    });
    repo.insertObservation({
      observation_id: 'obs-note',
      event_type: 'manual_note',
      payload: JSON.stringify({ content: 'a note' }),
      related_compile_id: null,
      related_snapshot_id: null,
    });

    const result = service.listObservations({ event_type: 'compile_miss' }, 'admin');
    expect(result.total).toBe(1);
    expect(result.observations[0].event_type).toBe('compile_miss');
  });

  it('correctly distinguishes proposed vs skipped in mixed set', () => {
    repo.insertObservation({
      observation_id: 'obs-1',
      event_type: 'compile_miss',
      payload: JSON.stringify({ review_comment: 'has proposal', target_files: ['a.ts'] }),
      related_compile_id: 'cmp-1',
      related_snapshot_id: 'snap-1',
    });
    repo.insertObservation({
      observation_id: 'obs-2',
      event_type: 'compile_miss',
      payload: JSON.stringify({ review_comment: 'no proposal', target_files: ['b.ts'] }),
      related_compile_id: 'cmp-2',
      related_snapshot_id: 'snap-2',
    });
    repo.markObservationsAnalyzed(['obs-1', 'obs-2']);
    repo.insertProposal({
      proposal_id: 'p-1',
      proposal_type: 'add_edge',
      payload: '{}',
      status: 'pending',
      review_comment: null,
    });
    repo.insertProposalEvidence('p-1', 'obs-1');

    const proposed = service.listObservations({ outcome: 'proposed' }, 'admin');
    expect(proposed.total).toBe(1);
    expect(proposed.observations[0].observation_id).toBe('obs-1');

    const skipped = service.listObservations({ outcome: 'skipped' }, 'admin');
    expect(skipped.total).toBe(1);
    expect(skipped.observations[0].observation_id).toBe('obs-2');
  });

  it('respects limit and offset', () => {
    for (let i = 0; i < 5; i++) {
      repo.insertObservation({
        observation_id: `obs-${i}`,
        event_type: 'manual_note',
        payload: JSON.stringify({ content: `note ${i}` }),
        related_compile_id: null,
        related_snapshot_id: null,
      });
    }

    const page1 = service.listObservations({ limit: 2, offset: 0 }, 'admin');
    expect(page1.total).toBe(5);
    expect(page1.observations).toHaveLength(2);

    const page2 = service.listObservations({ limit: 2, offset: 2 }, 'admin');
    expect(page2.observations).toHaveLength(2);

    const page3 = service.listObservations({ limit: 2, offset: 4 }, 'admin');
    expect(page3.observations).toHaveLength(1);
  });
});

// ============================================================
// importDoc with file_path
// ============================================================

describe('AegisService — importDoc file_path', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let service: AegisService;
  let tmpDir: string;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    tmpDir = mkdtempSync(join(tmpdir(), 'aegis-fp-'));
    // Inject tmpDir as projectRoot so file_path normalization works
    service = new AegisService(repo, TEMPLATES_ROOT, null, [], false, tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads content from file_path', async () => {
    const filePath = join(tmpDir, 'doc.md');
    writeFileSync(filePath, '# Full Content\nBody text here');

    const result = await service.importDoc(
      { file_path: filePath, doc_id: 'fp-doc', title: 'FP Doc', kind: 'guideline' },
      'admin',
    );

    expect(result.proposal_ids.length).toBeGreaterThan(0);
    const proposal = repo.getProposal(result.proposal_ids[0]);
    const payload = JSON.parse(proposal!.payload);
    expect(payload.content).toBe('# Full Content\nBody text here');
  });

  it('file_path takes priority over content', async () => {
    const filePath = join(tmpDir, 'priority.md');
    writeFileSync(filePath, 'file content');

    const result = await service.importDoc(
      { file_path: filePath, content: 'inline content', doc_id: 'prio-doc', title: 'Prio', kind: 'guideline' },
      'admin',
    );

    const proposal = repo.getProposal(result.proposal_ids[0]);
    const payload = JSON.parse(proposal!.payload);
    expect(payload.content).toBe('file content');
  });

  it('auto-sets source_path from file_path when not provided', async () => {
    const filePath = join(tmpDir, 'auto-source.md');
    writeFileSync(filePath, 'content');

    const result = await service.importDoc(
      { file_path: filePath, doc_id: 'auto-src', title: 'Auto', kind: 'reference' },
      'admin',
    );

    const obs = repo.getObservation(result.observation_id);
    const payload = JSON.parse(obs!.payload);
    // source_path is now repo-relative (normalized against tmpDir as projectRoot)
    expect(payload.source_path).toBe('auto-source.md');
  });

  it('includes normalized source_refs on document_import observation payload', async () => {
    writeFileSync(join(tmpDir, 'readme.md'), '# Hello');
    const refs = [
      { asset_path: 'readme.md', anchor_type: 'file' as const, anchor_value: '' },
      { asset_path: 'routes.ts', anchor_type: 'lines' as const, anchor_value: '10-20' },
    ];
    const result = await service.importDoc(
      {
        file_path: join(tmpDir, 'readme.md'),
        doc_id: 'multi-ref-doc',
        title: 'MR',
        kind: 'guideline',
        source_refs: refs,
      },
      'admin',
    );

    const obs = repo.getObservation(result.observation_id);
    const payload = JSON.parse(obs!.payload) as { source_refs?: Array<{ anchor_type: string; anchor_value: string }> };
    expect(payload.source_refs?.length).toBe(2);
    expect(payload.source_refs?.[1]?.anchor_type).toBe('lines');
    expect(payload.source_refs?.[1]?.anchor_value).toBe('10-20');
  });

  it('does not override explicit source_path but normalizes it', async () => {
    const filePath = join(tmpDir, 'explicit.md');
    writeFileSync(filePath, 'content');
    const customPath = join(tmpDir, 'custom/path');

    const result = await service.importDoc(
      { file_path: filePath, doc_id: 'explicit-src', title: 'Ex', kind: 'guideline', source_path: customPath },
      'admin',
    );

    const obs = repo.getObservation(result.observation_id);
    const payload = JSON.parse(obs!.payload);
    // Explicit source_path is normalized to repo-relative
    expect(payload.source_path).toBe('custom/path');
  });

  it('throws on non-existent file_path', async () => {
    await expect(
      service.importDoc(
        { file_path: '/nonexistent/path.md', doc_id: 'bad-fp', title: 'Bad', kind: 'guideline' },
        'admin',
      ),
    ).rejects.toThrow('File not found');
  });

  it('throws when neither content nor file_path provided', async () => {
    await expect(service.importDoc({ doc_id: 'no-content', title: 'NC', kind: 'guideline' }, 'admin')).rejects.toThrow(
      'Either content or file_path is required',
    );
  });
});

// ============================================================
// import plan (ADR-015)
// ============================================================

describe('AegisService — import plan', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let service: AegisService;
  let tmpDir: string;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    tmpDir = mkdtempSync(join(tmpdir(), 'aegis-imp-'));
    service = new AegisService(repo, TEMPLATES_ROOT, null, [], false, tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('analyzeDoc carries source_refs through the import plan', () => {
    const refs = [
      { asset_path: 'docs/a.md', anchor_type: 'file' as const, anchor_value: '' },
      { asset_path: 'docs/b.md', anchor_type: 'section' as const, anchor_value: '## Intro' },
    ];
    const plan = service.analyzeDoc({ content: '## One\nbody', source_refs: refs }, 'admin');
    expect(plan.source_refs?.length).toBe(2);
    expect(plan.source_refs?.[1]?.anchor_value).toBe('## Intro');
  });

  it('analyzeDoc returns an ImportPlan; executeImportPlan sets proposal bundle_id', () => {
    const plan = service.analyzeDoc(
      { content: '## U1\n\nRef `src/mcp/server.ts` for wiring.\n', source_label: 'x.md' },
      'admin',
    );
    expect(plan.resolved_source_path).toBeNull();
    const result = service.executeImportPlan({ import_plan: plan }, 'admin');
    expect(result.proposal_ids.length).toBeGreaterThan(0);
    const p0 = repo.getProposal(result.proposal_ids[0]);
    expect(p0?.bundle_id).toBe(result.bundle_id);
  });

  it('executeImportPlan does not attach source_path from source_label alone (provenance only)', () => {
    const plan = service.analyzeDoc(
      { content: '## Labeled\n\nbody', source_label: 'docs/not-a-real-file.md' },
      'admin',
    );
    expect(plan.resolved_source_path).toBeNull();
    const result = service.executeImportPlan({ import_plan: plan }, 'admin');
    const payload = JSON.parse(repo.getProposal(result.proposal_ids[0])!.payload) as Record<string, unknown>;
    expect(payload.source_path).toBeUndefined();
  });

  it('analyzeDoc sets resolved_source_path when content is read from file_path', () => {
    const fp = join(tmpDir, 'on-disk.md');
    writeFileSync(fp, '## From file\n\nok\n');
    const plan = service.analyzeDoc({ file_path: fp }, 'admin');
    expect(plan.resolved_source_path).toBe('on-disk.md');
  });

  it('analyzeDoc rejects whitespace-only content', () => {
    expect(() => service.analyzeDoc({ content: '  \n\t  ' }, 'admin')).toThrow(/whitespace-only/);
  });

  it('executeImportPlan sets source_path for single ## file when section body matches disk (file_path)', () => {
    const fp = join(tmpDir, 'single-h2.md');
    writeFileSync(fp, '## Single\n\nHello anchor.\n');
    const plan = service.analyzeDoc({ file_path: fp }, 'admin');
    expect(plan.suggested_units.length).toBe(1);
    const exec = service.executeImportPlan({ import_plan: plan }, 'admin');
    const newDocs = exec.proposal_ids
      .map((id) => repo.getProposal(id))
      .filter((p): p is NonNullable<typeof p> => p != null && p.proposal_type === 'new_doc');
    const sourcePaths = newDocs.map((p) => (JSON.parse(p.payload) as { source_path?: string }).source_path);
    expect(sourcePaths.some((sp) => sp === 'single-h2.md')).toBe(true);
  });

  it('executeImportPlan sets source_path on new_doc only when slice equals whole file (file_path)', () => {
    const fp = join(tmpDir, 'whole.md');
    writeFileSync(fp, '# One\n\nBody line.\n');
    const plan = service.analyzeDoc({ file_path: fp }, 'admin');
    expect(plan.suggested_units.length).toBe(1);
    const exec = service.executeImportPlan({ import_plan: plan }, 'admin');
    const newDocs = exec.proposal_ids
      .map((id) => repo.getProposal(id))
      .filter((p): p is NonNullable<typeof p> => p != null && p.proposal_type === 'new_doc');
    expect(newDocs.length).toBeGreaterThan(0);
    const sourcePaths = newDocs.map((p) => {
      try {
        return (JSON.parse(p.payload) as { source_path?: string }).source_path;
      } catch {
        return undefined;
      }
    });
    expect(sourcePaths.some((sp) => sp === 'whole.md')).toBe(true);
  });

  it('executeImportPlan omits source_path when file_path markdown splits into multiple ## units', () => {
    const fp = join(tmpDir, 'multi.md');
    writeFileSync(fp, '## A\n\nalpha\n\n## B\n\nbeta\n');
    const plan = service.analyzeDoc({ file_path: fp }, 'admin');
    expect(plan.suggested_units.length).toBe(2);
    const exec = service.executeImportPlan({ import_plan: plan }, 'admin');
    const newDocs = exec.proposal_ids
      .map((id) => repo.getProposal(id))
      .filter((p): p is NonNullable<typeof p> => p != null && p.proposal_type === 'new_doc');
    expect(newDocs.length).toBeGreaterThanOrEqual(1);
    for (const p of newDocs) {
      expect((JSON.parse(p.payload) as { source_path?: string }).source_path).toBeUndefined();
    }
  });

  it('executeImportPlan merges resolved_source_path into source_refs when split + extra refs (015-10)', () => {
    const fp = join(tmpDir, 'multi-extra.md');
    writeFileSync(fp, '## A\n\nalpha\n\n## B\n\nbeta\n');
    writeFileSync(join(tmpDir, 'extra-ref.md'), 'extra\n');

    const plan = service.analyzeDoc(
      {
        file_path: fp,
        source_refs: [{ asset_path: 'extra-ref.md', anchor_type: 'file', anchor_value: '' }],
      },
      'admin',
    );
    expect(plan.suggested_units.length).toBe(2);

    const exec = service.executeImportPlan({ import_plan: plan }, 'admin');
    const newDocPayloads = exec.proposal_ids
      .map((id) => repo.getProposal(id))
      .filter((p): p is NonNullable<typeof p> => p != null && p.proposal_type === 'new_doc')
      .map((p) => JSON.parse(p.payload) as { source_refs_json?: string | null });

    expect(newDocPayloads.length).toBeGreaterThanOrEqual(2);
    for (const pl of newDocPayloads) {
      expect(pl.source_refs_json).toBeTruthy();
      const refs = JSON.parse(pl.source_refs_json!) as Array<{ asset_path: string }>;
      const paths = refs.map((r) => r.asset_path);
      expect(paths).toContain('multi-extra.md');
      expect(paths).toContain('extra-ref.md');
    }
  });

  it('approve + sync_docs dry-run stays quiet for anchored single-file import-plan doc', async () => {
    const fp = join(tmpDir, 'whole2.md');
    writeFileSync(fp, '# Doc\n\nHello.\n');
    const plan = service.analyzeDoc({ file_path: fp }, 'admin');
    const docIds = plan.suggested_units.map((u) => u.doc_id);
    const { bundle_id } = service.executeImportPlan({ import_plan: plan }, 'admin');
    service.approveProposalBundle(bundle_id, 'admin');
    const sync = await service.syncDocs({ dryRun: true }, 'admin');
    const would = sync.would_create_proposals ?? [];
    for (const id of docIds) {
      expect(would).not.toContain(id);
    }
  });

  it('executeImportPlan throws when every proposal is a duplicate of pending proposals', () => {
    const plan = service.analyzeDoc({ content: '## DupTest\n\nRef `src/z/m.ts`.\n', source_label: 'once.md' }, 'admin');
    const first = service.executeImportPlan({ import_plan: plan, bundle_id: 'bundle-first' }, 'admin');
    expect(first.proposal_ids.length).toBeGreaterThan(0);
    const obsTotalAfterFirst = service.listObservations({}, 'admin').total;
    expect(() => service.executeImportPlan({ import_plan: plan, bundle_id: 'bundle-second' }, 'admin')).toThrow(
      /duplicates an existing pending proposal/,
    );
    expect(service.listObservations({}, 'admin').total).toBe(obsTotalAfterFirst);
  });

  it('executeImportPlan rolls back partial bundle when only some drafts duplicate pending proposals', () => {
    const itemA = { content: '## PartialDupA\n\nRef `src/partial/a.ts`.\n', source_label: 'pa.md' };
    const itemB = { content: '## PartialDupB\n\nRef `src/partial/b.ts`.\n', source_label: 'pb.md' };

    // Multi-file batches use doc_id suffixes like `…-b0`; a single-file batch does not — use the same
    // ImportPlan object as the first file in a two-item batch so semantic keys match on the second execute.
    const batch2 = service.analyzeImportBatch({ items: [itemA, itemB] }, 'admin');
    const planAFromBatch = batch2.plans[0];
    service.executeImportPlan({ import_plan: planAFromBatch }, 'admin');

    const proposalsBefore = repo.listProposals('pending', 500, 0).total;
    const observationsBefore = service.listObservations({}, 'admin').total;

    expect(() => service.executeImportPlan({ batch_plan: batch2 }, 'admin')).toThrow(/consistent bundle/);

    expect(repo.listProposals('pending', 500, 0).total).toBe(proposalsBefore);
    expect(service.listObservations({}, 'admin').total).toBe(observationsBefore);

    const partialBDocId = batch2.plans[1]?.suggested_units[0]?.doc_id;
    expect(partialBDocId).toBeDefined();
    const pending = repo.listProposals('pending', 500, 0).proposals;
    const hasPartialB = pending.some((p) => {
      if (p.proposal_type !== 'new_doc') return false;
      try {
        const pl = JSON.parse(p.payload) as { doc_id?: string };
        return pl.doc_id === partialBDocId;
      } catch {
        return false;
      }
    });
    expect(hasPartialB).toBe(false);
  });

  it('executeImportPlan accepts batch_plan with distinct auto doc_ids', () => {
    const batch = service.analyzeImportBatch(
      {
        items: [
          { content: '## S\n\n`src/a.ts`', source_label: 'a.md' },
          { content: '## S\n\n`src/b.ts`', source_label: 'b.md' },
        ],
      },
      'admin',
    );
    const out = service.executeImportPlan({ batch_plan: batch }, 'admin');
    expect(out.proposal_ids.length).toBeGreaterThan(0);
    const docIds = new Set(
      out.proposal_ids
        .map((id) => {
          const p = repo.getProposal(id);
          if (!p) return null;
          const pl = JSON.parse(p.payload) as { doc_id?: string };
          return pl.doc_id ?? null;
        })
        .filter((x): x is string => x != null),
    );
    expect(docIds.size).toBeGreaterThan(1);
  });

  it('blocks import plan tools on agent surface', () => {
    expect(() => service.analyzeDoc({ content: '## A\n\nb' }, 'agent')).toThrow(SurfaceViolationError);
    expect(() => service.analyzeImportBatch({ items: [{ content: '## A\n\nb' }] }, 'agent')).toThrow(
      SurfaceViolationError,
    );
    expect(() => service.executeImportPlan({ import_plan: { bad: true } }, 'agent')).toThrow(SurfaceViolationError);
  });
});

// ============================================================
// syncDocs
// ============================================================

describe('AegisService — syncDocs', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let service: AegisService;
  let tmpDir: string;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    tmpDir = mkdtempSync(join(tmpdir(), 'aegis-sync-'));
    // Inject tmpDir as projectRoot so resolveSourcePath works with repo-relative paths
    service = new AegisService(repo, TEMPLATES_ROOT, null, [], false, tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertApprovedDoc(docId: string, content: string, sourcePath: string) {
    const contentHash = hash(content);
    repo.insertDocument({
      doc_id: docId,
      title: `Doc ${docId}`,
      kind: 'guideline',
      content,
      content_hash: contentHash,
      status: 'approved',
      ownership: 'file-anchored',
      template_origin: null,
      source_path: sourcePath,
      source_refs_json: null,
    });
  }

  it('detects stale document and creates update_doc proposal with evidence', async () => {
    writeFileSync(join(tmpDir, 'stale.md'), 'original');
    insertApprovedDoc('stale-doc', 'original', 'stale.md');

    writeFileSync(join(tmpDir, 'stale.md'), 'updated content');
    const result = await service.syncDocs({}, 'admin');

    expect(result.checked).toBe(1);
    expect(result.proposals_created).toHaveLength(1);
    expect(result.up_to_date).toBe(0);

    const proposal = repo.getProposal(result.proposals_created[0]);
    expect(proposal!.proposal_type).toBe('update_doc');
    const payload = JSON.parse(proposal!.payload);
    expect(payload.content).toBe('updated content');
    expect(payload.doc_id).toBe('stale-doc');

    const evidence = repo.getProposalEvidence(result.proposals_created[0]);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].event_type).toBe('document_import');
  });

  it('reports up_to_date when file has not changed', async () => {
    writeFileSync(join(tmpDir, 'fresh.md'), 'same content');
    insertApprovedDoc('fresh-doc', 'same content', 'fresh.md');

    const result = await service.syncDocs({}, 'admin');
    expect(result.up_to_date).toBe(1);
    expect(result.proposals_created).toHaveLength(0);
  });

  it('syncDocs does not treat multi slice refs on one asset as skipped_invalid_anchor', async () => {
    const rel = 'twice.md';
    writeFileSync(join(tmpDir, rel), 'body');
    repo.insertDocument({
      doc_id: 'twice-slice',
      title: 'T',
      kind: 'guideline',
      content: 'x',
      content_hash: hash('x'),
      status: 'approved',
      ownership: 'file-anchored',
      template_origin: null,
      source_path: null,
      source_refs_json: JSON.stringify([
        { asset_path: rel, anchor_type: 'section', anchor_value: '## A' },
        { asset_path: rel, anchor_type: 'lines', anchor_value: '1-2' },
      ]),
    });

    const result = await service.syncDocs({ dryRun: true }, 'admin');
    expect(result.skipped_invalid_anchor).not.toContain('twice-slice');
  });

  it('does not whole-file hash-sync a single section anchor ref (015-10)', async () => {
    const rel = 'slice.md';
    const fileBody = '# Title\n\nintro\n\nfooter noise';
    const sliceBody = '# Title\n\nintro';
    writeFileSync(join(tmpDir, rel), fileBody);
    repo.insertDocument({
      doc_id: 'slice-doc',
      title: 'Slice',
      kind: 'guideline',
      content: sliceBody,
      content_hash: hash(sliceBody),
      status: 'approved',
      ownership: 'file-anchored',
      template_origin: null,
      source_path: null,
      source_refs_json: JSON.stringify([{ asset_path: rel, anchor_type: 'section', anchor_value: '# Title' }]),
    });

    const result = await service.syncDocs({}, 'admin');
    expect(result.proposals_created).toHaveLength(0);
    expect(result.skipped_invalid_anchor).not.toContain('slice-doc');
    expect(result.not_found).not.toContain('slice-doc');
  });

  it('whole-file sync_docs applies to single file anchor in source_refs_json without source_path', async () => {
    writeFileSync(join(tmpDir, 'only.md'), 'original');
    repo.insertDocument({
      doc_id: 'refs-only',
      title: 'Refs',
      kind: 'guideline',
      content: 'original',
      content_hash: hash('original'),
      status: 'approved',
      ownership: 'file-anchored',
      template_origin: null,
      source_path: null,
      source_refs_json: JSON.stringify([{ asset_path: 'only.md', anchor_type: 'file', anchor_value: '' }]),
    });
    writeFileSync(join(tmpDir, 'only.md'), 'updated');

    const result = await service.syncDocs({}, 'admin');
    expect(result.proposals_created).toHaveLength(1);
    const proposal = repo.getProposal(result.proposals_created[0]);
    expect(JSON.parse(proposal!.payload).doc_id).toBe('refs-only');
  });

  it('whole-file sync_docs applies when file + slice refs share one asset (015-10)', async () => {
    writeFileSync(join(tmpDir, 'mixed.md'), 'full body');
    repo.insertDocument({
      doc_id: 'file-plus-section',
      title: 'M',
      kind: 'guideline',
      content: 'full body',
      content_hash: hash('full body'),
      status: 'approved',
      ownership: 'file-anchored',
      template_origin: null,
      source_path: null,
      source_refs_json: JSON.stringify([
        { asset_path: 'mixed.md', anchor_type: 'file', anchor_value: '' },
        { asset_path: 'mixed.md', anchor_type: 'section', anchor_value: '## H' },
      ]),
    });
    writeFileSync(join(tmpDir, 'mixed.md'), 'changed on disk');

    const result = await service.syncDocs({}, 'admin');
    expect(result.skipped_invalid_anchor).not.toContain('file-plus-section');
    expect(result.proposals_created.map((id) => JSON.parse(repo.getProposal(id)!.payload).doc_id as string)).toContain(
      'file-plus-section',
    );
  });

  it('does not whole-file hash-sync when source_path plus source_refs_json name two distinct assets', async () => {
    writeFileSync(join(tmpDir, 'primary.md'), '# Doc\n\nHello.');
    writeFileSync(join(tmpDir, 'secondary.md'), 'secondary');
    const body = '# Doc\n\nHello.';
    repo.insertDocument({
      doc_id: 'dual-asset',
      title: 'Dual',
      kind: 'guideline',
      content: body,
      content_hash: hash(body),
      status: 'approved',
      ownership: 'file-anchored',
      template_origin: null,
      source_path: 'primary.md',
      source_refs_json: JSON.stringify([{ asset_path: 'secondary.md', anchor_type: 'file', anchor_value: '' }]),
    });

    const result = await service.syncDocs({ dryRun: true }, 'admin');
    expect(result.would_create_proposals ?? []).not.toContain('dual-asset');
    expect(result.multi_source_doc_ids).toContain('dual-asset');
  });

  it('refreshes source_synced_at when sync_docs finds hash match (ADR-014)', async () => {
    writeFileSync(join(tmpDir, 'fresh.md'), 'same content');
    insertApprovedDoc('fresh-doc', 'same content', 'fresh.md');
    db.prepare(`UPDATE documents SET source_synced_at = ? WHERE doc_id = ?`).run(
      '2000-01-01T00:00:00.000Z',
      'fresh-doc',
    );

    await service.syncDocs({}, 'admin');

    const row = db.prepare('SELECT source_synced_at FROM documents WHERE doc_id = ?').get('fresh-doc') as {
      source_synced_at: string;
    };
    expect(new Date(row.source_synced_at).getUTCFullYear()).toBeGreaterThan(2000);
  });

  it('reports not_found when source file is missing', async () => {
    insertApprovedDoc('missing-doc', 'content', 'nonexistent/file.md');

    const result = await service.syncDocs({}, 'admin');
    expect(result.not_found).toContain('missing-doc');
    expect(result.proposals_created).toHaveLength(0);
  });

  it('skips file-anchored docs whose source_path fails resolveSourcePath (e.g. escapes root)', async () => {
    repo.insertDocument({
      doc_id: 'bad-rel',
      title: 'Bad rel',
      kind: 'guideline',
      content: 'body',
      content_hash: hash('body'),
      status: 'approved',
      ownership: 'file-anchored',
      template_origin: null,
      source_path: '../../../etc/passwd',
      source_refs_json: null,
    });

    const result = await service.syncDocs({}, 'admin');
    expect(result.skipped_invalid_anchor).toContain('bad-rel');
    expect(result.proposals_created).toHaveLength(0);
  });

  it('skips file-anchored docs with missing source_path without throwing', async () => {
    const contentHash = hash('body');
    repo.insertDocument({
      doc_id: 'corrupt-anchor',
      title: 'Corrupt',
      kind: 'guideline',
      content: 'body',
      content_hash: contentHash,
      status: 'approved',
      ownership: 'file-anchored',
      template_origin: null,
      source_path: 'x.md',
      source_refs_json: null,
    });
    db.prepare('UPDATE documents SET source_path = NULL WHERE doc_id = ?').run('corrupt-anchor');

    const result = await service.syncDocs({}, 'admin');
    expect(result.skipped_invalid_anchor).toContain('corrupt-anchor');
    expect(result.proposals_created).toHaveLength(0);
  });

  it('does not sync standalone docs even when source_path is set (ADR-010)', async () => {
    writeFileSync(join(tmpDir, 'solo.md'), 'a');
    repo.insertDocument({
      doc_id: 'standalone-sync-skip',
      title: 'Standalone',
      kind: 'guideline',
      content: 'a',
      content_hash: hash('a'),
      status: 'approved',
      ownership: 'standalone',
      template_origin: null,
      source_path: 'solo.md',
      source_refs_json: null,
    });
    writeFileSync(join(tmpDir, 'solo.md'), 'changed on disk');

    const result = await service.syncDocs({}, 'admin');
    expect(result.checked).toBe(0);
    expect(result.proposals_created).toHaveLength(0);
  });

  it('skips documents with pending update_doc proposals', async () => {
    writeFileSync(join(tmpDir, 'pending.md'), 'original');
    insertApprovedDoc('pending-doc', 'original', 'pending.md');
    writeFileSync(join(tmpDir, 'pending.md'), 'changed');

    repo.insertProposal({
      proposal_id: 'existing-prop',
      proposal_type: 'update_doc',
      payload: JSON.stringify({ doc_id: 'pending-doc', content: 'x', content_hash: hash('x') }),
      status: 'pending',
      review_comment: null,
    });

    const result = await service.syncDocs({}, 'admin');
    expect(result.skipped_pending).toContain('pending-doc');
    expect(result.proposals_created).toHaveLength(0);
  });

  it('marks sync observations as analyzed', async () => {
    writeFileSync(join(tmpDir, 'analyzed.md'), 'original');
    insertApprovedDoc('analyzed-doc', 'original', 'analyzed.md');
    writeFileSync(join(tmpDir, 'analyzed.md'), 'changed');

    await service.syncDocs({}, 'admin');

    const unanalyzed = repo.getUnanalyzedObservations('document_import');
    expect(unanalyzed).toHaveLength(0);
  });

  it('filters by doc_ids when specified', async () => {
    writeFileSync(join(tmpDir, 'a.md'), 'old-a');
    writeFileSync(join(tmpDir, 'b.md'), 'old-b');
    insertApprovedDoc('doc-a', 'old-a', 'a.md');
    insertApprovedDoc('doc-b', 'old-b', 'b.md');
    writeFileSync(join(tmpDir, 'a.md'), 'new-a');
    writeFileSync(join(tmpDir, 'b.md'), 'new-b');

    const result = await service.syncDocs({ doc_ids: ['doc-a'] }, 'admin');
    expect(result.checked).toBe(1);
    expect(result.proposals_created).toHaveLength(1);
  });

  it('creates observation with full document_import contract payload', async () => {
    writeFileSync(join(tmpDir, 'contract.md'), 'original');
    insertApprovedDoc('contract-doc', 'original', 'contract.md');
    writeFileSync(join(tmpDir, 'contract.md'), 'new content');

    await service.syncDocs({}, 'admin');

    const allObs = repo.getUnanalyzedObservations('document_import');
    expect(allObs).toHaveLength(0);

    const { observations } = repo.listObservations({ event_type: 'document_import' }, 100, 0);
    const syncObs = observations.find((o) => {
      const p = JSON.parse(o.payload);
      return p.doc_id === 'contract-doc';
    });
    expect(syncObs).toBeDefined();
    const obsPayload = JSON.parse(syncObs!.payload);
    expect(obsPayload.title).toBe('Doc contract-doc');
    expect(obsPayload.kind).toBe('guideline');
    expect(obsPayload.content).toBe('new content');
    expect(obsPayload.source_path).toBeTruthy();
  });

  it('reject and re-sync creates new observation and proposal', async () => {
    writeFileSync(join(tmpDir, 'reject.md'), 'original');
    insertApprovedDoc('reject-doc', 'original', 'reject.md');
    writeFileSync(join(tmpDir, 'reject.md'), 'v2');

    const r1 = await service.syncDocs({}, 'admin');
    expect(r1.proposals_created).toHaveLength(1);

    repo.rejectProposal(r1.proposals_created[0], 'not yet');

    writeFileSync(join(tmpDir, 'reject.md'), 'v3');
    const r2 = await service.syncDocs({}, 'admin');
    expect(r2.proposals_created).toHaveLength(1);

    const proposal = repo.getProposal(r2.proposals_created[0]);
    const payload = JSON.parse(proposal!.payload);
    expect(payload.content).toBe('v3');
  });

  it('dryRun reports would_create_proposals without proposals or observations', async () => {
    writeFileSync(join(tmpDir, 'dry.md'), 'original');
    insertApprovedDoc('dry-doc', 'original', 'dry.md');
    writeFileSync(join(tmpDir, 'dry.md'), 'changed');

    const result = await service.syncDocs({ dryRun: true }, 'admin');
    expect(result.dry_run).toBe(true);
    expect(result.would_create_proposals).toEqual(['dry-doc']);
    expect(result.proposals_created).toHaveLength(0);
    expect(repo.listProposals('pending', 100, 0).proposals).toHaveLength(0);
  });
});

// ============================================================
// maintenance (ADR-014)
// ============================================================

describe('AegisService — maintenance', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let service: AegisService;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    service = new AegisService(repo, TEMPLATES_ROOT);
  });

  it('rejects agent surface', async () => {
    await expect(service.runMaintenance('agent', { dryRun: true })).rejects.toThrow(SurfaceViolationError);
  });

  it('dry-run leaves pending observations unprocessed', async () => {
    repo.insertObservation({
      observation_id: 'obs-m',
      event_type: 'compile_miss',
      payload: JSON.stringify({ target_files: ['a.ts'], review_comment: 'x' }),
      related_compile_id: 'c1',
      related_snapshot_id: 's1',
    });

    const r = await service.runMaintenance('admin', { dryRun: true });
    expect(r.dry_run).toBe(true);
    expect(r.process_observations.pending_total).toBeGreaterThanOrEqual(1);
    expect(repo.getUnanalyzedObservations('compile_miss')).toHaveLength(1);
  });

  it('executed run marks pending compile_miss observations analyzed (may skip proposals)', async () => {
    repo.insertObservation({
      observation_id: 'obs-exec',
      event_type: 'compile_miss',
      payload: JSON.stringify({ target_files: ['a.ts'], review_comment: 'x' }),
      related_compile_id: 'c1',
      related_snapshot_id: 's1',
    });

    const r = await service.runMaintenance('admin', { dryRun: false });
    expect(r.dry_run).toBe(false);
    expect(repo.getUnanalyzedObservations('compile_miss')).toHaveLength(0);
    // RuleBasedAnalyzer skips when missing_doc is absent → processed count can be 0
    expect(r.process_observations.processed).toBe(0);
  });

  it('dry-run pending_total reflects full backlog beyond 50 per type', async () => {
    for (let i = 0; i < 55; i++) {
      repo.insertObservation({
        observation_id: `obs-bulk-${i}`,
        event_type: 'compile_miss',
        payload: JSON.stringify({ target_files: ['a.ts'], review_comment: 'x' }),
        related_compile_id: 'c1',
        related_snapshot_id: 's1',
      });
    }
    expect(repo.countUnanalyzedObservations('compile_miss')).toBe(55);
    const r = await service.runMaintenance('admin', { dryRun: true });
    expect(r.process_observations.pending_by_type.compile_miss).toBe(55);
    expect(r.process_observations.pending_total).toBe(55);
  });

  it('staleness_report lists file-anchored docs past source-sync threshold (ADR-014)', async () => {
    repo.insertDocument({
      doc_id: 'old-sync',
      title: 'Old',
      kind: 'guideline',
      content: 'c',
      content_hash: hash('c'),
      status: 'approved',
      ownership: 'file-anchored',
      template_origin: null,
      source_path: 'legacy.md',
      source_synced_at: '2000-01-01T00:00:00.000Z',
    });

    const r = await service.runMaintenance('admin', { dryRun: true });
    expect(r.staleness_report.threshold_days).toBe(90);
    expect(r.staleness_report.stale_file_anchored_doc_ids).toContain('old-sync');
  });

  it('processObservations drains backlog beyond default fetch limit', async () => {
    for (let i = 0; i < 55; i++) {
      repo.insertObservation({
        observation_id: `obs-drain-${i}`,
        event_type: 'compile_miss',
        payload: JSON.stringify({ target_files: ['a.ts'], review_comment: 'x' }),
        related_compile_id: 'c1',
        related_snapshot_id: 's1',
      });
    }
    await service.processObservations('compile_miss', 'admin');
    expect(repo.countUnanalyzedObservations('compile_miss')).toBe(0);
  });

  it('processObservations runs doc-refactor pass once and emits split_candidate doc_gap_detected', async () => {
    repo.insertProposal({
      proposal_id: 'boot-int',
      proposal_type: 'bootstrap',
      payload: JSON.stringify({
        documents: [
          { doc_id: 'd1', title: 'd1', kind: 'guideline', content: 'x', content_hash: hash('x') },
          { doc_id: 'd2', title: 'd2', kind: 'guideline', content: 'x', content_hash: hash('x') },
          { doc_id: 'd3', title: 'd3', kind: 'guideline', content: 'x', content_hash: hash('x') },
        ],
        edges: [
          {
            edge_id: 'e-int',
            source_type: 'path',
            source_value: 'src/**',
            target_doc_id: 'd1',
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
    const { snapshot_id } = repo.approveProposal('boot-int');

    for (let i = 0; i < 10; i++) {
      repo.insertCompileLog({
        compile_id: `cmp-${i}`,
        snapshot_id,
        request: '{}',
        base_doc_ids: JSON.stringify(['d1', 'd2', 'd3']),
        expanded_doc_ids: null,
        audit_meta: null,
        agent_id: null,
      });
    }

    const miss = (id: string, files: string[], cid: string) =>
      repo.insertObservation({
        observation_id: id,
        event_type: 'compile_miss',
        payload: JSON.stringify({
          target_files: files,
          target_doc_id: 'd1',
          review_comment: 'm',
        }),
        related_compile_id: cid,
        related_snapshot_id: snapshot_id,
      });

    miss('cm-a', ['src/a/x.ts'], 'cmp-0');
    miss('cm-b', ['src/b/y.ts'], 'cmp-1');
    miss('cm-c', ['src/a/z.ts'], 'cmp-2');

    await service.processObservations('compile_miss', 'admin');

    const gaps = repo.listObservationsByEventType('doc_gap_detected');
    expect(gaps.length).toBe(1);
    const pl = JSON.parse(gaps[0]!.payload) as { gap_kind: string; algorithm_version: string };
    expect(pl.gap_kind).toBe('split_candidate');
    expect(pl.algorithm_version).toBe(DOC_REFACTOR_ALGORITHM_VERSION);
  });
});

// ============================================================
// buildObserveContent (server.ts response shape)
// ============================================================

describe('buildObserveContent', () => {
  it('returns single content block for non-compile_miss events', () => {
    const result = { observation_id: 'obs-1' };
    const content = buildObserveContent(result, 'manual_note');
    expect(content).toHaveLength(1);
    expect(JSON.parse(content[0].text)).toEqual(result);
  });

  it('returns two content blocks for compile_miss (JSON + hint)', () => {
    const result = { observation_id: 'obs-2' };
    const content = buildObserveContent(result, 'compile_miss');
    expect(content).toHaveLength(2);
    expect(JSON.parse(content[0].text)).toEqual(result);
    expect(content[1].text).toContain('aegis_list_observations');
  });

  it('first block is always valid JSON regardless of event type', () => {
    for (const eventType of [
      'compile_miss',
      'review_correction',
      'pr_merged',
      'manual_note',
      'document_import',
      'doc_gap_detected',
    ]) {
      const content = buildObserveContent({ observation_id: 'x' }, eventType);
      expect(() => JSON.parse(content[0].text)).not.toThrow();
    }
  });
});

// ============================================================
// new_doc_hint.kind validation
// ============================================================

describe('AegisService — new_doc_hint.kind validation', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let service: AegisService;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    service = new AegisService(repo, '', []);
  });

  it('accepts valid kind values in new_doc_hint', () => {
    for (const kind of ['guideline', 'pattern', 'constraint', 'template', 'reference']) {
      expect(() =>
        service.observe(
          {
            event_type: 'manual_note',
            payload: {
              content: 'test note',
              new_doc_hint: { doc_id: `test-${kind}`, title: 'Test', kind },
            },
          },
          'agent',
        ),
      ).not.toThrow();
    }
  });

  it('rejects invalid kind value in new_doc_hint', () => {
    expect(() =>
      service.observe(
        {
          event_type: 'manual_note',
          payload: {
            content: 'test note',
            new_doc_hint: { doc_id: 'test-bad', title: 'Test', kind: 'invalid-kind' },
          },
        },
        'agent',
      ),
    ).toThrow('new_doc_hint.kind is required');
  });

  it('rejects new_doc_hint without kind (required)', () => {
    expect(() =>
      service.observe(
        {
          event_type: 'manual_note',
          payload: {
            content: 'test note',
            new_doc_hint: { doc_id: 'test-no-kind', title: 'Test' },
          },
        },
        'agent',
      ),
    ).toThrow('new_doc_hint.kind is required');
  });
});

// ============================================================
// BudgetExceededError — MCP handler (via InMemoryTransport)
// ============================================================

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { IntentTagger } from '../core/tagging/tagger.js';
import type { IntentTag } from '../core/types.js';
import { BudgetExceededError } from '../core/types.js';
import { createAegisServer } from './server.js';

function bootstrapIntentTagsMcpFixture(repo: Repository): void {
  repo.insertProposal({
    proposal_id: 'boot-intent-mcp',
    proposal_type: 'bootstrap',
    payload: JSON.stringify({
      documents: [
        {
          doc_id: 'base-doc',
          title: 'Base',
          kind: 'guideline',
          content: 'base',
          content_hash: hash('base'),
        },
        {
          doc_id: 'auth-doc',
          title: 'Auth',
          kind: 'guideline',
          content: 'auth',
          content_hash: hash('auth'),
        },
      ],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'base-doc',
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
  repo.approveProposal('boot-intent-mcp');
  repo.upsertTagMapping({ tag: 'authentication', doc_id: 'auth-doc', confidence: 0.9, source: 'manual' });
}

class FailingTaggerForIntentTags implements IntentTagger {
  async extractTags(_plan: string, _knownTags: string[]): Promise<IntentTag[]> {
    throw new Error('tagger should not run when intent_tags controls expansion');
  }
}

describe('aegis_compile_context — intent_tags MCP wiring', () => {
  it('forwards intent_tags through transport and resolves expanded documents', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    bootstrapIntentTagsMcpFixture(repo);
    const service = new AegisService(repo, TEMPLATES_ROOT);

    const server = createAegisServer(service, 'agent');
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const response = await client.callTool({
      name: 'aegis_compile_context',
      arguments: { target_files: ['src/a.ts'], intent_tags: ['authentication'] },
    });

    expect(response.isError).not.toBe(true);
    const content = response.content as Array<{ type: string; text: string }>;
    const body = JSON.parse(content[0].text) as {
      expanded?: { documents: Array<{ doc_id: string }> };
      compile_id: string;
    };
    const expandedIds = body.expanded?.documents.map((d) => d.doc_id) ?? [];
    expect(expandedIds).toContain('auth-doc');

    const audit = service.getCompileAudit(body.compile_id, 'agent');
    expect(audit?.request).toMatchObject({ intent_tags: ['authentication'] });

    await client.close();
    await server.close();
  });

  it('intent_tags [] opts out even when plan is set and tagger would fail', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    bootstrapIntentTagsMcpFixture(repo);
    const service = new AegisService(repo, TEMPLATES_ROOT, new FailingTaggerForIntentTags());

    const server = createAegisServer(service, 'agent');
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const response = await client.callTool({
      name: 'aegis_compile_context',
      arguments: { target_files: ['src/a.ts'], plan: 'add auth', intent_tags: [] },
    });

    expect(response.isError).not.toBe(true);
    const content = response.content as Array<{ type: string; text: string }>;
    const body = JSON.parse(content[0].text) as { expanded?: unknown };
    expect(body.expanded).toBeUndefined();

    await client.close();
    await server.close();
  });

  it('persists raw intent_tags in compile_log.request (duplicate spacing preserved)', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    bootstrapIntentTagsMcpFixture(repo);
    const service = new AegisService(repo, TEMPLATES_ROOT);

    const server = createAegisServer(service, 'agent');
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const rawTags = ['  authentication ', 'authentication'];
    const response = await client.callTool({
      name: 'aegis_compile_context',
      arguments: { target_files: ['src/a.ts'], intent_tags: rawTags },
    });

    expect(response.isError).not.toBe(true);
    const content = response.content as Array<{ type: string; text: string }>;
    const body = JSON.parse(content[0].text) as { compile_id: string };
    const audit = service.getCompileAudit(body.compile_id, 'agent');
    expect(audit?.request).toMatchObject({ intent_tags: rawTags });

    await client.close();
    await server.close();
  });
});

describe('aegis_get_known_tags — MCP wiring', () => {
  it('is registered on agent and admin surfaces and returns catalog JSON', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    bootstrapIntentTagsMcpFixture(repo);
    const service = new AegisService(repo, TEMPLATES_ROOT);

    for (const surface of ['agent', 'admin'] as const) {
      const server = createAegisServer(service, surface);
      const client = new Client({ name: 'test-client', version: '0.0.1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

      const tools = await client.listTools();
      expect(tools.tools.some((t) => t.name === 'aegis_get_known_tags')).toBe(true);

      const response = await client.callTool({ name: 'aegis_get_known_tags', arguments: {} });
      expect(response.isError).not.toBe(true);
      const content = response.content as Array<{ type: string; text: string }>;
      const body = JSON.parse(content[0].text) as {
        tags: string[];
        knowledge_version: number;
        tag_catalog_hash: string;
      };
      expect(body.tags).toContain('authentication');
      expect(body.knowledge_version).toBeGreaterThanOrEqual(1);
      expect(body.tag_catalog_hash).toHaveLength(64);

      await client.close();
      await server.close();
    }
  });
});

describe('aegis_workspace_status — MCP wiring', () => {
  it('is registered on agent and admin surfaces and returns JSON', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    const service = new AegisService(repo, TEMPLATES_ROOT);

    for (const surface of ['agent', 'admin'] as const) {
      const server = createAegisServer(service, surface);
      const client = new Client({ name: 'ws-client', version: '0.0.1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

      const tools = await client.listTools();
      expect(tools.tools.some((t) => t.name === 'aegis_workspace_status')).toBe(true);

      const response = await client.callTool({
        name: 'aegis_workspace_status',
        arguments: { window_hours: 12 },
      });
      expect(response.isError).not.toBe(true);
      const content = response.content as Array<{ type: string; text: string }>;
      const body = JSON.parse(content[0].text) as {
        window_hours: number;
        pending_proposal_count: number;
      };
      expect(body.window_hours).toBe(12);
      expect(body.pending_proposal_count).toBe(0);

      await client.close();
      await server.close();
    }
  });
});

// ============================================================
// getStats / aegis_get_stats (ADR-012 / ADR-014)
// ============================================================

describe('AegisService — getStats', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let service: AegisService;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    service = new AegisService(repo, TEMPLATES_ROOT);
  });

  it('rejects agent surface', () => {
    expect(() => service.getStats('agent')).toThrow(SurfaceViolationError);
  });

  it('returns zeros for empty uninitialized DB', () => {
    const s = service.getStats('admin');
    expect(s.knowledge.approved_docs).toBe(0);
    expect(s.knowledge.approved_edges).toBe(0);
    expect(s.knowledge.pending_proposals).toBe(0);
    expect(s.knowledge.knowledge_version).toBe(0);
    expect(s.usage.total_compiles).toBe(0);
    expect(s.usage.unique_target_files).toBe(0);
    expect(s.usage.avg_budget_utilization).toBeNull();
    expect(s.health.unanalyzed_observations).toBe(0);
    expect(s.health.orphaned_tag_mappings).toBe(0);
  });

  it('aggregates compile_log usage and orphaned tag mappings', () => {
    repo.insertProposal({
      proposal_id: 'boot-stats',
      proposal_type: 'bootstrap',
      payload: JSON.stringify({
        documents: [{ doc_id: 'd0', title: 'D0', kind: 'guideline', content: 'c', content_hash: hash('c') }],
        edges: [],
        layer_rules: [],
      }),
      status: 'pending',
      review_comment: null,
    });
    repo.approveProposal('boot-stats');
    repo.insertProposal({
      proposal_id: 'p1',
      proposal_type: 'new_doc',
      payload: '{}',
      status: 'pending',
      review_comment: null,
    });
    const snapshot = repo.getCurrentSnapshot()!;
    const audit = {
      delivery_stats: {
        inline_count: 0,
        inline_total_bytes: 0,
        deferred_count: 0,
        deferred_total_bytes: 0,
        omitted_count: 0,
        omitted_total_bytes: 0,
      },
      budget_utilization: 0.5,
      budget_exceeded: false,
      budget_dropped: [],
      near_miss_edges: [
        {
          edge_id: 'e1',
          pattern: 'src/**/*.ts',
          target_doc_id: 'd1',
          reason: 'glob_no_match' as const,
        },
      ],
      layer_classification: {},
      policy_omitted_doc_ids: [],
      performance: { near_miss_edge_scan_ms: 0, near_miss_edges_evaluated: 0 },
    };
    repo.insertCompileLog({
      compile_id: 'c1',
      snapshot_id: snapshot.snapshot_id,
      request: JSON.stringify({ target_files: ['a.ts', 'b.ts'] }),
      base_doc_ids: JSON.stringify(['doc-a', 'doc-b', 'doc-a']),
      expanded_doc_ids: JSON.stringify(['exp-z', 'doc-a']),
      audit_meta: JSON.stringify(audit),
      agent_id: null,
    });
    repo.insertDocument({
      doc_id: 'ghost-doc',
      title: 'Ghost',
      kind: 'guideline',
      content: 'x',
      content_hash: hash('x'),
      status: 'draft',
      ownership: 'standalone',
      template_origin: null,
      source_path: null,
      source_synced_at: null,
    });
    repo.upsertTagMapping({ tag: 'orphan', doc_id: 'ghost-doc', confidence: 1, source: 'manual' });

    const s = service.getStats('admin');
    expect(s.knowledge.pending_proposals).toBe(1);
    expect(s.usage.total_compiles).toBe(1);
    expect(s.usage.unique_target_files).toBe(2);
    expect(s.usage.avg_budget_utilization).toBe(0.5);
    expect(s.usage.most_referenced_docs[0]).toEqual({ doc_id: 'doc-a', count: 3 });
    expect(s.usage.most_referenced_docs.map((x) => x.doc_id)).toContain('exp-z');
    expect(s.usage.most_missed_patterns[0]).toEqual({ pattern: 'src/**/*.ts', count: 1 });
    expect(s.health.orphaned_tag_mappings).toBe(1);
    expect(s.health.orphaned_tag_mapping_samples).toEqual([{ tag: 'orphan', doc_id: 'ghost-doc' }]);
  });
});

describe('aegis_get_stats — MCP wiring', () => {
  it('is admin-only and returns JSON', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    const service = new AegisService(repo, TEMPLATES_ROOT);

    const adminServer = createAegisServer(service, 'admin');
    const adminClient = new Client({ name: 'test-client', version: '0.0.1' });
    const [c1, c2] = InMemoryTransport.createLinkedPair();
    await Promise.all([adminClient.connect(c1), adminServer.connect(c2)]);

    const tools = await adminClient.listTools();
    expect(tools.tools.some((t) => t.name === 'aegis_get_stats')).toBe(true);
    const res = await adminClient.callTool({ name: 'aegis_get_stats', arguments: {} });
    expect(res.isError).not.toBe(true);
    const body = JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text) as Record<string, unknown>;
    expect(body.knowledge).toBeDefined();
    expect(body.usage).toBeDefined();
    expect(body.health).toBeDefined();

    await adminClient.close();
    await adminServer.close();

    const agentServer = createAegisServer(service, 'agent');
    const agentClient = new Client({ name: 'test-client2', version: '0.0.1' });
    const [a1, a2] = InMemoryTransport.createLinkedPair();
    await Promise.all([agentClient.connect(a1), agentServer.connect(a2)]);
    const agentTools = await agentClient.listTools();
    expect(agentTools.tools.some((t) => t.name === 'aegis_get_stats')).toBe(false);
    await agentClient.close();
    await agentServer.close();
  });
});

describe('BudgetExceededError — MCP handler', () => {
  function bootstrapLargeDoc(repo: Repository) {
    const largeContent = 'x'.repeat(10_000);
    repo.insertProposal({
      proposal_id: 'boot-budget',
      proposal_type: 'bootstrap',
      payload: JSON.stringify({
        documents: [
          {
            doc_id: 'big-doc',
            title: 'Big',
            kind: 'guideline',
            content: largeContent,
            content_hash: hash(largeContent),
          },
        ],
        edges: [
          {
            edge_id: 'e-big',
            source_type: 'path',
            source_value: 'src/**',
            target_doc_id: 'big-doc',
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
    repo.approveProposal('boot-budget');
  }

  it('service.compileContext throws BudgetExceededError with correct shape', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    const service = new AegisService(repo, TEMPLATES_ROOT);
    bootstrapLargeDoc(repo);

    try {
      await service.compileContext({ target_files: ['src/a.ts'], max_inline_bytes: 100 }, 'agent');
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExceededError);
      const err = e as BudgetExceededError;
      expect(err.compile_id).toBeTruthy();
      expect(err.mandatory_bytes).toBeGreaterThan(100);
      expect(err.max_inline_bytes).toBe(100);
      expect(err.offending_doc_ids).toContain('big-doc');
    }
  });

  it('MCP server returns isError:true with BUDGET_EXCEEDED_MANDATORY via transport', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    const service = new AegisService(repo, TEMPLATES_ROOT);
    bootstrapLargeDoc(repo);

    const server = createAegisServer(service, 'agent');
    const client = new Client({ name: 'test-client', version: '0.0.1' });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const response = await client.callTool({
      name: 'aegis_compile_context',
      arguments: { target_files: ['src/a.ts'], max_inline_bytes: 100 },
    });

    expect(response.isError).toBe(true);
    const content = response.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    const body = JSON.parse(content[0].text);
    expect(body.error).toBe('BUDGET_EXCEEDED_MANDATORY');
    expect(body.compile_id).toBeTruthy();
    expect(body.mandatory_bytes).toBeGreaterThan(100);
    expect(body.max_inline_bytes).toBe(100);
    expect(body.offending_doc_ids).toContain('big-doc');

    await client.close();
    await server.close();
  });
});

describe('aegis import plan — MCP wiring', () => {
  it('admin registers import plan tools; agent omits them; analyze_doc returns resolved_source_path null without file', async () => {
    const db = await createInMemoryDatabase();
    const repo = new Repository(db);
    const tmpDir = mkdtempSync(join(tmpdir(), 'aegis-ip-mcp-'));
    const service = new AegisService(repo, TEMPLATES_ROOT, null, [], false, tmpDir);

    const adminSrv = createAegisServer(service, 'admin');
    const adminCli = new Client({ name: 'adm', version: '0.0.1' });
    const [ac1, ac2] = InMemoryTransport.createLinkedPair();
    await Promise.all([adminCli.connect(ac1), adminSrv.connect(ac2)]);
    const adminNames = (await adminCli.listTools()).tools.map((t) => t.name);
    expect(adminNames).toContain('aegis_analyze_doc');
    expect(adminNames).toContain('aegis_analyze_import_batch');
    expect(adminNames).toContain('aegis_execute_import_plan');

    const res = await adminCli.callTool({
      name: 'aegis_analyze_doc',
      arguments: { content: '## T\n\nbody\n', source_label: 'label-only.md' },
    });
    expect(res.isError).not.toBe(true);
    const plan = JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text) as {
      resolved_source_path: string | null;
    };
    expect(plan.resolved_source_path).toBeNull();

    await adminCli.close();
    await adminSrv.close();

    const agentSrv = createAegisServer(service, 'agent');
    const agentCli = new Client({ name: 'ag', version: '0.0.1' });
    const [gc1, gc2] = InMemoryTransport.createLinkedPair();
    await Promise.all([agentCli.connect(gc1), agentSrv.connect(gc2)]);
    const agentNames = (await agentCli.listTools()).tools.map((t) => t.name);
    expect(agentNames.some((n) => n.includes('import_plan') || n.includes('analyze_doc'))).toBe(false);

    await agentCli.close();
    await agentSrv.close();

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
