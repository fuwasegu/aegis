---
id: "017-03"
title: "project-shared status / doctor / notices を追加"
status: "open"
adr: "ADR-017"
phase: 8
priority: "P1"
depends_on: ["017-01", "017-02"]
created: "2026-05-14"
closed: ""
closed_reason: ""
---

## 概要

repo 上の shared bundle と local DB の current snapshot を比較し、
`doctor`, `stats`, `compile_context.notices` で
project-share status を surfacing する。

## 受け入れ条件

- [ ] project-share status 導出 helper が実装されること
- [ ] `doctor` に share state が表示されること
- [ ] `stats` JSON に share state が含まれること
- [ ] `compile_context.notices` に `bundle_newer` / `local_ahead` / `diverged` が出せること
- [ ] `not_configured` ではノイズを出しすぎないこと
- [ ] malformed manifest / missing bundle を `unreadable_bundle` として surfacing できること
- [ ] テスト追加

## 設計詳細

### 想定 state

```typescript
type ProjectShareState =
  | 'not_configured'
  | 'in_sync'
  | 'bundle_newer'
  | 'local_ahead'
  | 'diverged'
  | 'unreadable_bundle';
```

### 導出ロジックの基本

- `aegis-share/manifest.json` が無い -> `not_configured`
- manifest / bundle が読めない -> `unreadable_bundle`
- local current `snapshot_id === manifest.snapshot_id` -> `in_sync`
- local `knowledge_version < manifest.knowledge_version` -> `bundle_newer`
- local `knowledge_version > manifest.knowledge_version` -> `local_ahead`
- それ以外の snapshot mismatch -> `diverged`

### surfacing 方針

- `doctor`
  - human-readable summary
- `stats`
  - JSON field として返す
- `compile_context.notices`
  - P-1 を崩さないため notice のみ
  - `bundle_newer`: `share-hydrate` を勧める
  - `local_ahead`: `share-export` を勧める
  - `diverged`: hydrate/export どちらかの明示判断を促す

## 実装対象

- 新規 `src/core/project-share/status.ts`
- `src/main.ts`
- `src/mcp/services.ts`
- テスト (`src/core/project-share/status.test.ts`, `src/mcp/services.test.ts`, `src/main-cli.test.ts` 相当)

## テスト観点

- manifest 不在で `not_configured` になること
- 同一 snapshot で `in_sync` になること
- manifest の方が新しく `bundle_newer` になること
- local の方が新しく `local_ahead` になること
- snapshot mismatch で `diverged` になること
- JSON parse error や missing file が `unreadable_bundle` として扱われること
