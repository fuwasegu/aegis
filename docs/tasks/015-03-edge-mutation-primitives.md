---
id: "015-03"
title: "retarget_edge / remove_edge proposal primitive 追加"
status: "open"
adr: "ADR-015"
phase: 3
priority: "P2"
depends_on: ["015-01"]
created: "2026-03-31"
closed: ""
closed_reason: ""
---

## 概要

`proposal_type` に `retarget_edge`（既存 edge の glob 変更）と `remove_edge`（edge 削除）を追加する。

## 受け入れ条件

- [ ] `proposal_type` に `retarget_edge` と `remove_edge` が追加されていること
- [ ] `_applyRetargetEdge()` / `_applyRemoveEdge()` が repository に実装されていること
- [ ] `approveProposal()` が新 primitive を処理できること
- [ ] edge 存在チェック、重複チェックが実装されていること
- [ ] テスト追加
