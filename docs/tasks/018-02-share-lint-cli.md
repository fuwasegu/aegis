---
id: "018-02"
title: "share-lint CLI"
status: "open"
adr: "ADR-018"
phase: 9
priority: "P0"
depends_on: ["018-01"]
created: "2026-05-19"
closed: ""
closed_reason: ""
---

## 概要

collaborative shared source を DB に取り込む前に、
壊れた source や危険な参照不整合を止める `share-lint` CLI を実装する。

## 受け入れ条件

- [ ] `share-lint` CLI が追加されること
- [ ] 既定入力が `aegis-share/source/` であること
- [ ] parse error を human-readable に出力し exit 1 すること
- [ ] required field 欠落を検出できること
- [ ] duplicate `doc_id` / `edge_id` / `rule_id` を検出できること
- [ ] edge が存在しない `target_doc_id` を参照していたら fail すること
- [ ] `tag_mappings` が存在しない `doc_id` を参照していたら fail すること
- [ ] success 時は exit 0 で、summary を返すこと
- [ ] テスト追加

## 設計詳細

### 最低限の lint 項目

- file parse 成功
- frontmatter / JSON の schema 妥当性
- ID 重複
- document 参照整合性
- edge source file と logical `source_type` の整合

### Phase 1 でやらないこと

- semantic duplicate 検出
- content quality 判定
- AI-assisted fix

## 実装対象

- 新規 `src/core/project-share/lint.ts`
- `src/main.ts`
- テスト (`src/core/project-share/lint.test.ts`, `src/main-cli.test.ts` 相当)

## テスト観点

- valid tree で exit 0 になること
- malformed Markdown / JSON で exit 1 になること
- duplicate IDs が一覧表示されること
- dangling edge / dangling tag mapping が検出されること

