---
id: "018-03"
title: "share-format CLI"
status: "done"
adr: "ADR-018"
phase: 9
priority: "P1"
depends_on: ["018-01"]
created: "2026-05-19"
closed: "2026-05-20"
closed_reason: "implemented"
---

## 概要

collaborative shared source を deterministic に整形する `share-format` CLI を実装する。
Git diff / review / merge を安定化させるための正規化レイヤー。

## 受け入れ条件

- [ ] `share-format` CLI が追加されること
- [ ] 既定入力が `aegis-share/source/` であること
- [ ] document frontmatter の key 順が固定されること
- [ ] JSON file の key 順と配列順が deterministic に正規化されること
- [ ] Markdown body は意味を変えずに保持されること
- [ ] 2 回連続実行すると 2 回目は no-op になること
- [ ] 改行が `\\n` に正規化されること
- [ ] テスト追加

## 設計詳細

### 正規化対象

- `documents/*.md`
  - frontmatter key order
  - trailing newline
- `edges/*.json`
  - array sort
  - key order
- `layer-rules.json`
  - array sort
- `tag-mappings.json`
  - array sort

### 想定ソート

- documents: filename (`doc_id`) ASC
- edges: `edge_id` ASC
- layer rules: `rule_id` ASC
- tag mappings: `tag ASC`, `doc_id ASC`

## 実装対象

- 新規 `src/core/project-share/format.ts`
- `src/main.ts`
- テスト (`src/core/project-share/format.test.ts`, `src/main-cli.test.ts` 相当)

## テスト観点

- 乱れた key order / array order が正規化されること
- 2 回実行で byte-identical になること
- body text が壊れないこと

