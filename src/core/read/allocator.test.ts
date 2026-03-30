import { describe, expect, it } from 'vitest';
import { BudgetExceededError } from '../types.js';
import { type DocCandidate, allocateDelivery } from './allocator.js';

function candidate(overrides: Partial<DocCandidate> & { doc_id: string }): DocCandidate {
  return {
    title: overrides.doc_id,
    kind: 'guideline',
    content: overrides.content ?? 'x'.repeat(100),
    content_bytes: overrides.content_bytes ?? Buffer.byteLength(overrides.content ?? 'x'.repeat(100), 'utf8'),
    content_hash: 'hash-' + overrides.doc_id,
    source_path: overrides.source_path ?? null,
    relevance: overrides.relevance ?? undefined,
    priority: overrides.priority ?? 100,
    doc_class: overrides.doc_class ?? 'document',
    ...overrides,
  };
}

const defaultOptions = (overrides: Record<string, unknown> = {}) => ({
  content_mode: 'always' as const,
  max_inline_bytes: 131_072,
  command: undefined as string | undefined,
  compile_id: 'test-compile',
  ...overrides,
});

// ============================================================
// content_mode = 'always'
// ============================================================

describe('allocateDelivery — always mode', () => {
  it('inlines all docs regardless of source_path', () => {
    const docs = [
      candidate({ doc_id: 'a', source_path: 'src/a.ts' }),
      candidate({ doc_id: 'b', source_path: null }),
    ];
    const result = allocateDelivery(docs, defaultOptions());
    expect(result.docs.every((d) => d.delivery === 'inline')).toBe(true);
  });

  it('defers source_path docs when budget exceeded', () => {
    const bigContent = 'x'.repeat(10_000);
    const docs = [
      candidate({ doc_id: 'a', source_path: 'a.ts', content: bigContent, content_bytes: 10_000 }),
      candidate({ doc_id: 'b', source_path: 'b.ts', content: bigContent, content_bytes: 10_000 }),
    ];
    const result = allocateDelivery(docs, defaultOptions({ max_inline_bytes: 15_000 }));
    const inlined = result.docs.filter((d) => d.delivery === 'inline');
    const deferred = result.docs.filter((d) => d.delivery === 'deferred');
    expect(inlined).toHaveLength(1);
    expect(deferred).toHaveLength(1);
  });

  it('disables template policy omission', () => {
    const docs = [
      candidate({ doc_id: 't1', doc_class: 'template', kind: 'template' }),
    ];
    const result = allocateDelivery(docs, defaultOptions({ command: 'review' }));
    // always mode: no policy omission
    expect(result.docs[0].delivery).toBe('inline');
    expect(result.docs[0].omit_reason).toBeUndefined();
  });

  it('mandatory inline docs are never omitted even when budget is tight', () => {
    const docs = [
      candidate({ doc_id: 'mandatory', source_path: null, content_bytes: 500 }),
      candidate({ doc_id: 'optional', source_path: 'opt.ts', content_bytes: 600 }),
    ];
    const result = allocateDelivery(docs, defaultOptions({ max_inline_bytes: 800 }));
    const mandatory = result.docs.find((d) => d.doc_id === 'mandatory')!;
    const optional = result.docs.find((d) => d.doc_id === 'optional')!;
    expect(mandatory.delivery).toBe('inline');
    expect(optional.delivery).toBe('deferred');
  });
});

// ============================================================
// content_mode = 'auto'
// ============================================================

describe('allocateDelivery — auto mode', () => {
  it('defers large source_path docs', () => {
    const docs = [
      candidate({ doc_id: 'large', source_path: 'big.ts', content_bytes: 5000 }),
    ];
    const result = allocateDelivery(docs, defaultOptions({ content_mode: 'auto' }));
    expect(result.docs[0].delivery).toBe('deferred');
  });

  it('inlines small source_path docs (≤ 2048 bytes)', () => {
    const docs = [
      candidate({ doc_id: 'small', source_path: 'small.ts', content_bytes: 2048 }),
    ];
    const result = allocateDelivery(docs, defaultOptions({ content_mode: 'auto' }));
    expect(result.docs[0].delivery).toBe('inline');
  });

  it('inlines docs without source_path (mandatory)', () => {
    const docs = [
      candidate({ doc_id: 'no-path', source_path: null, content_bytes: 5000 }),
    ];
    const result = allocateDelivery(docs, defaultOptions({ content_mode: 'auto' }));
    expect(result.docs[0].delivery).toBe('inline');
  });

  it('applies template policy omission when command !== scaffold', () => {
    const docs = [
      candidate({ doc_id: 't1', doc_class: 'template', kind: 'template' }),
    ];
    const result = allocateDelivery(docs, defaultOptions({ content_mode: 'auto', command: 'review' }));
    expect(result.docs[0].delivery).toBe('omitted');
    expect(result.docs[0].omit_reason).toBe('policy:non_scaffold_command');
  });

  it('does not omit templates when command is scaffold', () => {
    const docs = [
      candidate({ doc_id: 't1', doc_class: 'template', kind: 'template', source_path: null }),
    ];
    const result = allocateDelivery(docs, defaultOptions({ content_mode: 'auto', command: 'scaffold' }));
    expect(result.docs[0].delivery).toBe('inline');
  });
});

// ============================================================
// content_mode = 'metadata'
// ============================================================

describe('allocateDelivery — metadata mode', () => {
  it('defers all source_path docs', () => {
    const docs = [
      candidate({ doc_id: 'a', source_path: 'a.ts', content_bytes: 100 }),
    ];
    const result = allocateDelivery(docs, defaultOptions({ content_mode: 'metadata' }));
    expect(result.docs[0].delivery).toBe('deferred');
  });

  it('mandatory inline for docs without source_path', () => {
    const docs = [
      candidate({ doc_id: 'no-path', source_path: null }),
    ];
    const result = allocateDelivery(docs, defaultOptions({ content_mode: 'metadata' }));
    expect(result.docs[0].delivery).toBe('inline');
  });
});

// ============================================================
// Budget exceeded — BudgetExceededError
// ============================================================

describe('allocateDelivery — BudgetExceededError', () => {
  it('throws when mandatory inline docs exceed budget', () => {
    const docs = [
      candidate({ doc_id: 'big1', source_path: null, content_bytes: 5000 }),
      candidate({ doc_id: 'big2', source_path: null, content_bytes: 6000 }),
    ];
    expect(() => allocateDelivery(docs, defaultOptions({ max_inline_bytes: 8000 }))).toThrow(BudgetExceededError);
  });

  it('includes offending doc_ids sorted by size descending', () => {
    const docs = [
      candidate({ doc_id: 'small', source_path: null, content_bytes: 3000 }),
      candidate({ doc_id: 'large', source_path: null, content_bytes: 7000 }),
    ];
    try {
      allocateDelivery(docs, defaultOptions({ max_inline_bytes: 5000 }));
      expect.unreachable('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExceededError);
      const err = e as BudgetExceededError;
      expect(err.offending_doc_ids).toEqual(['large', 'small']);
      expect(err.mandatory_bytes).toBe(10000);
      expect(err.max_inline_bytes).toBe(5000);
    }
  });

  it('does not throw when source_path docs exceed budget (they get deferred)', () => {
    const docs = [
      candidate({ doc_id: 'a', source_path: 'a.ts', content_bytes: 100_000 }),
    ];
    const result = allocateDelivery(docs, defaultOptions({ max_inline_bytes: 1000 }));
    expect(result.docs[0].delivery).toBe('deferred');
  });
});

// ============================================================
// Stable order (P-1)
// ============================================================

describe('allocateDelivery — stable order', () => {
  it('same input yields same output (deterministic)', () => {
    const docs = [
      candidate({ doc_id: 'b', source_path: 'b.ts', content_bytes: 5000, doc_class: 'document' }),
      candidate({ doc_id: 'a', source_path: 'a.ts', content_bytes: 5000, doc_class: 'document' }),
      candidate({ doc_id: 't1', source_path: 't.ts', content_bytes: 5000, doc_class: 'template' }),
      candidate({ doc_id: 'e1', source_path: 'e.ts', content_bytes: 5000, doc_class: 'expanded' }),
    ];

    const r1 = allocateDelivery(docs, defaultOptions({ max_inline_bytes: 12_000 }));
    const r2 = allocateDelivery(docs, defaultOptions({ max_inline_bytes: 12_000 }));

    expect(r1.docs.map((d) => `${d.doc_id}:${d.delivery}`))
      .toEqual(r2.docs.map((d) => `${d.doc_id}:${d.delivery}`));
  });

  it('templates are inlined before documents, documents before expanded', () => {
    const docs = [
      candidate({ doc_id: 'e1', source_path: 'e.ts', content_bytes: 5000, doc_class: 'expanded' }),
      candidate({ doc_id: 'd1', source_path: 'd.ts', content_bytes: 5000, doc_class: 'document' }),
      candidate({ doc_id: 't1', source_path: 't.ts', content_bytes: 5000, doc_class: 'template' }),
    ];
    // Budget for 2 of 3
    const result = allocateDelivery(docs, defaultOptions({ max_inline_bytes: 10_000 }));

    const t1 = result.docs.find((d) => d.doc_id === 't1')!;
    const d1 = result.docs.find((d) => d.doc_id === 'd1')!;
    const e1 = result.docs.find((d) => d.doc_id === 'e1')!;

    expect(t1.delivery).toBe('inline');
    expect(d1.delivery).toBe('inline');
    expect(e1.delivery).toBe('deferred'); // expanded gets deferred first
  });

  it('lower numeric priority is inlined first (matches compiler convention)', () => {
    const docs = [
      candidate({ doc_id: 'low-prio', source_path: 'low.ts', content_bytes: 5000, priority: 200, doc_class: 'document' }),
      candidate({ doc_id: 'high-prio', source_path: 'high.ts', content_bytes: 5000, priority: 10, doc_class: 'document' }),
    ];
    // Budget for only one
    const result = allocateDelivery(docs, defaultOptions({ max_inline_bytes: 6000 }));
    const highPrio = result.docs.find((d) => d.doc_id === 'high-prio')!;
    const lowPrio = result.docs.find((d) => d.doc_id === 'low-prio')!;
    expect(highPrio.delivery).toBe('inline');
    expect(lowPrio.delivery).toBe('deferred');
  });
});

// ============================================================
// Audit meta
// ============================================================

describe('allocateDelivery — audit meta', () => {
  it('computes delivery_stats correctly', () => {
    const docs = [
      candidate({ doc_id: 'a', source_path: null, content_bytes: 1000 }),
      candidate({ doc_id: 'b', source_path: 'b.ts', content_bytes: 2000 }),
      candidate({ doc_id: 't1', doc_class: 'template', kind: 'template', content_bytes: 500 }),
    ];
    const result = allocateDelivery(docs, defaultOptions({ content_mode: 'auto', command: 'review' }));

    // t1 is omitted (policy), a is mandatory inline, b is deferred (auto, > 2048? no, 2000 ≤ 2048)
    const stats = result.audit_meta.delivery_stats;
    expect(stats.omitted_count).toBe(1); // t1
    expect(stats.inline_count).toBe(2); // a (mandatory) + b (small ≤ 2048)
    expect(stats.deferred_count).toBe(0);
  });

  it('records budget_utilization', () => {
    const docs = [
      candidate({ doc_id: 'a', source_path: null, content_bytes: 5000 }),
    ];
    const result = allocateDelivery(docs, defaultOptions({ max_inline_bytes: 10_000 }));
    expect(result.audit_meta.budget_utilization).toBe(0.5);
  });

  it('records policy_omitted_doc_ids', () => {
    const docs = [
      candidate({ doc_id: 't1', doc_class: 'template', kind: 'template' }),
      candidate({ doc_id: 't2', doc_class: 'template', kind: 'template' }),
    ];
    const result = allocateDelivery(docs, defaultOptions({ content_mode: 'auto', command: 'refactor' }));
    expect(result.audit_meta.policy_omitted_doc_ids).toEqual(['t1', 't2']);
  });
});
