/**
 * Task 000-01: 大規模 DAG + allocator + near_miss の負荷検証（詳細は docs/tasks/000-01-large-dag-load-test.md）。
 */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { beforeEach, describe, expect, it } from 'vitest';
import { type AegisDatabase, createInMemoryDatabase, Repository } from '../store/index.js';
import type { CompileAuditMeta } from '../types.js';
import { ContextCompiler } from './compiler.js';

const DOC_COUNT = 120;
/** path_requires のみで 500+ を満たす */
const PATH_EDGE_COUNT = 520;
/** 同一ファイルに複数エッジがヒットさせるパス共有エッジ数 (= allocator 入力ドキュメント数) */
const SHARED_PATTERN_EDGE_COUNT = DOC_COUNT;

const INLINE_CHUNK_BYTES = 2000;
/** source_path 付き doc が auto で inline 候補になり、budget で落ちるようにする上限 */
const TIGHT_INLINE_BUDGET = 50_000;

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function buildPathRequiresEdges(): Array<{
  edge_id: string;
  source_type: string;
  source_value: string;
  target_doc_id: string;
  edge_type: string;
  priority: number;
  specificity: number;
}> {
  const edges: Array<{
    edge_id: string;
    source_type: string;
    source_value: string;
    target_doc_id: string;
    edge_type: string;
    priority: number;
    specificity: number;
  }> = [];

  for (let e = 0; e < SHARED_PATTERN_EDGE_COUNT; e++) {
    edges.push({
      edge_id: `shared-${String(e).padStart(4, '0')}`,
      source_type: 'path',
      source_value: 'src/target/**',
      target_doc_id: `load-doc-${String(e).padStart(3, '0')}`,
      edge_type: 'path_requires',
      priority: 100,
      specificity: 2,
    });
  }

  for (let e = SHARED_PATTERN_EDGE_COUNT; e < PATH_EDGE_COUNT; e++) {
    edges.push({
      edge_id: `load-edge-${String(e).padStart(4, '0')}`,
      source_type: 'path',
      source_value: `src/miss/${e}/**`,
      target_doc_id: `load-doc-${String(e % DOC_COUNT).padStart(3, '0')}`,
      edge_type: 'path_requires',
      priority: 100,
      specificity: 1,
    });
  }

  return edges;
}

function bootstrapFromDocuments(
  repo: Repository,
  docs: Array<{ doc_id: string; title: string; kind: string; content: string; source_path?: string }>,
): void {
  const edges = buildPathRequiresEdges();

  repo.insertProposal({
    proposal_id: 'boot-large-dag',
    proposal_type: 'bootstrap',
    payload: JSON.stringify({
      documents: docs.map((d) => ({
        ...d,
        content_hash: hash(d.content),
      })),
      edges: edges.map((edge) => ({
        ...edge,
        specificity: edge.specificity ?? 0,
      })),
      layer_rules: [],
    }),
    status: 'pending',
    review_comment: null,
  });
  repo.approveProposal('boot-large-dag');
}

describe('ContextCompiler — large DAG routing', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let compiler: ContextCompiler;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    compiler = new ContextCompiler(repo);
    const documents = Array.from({ length: DOC_COUNT }, (_, i) => {
      const id = String(i).padStart(3, '0');
      return {
        doc_id: `load-doc-${id}`,
        title: `Load doc ${id}`,
        kind: 'guideline',
        content: 'x',
      };
    });
    bootstrapFromDocuments(repo, documents);
  });

  it('routes 120 docs into base + allocator; scans 520 path edges; audits near_miss cost', {
    timeout: 120_000,
  }, async () => {
    expect(repo.countApprovedDocuments()).toBe(DOC_COUNT);
    expect(repo.countApprovedEdges()).toBe(PATH_EDGE_COUNT);

    const wallStart = performance.now();
    const result = await compiler.compile({
      target_files: ['src/target/module/foo.ts'],
      intent_tags: [],
    });
    const wallMs = performance.now() - wallStart;

    expect(result.base.documents.length).toBe(DOC_COUNT);

    const log = repo.getCompileLog(result.compile_id);
    expect(log?.audit_meta).toBeTruthy();
    const audit = JSON.parse(log!.audit_meta!) as CompileAuditMeta;

    expect(audit.performance.near_miss_edges_evaluated).toBe(PATH_EDGE_COUNT);
    expect(audit.performance.near_miss_edge_scan_ms).toBeGreaterThanOrEqual(0);

    const missEdgeCount = PATH_EDGE_COUNT - SHARED_PATTERN_EDGE_COUNT;
    expect(result.debug_info?.near_miss_edges.length).toBe(missEdgeCount);

    expect(audit.budget_utilization).toBeGreaterThanOrEqual(0);
    expect(audit.budget_exceeded).toBe(false);

    /**
     * レイテンシ回帰検知: ローカルは目標 500ms、CI は遅いランナー向けに 750ms。
     * どちらも `AEGIS_LARGE_DAG_PERF_MAX_MS` で上書き可能。
     */
    const maxLatencyMs = Number(process.env.AEGIS_LARGE_DAG_PERF_MAX_MS ?? (process.env.CI ? '750' : '500'));
    expect(wallMs).toBeLessThan(maxLatencyMs);
  });
});

describe('ContextCompiler — allocator pressure (many inline candidates)', () => {
  let db: AegisDatabase;
  let repo: Repository;
  let compiler: ContextCompiler;

  beforeEach(async () => {
    db = await createInMemoryDatabase();
    repo = new Repository(db);
    compiler = new ContextCompiler(repo);
    const chunk = 'a'.repeat(INLINE_CHUNK_BYTES);
    const documents = Array.from({ length: DOC_COUNT }, (_, i) => {
      const id = String(i).padStart(3, '0');
      return {
        doc_id: `load-doc-${id}`,
        title: `Load doc ${id}`,
        kind: 'guideline',
        content: chunk,
        source_path: `docs/load/load-doc-${id}.md`,
      };
    });
    bootstrapFromDocuments(repo, documents);
  });

  it('drops inline candidates when 120 routed docs exceed max_inline_bytes budget', {
    timeout: 120_000,
  }, async () => {
    const wallStart = performance.now();
    const result = await compiler.compile({
      target_files: ['src/target/module/foo.ts'],
      intent_tags: [],
      max_inline_bytes: TIGHT_INLINE_BUDGET,
    });
    const wallMs = performance.now() - wallStart;

    expect(result.base.documents.length).toBe(DOC_COUNT);

    const log = repo.getCompileLog(result.compile_id);
    expect(log?.audit_meta).toBeTruthy();
    const audit = JSON.parse(log!.audit_meta!) as CompileAuditMeta;

    expect(audit.budget_exceeded).toBe(false);
    expect(audit.budget_dropped.length).toBeGreaterThan(90);
    expect(audit.performance.near_miss_edges_evaluated).toBe(PATH_EDGE_COUNT);

    const maxLatencyMs = Number(process.env.AEGIS_LARGE_DAG_PERF_MAX_MS ?? (process.env.CI ? '750' : '500'));
    expect(wallMs).toBeLessThan(maxLatencyMs);
  });
});
