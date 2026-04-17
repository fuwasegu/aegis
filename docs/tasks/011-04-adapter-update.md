---
id: "011-04"
title: "Adapter 更新 (intent_tags ワークフロー組み込み)"
status: "done"
adr: "ADR-011"
phase: 3
priority: "P2"
depends_on: ["011-01", "011-02"]
created: "2026-03-31"
closed: "2026-04-18"
closed_reason: ""
---

## 概要

CLAUDE.md, .cursor/rules/, AGENTS.md の Adapter テンプレートに intent_tags ワークフローを組み込む。Agent がセッション開始時に `aegis_get_known_tags` を呼び、compile_context に `intent_tags` を渡すフローを誘導する。

## 受け入れ条件

- [x] `AdapterConfig.toolNames` に `getKnownTags` が追加されていること
- [x] CLAUDE.md adapter テンプレートに intent_tags ワークフローが記述されていること
- [x] .cursor/rules/ adapter テンプレートが更新されていること
- [x] AGENTS.md adapter テンプレートが更新されていること
- [x] README.md / README.ja.md のツール数が更新されていること
- [x] ADR-004 が改訂されていること（SLM → fallback）

## 実装メモ

- `docs/technical-guide.md` / `.ja.md` のセクション 9 を、Agent `intent_tags` 優先・SLM は省略時フォールバックに整合させて更新（レビュー指摘）。
- ベース DAG のみの README 例は `intent_tags: []` を明示（`--slm` 有効時も一貫）。
- `deployAdapters` 経由で生成される 3 ファイルにワークフローが含まれることを統合テストで検証。

## 完了メモ

CriticalReview 2 ラウンド目でブロッキングなし。`npm test` 530 tests 通過。
