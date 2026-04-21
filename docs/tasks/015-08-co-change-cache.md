---
id: "015-08"
title: "co-change cache infrastructure"
status: "done"
adr: "ADR-015"
phase: 4
priority: "P3"
depends_on: ["014-01", "015-05"]
created: "2026-03-31"
closed: "2026-04-21"
closed_reason: ""
---

## 概要

git log からコード変更とドキュメント参照の相関を分析し、cache テーブルに保存する。maintenance CLI の増分ジョブとして実行する。

## 受け入れ条件

- [x] co-change cache テーブルが定義されていること（migration）
- [x] 初回: full scan、以後: `last_processed_commit` から増分更新
- [x] `maintenance` CLI から実行可能なこと
- [x] `edge-candidate-builder` が cache を読めること（cache なしでも graceful degradation）
- [x] テスト追加
