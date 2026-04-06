---
id: "012-03"
title: "compile_context レスポンスに debug_info を公開"
status: "done"
adr: "ADR-012"
phase: 2
priority: "P2"
depends_on: ["012-02"]
created: "2026-03-31"
closed: "2026-04-06"
closed_reason: ""
---

## 概要

audit_meta に蓄積した near_miss_edges, layer_classification, budget_dropped をエージェントが利用可能な `debug_info` フィールドとして compile_context レスポンスに含める。

## 受け入れ条件

- [x] `CompileResult` に `debug_info?: CompileDebugInfo` が追加されていること
- [x] `debug_info` がルーティングに影響しないこと（P-1 維持）
- [x] テスト追加

## 実装メモ

- `CompileDebugInfo` は `Pick<CompileAuditMeta, 'near_miss_edges' | 'layer_classification' | 'budget_dropped'>`。`CompiledContext.debug_info`、`CompileResult` エイリアス。
- `ContextCompiler` は `auditMeta` 確定後に同3キーを `debug_info` にコピー。未初期化 `emptyResult` では `debug_info` なし。
- CriticalReview（Codex）2026-04-06: ブロッキング指摘なし。

## 完了メモ

- レスポンスに診断を載せつつ、ルーティング入力から切り離した。
