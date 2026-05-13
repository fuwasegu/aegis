---
id: "016-04"
title: "drift 可視化と direct import guardrail を追加"
status: "open"
adr: "ADR-016"
phase: 7
priority: "P2"
depends_on: ["016-03"]
created: "2026-05-11"
closed: ""
closed_reason: ""
---

## 概要

drift backlog を admin だけが知る内部状態にせず、
`compile_context`, `workspace_status`, `maintenance`, `aegis_import_doc`
の各面で見えるようにする。

## 受け入れ条件

- [ ] `compile_context.notices` に stale tracked unit の注意が mode 別に出ること
- [ ] `workspace_status` に reconcile-mode ごとの backlog 集計が追加されること
- [ ] `maintenance` レポートに `hash-sync`, `anchor-sync`, `semantic-review` の件数と対象が出ること
- [ ] `aegis_import_doc` が whole-file raw import に対して advisory warning を返せること
- [ ] README または運用ドキュメントが新フローに言及すること
- [ ] テスト追加

## 設計詳細

### `compile_context.notices`

現状の `source_synced_at` ベース warning を一般化する。

- `hash-sync`
  - 現行どおり stale age ベース
- `anchor-sync`
  - `source_synced_at` が古い、または anchor failure backlog がある場合に notice
- `semantic-review`
  - doc 単位の長文 notice を乱発せず、件数 summary を優先

P-1 を守るため、時刻依存や運用依存の情報はすべて notices に留める。

### `workspace_status`

追加候補:

```typescript
{
  reconcile_backlog: {
    hash_sync_stale: number;
    anchor_sync_stale: number;
    semantic_review_pending: number;
  };
}
```

`recent compile regions` や `unresolved_misses` と同じ read model として扱い、
Canonical mutation を伴わない。

### `maintenance` レポート

`runMaintenance()` の出力に、次の summary を含める。

- `hash_sync`: checked / up_to_date / proposals_created
- `anchor_sync`: checked / proposals_created / failures
- `semantic_review`: doc_ids / observations_created

### `aegis_import_doc` の advisory warning

return shape に `warnings?: string[]` を追加する。
少なくとも次の条件で warning を返す。

- import される content が 4096 bytes 超
- source に `## ` section が 2 つ以上ある
- 導出 `reconcile_mode === 'semantic-review'`

この warning は import を拒否しない。
「より良いフローとして `aegis_analyze_doc` / `aegis_analyze_import_batch` を使うべき」
ことを伝えるためのものとする。

## 実装対象

- `src/core/source-sync-staleness.ts`
- `src/core/read/workspace-status.ts`
- `src/mcp/services.ts`
- `src/mcp/services.test.ts`
- `src/core/read/workspace-status.test.ts`
- `README.md` / `README.ja.md` のうち関連箇所

## テスト観点

- stale hash-sync doc の notice が従来どおり出ること
- stale anchor-sync doc の notice が追加されること
- semantic-review backlog が summary notice になること
- `workspace_status` の新集計が deterministic に返ること
- `aegis_import_doc` が warning を返しても proposal 生成自体は続くこと

