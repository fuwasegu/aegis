---
id: "012-02"
title: "near_miss_edges と layer_classification の収集・記録"
status: "open"
adr: "ADR-012"
phase: 2
priority: "P1"
depends_on: ["012-01"]
created: "2026-03-31"
closed: ""
closed_reason: ""
---

## 概要

`ContextCompiler` でルーティング時に評価されたが不一致だったエッジ（near_miss）と、各 target_file の layer 分類結果を収集し、audit_meta に記録する。

## 受け入れ条件

- [ ] `near_miss_edges` が audit_meta に記録されること（edge_id, pattern, target_doc_id, reason）
- [ ] `layer_classification` が audit_meta に記録されること（target_file → layer | null）
- [ ] `budget_dropped` が audit_meta に記録されること（inline 候補から外れた doc）
- [ ] パフォーマンス影響の計測（エッジ全走査のコスト）
- [ ] テスト追加
