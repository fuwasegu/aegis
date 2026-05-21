---
id: "018-05"
title: "authoring DB から shared source を bootstrap export"
status: "done"
adr: "ADR-018"
phase: 9
priority: "P1"
depends_on: ["018-01", "018-03"]
created: "2026-05-19"
closed: "2026-05-21"
closed_reason: "implemented"
---

## 概要

既存の authoring DB を collaborative mode へ移行しやすくするため、
approved Canonical から `aegis-share/source/` を初期生成する bootstrap export を実装する。

## 受け入れ条件

- [ ] authoring DB から `aegis-share/source/` を生成できること
- [ ] documents が `<doc_id>.md` + frontmatter 形式で出力されること
- [ ] edges / layer rules / tag mappings が collaborative source format に変換されること
- [ ] 同じ DB state から 2 回出力すると deterministic な結果になること
- [ ] 生成後に `share-lint` が通ること
- [ ] 生成後に `share-format` 2 回目が no-op になること
- [ ] テスト追加

## 設計詳細

### 目的

- 新規 collaborative repo を立ち上げる初回導線
- 既存 ADR-017 bundle only 運用からの移行

### Phase 1 の割り切り

- DB -> source の一方向 bootstrap をまず作る
- source と DB の双方向同期は後続フェーズ

## 実装対象

- 新規 `src/core/project-share/source-export.ts`
- `src/main.ts`
- テスト (`src/core/project-share/source-export.test.ts`, `src/main-cli.test.ts` 相当)

## テスト観点

- bootstrap export 後に lint / format が通ること
- approved rows のみが出力されること
- tag mappings が compile parity を保つこと

