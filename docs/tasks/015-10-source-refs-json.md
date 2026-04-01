---
id: "015-10"
title: "source_refs_json カラム追加 (N:M マッピング)"
status: "open"
adr: "ADR-015"
phase: 5
priority: "P3"
depends_on: ["013-01", "015-09"]
created: "2026-03-31"
closed: ""
closed_reason: ""
---

## 概要

`documents` テーブルに `source_refs_json` TEXT カラムを追加し、1 delivery unit : N source asset の N:M マッピングを実現する。ADR-002 の 1:1 前提を超える。

## 受け入れ条件

- [ ] `SourceRef` 型が定義されていること（asset_path, anchor_type, anchor_value）
- [ ] migration で `source_refs_json` カラムが追加されること
- [ ] `import_doc` / `aegis_analyze_doc` で `source_refs` を設定可能なこと
- [ ] `sync_docs` の責務分離: 単一 source = hash sync、複数 source = staleness analyze
- [ ] テスト追加
