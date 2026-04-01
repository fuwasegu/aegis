---
id: "015-02"
title: "doc_gap_detected derived observation の導入"
status: "open"
adr: "ADR-015"
phase: 0
priority: "P0"
depends_on: ["015-01"]
created: "2026-03-31"
closed: ""
closed_reason: ""
---

## 概要

`doc_gap_detected` を新しい observation event_type として追加する。content gap や split candidate を診断情報として記録し、将来の optimization 層の入力にする。

## 受け入れ条件

- [ ] `DocGapPayload` 型が `types.ts` に定義されていること
- [ ] `event_type: 'doc_gap_detected'` が observe のバリデーションを通ること
- [ ] `doc_gap_detected` は proposal を直接生成しないこと（診断のみ）
- [ ] `aegis_list_observations` で `doc_gap_detected` がフィルタ可能なこと
- [ ] テスト追加
