---
id: "015-10"
title: "source_refs_json カラム追加 (N:M マッピング)"
status: "done"
adr: "ADR-015"
phase: 5
priority: "P3"
depends_on: ["013-01", "015-09"]
created: "2026-03-31"
closed: "2026-04-21"
closed_reason: ""
---

## 概要

`documents` テーブルに `source_refs_json` TEXT カラムを追加し、1 delivery unit : N source asset の N:M マッピングを実現する。ADR-002 の 1:1 前提を超える。

## 受け入れ条件

- [x] `SourceRef` 型が定義されていること（`asset_path`, `anchor_type`: `file` \| `section` \| `lines`, `anchor_value` — 実装および `docs/adr/015-knowledge-optimization-architecture.md` §10 と整合）
- [x] migration で `source_refs_json` カラムが追加されること
- [x] `import_doc` / `aegis_analyze_doc` で `source_refs` を設定可能なこと
- [x] `sync_docs` の責務分離: **distinct whole-file 単一アセット**なら hash sync。**複数 distinct アセット**または slice アンカー主体は hash sync の対象外で、multi-source は `optimization/staleness.ts`／`linkedPathsForMultiSourceStaleness` に寄せる（単一ファイルの `section`/`lines` のみは slice のため別扱い — §2.3 設計書参照）
- [x] テスト追加
