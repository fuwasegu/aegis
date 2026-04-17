---
id: "000-02"
title: "detector.ts / upgrade.ts のユニットテスト追加"
status: "done"
adr: ""
phase: 3
priority: "P2"
depends_on: []
created: "2026-03-31"
closed: "2026-04-18"
closed_reason: ""
---

## 概要

`detector.ts`（スタック検出）と `upgrade.ts`（テンプレートアップグレード）のユニットテストを追加する。現在テスト未カバー。

## 受け入れ条件

- [x] `detector.ts` のユニットテスト: 各スタック検出パターンのカバレッジ
- [x] `upgrade.ts` のユニットテスト: バージョン比較、proposal 生成、エラーケース
- [x] edge case（未知のスタック、壊れたテンプレート等）のテスト

## 完了メモ

- `src/core/init/detector.test.ts` / `upgrade.test.ts` を追加。`new_layer_rule` は `detectUpgrade` で検出するが `generateUpgradeProposals` 未対応であることをテストで明示。
