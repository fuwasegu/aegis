---
id: "014-02"
title: "sync_docs の staleness 検知強化"
status: "done"
adr: "ADR-014"
phase: 3
priority: "P2"
depends_on: ["010-01", "014-01"]
created: "2026-03-31"
closed: "2026-04-06"
closed_reason: ""
---

## 概要

sync_docs の検知を拡張する。source_path 削除検知、compile-time staleness warning を実装する。

## 受け入れ条件

- [x] source_path が存在しないファイルを `not_found` として報告すること
- [x] `compile_context` レスポンスの `notices` に最終 sync が N 日以上前の file-anchored doc の注意が含まれること（P-1 の対象は `warnings` のため、時刻依存の staleness は `notices` に載せる）
- [x] `maintenance` のレポートに staleness 結果が含まれること
- [x] テスト追加

## 完了メモ

- `documents.source_synced_at` と migration 006。`sync_docs` が hash 一致時にのみ更新。`update_doc` 承認では更新しない（review 経路で staleness が潰れないようにする）。
- `new_doc` 承認では `projectRoot` 指定時のみソースファイルを再読込みし、`content_hash` と一致したときだけ `source_synced_at` を入れる（pending 中にファイルが変わっても誤って verified にならない）。bootstrap の `insertDocument` 直列きは従来どおり NULL のまま。
- compile 時の staleness は P-1 のため `notices` に出力（technical-guide の P-1 範囲に合わせる）。
