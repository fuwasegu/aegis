/**
 * E2E Integration Tests
 *
 * Tests the full flow through AegisService without MCP transport:
 * init → compile_context → observe → analyzeAndPropose → approve
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualNoteAnalyzer } from '../core/automation/manual-note-analyzer.js';
import { ReviewCorrectionAnalyzer } from '../core/automation/review-correction-analyzer.js';
import { RuleBasedAnalyzer } from '../core/automation/rule-analyzer.js';
import { createInMemoryDatabase } from '../core/store/database.js';
import { Repository } from '../core/store/repository.js';
import type { IntentTagger } from '../core/tagging/tagger.js';
import type { IntentTag } from '../core/types.js';
import { AegisService } from '../mcp/services.js';

function makeTmpProject(): string {
  const dir = join(import.meta.dirname, '../../.tmp-test', randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTestTemplateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-tpl-'));
  const tplDir = join(dir, 'test-tpl');
  mkdirSync(join(tplDir, 'documents'), { recursive: true });

  writeFileSync(
    join(tplDir, 'manifest.yaml'),
    `template_id: test-tpl
version: "0.1.0"
display_name: "Test Template"
description: "E2E test template"

detect_signals:
  required:
    - type: file_exists
      path: marker.txt
  boosters: []
  confidence_thresholds:
    high: 50
    medium: 10

placeholders:
  app_root:
    description: "App root"
    required: true
    detect_strategy: first_match
    candidates:
      - app
      - src
    ambiguity_policy: first
    default: src

seed_documents:
  - doc_id: test-root
    title: "Test Architecture Root"
    kind: guideline
    file: root.md

seed_edges:
  - source_type: path
    source_value: "{{app_root}}/**"
    target_doc_id: test-root
    edge_type: path_requires
    priority: 100

seed_layer_rules: []
`,
  );

  writeFileSync(
    join(tplDir, 'documents', 'root.md'),
    '# Architecture Root\n\nAll code should follow clean architecture patterns.',
  );

  return dir;
}

class FakeTagger implements IntentTagger {
  async extractTags(_plan: string, _knownTags: string[]): Promise<IntentTag[]> {
    return [{ tag: 'state_mutation', confidence: 0.9 }];
  }
}

describe('E2E: Template-based Lifecycle', () => {
  let repo: Repository;
  let adminService: AegisService;
  let agentService: AegisService;
  let tmpDir: string;
  let templatesDir: string;

  beforeEach(async () => {
    const db = await createInMemoryDatabase();
    repo = new Repository(db);
    const tagger = new FakeTagger();
    templatesDir = makeTestTemplateDir();
    adminService = new AegisService(repo, templatesDir, tagger);
    agentService = new AegisService(repo, templatesDir, tagger);

    tmpDir = makeTmpProject();
    writeFileSync(join(tmpDir, 'marker.txt'), '');
    mkdirSync(join(tmpDir, 'app'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(templatesDir, { recursive: true, force: true });
    } catch {}
  });

  it('full lifecycle: init → compile → observe → analyze → approve', async () => {
    const preview = adminService.initDetect(tmpDir, 'admin');
    expect(preview.template_id).toBe('test-tpl');
    expect(preview.has_blocking_warnings).toBe(false);
    expect(preview.generated.documents.length).toBeGreaterThan(0);

    const initResult = adminService.initConfirm(preview.preview_hash, 'admin');
    expect(initResult.knowledge_version).toBe(1);

    const compiled = await agentService.compileContext({ target_files: ['app/User/Entity.ts'] }, 'agent');
    expect(compiled.knowledge_version).toBe(1);
    expect(compiled.base.documents.length).toBeGreaterThan(0);
    expect(compiled.compile_id).toBeTruthy();

    const observation = agentService.observe(
      {
        event_type: 'compile_miss',
        related_compile_id: compiled.compile_id,
        related_snapshot_id: compiled.snapshot_id,
        payload: {
          target_files: ['app/User/Entity.ts'],
          missing_doc: 'test-root',
          review_comment: 'Guidelines were not specific enough',
        },
      },
      'agent',
    );
    expect(observation.observation_id).toBeTruthy();

    const analyzer = new RuleBasedAnalyzer(repo);
    const analysis = await adminService.analyzeAndPropose(analyzer, 'compile_miss', 'admin');
    expect(analysis.proposals.created_proposal_ids.length).toBeGreaterThan(0);

    const proposalList = adminService.listProposals({ status: 'pending' }, 'admin');
    for (const p of proposalList.proposals as any[]) {
      const approved = adminService.approveProposal(p.proposal_id, undefined, 'admin');
      expect(approved.knowledge_version).toBeGreaterThan(1);
    }
  });

  it('review_correction flow works end to end', async () => {
    const preview = adminService.initDetect(tmpDir, 'admin');
    adminService.initConfirm(preview.preview_hash, 'admin');

    agentService.observe(
      {
        event_type: 'review_correction',
        payload: {
          file_path: 'app/User/Entity.ts',
          correction: 'Should use value objects for IDs',
          target_doc_id: 'test-root',
          proposed_content: '# Updated Root\n\nUse value objects for IDs.',
        },
      },
      'agent',
    );

    const analyzer = new ReviewCorrectionAnalyzer(repo);
    const analysis = await adminService.analyzeAndPropose(analyzer, 'review_correction', 'admin');
    expect(analysis.proposals.created_proposal_ids.length).toBe(1);

    const detail = adminService.getProposal(analysis.proposals.created_proposal_ids[0], 'admin');
    expect(detail?.proposal_type).toBe('update_doc');
  });

  it('manual_note with new_doc_hint creates new doc proposal', async () => {
    const preview = adminService.initDetect(tmpDir, 'admin');
    adminService.initConfirm(preview.preview_hash, 'admin');

    agentService.observe(
      {
        event_type: 'manual_note',
        payload: {
          content: '# Error Handling\n\nAll errors should be wrapped.',
          new_doc_hint: { doc_id: 'error-handling', title: 'Error Handling Guide', kind: 'guideline' },
        },
      },
      'agent',
    );

    const analyzer = new ManualNoteAnalyzer(repo);
    const analysis = await adminService.analyzeAndPropose(analyzer, 'manual_note', 'admin');
    expect(analysis.proposals.created_proposal_ids.length).toBe(1);

    const detail = adminService.getProposal(analysis.proposals.created_proposal_ids[0], 'admin');
    expect(detail?.proposal_type).toBe('new_doc');
    const payload = (detail as any).payload;
    expect(payload.doc_id).toBe('error-handling');
  });

  it('agent can call init_detect but not init_confirm', () => {
    const preview = agentService.initDetect(tmpDir, 'agent');
    expect(preview.template_id).toBe('test-tpl');
    expect(() => agentService.initConfirm(preview.preview_hash, 'agent')).toThrow('not available');
  });
});

describe('E2E: Template-less Lifecycle (skip_template)', () => {
  let repo: Repository;
  let adminService: AegisService;
  let agentService: AegisService;
  let tmpDir: string;

  beforeEach(async () => {
    const db = await createInMemoryDatabase();
    repo = new Repository(db);
    const tagger = new FakeTagger();
    adminService = new AegisService(repo, '', tagger);
    agentService = new AegisService(repo, '', tagger);

    tmpDir = makeTmpProject();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('skip_template → init → import_doc(edge_hints) → approve → compile_context returns doc', async () => {
    // Step 1: Admin inits with skip_template
    const preview = adminService.initDetect(tmpDir, 'admin', { skip_template: true });
    expect(preview.template_id).toBe('none');
    expect(preview.has_blocking_warnings).toBe(false);
    expect(preview.generated.documents).toHaveLength(0);

    const initResult = adminService.initConfirm(preview.preview_hash, 'admin');
    expect(initResult.knowledge_version).toBe(1);

    // Step 2: compile_context is empty
    const emptyCompile = await agentService.compileContext({ target_files: ['src/core/store/repo.ts'] }, 'agent');
    expect(emptyCompile.base.documents).toHaveLength(0);
    expect(emptyCompile.warnings.length).toBeGreaterThan(0);
    expect(emptyCompile.warnings.some((w: string) => w.includes('No edges are registered'))).toBe(true);

    // Step 3: Admin imports a doc with edge_hints
    const importResult = await adminService.importDoc(
      {
        content: '# Repository Pattern\n\nAll data access goes through repositories.',
        doc_id: 'repo-pattern',
        title: 'Repository Pattern',
        kind: 'guideline',
        edge_hints: [
          { source_type: 'path' as const, source_value: 'src/core/store/**', edge_type: 'path_requires' as const },
        ],
      },
      'admin',
    );
    expect(importResult.proposal_ids.length).toBeGreaterThan(0);
    expect(importResult.warnings).toHaveLength(0);

    // Step 4: Admin approves proposals in importDoc return order (new_doc first, then add_edge)
    for (const pid of importResult.proposal_ids) {
      adminService.approveProposal(pid, undefined, 'admin');
    }

    // Step 5: compile_context now returns the imported doc
    const compiled = await agentService.compileContext({ target_files: ['src/core/store/repo.ts'] }, 'agent');
    expect(compiled.base.documents.length).toBe(1);
    expect(compiled.base.documents[0].doc_id).toBe('repo-pattern');
    expect(compiled.base.documents[0].content).toContain('Repository Pattern');
  });

  it('auto mode defers source_path docs, agent can use source_path to read', async () => {
    const preview = adminService.initDetect(tmpDir, 'admin', { skip_template: true });
    adminService.initConfirm(preview.preview_hash, 'admin');

    // Create a real file in the tmp project
    const docFilePath = join(tmpDir, 'docs', 'arch.md');
    mkdirSync(join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(docFilePath, '# Architecture\n\nClean architecture patterns.\n'.repeat(100));

    // Import with file_path → source_path gets auto-set
    const importResult = await adminService.importDoc(
      {
        file_path: docFilePath,
        doc_id: 'arch-guide',
        title: 'Architecture Guide',
        kind: 'guideline',
        edge_hints: [
          { source_type: 'path' as const, source_value: 'src/**', edge_type: 'path_requires' as const },
        ],
      },
      'admin',
    );
    for (const pid of importResult.proposal_ids) {
      adminService.approveProposal(pid, undefined, 'admin');
    }

    // Default auto mode: large doc with source_path → deferred
    const compiled = await agentService.compileContext({ target_files: ['src/index.ts'] }, 'agent');
    const doc = compiled.base.documents.find((d: any) => d.doc_id === 'arch-guide')!;
    expect(doc).toBeDefined();
    expect(doc.delivery).toBe('deferred');
    expect(doc.content).toBeUndefined();
    expect(doc.source_path).toBeDefined();
    expect(doc.content_bytes).toBeGreaterThan(0);

    // Explicit always mode: same doc → inline
    const compiledAlways = await agentService.compileContext(
      { target_files: ['src/index.ts'], content_mode: 'always' },
      'agent',
    );
    const docAlways = compiledAlways.base.documents.find((d: any) => d.doc_id === 'arch-guide')!;
    expect(docAlways.delivery).toBe('inline');
    expect(docAlways.content).toContain('Architecture');
  });

  it('import_doc without edge_hints warns about isolation', async () => {
    const preview = adminService.initDetect(tmpDir, 'admin', { skip_template: true });
    adminService.initConfirm(preview.preview_hash, 'admin');

    const importResult = await adminService.importDoc(
      {
        content: '# Isolated Doc\n\nNo edges.',
        doc_id: 'isolated-doc',
        title: 'Isolated Document',
        kind: 'guideline',
      },
      'admin',
    );

    expect(importResult.warnings.length).toBeGreaterThan(0);
    expect(importResult.warnings[0]).toContain('isolated');
  });
});
