---
id: "016-02"
title: "deterministic anchor materializer を実装"
status: "done"
adr: "ADR-016"
phase: 7
priority: "P1"
depends_on: ["016-01"]
created: "2026-05-11"
closed: "2026-05-21"
closed_reason: "implemented"
---

## 概要

single-source / single-anchor の compile unit を、
repo 上の source artifact から決定的に再 materialize する helper を実装する。
これは `anchor-sync` の土台になる。

## 受け入れ条件

- [ ] `src/core/source-materialization.ts`（名前は同等なら可）に materializer が実装されること
- [ ] materializer は single-source / single-anchor のみをサポートすること
- [ ] `section` anchor は exact `## Heading` 形式をサポートし、`splitMarkdownSections()` と整合すること
- [ ] `lines` anchor は `start-end` の 1-based inclusive 形式をサポートすること
- [ ] unsupported anchor shape や複数 anchor は structured failure を返し、例外で落とさないこと
- [ ] テスト追加

## 設計詳細

### 新規 helper の想定 API

```typescript
type AnchorMaterializationFailureKind =
  | 'unsupported_shape'
  | 'missing_anchor'
  | 'invalid_range'
  | 'unreadable_source';

type AnchorMaterializationResult =
  | {
      ok: true;
      content: string;
      content_hash: string;
      materialization_kind: 'markdown-section' | 'line-range';
    }
  | {
      ok: false;
      kind: AnchorMaterializationFailureKind;
      detail: string;
    };
```

```typescript
function materializeAnchoredContent(params: {
  projectRoot: string;
  source_path: string;
  source_ref: SourceRef;
}): AnchorMaterializationResult
```

### サポート範囲

- `section`
  - `anchor_value` は exact heading line のみ
  - Phase 1 で deterministic path としてサポートするのは `## Heading`
  - `splitMarkdownSections()` と同じく、返すのは heading 行ではなく body
- `lines`
  - `anchor_value` は `start-end`
  - `start`, `end` は正の整数
  - 1-based inclusive
  - `\r\n` は `\n` に正規化してから切り出す

### 明示的にやらないこと

- `# Heading`, `### Heading`, heading path、symbol 単位解決
- 複数 `source_ref` の結合 materialization
- multi-file 合成

これらは Phase 1 では `semantic-review` に寄せる。

## 実装対象

- 新規 `src/core/source-materialization.ts`
- `src/core/source-materialization.test.ts`
- 必要なら `src/core/optimization/import-plan.ts` から `splitMarkdownSections()` を共通利用しやすく小整理

## テスト観点

- `## Auth` が対応 section body を返すこと
- 見出しが存在しない場合 `missing_anchor` になること
- `1-3` が 1,2,3 行目を返すこと
- `3-1`, `0-2`, `abc` が `invalid_range` になること
- `# Title` や複数 anchor は `unsupported_shape` になること
- UTF-8 文字列でも hash が安定すること

