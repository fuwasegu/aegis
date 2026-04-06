---
id: "015-03"
title: "retarget_edge / remove_edge proposal primitive 追加"
status: "done"
adr: "ADR-015"
phase: 3
priority: "P2"
depends_on: ["015-01"]
created: "2026-03-31"
closed: "2026-04-06"
closed_reason: ""
---

## 概要

`proposal_type` に `retarget_edge`（既存 edge の glob 変更）と `remove_edge`（edge 削除）を追加する。

## 受け入れ条件

- [x] `proposal_type` に `retarget_edge` と `remove_edge` が追加されていること
- [x] `_applyRetargetEdge()` / `_applyRemoveEdge()` が repository に実装されていること
- [x] `approveProposal()` が新 primitive を処理できること
- [x] edge 存在チェック、重複チェックが実装されていること
- [x] テスト追加

## 完了メモ

マージ: https://github.com/fuwasegu/aegis/pull/33 （migration 005、repository / services、テスト含む）
