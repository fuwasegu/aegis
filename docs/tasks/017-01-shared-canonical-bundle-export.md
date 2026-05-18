---
id: "017-01"
title: "shared canonical bundle schema + share-export CLI"
status: "open"
adr: "ADR-017"
phase: 8
priority: "P0"
depends_on: []
created: "2026-05-14"
closed: ""
closed_reason: ""
---

## 概要

approved Canonical を repo で共有できるよう、
`aegis-share/manifest.json` + `aegis-share/canonical.json`
の deterministic bundle format を定義し、
それを書き出す `share-export` CLI を実装する。

## 受け入れ条件

- [ ] `share-export` CLI が追加されること
- [ ] 既定出力先が `aegis-share/` であること
- [ ] `manifest.json` と `canonical.json` が deterministic に出力されること
- [ ] bundle には approved `documents`, `edges`, `layer_rules`, current `snapshot_id`, `knowledge_version` が含まれること
- [ ] approved-resolvable な `tag_mappings` が export されること
- [ ] `observations`, `proposals`, `compile_log`, `adapter_meta` は export されないこと
- [ ] 同じ snapshot から 2 回 export すると byte-identical な出力になること
- [ ] テスト追加

## 設計詳細

### 出力ファイル

- `aegis-share/manifest.json`
- `aegis-share/canonical.json`

### `manifest.json` の最低限の契約

```typescript
interface SharedCanonicalManifestV1 {
  format_version: 1;
  bundle_file: 'canonical.json';
  snapshot_id: string;
  knowledge_version: number;
  bundle_sha256: string;
  includes_tag_mappings: boolean;
}
```

### `canonical.json` の最低限の契約

```typescript
interface SharedCanonicalBundleV1 {
  format_version: 1;
  snapshot_id: string;
  knowledge_version: number;
  documents: Document[];
  edges: Edge[];
  layer_rules: LayerRule[];
  tag_mappings: TagMapping[];
}
```

### deterministic rules

- JSON key 順固定
- 配列ソート固定
- `generated_at` のような非決定的フィールドを入れない
- 改行は `\n`

### advisory warning

Phase 1 では export 自体は pending proposal や drift backlog があっても可能でよい。
ただし CLI summary に advisory warning を返してもよい。

## 実装対象

- 新規 `src/core/project-share/types.ts`
- 新規 `src/core/project-share/export.ts`
- 必要なら `src/core/project-share/index.ts`
- `src/main.ts`
- テスト (`src/core/project-share/export.test.ts`, `src/main-cli.test.ts` 相当)

## テスト観点

- 同じ DB state から 2 回 export して完全一致すること
- `compile_log` や `observations` が増えても bundle 出力が変わらないこと
- deprecated / draft / proposed row が export されないこと
- approved doc に紐づかない tag mapping が export されないこと
- 未初期化 DB で human-readable error になること
