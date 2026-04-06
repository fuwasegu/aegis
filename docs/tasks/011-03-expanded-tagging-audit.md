---
id: "011-03"
title: "Audit に ExpandedTaggingAudit メタデータを追加"
status: "done"
adr: "ADR-011"
phase: 2
priority: "P1"
depends_on: ["011-01", "012-01"]
created: "2026-03-31"
closed: "2026-04-06"
closed_reason: ""
---

## 概要

`CompileAuditMeta` に `ExpandedTaggingAudit` を追加し、tags_source, requested_tags, accepted_tags, ignored_unknown_count, matched_doc_count を記録する。

## 受け入れ条件

- [x] `ExpandedTaggingAudit` 型が定義されていること
- [x] `CompileAuditMeta.expanded_tagging` に記録されること
- [x] 正常経路・失敗経路（BudgetExceededError）両方で記録されること
- [x] `aegis_get_compile_audit` で返却されること
- [x] テスト追加
