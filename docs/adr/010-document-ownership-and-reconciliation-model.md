# ADR-010: Document Ownership と Reconciliation モデル

**ステータス:** Accepted
**日付:** 2026-03-31

## 関連議題

- [Aegis 主導ドキュメント運用と Single Source of Truth](../議題_Aegis主導ドキュメント運用とSingle Source of Truth.md)
- [ADR-009: compile_context 出力サイズ制御](009-compile-context-output-size-control.md)

## コンテキスト

ADR-009 により `source_path` 付きドキュメントを `deferred` 配信できるようになった。
しかし `source_path` は現在 2 つの責務を暗黙的に担っている:

1. **Delivery routing**: `source_path` なし → mandatory inline、あり → defer 可能（allocator.ts）
2. **Reconciliation**: `sync_docs` の対象判定（`approved && source_path != null`）

さらに、Aegis がドキュメント運用においてどの役割を果たすのか（Index / SoT / Control Plane）が
明確に定義されていない。このままでは論理分割・要約・派生ドキュメントが進むほど、
以下の問題が深刻化する:

- 実ファイル更新後も DB content が古いまま残る（stale knowledge）
- `source_path` なし doc が増えるほど、provenance の追跡が困難になる
- ドキュメントの lifecycle（split / merge / deprecate）の管理モデルが不在

## 決定

### 1. Aegis の役割: Control Plane

Aegis は **Document Control Plane** として位置づける。

- **Content authority**: 常に Aegis DB。compile は DB の content を使う
- **Structure authority**: 常に Aegis DB（edges, layer_rules, tag_mappings）
- **Reconciliation candidate source**: `file-anchored` doc の repo ファイル。
  `sync_docs` が差分を検知した場合、`document_import` observation → `update_doc` proposal を
  生成する。canonical への反映には人間承認が必要（P-3）

repo ファイルは SoT でも自動 refresh source でもなく、
**P-3 のガバナンスを経由する proposal の入力源** である。

### 2. Ownership モデル

`documents` テーブルに `ownership` カラムを追加する。

```sql
ALTER TABLE documents ADD COLUMN ownership TEXT NOT NULL DEFAULT 'standalone'
    CHECK (ownership IN ('file-anchored', 'standalone', 'derived'));
```

| ownership | 意味 | refresh |
|---|---|---|
| `file-anchored` | DB content が正本。repo ファイルを reconciliation candidate source として追跡 | `sync_docs` 対象 |
| `standalone` | DB content のみ。外部ソースなし | `sync_docs` 対象外 |
| `derived` | 他 doc から生成（要約、分割片など）。将来用 | parent doc 変更時に stale 検知（将来） |

**`file-anchored` という名称の意図**: `file-backed` だと「ファイルが正本」と誤解されやすい。
実態は「DB content が正本だが、外部ファイルに anchored されている」である。

### 3. `source_path` と `ownership` の責務分離

```
source_path → delivery routing（read path の関心事）
ownership   → reconcile policy（write path の関心事）
```

- allocator は引き続き `source_path` の有無で inline / deferred を判定する
- `sync_docs` は `ownership = 'file-anchored'` を対象にする
- 将来「`standalone` doc に `source_path` を後から付与して materialize + anchor する」パスも自然に表現できる

### 4. Deprecated doc の再活性化ルール

現状の `_applyUpdateDoc` は `status` を問わず `approved` に戻す。
これは「間違えて deprecate した doc を update で蘇生する」ユースケースとして維持する。

将来 split / merge を実装する際、`doc_lineage` テーブルを導入する:

```sql
CREATE TABLE IF NOT EXISTS doc_lineage (
    parent_doc_id TEXT NOT NULL REFERENCES documents(doc_id),
    child_doc_id  TEXT NOT NULL REFERENCES documents(doc_id),
    operation     TEXT NOT NULL CHECK (operation IN ('split', 'merge', 'supersede')),
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (parent_doc_id, child_doc_id)
);
```

**ルール**: `doc_lineage` に parent として存在する doc への `update_doc` は拒否する。
後継 doc が存在するため、蘇生ではなく後継 doc を更新すべきである。

新 status（`superseded` 等）の追加は、lineage だけでは不十分と判明した場合に再検討する。

### 5. 実装不要の決定

以下は本 ADR 時点では実装しない:

- **アンカー先ファイル喪失時の扱い**: Phase 1 では `sync_docs` は対象 doc を `not_found` として
  報告するのみとし、proposal の自動生成は行わない。compile notices への警告表示は
  stale 可視化の一種として Phase 2 で再検討する
- **`stale_since`**: compile notices への stale 表示は Phase 2 送り
- **`source_ref`**（heading / range 単位の provenance）: 論理分割の実ユースケースが発生するまで待つ
- **`sync_docs` → `reconcile_knowledge` 改名**: `file-anchored` 以外の reconcile が実装されるまで待つ
- **`superseded` status**: `doc_lineage` 存在チェックで十分な間は追加しない

## 実装フェーズ

### Phase 1: Ownership（本 ADR のスコープ）

1. `documents` テーブルに `ownership` カラム追加（schema migration）
2. `Document` 型に `ownership` フィールド追加
3. `import_doc`: `file_path` あり → `file-anchored`、`content` のみ → `standalone`（自動判定）
4. `sync_docs`: `ownership = 'file-anchored'` で対象をフィルタし、source file が存在しない場合は `not_found` として報告する（behavioral change ほぼゼロ）
5. 既存データ migration: `source_path` あり → `file-anchored`、なし → `standalone`

### Phase 2: Split / Merge + Lineage（将来 ADR）

1. `doc_lineage` テーブル追加
2. `split_doc` / `merge_docs` proposal type 追加
3. `_applyUpdateDoc` に lineage 存在チェック追加
4. `stale_since` と compile notices への stale 表示（必要に応じて）

### Phase 3: Source Ref（将来 ADR）

1. `source_ref` テーブル追加（`source_path` は `source_ref` の sugar として維持）
2. Section-level reconciliation
3. `derived` ownership の refresh policy 実装

## 帰結

### 正の帰結

- ドキュメントの性質（file-anchored / standalone / derived）が明示的になる
- `source_path` の delivery 責務と ownership の reconcile 責務が分離される
- 将来の split / merge / 論理分割への拡張パスが明確になる
- Phase 1 は behavioral change がほぼゼロで、安全に導入できる

### 負の帰結

- schema migration が必要（ただし additive で破壊的変更なし）
- `ownership` の自動判定ロジックを `import_doc` に追加する必要がある
- 将来 Phase 2-3 への移行計画を維持する必要がある

### 維持される不変条件

- **P-1**: 決定性。ownership は compile の delivery routing に影響しない（source_path が担う）
- **P-3**: 人間承認。file-anchored doc の reconciliation も proposal 経由
- **INV-6**: agent surface から Canonical を直接変更しない
