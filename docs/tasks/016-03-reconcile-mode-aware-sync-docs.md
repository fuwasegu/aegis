---
id: "016-03"
title: "sync_docs を reconcile-mode-aware に拡張"
status: "open"
adr: "ADR-016"
phase: 7
priority: "P0"
depends_on: ["016-01", "016-02", "014-01", "014-02"]
created: "2026-05-11"
closed: ""
closed_reason: ""
---

## 概要

`AegisService.syncDocs()` を `hash-sync` / `anchor-sync` / `semantic-review` に分岐させる。
`git pull` 後の drift を deterministic に検知しつつ、P-3 を崩さず proposal / diagnostic に振り分ける。

## 受け入れ条件

- [ ] `syncDocs()` が doc ごとに `ReconcileMode` を導出して分岐すること
- [ ] `hash-sync` の既存挙動が維持されること
- [ ] `anchor-sync` で materialized content 差分を `update_doc` proposal に変換できること
- [ ] `anchor-sync` の materialization failure を `staleness_detected` に変換できること
- [ ] `semantic-review` は自動更新せず、semantic staleness 側の backlog として扱われること
- [ ] `syncDocs()` の返り値に mode 別の結果が追加されること
- [ ] テスト追加

## 設計詳細

### mode 導出 helper

`src/core/source-refs.ts` か新規 helper module に、少なくとも次の関数を追加する。

```typescript
function classifyReconcileMode(
  doc: Pick<Document, 'ownership' | 'source_path' | 'source_refs_json'>
): ReconcileMode
```

Phase 1 の判定:

- `untracked`
  - `ownership !== 'file-anchored'`
- `hash-sync`
  - 既存 `primaryAssetPathForHashSync(doc) !== null`
- `anchor-sync`
  - distinct asset 数が 1
  - `primaryAssetPathForHashSync(doc) === null`
  - `source_refs_json` に supported slice anchor が **ちょうど 1 個**
- `semantic-review`
  - それ以外

### `anchor-sync` で proposal を作る条件

1. source file を読む
2. materializer で expected content を生成
3. `expected_hash !== doc.content_hash` なら drift
4. pending `update_doc` がなければ:
   - `document_import` observation を insert
   - `update_doc` proposal を draft
   - payload には `content`, `source_path`, `source_refs` / `source_refs_json`, `ownership` を保持

### `anchor-sync` failure の扱い

materializer が `ok: false` を返した場合:

- proposal は作らない
- `staleness_detected` observation を作る
- `level = 2`
- `kind`
  - `anchor_missing`
  - `anchor_unsupported`
  - `anchor_source_unreadable`
  - `anchor_invalid_range`

### `syncDocs()` 返り値の追加項目

既存フィールドは互換性維持のため残す。
追加候補:

```typescript
{
  hash_sync_checked: number;
  anchor_sync_checked: number;
  anchor_sync_proposals_created: string[];
  anchor_sync_failures: Array<{ doc_id: string; kind: string }>;
  semantic_review_doc_ids: string[];
}
```

`multi_source_doc_ids` は既存互換のため残してよいが、
新規呼び出し側は `semantic_review_doc_ids` を優先する。

## 実装対象

- `src/core/source-refs.ts`
- `src/core/source-materialization.ts`
- `src/mcp/services.ts`
- `src/mcp/services.test.ts`
- `src/core/optimization/staleness.ts`（必要なら semantic-review 連携の小調整）

## テスト観点

- existing hash-sync regression がないこと
- single-file section anchor doc が drift 時に `update_doc` proposal になること
- missing `## Heading` が `staleness_detected(kind='anchor_missing')` になること
- invalid `lines` range が proposal ではなく failure になること
- multi-source doc が auto-update されず `semantic_review_doc_ids` に入ること
- pending `update_doc` がある doc は二重 proposal にならないこと

