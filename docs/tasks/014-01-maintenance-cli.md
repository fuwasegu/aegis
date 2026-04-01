---
id: "014-01"
title: "maintenance CLI サブコマンド実装"
status: "done"
adr: "ADR-014"
phase: 3
priority: "P1"
depends_on: []
created: "2026-03-31"
closed: "2026-04-02"
closed_reason: ""
---

## 概要

`main.ts` に `maintenance` サブコマンドを追加。process_observations → sync_docs → archive_observations → check_upgrade の一括実行と `--dry-run` モードを実装する。

## 受け入れ条件

- [x] `npx aegis maintenance` で 4 操作が順序通り実行されること
- [x] `--dry-run` で変更なしのレポートのみ出力されること
- [x] 自動承認は行わないこと（P-3 堅守）
- [x] 各ステップの結果がサマリとして出力されること
- [x] テスト追加

## 完了メモ

- `AegisService.runMaintenance` がオーケストレーション。`syncDocs({ dryRun })` と `Repository.countObservationsEligibleForArchive` を追加。
- `--dry-run` 時は `runInitialBaselineSourcePathMigration` を呼ばない（ソースパス正規化による DB 更新を避ける）。
