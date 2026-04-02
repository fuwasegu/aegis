---
id: "012-02"
title: "near_miss_edges と layer_classification の収集・記録"
status: "done"
adr: "ADR-012"
phase: 2
priority: "P1"
depends_on: ["012-01"]
created: "2026-03-31"
closed: "2026-04-03"
closed_reason: ""
---

## 概要

`ContextCompiler` でルーティング時に評価されたが不一致だったエッジ（near_miss）と、各 target_file の layer 分類結果を収集し、audit_meta に記録する。

## 受け入れ条件

- [x] `near_miss_edges` が audit_meta に記録されること（edge_id, pattern, target_doc_id, reason）
- [x] `layer_classification` が audit_meta に記録されること（target_file → layer | null）
- [x] `budget_dropped` が audit_meta に記録されること（inline 候補から外れた doc）
- [x] パフォーマンス影響の計測（エッジ全走査のコスト）
- [x] テスト追加

## 完了メモ

- `CompileAuditMeta` に診断用フィールドを追加し、`ContextCompiler` が near miss・layer 分類・計測結果を監査ログへ保存するようにした。
- `allocateDelivery()` で inline 候補から予算超過で落ちたドキュメントを `budget_dropped` として記録するようにした。
- `compiler.test.ts` に監査記録・予算超過・`target_layers` override の回帰テストを追加し、CriticalReview でブロッキングなしを確認した。
