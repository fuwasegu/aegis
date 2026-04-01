# ADR-013: Schema Migration フレームワーク

**ステータス:** Proposed
**日付:** 2026-03-31

## 関連議題

- [改善議論レポート](../aegis-improvement-discussion-2026-03-31.md) — セクション 2.3

## コンテキスト

現状のスキーマ変更は `migrateSourcePaths()` のようなアドホックな列存在チェック型で行われている。
ADR-009 で `audit_meta` 列追加が必要になり、ADR-010 で `ownership` 列追加、
ADR-011 以降でもスキーマ変更が予定されている。

問題:
- スキーマ変更が増えると監査不能になる
- 「どのバージョンのスキーマで動いているか」が分からない
- ロールバック不可能
- ad hoc な列存在チェックの延命は技術的負債を拡大する

## 決定

### 1. `schema_migrations` テーブルの導入

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

### 2. Migration ファイルの規約

```typescript
// src/core/store/migrations/
// 001_initial_schema.ts
// 002_add_audit_meta.ts
// 003_add_ownership.ts
// ...

interface Migration {
  version: number;
  name: string;
  up(db: Database): void;
}
```

- 各 migration は `up()` のみ（down は実装しない — SQLite の ALTER TABLE 制約上、実用的な down migration は困難）
- migration はトランザクション内で実行
- 冪等性: 適用済みの migration はスキップ

### 3. 実行タイミング

```typescript
function runMigrations(db: Database, migrations: Migration[]): void {
  const applied = getAppliedVersions(db);
  for (const m of migrations.filter(m => !applied.has(m.version))) {
    db.transaction(() => {
      m.up(db);
      recordMigration(db, m.version, m.name);
    });
  }
}
```

- `AegisDatabase` コンストラクタで `ensureSchema()` の後に `runMigrations()` を呼ぶ
- `ensureSchema()` は初期テーブル作成のみ担当（既存動作を維持）
- migration は追加的な変更のみ担当

### 4. 既存のアドホック migration の移行

`migrateSourcePaths()` は migration 001 として formalize する。
既存 DB では `schema_migrations` テーブルがないため、テーブル作成時に
「version 0 = 初期スキーマ」を暗黙的に適用済みとして記録する。

### 5. 初回 migration の内容

```
001_initial_baseline.ts  — schema_migrations テーブル作成 + 既存 migrateSourcePaths の formalize
002_add_audit_meta.ts    — compile_log に audit_meta TEXT 列追加 (ADR-012)
003_add_ownership.ts     — documents に ownership TEXT 列追加 (ADR-010)
```

## 帰結

### 正の帰結

- スキーマ変更が監査可能になる
- 「どのバージョンのスキーマで動いているか」が明確になる
- 今後の ADR で予定されるスキーマ変更（audit_meta, ownership, source_refs_json, doc_lineage 等）に安全な基盤を提供

### 負の帰結

- migration ファイルの管理コストが発生
- down migration 非対応（SQLite 制約。破壊的変更が必要な場合は新テーブル作成 + データ移行パターン）

### 維持される不変条件

- **P-1**: migration はスキーマのみ変更、ルーティングロジックに影響しない
- **P-3**: migration は Canonical Knowledge のデータを変更しない（スキーマのみ）
