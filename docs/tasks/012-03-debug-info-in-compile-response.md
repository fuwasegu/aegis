---
id: "012-03"
title: "compile_context レスポンスに debug_info を公開"
status: "open"
adr: "ADR-012"
phase: 2
priority: "P2"
depends_on: ["012-02"]
created: "2026-03-31"
closed: ""
closed_reason: ""
---

## 概要

audit_meta に蓄積した near_miss_edges, layer_classification, budget_dropped をエージェントが利用可能な `debug_info` フィールドとして compile_context レスポンスに含める。

## 受け入れ条件

- [ ] `CompileResult` に `debug_info?: CompileDebugInfo` が追加されていること
- [ ] `debug_info` がルーティングに影響しないこと（P-1 維持）
- [ ] テスト追加
