---
id: "011-04"
title: "Adapter 更新 (intent_tags ワークフロー組み込み)"
status: "open"
adr: "ADR-011"
phase: 3
priority: "P2"
depends_on: ["011-01", "011-02"]
created: "2026-03-31"
closed: ""
closed_reason: ""
---

## 概要

CLAUDE.md, .cursor/rules/, AGENTS.md の Adapter テンプレートに intent_tags ワークフローを組み込む。Agent がセッション開始時に `aegis_get_known_tags` を呼び、compile_context に `intent_tags` を渡すフローを誘導する。

## 受け入れ条件

- [ ] `AdapterConfig.toolNames` に `getKnownTags` が追加されていること
- [ ] CLAUDE.md adapter テンプレートに intent_tags ワークフローが記述されていること
- [ ] .cursor/rules/ adapter テンプレートが更新されていること
- [ ] AGENTS.md adapter テンプレートが更新されていること
- [ ] README.md / README.ja.md のツール数が更新されていること
- [ ] ADR-004 が改訂されていること（SLM → fallback）
