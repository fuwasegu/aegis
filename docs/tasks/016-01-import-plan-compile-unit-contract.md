---
id: "016-01"
title: "ImportPlan に compile unit 契約と診断を追加"
status: "done"
adr: "ADR-016"
phase: 7
priority: "P1"
depends_on: ["015-09", "015-10"]
created: "2026-05-11"
closed: "2026-05-13"
closed_reason: ""
---

## 概要

`aegis_analyze_doc` / `aegis_analyze_import_batch` が返す ImportPlan を、
単なる `content_slice` の一覧ではなく「この unit がどう materialize され、
外部更新とどう reconcile されるか」まで分かる契約に拡張する。

## 受け入れ条件

- [ ] `src/core/types.ts` または `src/core/optimization/import-plan.ts` に `ReconcileMode`, `MaterializationKind`, `ImportUnitDiagnosticCode` が定義されていること
- [ ] `SuggestedImportUnit` に `content_bytes`, `materialization_kind`, `reconcile_mode`, `diagnostics` が追加されること
- [ ] `aegis_analyze_doc` が新フィールドを決定的に返すこと
- [ ] `aegis_analyze_import_batch` が batch 内全 unit に対して同じ契約を返すこと
- [ ] `aegis_execute_import_plan` は advisory フィールドを受け取っても Canonical mutation の判断に使わず、必要な provenance を再導出すること
- [ ] テスト追加

## 設計詳細

### 追加する unit-level advisory フィールド

```typescript
type ReconcileMode =
  | 'untracked'
  | 'hash-sync'
  | 'anchor-sync'
  | 'semantic-review';

type MaterializationKind =
  | 'whole-file'
  | 'markdown-section'
  | 'line-range'
  | 'composed';

type ImportUnitDiagnosticCode =
  | 'oversize_unit'
  | 'weak_routing_signal'
  | 'semantic_review_only';
```

```typescript
interface ImportUnitDiagnostic {
  code: ImportUnitDiagnosticCode;
  message: string;
}
```

```typescript
interface SuggestedImportUnit {
  unit_index: number;
  doc_id: string;
  title: string;
  kind: DocumentKind;
  content_slice: string;
  content_bytes: number;
  edge_hints: EdgeSpec[];
  tags: string[];
  materialization_kind: MaterializationKind;
  reconcile_mode: ReconcileMode;
  diagnostics: ImportUnitDiagnostic[];
}
```

### 導出ルール

- `content_bytes`
  - `Buffer.byteLength(content_slice, 'utf8')`
- `materialization_kind`
  - `whole-file`
    - `resolved_source_path` があり、unit が source 全文に一致する
  - `markdown-section`
    - `splitMarkdownSections()` 由来の `## ` section unit
  - `line-range`
    - caller supplied `source_refs` が 1 個で `anchor_type === 'lines'`
  - `composed`
    - 上記以外。multi-source や複数断片をまとめたもの
- `reconcile_mode`
  - Phase 1 では plan 時点の provenance から advisory として導出
  - 最終的な runtime 判定とロジックを揃えるため、helper は `src/core/source-refs.ts` か新規 helper module に切り出して共用する

### 診断コード

- `oversize_unit`
  - `content_bytes > 4096`
  - ADR-009 の auto-inline 閾値と整合
- `weak_routing_signal`
  - `edge_hints.length === 0 && tags.length === 0`
- `semantic_review_only`
  - `reconcile_mode === 'semantic-review'`

### `execute_import_plan` の扱い

- advisory フィールドは **plan 表示用** として受け取り、実行時の source anchoring や `ownership` は現行ロジックから再導出する
- つまり `execute_import_plan` は `materialization_kind` / `reconcile_mode` を trust しない
- forward compatibility のため、未知の advisory フィールドが入っていても parse error にしない

## 実装対象

- `src/core/optimization/import-plan.ts`
- `src/core/source-refs.ts` または新規 helper module
- `src/core/types.ts`
- `src/mcp/services.ts`
- `src/mcp/services.test.ts`
- `src/core/optimization/import-plan.test.ts` 相当のテスト

## テスト観点

- `## ` 見出しで分割された markdown が `markdown-section` になること
- 1 unit 全文取り込みが `whole-file` になること
- `source_refs: [{ anchor_type: 'lines', anchor_value: '10-20' }]` が `line-range` になること
- multi-source または unsupported anchor が `semantic-review` になること
- `content_bytes` が日本語を含んでも UTF-8 bytes で安定すること
- `execute_import_plan` が advisory フィールドの有無で proposal payload を変えないこと

