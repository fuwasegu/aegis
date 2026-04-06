---
id: "011-02"
title: "aegis_get_known_tags ツール実装"
status: "done"
adr: "ADR-011"
phase: 2
priority: "P1"
depends_on: ["011-01"]
created: "2026-03-31"
closed: "2026-04-06"
closed_reason: ""
---

## 概要

Agent がタグカタログを取得しキャッシュするための `aegis_get_known_tags` ツールを実装する。

## 受け入れ条件

- [x] `AegisService.getKnownTags()` が実装されていること
- [x] 返却値: `{ tags: string[], knowledge_version: number, tag_catalog_hash: string }`
- [x] `tag_catalog_hash` が SHA-256 ベースで計算されていること
- [x] Agent surface / Admin surface 両方にツールが登録されていること
- [x] INV-6 違反がないこと（read-only）
- [x] テスト追加

## 完了メモ

実装は `src/mcp/services.ts`（`getKnownTags`）、`src/mcp/server.ts`（`aegis_get_known_tags`）、`Repository.getAllTags`、および `services.test.ts` に既存。本 PR はタスク完了クローズと README / AGENTS.md / CLAUDE.md / technical-guide のツール数表記をコード（agent 5 / admin 17）に整合。
