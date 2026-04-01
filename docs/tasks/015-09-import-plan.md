---
id: "015-09"
title: "import-plan (aegis_analyze_doc / analyze_import_batch)"
status: "open"
adr: "ADR-015"
phase: 5
priority: "P2"
depends_on: ["015-05"]
created: "2026-03-31"
closed: ""
closed_reason: ""
---

## 概要

初回取り込みを革新する。ドキュメントを分析し、分割候補・重複検知・coverage delta を算出する `aegis_analyze_doc` と一括取り込み用 `analyze_import_batch` を実装する。

## 受け入れ条件

- [ ] `optimization/import-plan.ts` が実装されていること
- [ ] `aegis_analyze_doc` admin ツール（read-only）: ImportPlan を返却
- [ ] `aegis_execute_import_plan` admin ツール: proposal bundle を生成
- [ ] 一括取り込み: 横断的な重複検知、cross-doc overlap
- [ ] テスト追加
