---
id: "015-05"
title: "optimization/ 層の新設 (edge-candidate-builder + edge-validation)"
status: "open"
adr: "ADR-015"
phase: 4
priority: "P2"
depends_on: ["015-02", "012-02"]
created: "2026-03-31"
closed: ""
closed_reason: ""
---

## 概要

`src/core/optimization/` ディレクトリを新設し、Edge 自動推論（コード構造、compile_miss パターン）と Edge 検証（正規形 glob 包含判定、impact simulation）を実装する。

## 受け入れ条件

- [ ] `src/core/optimization/` ディレクトリが作成されていること
- [ ] `edge-candidate-builder.ts` — PathCluster 生成 + MissCluster 生成
- [ ] `edge-validation.ts` — 正規形 glob 包含判定、重複検知、impact simulation
- [ ] `EdgeValidationResult` 型（target_exists, duplicate, subsumes, subsumed_by, impact）
- [ ] impact simulation: compile_log を使い matched_compile_count, observed_recovery_count を計算
- [ ] `automation/` に CoverageAnalyzer adapter を追加
- [ ] テスト追加
