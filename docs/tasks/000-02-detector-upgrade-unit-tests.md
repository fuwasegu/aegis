---
id: "000-02"
title: "detector.ts / upgrade.ts のユニットテスト追加"
status: "open"
adr: ""
phase: 3
priority: "P2"
depends_on: []
created: "2026-03-31"
closed: ""
closed_reason: ""
---

## 概要

`detector.ts`（スタック検出）と `upgrade.ts`（テンプレートアップグレード）のユニットテストを追加する。現在テスト未カバー。

## 受け入れ条件

- [ ] `detector.ts` のユニットテスト: 各スタック検出パターンのカバレッジ
- [ ] `upgrade.ts` のユニットテスト: バージョン比較、proposal 生成、エラーケース
- [ ] edge case（未知のスタック、壊れたテンプレート等）のテスト
