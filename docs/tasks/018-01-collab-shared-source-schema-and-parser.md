---
id: "018-01"
title: "collaborative shared source schema + parser"
status: "done"
adr: "ADR-018"
phase: 9
priority: "P0"
depends_on: ["017-01", "017-02", "017-03", "017-04"]
created: "2026-05-19"
closed: "2026-05-20"
closed_reason: ""
---

## 概要

`aegis-share/source/` を collaborative authoring source として扱うため、
ファイル構造・型・parser を定義する。
Phase 1 では Markdown + frontmatter と JSON 群を deterministic に読み込めることがゴール。

## 受け入れ条件

- [x] `aegis-share/source/` の directory contract が型として定義されること
- [x] `documents/<doc_id>.md` の frontmatter + body を parse できること
- [x] `edges/path-requires.json` / `layer-requires.json` / `command-requires.json` / `doc-depends-on.json` を parse できること
- [x] `layer-rules.json` と `tag-mappings.json` を parse できること
- [x] `content_hash` は source file からは受け取らず、materialize 側で再計算する前提が parser contract に明示されること
- [x] parse error が file path / logical location 付きで返ること
- [x] 余計な source type / unknown file layout を reject できること
- [x] テスト追加

## 設計詳細

### 想定配置

```text
aegis-share/
  source/
    documents/
      <doc_id>.md
    edges/
      path-requires.json
      layer-requires.json
      command-requires.json
      doc-depends-on.json
    layer-rules.json
    tag-mappings.json
```

### parser の責務

- file layout を読む
- Markdown frontmatter を object にする
- JSON を structured object にする
- edge file 名から `source_type` を導出する
- parse error を集約する

### parser に含めない責務

- duplicate ID 検出
- dangling reference 検出
- deterministic rewrite
- DB diff / materialize

これらは後続の lint / format / materialize が担う。

## 実装対象

- 新規 `src/core/project-share/source-types.ts`
- 新規 `src/core/project-share/source-parser.ts`
- 必要なら `src/core/project-share/index.ts`
- テスト (`src/core/project-share/source-parser.test.ts` 相当)

## テスト観点

- 正常な shared source tree を parse できること
- frontmatter 欠落 / malformed JSON が location 付き error になること
- unsupported edge filename が reject されること
- `doc_id` と filename の不整合が検出できること

