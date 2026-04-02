---
id: "012-01"
title: "compile_log に audit_meta 列を追加"
status: "done"
adr: "ADR-012"
phase: 1
priority: "P0"
depends_on: ["013-01"]
created: "2026-03-31"
closed: "2026-04-02"
closed_reason: ""
---

## 概要

`compile_log` テーブルに `audit_meta` TEXT 列を追加する migration を作成し、`CompileAuditMeta` 型を定義する。ADR-009 の TODO を解消する。

## 受け入れ条件

- [x] `002_add_audit_meta.ts` migration が作成されていること
- [x] `CompileAuditMeta` 型が `types.ts` に定義されていること（delivery_stats, budget_utilization）
- [x] `ContextCompiler` が compile 時に audit_meta を JSON として記録すること
- [x] `AegisService.getCompileAudit()` が audit_meta を含めて返却すること
- [x] 既存テストが壊れていないこと
- [x] audit_meta の構造検証テスト

## 完了メモ

- `compile_log.audit_meta` は既に実装済みだったため、ADR-013 どおり `002_add_audit_meta.ts`（version 2）を分離し、`001_initial_baseline` から重複 ALTER を除去。`schema.ts` の baseline DDL に `audit_meta` を明記。
- `compiler.test.ts` に `CompileAuditMeta` 形状の `toMatchObject` 検証を追加。`migrations.test.ts` に legacy テーブル向け `upAddAuditMeta` のテストを追加。
- `AegisService.getCompileAudit` の戻り値型を `ContextCompiler.getCompileAudit` と一致させ、`delivery_stats` 等が型で見えるようにした。
