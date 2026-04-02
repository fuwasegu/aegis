---
id: "015-01"
title: "RuleBasedAnalyzer の placeholder update_doc を除去"
status: "done"
adr: "ADR-015"
phase: 0
priority: "P0"
depends_on: []
created: "2026-03-31"
closed: "2026-04-02"
closed_reason: ""
---

## 概要

ADR-008 D-2 との不整合を解消する。`RuleBasedAnalyzer` が `compile_miss` + `target_doc_id`（`missing_doc` なし）のケースで出力している placeholder 付き `update_doc` proposal を除去する。

## 受け入れ条件

- [x] `RuleBasedAnalyzer` が `target_doc_id` のみの compile_miss で `update_doc` を出力しないこと
- [x] 代わりに `skip` を返すか、015-02 の `doc_gap_detected` に委譲すること（skip。015-02 は将来委譲先）
- [x] 既存テスト（`rule-analyzer.test.ts`）が更新されていること
- [x] ADR-008 のドキュメントが更新されていること

## 完了メモ

- `main` 上ですでに `rule-analyzer.ts` は skip 実装済み。受け入れに合わせ `RuleBasedAnalyzer` 一式を `rule-analyzer.test.ts` に移し、target_doc_id のみで `update_doc` が出ないことを明示アサートした。
