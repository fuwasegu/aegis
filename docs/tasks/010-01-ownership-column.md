---
id: "010-01"
title: "documents テーブルに ownership 列を追加"
status: "open"
adr: "ADR-010"
phase: 1
priority: "P1"
depends_on: ["013-01"]
created: "2026-03-31"
closed: ""
closed_reason: ""
---

## 概要

ADR-010 Phase 1 を実装する。`documents` テーブルに `ownership` カラムを追加し、`import_doc` での自動判定と `sync_docs` のフィルタ変更を行う。

## 受け入れ条件

- [ ] `003_add_ownership.ts` migration が作成されていること
- [ ] `Document` 型に `ownership: 'file-anchored' | 'standalone' | 'derived'` が追加されていること
- [ ] 既存データ migration: `source_path` あり → `file-anchored`、なし → `standalone`
- [ ] `import_doc`: `file_path` あり → `file-anchored`、`content` のみ → `standalone`
- [ ] `sync_docs`: `ownership = 'file-anchored'` で対象フィルタ
- [ ] `sync_docs`: source file が存在しない場合 `not_found` として報告
- [ ] テスト追加
