# ADR-016: Source Artifact と Compile Unit の分離、および Drift Reconciliation モデル

**ステータス:** Proposed
**日付:** 2026-05-11

## 関連議題

- [ADR-009: compile_context 出力サイズ制御](009-compile-context-output-size-control.md)
- [ADR-010: Document Ownership と Reconciliation モデル](010-document-ownership-and-reconciliation-model.md)
- [ADR-014: maintenance CLI と feedback automation](014-maintenance-cli-and-feedback-automation.md)
- [ADR-015: Knowledge Optimization アーキテクチャ](015-knowledge-optimization-architecture.md)

---

## コンテキスト

Aegis は既に `aegis_analyze_doc` / `aegis_analyze_import_batch` / `aegis_execute_import_plan`、
`source_refs_json`、`sync_docs`、Level 1-3 の staleness 検知を持っている。
しかし、次の 2 つを一つのモデルとして明文化できていない。

1. **取り込み時の粒度最適化**
   - 既存ドキュメントをそのまま 1 doc として入れると、関心事が混在し、
     `compile_context` が不要に大きい delivery unit を返しやすい
   - `content_mode='auto'` では `source_path` 付き大きめ doc は deferred になるため、
     エージェントは Read を繰り返すことになり、UX が落ちる
   - Aegis にとって重要なのは「原本を保管すること」ではなく、
     **compile に効く粒度へ materialize すること** である

2. **Aegis を経由しない更新への対応**
   - 他の人が repo 上の doc を更新し、`git pull` で変更が入ることは自然に発生する
   - 現行の `sync_docs` は single-file hash sync には強いが、
     section slice や multi-source unit をどう reconcile するかの上位方針が曖昧である
   - Canonical の content authority は Aegis DB にあるため、
     repo 側の変更をそのまま自動反映することは P-3 と矛盾する

ADR-015 は optimization 層と import-plan の方向性を定義したが、
「source artifact から compile unit を作る」という materialization モデルと、
「その unit が外部更新とどう向き合うか」という drift reconciliation モデルは
別 ADR として明確化する価値がある。

---

## 決定

### D-1: Source Artifact と Compile Unit を明示的に分離する

今後の用語を以下で固定する。

- **source artifact**
  - repo 上のファイル、または import 時に与えられた content blob
  - 原本または原本候補
  - `compile_context` は直接返さない
- **compile unit**
  - Canonical Knowledge に保存され、`compile_context` が返す最小 delivery 単位
  - 一つの routing 意図と一つの説明責務に寄せる
  - source artifact から 1:N または N:1 で materialize されうる

`documents` テーブルに保存されるものは、原則として **source artifact そのものではなく compile unit** である。

### D-2: 標準取り込み経路は `analyze -> execute_import_plan -> approve` とする

既存ドキュメントの標準取り込みは以下とする。

1. `aegis_analyze_doc` / `aegis_analyze_import_batch`
2. ImportPlan 上で unit / edge_hints / tags / provenance を確認
3. `aegis_execute_import_plan`
4. proposal bundle を review / approve

`aegis_import_doc` は残してよいが、これは **既に compile unit として整形済みの内容を投入する escape hatch** と位置づける。
repo 全体の onboarding で raw file をそのまま `import_doc` でループ投入することは、
推奨フローとみなさない。

### D-3: ReconcileMode は provenance から導出し、DB 列として保存しない

drift への対処方針は `ownership`, `source_path`, `source_refs_json` から **決定的に導出** する。
新しい永続カラムは導入しない。

```typescript
type ReconcileMode =
  | 'untracked'
  | 'hash-sync'
  | 'anchor-sync'
  | 'semantic-review';
```

導出規則:

- `untracked`
  - `ownership !== 'file-anchored'`
  - または provenance が空で、外部 source と reconcile しない unit
- `hash-sync`
  - distinct source asset が 1
  - whole-file hash sync が可能
  - 現行の `primaryAssetPathForHashSync()` と同じ条件を使う
- `anchor-sync`
  - distinct source asset が 1
  - whole-file hash sync ではない
  - **supported slice anchor が 1 個だけ** あり、決定的に再 materialize できる
- `semantic-review`
  - 上記以外の tracked unit
  - multi-source、unsupported anchor shape、複数 slice 合成、要約・統合 unit など

この ADR の Phase 1 では `anchor-sync` の対象を intentionally narrow にする。
多 ref 合成や複数 section の再構成は `semantic-review` に寄せる。

### D-4: ImportPlan は compile unit の materialization 情報と診断を返す

ImportPlan の `suggested_units[]` は `doc_id`, `title`, `content_slice` だけでなく、
次の advisory 情報を返すべきである。

```typescript
type MaterializationKind =
  | 'whole-file'
  | 'markdown-section'
  | 'line-range'
  | 'composed';

type ImportUnitDiagnosticCode =
  | 'oversize_unit'
  | 'weak_routing_signal'
  | 'semantic_review_only';
```

各 suggested unit に含めるべき情報:

- `content_bytes`
- `materialization_kind`
- `reconcile_mode`
- `diagnostics[]`

診断コードの Phase 1 定義:

- `oversize_unit`
  - `content_bytes > 4096`
  - ADR-009 の auto inline 閾値と揃える
- `weak_routing_signal`
  - `edge_hints.length === 0` かつ `tags.length === 0`
- `semantic_review_only`
  - 導出された `reconcile_mode === 'semantic-review'`

これらは advisory であり、`execute_import_plan` の blocking validation には使わない。
ただし、エージェントや人間に「この unit はそのまま入れると後で困る」ことを明示する。

### D-5: `sync_docs` と `maintenance` は ReconcileMode ごとに分岐する

#### `hash-sync`

現行方針を維持する。

- source file 全文を読む
- `content_hash` 比較
- 差分があれば `document_import` observation -> `update_doc` proposal
- 自動 approve はしない

#### `anchor-sync`

新設する deterministic path。

- source file を読む
- anchor から compile unit の期待 content を再 materialize する
- 現在の Canonical content と比較する
- 差分があれば `document_import` observation -> `update_doc` proposal

Phase 1 でサポートする anchor は以下のみ:

- `section`
  - exact heading line 形式の `## Heading`
  - 現行 `splitMarkdownSections()` の `## ` 分割と整合すること
- `lines`
  - `start-end` 形式
  - 1-based inclusive

materialize に失敗した場合:

- proposal は作らない
- `staleness_detected` を記録する
- `kind` は `anchor_missing` または `anchor_unsupported` を使う

#### `semantic-review`

自動 content 更新をしない。

- drift は `staleness_detected` で可視化する
- `compile_context` / `workspace_status` / `maintenance` で backlog として見せる
- review 後の修正は `manual_note`, `document_import`, あるいは将来の split/merge proposal に委ねる

### D-6: `git pull` など Aegis を経由しない更新は first-class な入力として扱う

repo 上の source artifact が Aegis の外から更新されることは正常系とみなす。

ただし、取り扱いは以下で固定する。

- repo file は **reconciliation candidate source** であり、Canonical の SoT ではない
- `git pull` 後に `maintenance` / `sync_docs` を走らせて drift を検知する
- 変更が見つかっても Canonical へ直書きしない
- すべて observation / proposal / approval を通す

### D-7: drift backlog は compile path と admin path の両方で見えるようにする

drift は「maintenance の時だけ見る裏側の情報」ではなく、
知識の健全性そのものなので、複数の面で surfacing する。

- `compile_context.notices`
  - stale な tracked unit を notices で伝える
  - P-1 の対象は `warnings` なので、時刻依存情報は notices に載せる
- `workspace_status`
  - reconcile mode ごとの backlog 数を返す
- `maintenance`
  - `hash-sync`, `anchor-sync`, `semantic-review` ごとの件数・対象 doc を返す

### D-8: Phase 1 では source asset 専用テーブルを作らない

`source_assets` のような新テーブルは導入しない。

理由:

- 現在の必要は queryable source registry ではなく、materialization / reconcile policy の明文化である
- provenance 自体は `source_path` と `source_refs_json` で十分に表現できる
- 先に専用テーブルを入れると schema と migration の複雑さだけが先行する

将来、source artifact 単位での dedupe、versioning、batch diff 参照が必要になった段階で再検討する。

---

## 却下した代替案

### A-1: raw doc をそのまま Canonical の基本単位とする

却下。
compile 向け粒度と原本粒度は一致しない。
そのまま取り込むと context budget と routing 精度が悪化する。

### A-2: repo file を SoT とし、`git pull` 後に Canonical を自動上書きする

却下。
P-3 に反する。
また、誤更新や一時的な混乱をそのまま compile path に流し込むことになる。

### A-3: ReconcileMode を DB 列で保存する

却下。
`ownership` / `source_path` / `source_refs_json` から導出可能であり、
列を追加すると migration と整合性維持コストだけが増える。

### A-4: section / lines / multi-source をすべて `sync_docs` の自動更新対象にする

却下。
Phase 1 の deterministic boundary が曖昧になる。
まずは single-source / single-anchor の narrow path を固める。

---

## 影響

### 実装フェーズ

1. ImportPlan に compile unit advisory 情報を追加する
2. single-source / single-anchor の deterministic materializer を実装する
3. `sync_docs` を reconcile-mode-aware に拡張する
4. drift backlog を `compile_context`, `workspace_status`, `maintenance`, `import_doc` に surfacing する

### 正の帰結

- 原本と compile unit の責務が分かれる
- `git pull` 後の更新を deterministic に triage できる
- raw import による context 膨張を減らしやすくなる
- section slice と multi-source を同じ `file-anchored` で雑に扱わずに済む

### 負の帰結

- `sync_docs` の分岐とレポートが複雑になる
- `anchor-sync` の対象を narrow にするため、当面は semantic-review に逃げるケースが残る
- import-plan のレスポンス項目が増える

### 維持される不変条件

- **P-1**: compile の決定性。reconcile mode は write / maintenance path の関心事であり、
  compile routing 自体は既存の path/layer/command/doc DAG を維持する
- **P-3**: 外部 source の変更も人間承認を経由して Canonical に入る
- **INV-6**: drift handling を含む mutation path は admin surface に留める

