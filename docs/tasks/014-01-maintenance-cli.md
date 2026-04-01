---
id: "014-01"
title: "maintenance CLI サブコマンド実装"
status: "open"
adr: "ADR-014"
phase: 3
priority: "P1"
depends_on: []
created: "2026-03-31"
closed: ""
closed_reason: ""
---

## 概要

`main.ts` に `maintenance` サブコマンドを追加。process_observations → sync_docs → archive_observations → check_upgrade の一括実行と `--dry-run` モードを実装する。

## 受け入れ条件

- [ ] `npx aegis maintenance` で 4 操作が順序通り実行されること
- [ ] `--dry-run` で変更なしのレポートのみ出力されること
- [ ] 自動承認は行わないこと（P-3 堅守）
- [ ] 各ステップの結果がサマリとして出力されること
- [ ] テスト追加
