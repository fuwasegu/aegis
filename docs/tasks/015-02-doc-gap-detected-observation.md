---
id: "015-02"
title: "doc_gap_detected derived observation の導入"
status: "done"
adr: "ADR-015"
phase: 0
priority: "P0"
depends_on: ["015-01"]
created: "2026-03-31"
closed: "2026-04-02"
closed_reason: ""
---

## 概要

`doc_gap_detected` を新しい observation event_type として追加する。content gap や split candidate を診断情報として記録し、将来の optimization 層の入力にする。

## 受け入れ条件

- [x] `DocGapPayload` 型が `types.ts` に定義されていること
- [x] `event_type: 'doc_gap_detected'` が observe のバリデーションを通ること
- [x] `doc_gap_detected` は proposal を直接生成しないこと（診断のみ）
- [x] `aegis_list_observations` で `doc_gap_detected` がフィルタ可能なこと
- [x] テスト追加

## 完了メモ

- `DocGapAnalyzer` は常に空 `drafts`（`DocGapAnalyzer` + `process_observations` で proposal なし）。
- DB: `schema.ts` の CHECK とマイグレーション `003_add_doc_gap_event_type` で既存 DB 互換。
- `DocGapPayload` は ADR-015 のフィールド名・enum（`gap_kind`, `scope_patterns`, `routing_gap`, `metrics`, …）に合わせて永続化。
- `listObservations` の `review_comment` は `gap_kind → suggested_next_action` の合成文字列をフォールバック表示。
