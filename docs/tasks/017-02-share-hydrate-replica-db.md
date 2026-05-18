---
id: "017-02"
title: "share-hydrate による replica DB 再生成"
status: "open"
adr: "ADR-017"
phase: 8
priority: "P0"
depends_on: ["017-01"]
created: "2026-05-14"
closed: ""
closed_reason: ""
---

## 概要

`aegis-share/` の bundle から local replica DB を再生成する
`share-hydrate` CLI を実装する。
Phase 1 は in-place Canonical merge を行わず、
target DB を whole-file で置き換える方式を採る。

## 受け入れ条件

- [ ] `share-hydrate` CLI が追加されること
- [ ] 既定入力が `aegis-share/manifest.json` + `canonical.json` であること
- [ ] bundle integrity (`bundle_sha256`) を検証すること
- [ ] document の `content_hash` を hydrate 側で再計算・検証すること
- [ ] temp DB を構築して atomic swap で target DB を置き換えること
- [ ] hydrate 後の DB が `knowledge_version >= 1` の initialized state になること
- [ ] hydrate 後の DB に current `snapshot_id` と `snapshot_*` rows が入ること
- [ ] 既存 DB がある場合、`--replace` なしでは上書きしないこと
- [ ] local operational state を preserve しないことが CLI で明示されること
- [ ] テスト追加

## 設計詳細

### Phase 1 semantics

`share-hydrate` は「既存 DB に Canonical だけ差し込む」機能ではなく、
**replica DB の rebuild** とみなす。

### 期待フロー

1. manifest を読む
2. bundle file を読む
3. schema / hash / snapshot 整合性を検証する
4. temp path に新規 DB を構築する
5. Canonical rows + `tag_mappings` + current snapshot を投入する
6. `knowledge_meta.current_version = bundle.knowledge_version` を設定する
7. `--replace` 指定時のみ target と swap する

### preserve しないもの

- `observations`
- `proposals`
- `proposal_evidence`
- `compile_log`
- `adapter_meta`

### guardrails

- target DB が初期化済みなら `--replace` 必須
- manifest / bundle のどちらかが欠けていたら fail
- bundle hash mismatch / content hash mismatch / malformed JSON は fail

## 実装対象

- 新規 `src/core/project-share/hydrate.ts`
- `src/main.ts`
- テスト (`src/core/project-share/hydrate.test.ts`, `src/main-cli.test.ts` 相当)

## テスト観点

- `share-export` -> `share-hydrate` round trip 後に current snapshot が一致すること
- hydrate 後に `repo.isInitialized()` が true になること
- target DB が既にあると `--replace` なしで fail すること
- hash mismatch bundle が reject されること
- atomic swap 中断で partial DB が残らないこと
- `tag_mappings` を含む bundle が正しく hydrate されること
