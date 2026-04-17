---
id: "014-03"
title: "Deprecation with replacement + tag cleanup"
status: "done"
adr: "ADR-014"
phase: 3
priority: "P2"
depends_on: []
created: "2026-03-31"
closed: "2026-04-18"
closed_reason: ""
---

## 概要

`deprecate` proposal に `replaced_by_doc_id` フィールドを追加し、承認時に `tag_mappings` の自動クリーンアップを行う。

## 受け入れ条件

- [x] `deprecate` proposal payload に `replaced_by_doc_id?: string` が追加されていること
- [x] `approveProposal` の deprecate 処理で、対象 doc の `tag_mappings` が削除されること
- [x] `replaced_by_doc_id` が指定された場合、置換関係が記録されること
- [x] テスト追加
