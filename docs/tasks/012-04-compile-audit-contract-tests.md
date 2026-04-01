---
id: "012-04"
title: "compile_audit の契約テスト"
status: "open"
adr: "ADR-012"
phase: 1
priority: "P1"
depends_on: ["012-01"]
created: "2026-03-31"
closed: ""
closed_reason: ""
---

## 概要

compile_audit の後方互換性と audit_meta の構造を検証する契約テストを追加する。

## 受け入れ条件

- [ ] audit_meta なし（v1 DB）でも `getCompileAudit()` が正常に動作すること
- [ ] audit_meta あり（v2 DB）で構造が正しく返却されること
- [ ] 失敗経路（BudgetExceededError）でも audit が記録されること
- [ ] observation 競合テスト: 複数 admin が同時に `process_observations` を叩くケースの排他制御検証
