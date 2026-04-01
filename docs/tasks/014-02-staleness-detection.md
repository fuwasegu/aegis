---
id: "014-02"
title: "sync_docs の staleness 検知強化"
status: "open"
adr: "ADR-014"
phase: 3
priority: "P2"
depends_on: ["010-01", "014-01"]
created: "2026-03-31"
closed: ""
closed_reason: ""
---

## 概要

sync_docs の検知を拡張する。source_path 削除検知、compile-time staleness warning を実装する。

## 受け入れ条件

- [ ] source_path が存在しないファイルを `not_found` として報告すること
- [ ] `compile_context` レスポンスの `warnings` に最終 sync が N 日以上前の doc の警告が含まれること
- [ ] `maintenance` のレポートに staleness 結果が含まれること
- [ ] テスト追加
