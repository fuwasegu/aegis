---
id: "015-07"
title: "意味的陳腐化検知 (Level 1-3 決定的)"
status: "done"
adr: "ADR-015"
phase: 4
priority: "P2"
depends_on: ["014-02"]
created: "2026-03-31"
closed: "2026-04-18"
closed_reason: ""
---

## 概要

Level 1 (hash 不一致) に加え、Level 2 (source_path 消失/リネーム) と Level 3 (参照コード変更検知) を実装する。全て決定的。

## 完了メモ

- `core/optimization/staleness.ts` に Level 1–3（hash / 消失・リネーム候補 / edge 先ファイルの fingerprint）を集約。Level 3 baseline は `staleness_baselines` テーブル（マイグレーション 009）。
- `maintenance` の `staleness_report.semantic` に集計。`staleness_detected` observation + `StalenessAnalyzer`（診断のみ、提案なし）。

## 受け入れ条件

- [x] `optimization/staleness.ts` が実装されていること
- [x] Level 2: source_path の消失・リネーム検知
- [x] Level 3: delivery unit が edge で紐付くファイル群の変更を検知（関数名/クラス名の rename/delete）
- [x] `automation/` に StalenessAnalyzer adapter を追加
- [x] テスト追加
