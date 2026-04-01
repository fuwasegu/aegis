---
id: "011-02"
title: "aegis_get_known_tags ツール実装"
status: "open"
adr: "ADR-011"
phase: 2
priority: "P1"
depends_on: ["011-01"]
created: "2026-03-31"
closed: ""
closed_reason: ""
---

## 概要

Agent がタグカタログを取得しキャッシュするための `aegis_get_known_tags` ツールを実装する。

## 受け入れ条件

- [ ] `AegisService.getKnownTags()` が実装されていること
- [ ] 返却値: `{ tags: string[], knowledge_version: number, tag_catalog_hash: string }`
- [ ] `tag_catalog_hash` が SHA-256 ベースで計算されていること
- [ ] Agent surface / Admin surface 両方にツールが登録されていること
- [ ] INV-6 違反がないこと（read-only）
- [ ] テスト追加
