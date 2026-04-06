---
id: "012-04"
title: "compile_audit の契約テスト"
status: "done"
adr: "ADR-012"
phase: 1
priority: "P1"
depends_on: ["012-01"]
created: "2026-03-31"
closed: "2026-04-06"
closed_reason: ""
---

## 概要

compile_audit の後方互換性と audit_meta の構造を検証する契約テストを追加する。

## 受け入れ条件

- [x] audit_meta なし（v1 DB）でも `getCompileAudit()` が正常に動作すること
- [x] audit_meta あり（v2 DB）で構造が正しく返却されること
- [x] 失敗経路（BudgetExceededError）でも audit が記録されること
- [x] observation 競合テスト: 複数 admin が同時に `process_observations` を叩くケースの排他制御検証

## 実装メモ

- `src/mcp/compile-audit.contract.test.ts` — `AegisService` 経由の v1 / v2（`CompileAuditMeta` 相当フィールド）/ `BudgetExceededError`、および **file-backed** 同一 DB に対する 2 接続での並列 `process_observations('compile_miss')`。
- `Repository.claimUnanalyzedObservations` + `AegisService.analyzeAndPropose` — 未分析行の取得と `analyzed_at` 更新を 1 トランザクションにまとめ、多プロセス/複数接続時の二重 claim を防ぐ（`processObservations` のループも `claimed_count` 基準に変更）。
- `src/core/store/repository.test.ts` — file-backed で 2 接続を開き、先に claim した接続のみが観測を取得することを検証。
