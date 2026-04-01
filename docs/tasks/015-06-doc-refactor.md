---
id: "015-06"
title: "doc-refactor (分割トリガー検知 + 分割計画)"
status: "open"
adr: "ADR-015"
phase: 4
priority: "P2"
depends_on: ["015-05"]
created: "2026-03-31"
closed: ""
closed_reason: ""
---

## 概要

hybrid threshold に基づくドキュメント分割トリガー検知と、分割計画の生成を実装する。

## 受け入れ条件

- [ ] `optimization/doc-refactor.ts` が実装されていること
- [ ] `RefactorTrigger` 閾値（min_exposure_count, min_content_gap_count, gap_rate_threshold, min_distinct_clusters）
- [ ] 分割トリガー検知 → `doc_gap_detected (gap_kind: 'split_candidate')` を emit
- [ ] `automation/` に DocRefactorAnalyzer adapter を追加
- [ ] テスト追加
