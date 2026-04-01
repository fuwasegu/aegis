---
id: "015-07"
title: "意味的陳腐化検知 (Level 1-3 決定的)"
status: "open"
adr: "ADR-015"
phase: 4
priority: "P2"
depends_on: ["014-02"]
created: "2026-03-31"
closed: ""
closed_reason: ""
---

## 概要

Level 1 (hash 不一致) に加え、Level 2 (source_path 消失/リネーム) と Level 3 (参照コード変更検知) を実装する。全て決定的。

## 受け入れ条件

- [ ] `optimization/staleness.ts` が実装されていること
- [ ] Level 2: source_path の消失・リネーム検知
- [ ] Level 3: delivery unit が edge で紐付くファイル群の変更を検知（関数名/クラス名の rename/delete）
- [ ] `automation/` に StalenessAnalyzer adapter を追加
- [ ] テスト追加
