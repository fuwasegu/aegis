---
id: "011-01"
title: "CompileRequest に intent_tags を追加し expanded ロジックを拡張"
status: "open"
adr: "ADR-011"
phase: 2
priority: "P1"
depends_on: []
created: "2026-03-31"
closed: ""
closed_reason: ""
---

## 概要

`CompileRequest` に `intent_tags?: string[]` を追加し、`ContextCompiler` の expanded context ロジックで Agent 提供タグ > SLM fallback の優先順位を実装する。

## 受け入れ条件

- [ ] `CompileRequest.intent_tags` が `types.ts` に追加されていること
- [ ] `intent_tags` 提供時に SLM tagger が呼ばれないこと
- [ ] `intent_tags: []` で expanded context が明示的にオプトアウトされること
- [ ] `intent_tags: undefined` で既存の SLM fallback が機能すること（後方互換）
- [ ] 正規化: dedupe, sort, trim, 空文字除外
- [ ] unknown tags が warning 付きで除外されること
- [ ] `compile_log.request` に raw `intent_tags` が記録されること
- [ ] テスト追加（優先順位、opt-out、正規化、unknown tags）
