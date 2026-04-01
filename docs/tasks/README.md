# Aegis タスク管理

## タスクフォーマット

各タスクは個別の Markdown ファイルとして管理する。

### ファイル命名規約

```
{ADR番号}-{連番}-{短縮名}.md
例: 013-01-migration-framework.md
```

ADR に紐づかないタスクは `000-XX-name.md` を使用。

### Frontmatter

```yaml
---
id: "013-01"
title: "Schema Migration フレームワーク実装"
status: "open"          # open | in-progress | done | cancelled
adr: "ADR-013"
phase: 1
priority: "P0"          # P0 (blocker) | P1 (high) | P2 (medium) | P3 (low)
depends_on: []           # 依存タスク ID のリスト
created: "2026-03-31"
closed: ""               # 完了/キャンセル時に日付を記入
closed_reason: ""        # done の場合は空、cancelled の場合は理由
---
```

### 本文構造

```markdown
## 概要
1-3 行の要約

## 受け入れ条件
- [ ] 条件1
- [ ] 条件2

## 実装メモ
（任意。着手時に追記）

## 完了メモ
（任意。完了時に振り返り）
```

## ステータス遷移

```
open → in-progress → done
                   → cancelled (理由を closed_reason に記載)
```

## ロードマップ概要

```
Phase 0: ADR-008 整合 (ADR-015)
Phase 1: Schema Migration (ADR-013) → Audit Meta (ADR-012) → Ownership (ADR-010)
Phase 2: Intent Tagging (ADR-011) → Compile Diagnostics 公開 (ADR-012)
Phase 3: Maintenance CLI (ADR-014) → Edge Mutation Primitives (ADR-015)
Phase 4: Optimization 層 (ADR-015)
Phase 5: Import 革新 + Staleness (ADR-015)
Phase 6: マルチエージェント (ADR-015)
```

依存関係のクリティカルパス:
```
ADR-013 (migration) ──→ ADR-012 (audit_meta) ──→ ADR-012 (debug_info)
                    ──→ ADR-010 (ownership)       ↓
                                              ADR-015 (impact simulation)
ADR-011 (intent_tags) ──→ ADR-011 (adapters)
ADR-015 (doc_gap) ──→ ADR-015 (optimization/)
ADR-014 (maintenance) ──→ ADR-015 (co-change cache)
```
