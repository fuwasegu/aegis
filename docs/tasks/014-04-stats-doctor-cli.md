---
id: "014-04"
title: "stats / doctor CLI サブコマンド実装"
status: "open"
adr: "ADR-014"
phase: 3
priority: "P2"
depends_on: ["012-01"]
created: "2026-03-31"
closed: ""
closed_reason: ""
---

## 概要

`npx aegis stats` と `npx aegis doctor` CLI サブコマンドを実装する。`aegis_get_stats` admin ツールの CLI ラッパー。

## 受け入れ条件

- [ ] `AegisService.getStats()` が実装されていること
- [ ] `aegis_get_stats` admin ツールが登録されていること
- [ ] `npx aegis stats` — 知識ベース統計（approved docs/edges, pending proposals, usage stats）
- [ ] `npx aegis doctor` — ヘルスチェック（stale docs, unanalyzed observations, orphaned mappings）
- [ ] テスト追加
