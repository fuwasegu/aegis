---
id: "010-01"
title: "documents テーブルに ownership 列を追加"
status: "done"
adr: "ADR-010"
phase: 1
priority: "P1"
depends_on: ["013-01"]
created: "2026-03-31"
closed: "2026-04-02"
closed_reason: ""
---

## 概要

ADR-010 Phase 1 を実装する。`documents` テーブルに `ownership` カラムを追加し、`import_doc` での自動判定と `sync_docs` のフィルタ変更を行う。

## 受け入れ条件

- [x] `004_add_documents_ownership.ts` migration（ADR-013 連番。タスク記載の 003 は `doc_gap` と衝突のため 004 で定義）
- [x] `Document` 型に `ownership: 'file-anchored' | 'standalone' | 'derived'` が追加されていること
- [x] 既存データ migration: `source_path` あり → `file-anchored`、なし → `standalone`
- [x] `import_doc`: `file_path` あり → `file-anchored`、`content` のみ → `standalone`（`new_doc` 承認時の既定 + 既存 doc への `source_path` 付与で `update_doc` に `ownership` を含める）
- [x] `sync_docs`: `ownership = 'file-anchored'` で対象フィルタ
- [x] `sync_docs`: source file が存在しない場合 `not_found` として報告
- [x] テスト追加

## 完了メモ

- 001 から ownership DDL を切り出し、version 4 として `upAddDocumentsOwnership` に集約（新規／レガシー DB とも idempotent）。
- `DocumentImportAnalyzer` の `update_doc` で `source_path` がある場合に `ownership: file-anchored` を付与。
- `approveProposal` の modification 許可フィールドに `ownership` を追加。
