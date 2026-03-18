import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { type AegisDatabase, createInMemoryDatabase, Repository } from '../store/index.js';
import type { IntentTagger } from '../tagging/tagger.js';
import type { IntentTag } from '../types.js';
import { ContextCompiler } from './compiler.js';

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Helper: bootstrap a set of documents, edges, and layer_rules
 * through the standard Proposed → approve flow.
 */
function bootstrap(
  repo: Repository,
  data: {
    documents: { doc_id: string; title: string; kind: string; content: string }[];
    edges: {
      edge_id: string;
      source_type: string;
      source_value: string;
      target_doc_id: string;
      edge_type: string;
      priority: number;
      specificity?: number;
    }[];
    layer_rules?: {
      rule_id: string;
      path_pattern: string;
      layer_name: string;
      priority: number;
      specificity?: number;
    }[];
  },
) {
  repo.insertProposal({
    proposal_id: 'boot',
    proposal_type: 'bootstrap',
    payload: JSON.stringify({
      documents: data.documents.map((d) => ({
        ...d,
        content_hash: hash(d.content),
      })),
      edges: data.edges.map((e) => ({
        ...e,
        specificity: e.specificity ?? 0,
      })),
      layer_rules: (data.layer_rules ?? []).map((r) => ({
        ...r,
        specificity: r.specificity ?? 0,
      })),
    }),
    status: 'pending',
    review_comment: null,
  });
  return repo.approveProposal('boot');
}

// ============================================================
// FakeTagger for expanded context tests
// ============================================================

class FakeTagger implements IntentTagger {
  constructor(private tagMap: Record<string, IntentTag[]> = {}) {}

  async extractTags(plan: string, _knownTags: string[]): Promise<IntentTag[]> {
    return this.tagMap[plan] ?? [];
  }
}

class FailingTagger implements IntentTagger {
  async extractTags(_plan: string, _knownTags: string[]): Promise<IntentTag[]> {
    throw new Error('SLM connection failed');
  }
}

describe('ContextCompiler', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let compiler: ContextCompiler;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    compiler = new ContextCompiler(repo);
  });

  // ── 1. target_files だけで動く ──
  it('resolves documents from target_files via path_requires', async () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'ddd-guide', title: 'DDD Fundamentals', kind: 'guideline', content: 'DDD content' }],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'app/Domain/**',
          target_doc_id: 'ddd-guide',
          edge_type: 'path_requires',
          priority: 100,
          specificity: 2,
        },
      ],
    });

    const result = await compiler.compile({ target_files: ['app/Domain/User/UserEntity.php'] });

    expect(result.base.documents).toHaveLength(1);
    expect(result.base.documents[0].doc_id).toBe('ddd-guide');
    expect(result.base.resolution_path).toHaveLength(1);
    expect(result.base.resolution_path[0].edge_type).toBe('path_requires');
    expect(result.snapshot_id).toBeTruthy();
    expect(result.knowledge_version).toBe(1);
  });

  // ── 2. 複数 path edge は union される ──
  it('unions multiple path_requires matches (union semantics)', async () => {
    bootstrap(repo, {
      documents: [
        { doc_id: 'ddd-guide', title: 'DDD Fundamentals', kind: 'guideline', content: 'DDD' },
        { doc_id: 'entity-guide', title: 'Entity Guidelines', kind: 'pattern', content: 'Entity' },
        { doc_id: 'unrelated', title: 'Unrelated', kind: 'guideline', content: 'nope' },
      ],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'app/Domain/**',
          target_doc_id: 'ddd-guide',
          edge_type: 'path_requires',
          priority: 100,
          specificity: 2,
        },
        {
          edge_id: 'e2',
          source_type: 'path',
          source_value: 'app/Domain/*/Entity.php',
          target_doc_id: 'entity-guide',
          edge_type: 'path_requires',
          priority: 50,
          specificity: 4,
        },
        {
          edge_id: 'e3',
          source_type: 'path',
          source_value: 'tests/**',
          target_doc_id: 'unrelated',
          edge_type: 'path_requires',
          priority: 100,
          specificity: 1,
        },
      ],
    });

    const result = await compiler.compile({ target_files: ['app/Domain/User/Entity.php'] });

    // Both e1 and e2 should match. e3 should NOT match.
    const docIds = result.base.documents.map((d) => d.doc_id);
    expect(docIds).toContain('ddd-guide');
    expect(docIds).toContain('entity-guide');
    expect(docIds).not.toContain('unrelated');
    expect(result.base.resolution_path).toHaveLength(2);
  });

  // ── 3. layer 推論が base に反映される ──
  it('infers layer from layer_rules and resolves layer_requires edges', async () => {
    bootstrap(repo, {
      documents: [
        { doc_id: 'usecase-guide', title: 'UseCase Guidelines', kind: 'guideline', content: 'UseCase content' },
      ],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'layer',
          source_value: 'UseCase',
          target_doc_id: 'usecase-guide',
          edge_type: 'layer_requires',
          priority: 100,
        },
      ],
      layer_rules: [
        { rule_id: 'lr1', path_pattern: 'app/UseCases/**', layer_name: 'UseCase', priority: 100, specificity: 2 },
      ],
    });

    const result = await compiler.compile({ target_files: ['app/UseCases/CreateOrder/CreateOrderUseCase.php'] });

    expect(result.base.documents).toHaveLength(1);
    expect(result.base.documents[0].doc_id).toBe('usecase-guide');
    expect(result.base.resolution_path.some((e) => e.edge_type === 'layer_requires')).toBe(true);
  });

  // ── 3b. target_layers 明示指定が layer_rules 推論に優先する ──
  it('uses explicit target_layers over inferred layers', async () => {
    bootstrap(repo, {
      documents: [
        { doc_id: 'usecase-guide', title: 'UseCase Guidelines', kind: 'guideline', content: 'UseCase' },
        { doc_id: 'domain-guide', title: 'Domain Guidelines', kind: 'guideline', content: 'Domain' },
      ],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'layer',
          source_value: 'UseCase',
          target_doc_id: 'usecase-guide',
          edge_type: 'layer_requires',
          priority: 100,
        },
        {
          edge_id: 'e2',
          source_type: 'layer',
          source_value: 'Domain',
          target_doc_id: 'domain-guide',
          edge_type: 'layer_requires',
          priority: 100,
        },
      ],
      layer_rules: [
        { rule_id: 'lr1', path_pattern: 'app/UseCases/**', layer_name: 'UseCase', priority: 100, specificity: 2 },
      ],
    });

    // File is in UseCases, but we explicitly ask for Domain layer
    const result = await compiler.compile({
      target_files: ['app/UseCases/Foo.php'],
      target_layers: ['Domain'],
    });

    const docIds = result.base.documents.map((d) => d.doc_id);
    expect(docIds).toContain('domain-guide');
    // UseCase should NOT be resolved because target_layers overrides inference
    expect(docIds).not.toContain('usecase-guide');
  });

  // ── 4. doc_depends_on の閉包が取れる ──
  it('resolves doc_depends_on transitive closure', async () => {
    bootstrap(repo, {
      documents: [
        { doc_id: 'arch-root', title: 'Architecture Root', kind: 'guideline', content: 'root' },
        { doc_id: 'layer-guide', title: 'Layer Guide', kind: 'guideline', content: 'layer' },
        { doc_id: 'naming-guide', title: 'Naming Guide', kind: 'constraint', content: 'naming' },
      ],
      edges: [
        // path_requires → arch-root
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'arch-root',
          edge_type: 'path_requires',
          priority: 100,
        },
        // arch-root depends on layer-guide
        {
          edge_id: 'e2',
          source_type: 'doc',
          source_value: 'arch-root',
          target_doc_id: 'layer-guide',
          edge_type: 'doc_depends_on',
          priority: 100,
        },
        // layer-guide depends on naming-guide (transitive)
        {
          edge_id: 'e3',
          source_type: 'doc',
          source_value: 'layer-guide',
          target_doc_id: 'naming-guide',
          edge_type: 'doc_depends_on',
          priority: 100,
        },
      ],
    });

    const result = await compiler.compile({ target_files: ['src/index.ts'] });

    const docIds = result.base.documents.map((d) => d.doc_id);
    expect(docIds).toContain('arch-root');
    expect(docIds).toContain('layer-guide');
    expect(docIds).toContain('naming-guide');

    // resolution_path should include both path_requires and doc_depends_on edges
    const edgeTypes = result.base.resolution_path.map((e) => e.edge_type);
    expect(edgeTypes).toContain('path_requires');
    expect(edgeTypes).toContain('doc_depends_on');
  });

  // ── 5. resolution_path が決定順で返る ──
  it('resolution_path reflects traversal order (path → layer → command → deps)', async () => {
    bootstrap(repo, {
      documents: [
        { doc_id: 'path-doc', title: 'Path Doc', kind: 'guideline', content: 'path' },
        { doc_id: 'layer-doc', title: 'Layer Doc', kind: 'guideline', content: 'layer' },
        { doc_id: 'cmd-doc', title: 'Command Doc', kind: 'guideline', content: 'cmd' },
        { doc_id: 'dep-doc', title: 'Dep Doc', kind: 'guideline', content: 'dep' },
      ],
      edges: [
        {
          edge_id: 'e-path',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'path-doc',
          edge_type: 'path_requires',
          priority: 100,
        },
        {
          edge_id: 'e-layer',
          source_type: 'layer',
          source_value: 'Service',
          target_doc_id: 'layer-doc',
          edge_type: 'layer_requires',
          priority: 100,
        },
        {
          edge_id: 'e-cmd',
          source_type: 'command',
          source_value: 'scaffold',
          target_doc_id: 'cmd-doc',
          edge_type: 'command_requires',
          priority: 100,
        },
        {
          edge_id: 'e-dep',
          source_type: 'doc',
          source_value: 'path-doc',
          target_doc_id: 'dep-doc',
          edge_type: 'doc_depends_on',
          priority: 100,
        },
      ],
      layer_rules: [
        { rule_id: 'lr1', path_pattern: 'src/services/**', layer_name: 'Service', priority: 100, specificity: 2 },
      ],
    });

    const result = await compiler.compile({
      target_files: ['src/services/OrderService.ts'],
      command: 'scaffold',
    });

    const edgeIds = result.base.resolution_path.map((e) => e.edge_id);
    // path edges first, then layer, then command, then deps
    const pathIdx = edgeIds.indexOf('e-path');
    const layerIdx = edgeIds.indexOf('e-layer');
    const cmdIdx = edgeIds.indexOf('e-cmd');
    const depIdx = edgeIds.indexOf('e-dep');

    expect(pathIdx).toBeLessThan(layerIdx);
    expect(layerIdx).toBeLessThan(cmdIdx);
    expect(cmdIdx).toBeLessThan(depIdx);
  });

  // ── 6. 同一 snapshot_id でも compile_id は毎回変わる ──
  it('produces unique compile_id for each invocation on the same snapshot', async () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'd1', title: 'Doc', kind: 'guideline', content: 'c' }],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'd1',
          edge_type: 'path_requires',
          priority: 100,
        },
      ],
    });

    const r1 = await compiler.compile({ target_files: ['src/a.ts'] });
    const r2 = await compiler.compile({ target_files: ['src/a.ts'] });

    expect(r1.snapshot_id).toBe(r2.snapshot_id);
    expect(r1.compile_id).not.toBe(r2.compile_id);
  });

  // ── 7. get_compile_audit で元 request と doc ids を再取得できる ──
  it('get_compile_audit returns original request and resolved doc_ids', async () => {
    bootstrap(repo, {
      documents: [
        { doc_id: 'd1', title: 'Doc1', kind: 'guideline', content: 'c1' },
        { doc_id: 'd2', title: 'Doc2', kind: 'pattern', content: 'c2' },
      ],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'd1',
          edge_type: 'path_requires',
          priority: 100,
        },
        {
          edge_id: 'e2',
          source_type: 'doc',
          source_value: 'd1',
          target_doc_id: 'd2',
          edge_type: 'doc_depends_on',
          priority: 100,
        },
      ],
    });

    const request = { target_files: ['src/main.ts'] };
    const result = await compiler.compile(request);
    const audit = compiler.getCompileAudit(result.compile_id);

    expect(audit).toBeDefined();
    expect(audit!.compile_id).toBe(result.compile_id);
    expect(audit!.snapshot_id).toBe(result.snapshot_id);
    expect(audit!.knowledge_version).toBe(result.knowledge_version);
    expect(audit!.request).toEqual(request);
    expect(audit!.base_doc_ids).toContain('d1');
    expect(audit!.base_doc_ids).toContain('d2');
    expect(audit!.created_at).toBeTruthy();
  });

  // ── Edge case: templates are separated from regular documents ──
  it('separates template documents into base.templates', async () => {
    bootstrap(repo, {
      documents: [
        { doc_id: 'd-guide', title: 'Guidelines', kind: 'guideline', content: 'guide content' },
        { doc_id: 'd-tmpl', title: 'Entity Template', kind: 'template', content: '<?php class {{name}} {}' },
      ],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'app/Domain/**',
          target_doc_id: 'd-guide',
          edge_type: 'path_requires',
          priority: 100,
        },
        {
          edge_id: 'e2',
          source_type: 'path',
          source_value: 'app/Domain/**',
          target_doc_id: 'd-tmpl',
          edge_type: 'path_requires',
          priority: 100,
        },
      ],
    });

    const result = await compiler.compile({ target_files: ['app/Domain/Foo.php'] });

    // Guide is in documents, template is in templates
    expect(result.base.documents).toHaveLength(1);
    expect(result.base.documents[0].doc_id).toBe('d-guide');
    expect(result.base.templates).toHaveLength(1);
    expect(result.base.templates[0].name).toBe('Entity Template');
  });

  // ── Edge case: uninitialised project returns warnings, no compile_log ──
  it('returns warnings when project is not initialized and does not write compile_log', async () => {
    const result = await compiler.compile({ target_files: ['src/a.ts'] });

    expect(result.base.documents).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/not initialized/i);
    // compile_id is empty — not a real audit entry
    expect(result.compile_id).toBe('');
    // No compile_log should have been written
    expect(compiler.getCompileAudit('')).toBeUndefined();
  });

  // ── Edge case: command_requires works ──
  it('resolves command_requires edges', async () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'scaffold-guide', title: 'Scaffold Guide', kind: 'guideline', content: 'scaffold' }],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'command',
          source_value: 'scaffold',
          target_doc_id: 'scaffold-guide',
          edge_type: 'command_requires',
          priority: 100,
        },
      ],
    });

    const result = await compiler.compile({
      target_files: ['anything.ts'],
      command: 'scaffold',
    });

    expect(result.base.documents).toHaveLength(1);
    expect(result.base.documents[0].doc_id).toBe('scaffold-guide');
  });
});

// ============================================================
// Empty Result Hint Tests
// ============================================================

describe('ContextCompiler — empty result hints', () => {
  let db: AegisDatabase;
  let repo: Repository;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
  });

  it('includes sorted path/command/layer hints when no docs match', async () => {
    bootstrap(repo, {
      documents: [
        { doc_id: 'doc-b', title: 'Doc B', kind: 'guideline', content: 'b' },
        { doc_id: 'doc-a', title: 'Doc A', kind: 'guideline', content: 'a' },
        { doc_id: 'doc-c', title: 'Doc C', kind: 'guideline', content: 'c' },
        { doc_id: 'doc-d', title: 'Doc D', kind: 'guideline', content: 'd' },
      ],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'doc-b',
          edge_type: 'path_requires',
          priority: 100,
        },
        {
          edge_id: 'e2',
          source_type: 'path',
          source_value: 'modules/**',
          target_doc_id: 'doc-a',
          edge_type: 'path_requires',
          priority: 100,
        },
        {
          edge_id: 'e3',
          source_type: 'command',
          source_value: 'scaffold',
          target_doc_id: 'doc-c',
          edge_type: 'command_requires',
          priority: 100,
        },
        {
          edge_id: 'e4',
          source_type: 'layer',
          source_value: 'Domain',
          target_doc_id: 'doc-d',
          edge_type: 'layer_requires',
          priority: 100,
        },
        {
          edge_id: 'e5',
          source_type: 'layer',
          source_value: 'Application',
          target_doc_id: 'doc-d',
          edge_type: 'layer_requires',
          priority: 100,
        },
      ],
    });

    const compiler = new ContextCompiler(repo);
    const result = await compiler.compile({ target_files: ['app/UseCases'] });

    expect(result.base.documents).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toBe(
      [
        'No documents matched target_files: [app/UseCases].',
        '',
        'Registered path patterns (path_requires):',
        '  modules/** -> doc-a',
        '  src/** -> doc-b',
        '',
        'Registered commands: scaffold',
        '',
        'Registered layers (layer_requires): Application, Domain',
        '',
        'Ensure target_files are real file paths (not directories) matching the patterns above.',
        'If the paths are correct but no edges cover them, report a compile_miss.',
      ].join('\n'),
    );
  });

  it('includes only header and footer when no edges exist', async () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'orphan', title: 'Orphan', kind: 'guideline', content: 'orphan' }],
      edges: [],
    });

    const compiler = new ContextCompiler(repo);
    const result = await compiler.compile({ target_files: ['anything.ts'] });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toBe(
      [
        'No documents matched target_files: [anything.ts].',
        '',
        'No edges are registered in the knowledge base.',
        'If the paths are correct but no edges cover them, report a compile_miss.',
      ].join('\n'),
    );
  });

  it('truncates path patterns beyond MAX_PATTERNS (20)', async () => {
    const docs = Array.from({ length: 21 }, (_, i) => ({
      doc_id: `doc-${String(i).padStart(2, '0')}`,
      title: `Doc ${i}`,
      kind: 'guideline',
      content: `content ${i}`,
    }));
    const edges = docs.map((d, i) => ({
      edge_id: `e-${String(i).padStart(2, '0')}`,
      source_type: 'path' as const,
      source_value: `pattern-${String(i).padStart(2, '0')}/**`,
      target_doc_id: d.doc_id,
      edge_type: 'path_requires' as const,
      priority: 100,
    }));

    bootstrap(repo, { documents: docs, edges });

    const compiler = new ContextCompiler(repo);
    const result = await compiler.compile({ target_files: ['no-match.ts'] });

    expect(result.warnings).toHaveLength(1);
    const hint = result.warnings[0];
    expect(hint).toContain('...and 1 more');
    const patternLines = hint.split('\n').filter((l) => l.startsWith('  pattern-'));
    expect(patternLines).toHaveLength(20);
  });

  it('does not add hint when documents are matched', async () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'd1', title: 'Doc', kind: 'guideline', content: 'c' }],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'd1',
          edge_type: 'path_requires',
          priority: 100,
        },
      ],
    });

    const compiler = new ContextCompiler(repo);
    const result = await compiler.compile({ target_files: ['src/a.ts'] });

    expect(result.base.documents).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
  });

  it('includes hint alongside expanded results when base is empty', async () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'auth-doc', title: 'Auth Guide', kind: 'guideline', content: 'auth' }],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'auth-doc',
          edge_type: 'path_requires',
          priority: 100,
        },
      ],
    });
    repo.upsertTagMapping({ tag: 'auth', doc_id: 'auth-doc', confidence: 0.9, source: 'manual' });

    const tagger = new FakeTagger({
      'add auth': [{ tag: 'auth', confidence: 0.9 }],
    });
    const compiler = new ContextCompiler(repo, tagger);

    const result = await compiler.compile({
      target_files: ['app/NoMatch.ts'],
      plan: 'add auth',
    });

    expect(result.base.documents).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('No documents matched');
    expect(result.expanded).toBeDefined();
    expect(result.expanded!.documents).toHaveLength(1);
    expect(result.expanded!.documents[0].doc_id).toBe('auth-doc');
  });
});

// ============================================================
// Notices Tests (P-1 excluded, operational metadata)
// ============================================================

describe('ContextCompiler — notices', () => {
  let db: AegisDatabase;
  let repo: Repository;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
  });

  it('includes outdated adapter notice when adapterOutdated is true', async () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'd1', title: 'Doc', kind: 'guideline', content: 'c' }],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'd1',
          edge_type: 'path_requires',
          priority: 100,
        },
      ],
    });

    const compiler = new ContextCompiler(repo, null, true);
    const result = await compiler.compile({ target_files: ['src/a.ts'] });

    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain('deploy-adapters');
  });

  it('returns empty notices when adapterOutdated is false', async () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'd1', title: 'Doc', kind: 'guideline', content: 'c' }],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'd1',
          edge_type: 'path_requires',
          priority: 100,
        },
      ],
    });

    const compiler = new ContextCompiler(repo, null, false);
    const result = await compiler.compile({ target_files: ['src/a.ts'] });

    expect(result.notices).toHaveLength(0);
  });

  it('returns empty notices by default (no adapterOutdated parameter)', async () => {
    bootstrap(repo, {
      documents: [{ doc_id: 'd1', title: 'Doc', kind: 'guideline', content: 'c' }],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'd1',
          edge_type: 'path_requires',
          priority: 100,
        },
      ],
    });

    const compiler = new ContextCompiler(repo);
    const result = await compiler.compile({ target_files: ['src/a.ts'] });

    expect(result.notices).toHaveLength(0);
  });
});

// ============================================================
// Expanded Context Tests
// ============================================================

describe('ContextCompiler — expanded context', () => {
  let db: AegisDatabase;
  let repo: Repository;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
  });

  function setupBaseAndTags() {
    // Bootstrap base documents and edges
    bootstrap(repo, {
      documents: [
        { doc_id: 'base-doc', title: 'Base Doc', kind: 'guideline', content: 'base content' },
        { doc_id: 'auth-doc', title: 'Auth Guide', kind: 'guideline', content: 'auth content' },
        { doc_id: 'security-doc', title: 'Security Guide', kind: 'guideline', content: 'security content' },
      ],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'base-doc',
          edge_type: 'path_requires',
          priority: 100,
        },
      ],
    });

    // Set up tag mappings (outside canonical DAG)
    repo.upsertTagMapping({ tag: 'authentication', doc_id: 'auth-doc', confidence: 0.9, source: 'manual' });
    repo.upsertTagMapping({ tag: 'authentication', doc_id: 'security-doc', confidence: 0.7, source: 'slm' });
    repo.upsertTagMapping({ tag: 'security', doc_id: 'security-doc', confidence: 0.85, source: 'manual' });
  }

  // ── no plan → expanded undefined ──
  it('no plan: expanded is undefined, audit expanded_doc_ids is null', async () => {
    setupBaseAndTags();
    const tagger = new FakeTagger({ 'add auth': [{ tag: 'authentication', confidence: 0.9 }] });
    const compiler = new ContextCompiler(repo, tagger);

    const result = await compiler.compile({ target_files: ['src/a.ts'] });

    expect(result.expanded).toBeUndefined();
    const audit = compiler.getCompileAudit(result.compile_id);
    expect(audit!.expanded_doc_ids).toBeNull();
  });

  // ── no tagger → expanded undefined ──
  it('no tagger: expanded is undefined even with plan', async () => {
    setupBaseAndTags();
    const compiler = new ContextCompiler(repo, null);

    const result = await compiler.compile({ target_files: ['src/a.ts'], plan: 'add auth' });

    expect(result.expanded).toBeUndefined();
    const audit = compiler.getCompileAudit(result.compile_id);
    expect(audit!.expanded_doc_ids).toBeNull();
  });

  // ── tagger returns tags → expanded docs populated ──
  it('plan + tagger: expanded includes tag-matched docs not in base', async () => {
    setupBaseAndTags();
    const tagger = new FakeTagger({
      'add authentication to login': [{ tag: 'authentication', confidence: 0.9 }],
    });
    const compiler = new ContextCompiler(repo, tagger);

    const result = await compiler.compile({
      target_files: ['src/a.ts'],
      plan: 'add authentication to login',
    });

    expect(result.expanded).toBeDefined();
    const expandedIds = result.expanded!.documents.map((d) => d.doc_id);
    expect(expandedIds).toContain('auth-doc');
    expect(expandedIds).toContain('security-doc');
    expect(result.expanded!.confidence).toBeGreaterThan(0);
    expect(result.expanded!.resolution_path).toEqual([]);

    // Audit records expanded doc ids
    const audit = compiler.getCompileAudit(result.compile_id);
    expect(audit!.expanded_doc_ids).toEqual(expect.arrayContaining(['auth-doc', 'security-doc']));
  });

  // ── base overlap excluded from expanded ──
  it('excludes base docs from expanded results', async () => {
    setupBaseAndTags();
    // Tag base-doc with 'authentication' so it would appear in expanded
    repo.upsertTagMapping({ tag: 'authentication', doc_id: 'base-doc', confidence: 0.95, source: 'manual' });

    const tagger = new FakeTagger({
      'add auth': [{ tag: 'authentication', confidence: 0.9 }],
    });
    const compiler = new ContextCompiler(repo, tagger);

    const result = await compiler.compile({
      target_files: ['src/a.ts'],
      plan: 'add auth',
    });

    // base-doc is in base, so should NOT be in expanded
    const expandedIds = result.expanded!.documents.map((d) => d.doc_id);
    expect(expandedIds).not.toContain('base-doc');
    expect(expandedIds).toContain('auth-doc');
  });

  // ── tagger returns no tags → expanded empty, not undefined ──
  it('tagger returns no tags: expanded is empty with doc_ids=[]', async () => {
    setupBaseAndTags();
    const tagger = new FakeTagger({
      'unrelated plan': [],
    });
    const compiler = new ContextCompiler(repo, tagger);

    const result = await compiler.compile({
      target_files: ['src/a.ts'],
      plan: 'unrelated plan',
    });

    expect(result.expanded).toBeDefined();
    expect(result.expanded!.documents).toHaveLength(0);
    expect(result.expanded!.confidence).toBe(0);

    const audit = compiler.getCompileAudit(result.compile_id);
    expect(audit!.expanded_doc_ids).toEqual([]);
  });

  // ── tagger failure → warning, expanded undefined ──
  it('tagger failure: adds warning, expanded is undefined', async () => {
    setupBaseAndTags();
    const compiler = new ContextCompiler(repo, new FailingTagger());

    const result = await compiler.compile({
      target_files: ['src/a.ts'],
      plan: 'add auth',
    });

    expect(result.expanded).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/tagger failed/);
    expect(result.warnings[0]).toContain('SLM connection failed');

    // Audit records null for expanded_doc_ids
    const audit = compiler.getCompileAudit(result.compile_id);
    expect(audit!.expanded_doc_ids).toBeNull();
  });

  // ── unapproved docs excluded (getDocumentsByTags already filters) ──
  it('unapproved docs are excluded from expanded', async () => {
    setupBaseAndTags();

    // Add a draft document with tag mapping
    repo.insertDocument({
      doc_id: 'draft-doc',
      title: 'Draft Doc',
      kind: 'guideline',
      content: 'draft content',
      content_hash: hash('draft content'),
      status: 'draft',
    });
    repo.upsertTagMapping({ tag: 'authentication', doc_id: 'draft-doc', confidence: 0.99, source: 'manual' });

    const tagger = new FakeTagger({
      'add auth': [{ tag: 'authentication', confidence: 0.9 }],
    });
    const compiler = new ContextCompiler(repo, tagger);

    const result = await compiler.compile({
      target_files: ['src/a.ts'],
      plan: 'add auth',
    });

    const expandedIds = result.expanded!.documents.map((d) => d.doc_id);
    expect(expandedIds).not.toContain('draft-doc');
  });

  // ── base templates excluded from expanded ──
  it('excludes base template docs from expanded results', async () => {
    // Bootstrap with a template doc in base
    bootstrap(repo, {
      documents: [
        { doc_id: 'base-doc', title: 'Base Doc', kind: 'guideline', content: 'base' },
        { doc_id: 'tmpl-doc', title: 'Entity Template', kind: 'template', content: '<?php class {{name}} {}' },
        { doc_id: 'auth-doc', title: 'Auth Guide', kind: 'guideline', content: 'auth' },
      ],
      edges: [
        {
          edge_id: 'e1',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'base-doc',
          edge_type: 'path_requires',
          priority: 100,
        },
        {
          edge_id: 'e2',
          source_type: 'path',
          source_value: 'src/**',
          target_doc_id: 'tmpl-doc',
          edge_type: 'path_requires',
          priority: 100,
        },
      ],
    });

    // Tag both tmpl-doc and auth-doc with 'scaffold'
    repo.upsertTagMapping({ tag: 'scaffold', doc_id: 'tmpl-doc', confidence: 0.9, source: 'manual' });
    repo.upsertTagMapping({ tag: 'scaffold', doc_id: 'auth-doc', confidence: 0.8, source: 'manual' });

    const tagger = new FakeTagger({
      'scaffold entity': [{ tag: 'scaffold', confidence: 0.9 }],
    });
    const compiler = new ContextCompiler(repo, tagger);

    const result = await compiler.compile({
      target_files: ['src/a.ts'],
      plan: 'scaffold entity',
    });

    // tmpl-doc is in base.templates, so must NOT appear in expanded
    expect(result.base.templates).toHaveLength(1);
    expect(result.base.templates[0].name).toBe('Entity Template');

    const expandedIds = result.expanded!.documents.map((d) => d.doc_id);
    expect(expandedIds).not.toContain('tmpl-doc');
    expect(expandedIds).toContain('auth-doc');
  });

  // ── audit records expanded_doc_ids correctly ──
  it('audit distinguishes null (no expanded) from [] (expanded ran, no results)', async () => {
    setupBaseAndTags();

    // Case 1: no plan → null
    const compilerNoTagger = new ContextCompiler(repo);
    const r1 = await compilerNoTagger.compile({ target_files: ['src/a.ts'] });
    const a1 = compilerNoTagger.getCompileAudit(r1.compile_id);
    expect(a1!.expanded_doc_ids).toBeNull();

    // Case 2: plan + tagger returns empty tags → []
    const emptyTagger = new FakeTagger({ 'empty plan': [] });
    const compilerEmpty = new ContextCompiler(repo, emptyTagger);
    const r2 = await compilerEmpty.compile({ target_files: ['src/a.ts'], plan: 'empty plan' });
    const a2 = compilerEmpty.getCompileAudit(r2.compile_id);
    expect(a2!.expanded_doc_ids).toEqual([]);
  });
});
