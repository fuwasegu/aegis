---
id: "015-01"
title: "RuleBasedAnalyzer の placeholder update_doc を除去"
status: "open"
adr: "ADR-015"
phase: 0
priority: "P0"
depends_on: []
created: "2026-03-31"
closed: ""
closed_reason: ""
---

## 概要

ADR-008 D-2 との不整合を解消する。`RuleBasedAnalyzer` が `compile_miss` + `target_doc_id`（`missing_doc` なし）のケースで出力している placeholder 付き `update_doc` proposal を除去する。

## 受け入れ条件

- [ ] `RuleBasedAnalyzer` が `target_doc_id` のみの compile_miss で `update_doc` を出力しないこと
- [ ] 代わりに `skip` を返すか、015-02 の `doc_gap_detected` に委譲すること
- [ ] 既存テスト（`rule-analyzer.test.ts`）が更新されていること
- [ ] ADR-008 のドキュメントが更新されていること
