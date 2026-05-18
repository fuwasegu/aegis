---
id: "017-04"
title: "project-shared workflow の README / setup guidance"
status: "open"
adr: "ADR-017"
phase: 8
priority: "P2"
depends_on: ["017-01", "017-02", "017-03"]
created: "2026-05-14"
closed: ""
closed_reason: ""
---

## 概要

project-shared mode の運用を README / setup guidance に追加し、
authoring workspace と replica workspace の違い、
`share-export` / `share-hydrate` のタイミング、
破壊的 rebuild であることを明確にする。

## 受け入れ条件

- [ ] `README.md` に project-shared workflow が追加されること
- [ ] `README.ja.md` に同等内容が追加されること
- [ ] `share-export` / `share-hydrate` の利用例があること
- [ ] authoring workflow と replica workflow の違いが説明されること
- [ ] `share-hydrate` が local operational state を preserve しないことが明記されること
- [ ] `doctor` / `stats` / `compile_context.notices` の share status に触れること

## 設計詳細

### README で最低限伝えること

- `.aegis/` は local runtime DB であり Git 管理対象ではない
- `aegis-share/` は repo commit される shared snapshot artifact
- authoring workspace は approve 後に `share-export` を実行する
- replica workspace は `git pull` 後に `share-hydrate --replace` を実行する
- local proposal / compile log / observations は re-hydrate で失われうる

### setup guidance

必要なら将来、
post-pull hook や CI check に接続できるよう、
CLI help text や examples も整える。

## 実装対象

- `README.md`
- `README.ja.md`
- 必要なら `src/main.ts` の help text

## テスト観点

- なし（文書更新）
