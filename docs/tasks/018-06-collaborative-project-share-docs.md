---
id: "018-06"
title: "collaborative project-share の README / setup guidance"
status: "done"
adr: "ADR-018"
phase: 9
priority: "P2"
depends_on: ["018-02", "018-03", "018-04", "018-05"]
created: "2026-05-19"
closed: "2026-05-21"
closed_reason: "implemented"
---

## 概要

ADR-018 の collaborative authoring mode を README / setup guidance に追加し、
ADR-017 の distribution workflow との違いと接続方法を明確にする。

## 受け入れ条件

- [ ] `README.md` に collaborative project-share workflow が追加されること
- [ ] `README.ja.md` に同等内容が追加されること
- [ ] `share-lint` / `share-format` / `share-materialize` / bootstrap export の利用例があること
- [ ] ADR-017 distribution mode と ADR-018 collaborative mode の違いが説明されること
- [ ] `compile_context` は shared source ではなく DB を読むことが明記されること
- [ ] Phase 1 では local overlay を扱わないことが明記されること
- [ ] source-native lane と DB-native lane の 2-lane approval が説明されること

## 設計詳細

### README で最低限伝えること

- `aegis-share/source/` は human-editable shared source
- `aegis-share/canonical.json` は引き続き distribution artifact
- collaborative mode の標準フロー
  - edit
  - `share-format`
  - `share-lint`
  - PR merge
  - `share-materialize`
  - `share-export`
- replica は引き続き `share-hydrate --replace`

### setup guidance

- CI で `share-lint` を回す想定に触れる
- どの lane を使うかの判断基準を短く添える

## 実装対象

- `README.md`
- `README.ja.md`
- 必要なら `src/main.ts` の help text

## テスト観点

- なし（文書更新）

