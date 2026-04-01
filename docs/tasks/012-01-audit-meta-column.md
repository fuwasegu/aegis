---
id: "012-01"
title: "compile_log に audit_meta 列を追加"
status: "open"
adr: "ADR-012"
phase: 1
priority: "P0"
depends_on: ["013-01"]
created: "2026-03-31"
closed: ""
closed_reason: ""
---

## 概要

`compile_log` テーブルに `audit_meta` TEXT 列を追加する migration を作成し、`CompileAuditMeta` 型を定義する。ADR-009 の TODO を解消する。

## 受け入れ条件

- [ ] `002_add_audit_meta.ts` migration が作成されていること
- [ ] `CompileAuditMeta` 型が `types.ts` に定義されていること（delivery_stats, budget_utilization）
- [ ] `ContextCompiler` が compile 時に audit_meta を JSON として記録すること
- [ ] `AegisService.getCompileAudit()` が audit_meta を含めて返却すること
- [ ] 既存テストが壊れていないこと
- [ ] audit_meta の構造検証テスト
