---
id: "014-04"
title: "stats / doctor CLI サブコマンド実装"
status: "done"
adr: "ADR-014"
phase: 3
priority: "P2"
depends_on: ["012-01"]
created: "2026-03-31"
closed: "2026-04-07"
closed_reason: ""
---

## 概要

`npx aegis stats` と `npx aegis doctor` CLI サブコマンドを実装する。`aegis_get_stats` admin ツールの CLI ラッパー。

## 受け入れ条件

- [x] `AegisService.getStats()` が実装されていること
- [x] `aegis_get_stats` admin ツールが登録されていること
- [x] `npx aegis stats` — 知識ベース統計（approved docs/edges, pending proposals, usage stats）
- [x] `npx aegis doctor` — ヘルスチェック（stale docs, unanalyzed observations, orphaned mappings）
- [x] テスト追加
