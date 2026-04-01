---
id: "015-08"
title: "co-change cache infrastructure"
status: "open"
adr: "ADR-015"
phase: 4
priority: "P3"
depends_on: ["014-01", "015-05"]
created: "2026-03-31"
closed: ""
closed_reason: ""
---

## 概要

git log からコード変更とドキュメント参照の相関を分析し、cache テーブルに保存する。maintenance CLI の増分ジョブとして実行する。

## 受け入れ条件

- [ ] co-change cache テーブルが定義されていること（migration）
- [ ] 初回: full scan、以後: `last_processed_commit` から増分更新
- [ ] `maintenance` CLI から実行可能なこと
- [ ] `edge-candidate-builder` が cache を読めること（cache なしでも graceful degradation）
- [ ] テスト追加
