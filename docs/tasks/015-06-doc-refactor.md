---
id: "015-06"
title: "doc-refactor (分割トリガー検知 + 分割計画)"
status: "done"
adr: "ADR-015"
phase: 4
priority: "P2"
depends_on: ["015-05"]
created: "2026-03-31"
closed: "2026-04-18"
closed_reason: ""
---

## 概要

hybrid threshold に基づくドキュメント分割トリガー検知と、分割計画の生成を実装する。

## 受け入れ条件

- [x] `optimization/doc-refactor.ts` が実装されていること
- [x] `RefactorTrigger` 閾値（min_exposure_count, min_content_gap_count, gap_rate_threshold（=`max(gap_rate_threshold_floor, cohort_median × multiplier)`）, min_distinct_clusters）
- [x] 分割トリガー検知 → `doc_gap_detected (gap_kind: 'split_candidate')` を emit
- [x] `automation/` に DocRefactorAnalyzer adapter を追加
- [x] テスト追加

## 完了メモ

Phase 1 は ADR §5.1 の hybrid 閾値による **分割トリガー検知** と `doc_gap_detected` への記録まで。SLM による分割計画（設計 §5.2 Step 2 以降）は別タスクとする。
