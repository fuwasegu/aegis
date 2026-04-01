---
id: "013-01"
title: "Schema Migration フレームワーク実装"
status: "done"
adr: "ADR-013"
phase: 1
priority: "P0"
depends_on: []
created: "2026-03-31"
closed: "2026-04-01"
closed_reason: ""
---

## 概要

`schema_migrations` テーブルと migration runner を実装する。既存の `migrateSourcePaths()` を migration 001 として formalize し、アドホックな列存在チェックを置き換える。

## 受け入れ条件

- [x] `schema_migrations` テーブルが作成されること
- [x] `Migration` インターフェースが定義されていること (`src/core/store/migrations/`)
- [x] `runMigrations()` が `AegisDatabase` 初期化時に実行されること
- [x] `001_initial_baseline.ts` が既存の `migrateSourcePaths()` を formalize していること
- [x] 新規 DB と既存 DB の両方で正常に動作すること
- [x] migration の冪等性テスト
- [x] `migrateSourcePaths()` のアドホック呼び出しが除去されていること

## 実装メモ

- `runMigrations` は各バージョンごとにトランザクション内で **適用済みを再読み** し、複数プロセスが同時起動した際の `schema_migrations` 重複 INSERT を避ける（Codex レビュー指摘に対応）。

## 完了メモ

- `main.ts` では `runInitialBaselineSourcePathMigration`（001 のデータ手順）を呼ぶ。実体は `paths.ts` の `migrateSourcePaths` に委譲。
