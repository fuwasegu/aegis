import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    service = new AegisService(repo, templatesDir);
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

    // Each document should have the required fields
    for (const doc of result.base.documents) {
      expect(doc.doc_id).toBeTruthy();
      expect(doc.title).toBeTruthy();
      expect(doc.kind).toBeTruthy();
      expect(doc.content).toBeTruthy();
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
      template_origin: null,
      source_path: sourcePath,
    });
  }

  it('detects stale document and creates update_doc proposal with evidence', () => {
    writeFileSync(join(tmpDir, 'stale.md'), 'original');
    insertApprovedDoc('stale-doc', 'original', 'stale.md');

    writeFileSync(join(tmpDir, 'stale.md'), 'updated content');
    const result = service.syncDocs({}, 'admin');

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

  it('reports up_to_date when file has not changed', () => {
    writeFileSync(join(tmpDir, 'fresh.md'), 'same content');
    insertApprovedDoc('fresh-doc', 'same content', 'fresh.md');

    const result = service.syncDocs({}, 'admin');
    expect(result.up_to_date).toBe(1);
    expect(result.proposals_created).toHaveLength(0);
  });

  it('reports not_found when source file is missing', () => {
    insertApprovedDoc('missing-doc', 'content', 'nonexistent/file.md');

    const result = service.syncDocs({}, 'admin');
    expect(result.not_found).toContain('missing-doc');
    expect(result.proposals_created).toHaveLength(0);
  });

  it('skips documents with pending update_doc proposals', () => {
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

    const result = service.syncDocs({}, 'admin');
    expect(result.skipped_pending).toContain('pending-doc');
    expect(result.proposals_created).toHaveLength(0);
  });

  it('marks sync observations as analyzed', () => {
    writeFileSync(join(tmpDir, 'analyzed.md'), 'original');
    insertApprovedDoc('analyzed-doc', 'original', 'analyzed.md');
    writeFileSync(join(tmpDir, 'analyzed.md'), 'changed');

    service.syncDocs({}, 'admin');

    const unanalyzed = repo.getUnanalyzedObservations('document_import');
    expect(unanalyzed).toHaveLength(0);
  });

  it('filters by doc_ids when specified', () => {
    writeFileSync(join(tmpDir, 'a.md'), 'old-a');
    writeFileSync(join(tmpDir, 'b.md'), 'old-b');
    insertApprovedDoc('doc-a', 'old-a', 'a.md');
    insertApprovedDoc('doc-b', 'old-b', 'b.md');
    writeFileSync(join(tmpDir, 'a.md'), 'new-a');
    writeFileSync(join(tmpDir, 'b.md'), 'new-b');

    const result = service.syncDocs({ doc_ids: ['doc-a'] }, 'admin');
    expect(result.checked).toBe(1);
    expect(result.proposals_created).toHaveLength(1);
  });

  it('creates observation with full document_import contract payload', () => {
    writeFileSync(join(tmpDir, 'contract.md'), 'original');
    insertApprovedDoc('contract-doc', 'original', 'contract.md');
    writeFileSync(join(tmpDir, 'contract.md'), 'new content');

    service.syncDocs({}, 'admin');

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

  it('reject and re-sync creates new observation and proposal', () => {
    writeFileSync(join(tmpDir, 'reject.md'), 'original');
    insertApprovedDoc('reject-doc', 'original', 'reject.md');
    writeFileSync(join(tmpDir, 'reject.md'), 'v2');

    const r1 = service.syncDocs({}, 'admin');
    expect(r1.proposals_created).toHaveLength(1);

    repo.rejectProposal(r1.proposals_created[0], 'not yet');

    writeFileSync(join(tmpDir, 'reject.md'), 'v3');
    const r2 = service.syncDocs({}, 'admin');
    expect(r2.proposals_created).toHaveLength(1);

    const proposal = repo.getProposal(r2.proposals_created[0]);
    const payload = JSON.parse(proposal!.payload);
    expect(payload.content).toBe('v3');
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
    for (const eventType of ['compile_miss', 'review_correction', 'pr_merged', 'manual_note']) {
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

import { BudgetExceededError } from '../core/types.js';
import { createAegisServer } from './server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

describe('BudgetExceededError — MCP handler', () => {
  function bootstrapLargeDoc(repo: Repository) {
    const largeContent = 'x'.repeat(10_000);
    repo.insertProposal({
      proposal_id: 'boot-budget',
      proposal_type: 'bootstrap',
      payload: JSON.stringify({
        documents: [{
          doc_id: 'big-doc',
          title: 'Big',
          kind: 'guideline',
          content: largeContent,
          content_hash: hash(largeContent),
        }],
        edges: [{
          edge_id: 'e-big',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'big-doc',
          edge_type: 'path_requires',
          priority: 100,
          specificity: 0,
        }],
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
      await service.compileContext(
        { target_files: ['src/a.ts'], max_inline_bytes: 100 },
        'agent',
      );
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
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

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
