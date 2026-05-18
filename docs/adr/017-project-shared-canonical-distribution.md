# ADR-017: Project-Shared Canonical Bundle と Replica Hydration

**ステータス:** Proposed
**日付:** 2026-05-14

## 関連議題

- [ADR-007: Adapter 配布は MCP ツールではなく CLI / setup flow で行う](007-adapter-deployment-via-cli-not-mcp-tool.md)
- [ADR-010: Document Ownership と Reconciliation モデル](010-document-ownership-and-reconciliation-model.md)
- [ADR-014: maintenance CLI と feedback automation](014-maintenance-cli-and-feedback-automation.md)
- [ADR-016: Source Artifact と Compile Unit の分離、および Drift Reconciliation モデル](016-source-artifact-compile-unit-and-drift-reconciliation.md)
- [Aegis 主導ドキュメント運用と Single Source of Truth](<../議題_Aegis主導ドキュメント運用とSingle Source of Truth.md>)

---

## コンテキスト

Aegis の DB は既定で project-local な `.aegis/aegis.db` に置かれ、
`.aegis/` 自体も Git 管理対象外として扱われる。
この前提は「作業中の live DB は workspace ローカルな operational state を含む」という
現実に合っている。

一方で、チームや複数 clone の観点では別の要請がある。

1. **approved Canonical を clone 間で揃えたい**
   - 同じ repo を pull した別 clone でも、
     `compile_context` の土台になる knowledge をなるべく一致させたい
   - 特に onboarding / CI / read-only agent 利用では、
     repo に同梱された「承認済み知識の最新版」を簡単に使いたい

2. **live SQLite を Git 管理したくない**
   - DB には `documents` / `edges` / `layer_rules` のような Canonical だけでなく、
     `observations`, `proposals`, `compile_log`, `adapter_meta` のような
     clone ごとにズレて当然の operational state が同居している
   - 現在の DB 実装は file lock + full-file persist であり、
     Git diff / merge の第一級データとしては扱いづらい

3. **ADR-016 は clone convergence までは解かない**
   - ADR-016 は repo 上の source artifact と authoring DB の間の
     drift reconciliation を整理する ADR である
   - しかし「承認済み Canonical を別 clone にどう配るか」は別の責務である
   - `git pull -> sync_docs` は authoring DB の更新検知には有効だが、
     clone 全体の Canonical 収束モデルにはならない

したがって必要なのは、
`live DB` をそのまま配ることではなく、
**approved Canonical だけを deterministic な artifact として repo に同梱し、
各 clone がそれを local replica DB に hydrate できる仕組み** である。

---

## 決定

### D-1: 3 つの面を区別する

project sharing に関わる実体を次の 3 つに分ける。

- **authoring DB**
  - 人間が admin surface / maintenance / approval を行う通常の Aegis DB
  - repo 上の source artifact と reconcile し、Canonical を前進させる唯一の場所
- **shared canonical bundle**
  - repo に commit される deterministic な配布 artifact
  - 1 つの approved snapshot を表す
- **hydrated replica DB**
  - shared bundle から local に再生成される DB
  - compile / read / local experimentation 用の replica
  - re-hydrate 時に置き換えられうる disposable な作業物

### D-2: shared canonical bundle は runtime SoT ではなく distribution artifact である

SQLite は引き続き runtime 上の唯一の永続 state であり、
`compile_context` は DB からのみ知識を読む。

shared bundle は:

- repo で review / distribute するための artifact
- hydration の入力
- status 比較の対象

であり、read path が直接参照する SoT ではない。

これにより、
「Aegis は SQLite を runtime source of truth とする」
という現行原則を崩さずに、
project-shared distribution を導入できる。

### D-3: repo 上の共有配置は `aegis-share/` を既定とする

shared bundle の既定配置は repo root 配下の `aegis-share/` とする。

Phase 1 の既定ファイル:

- `aegis-share/manifest.json`
- `aegis-share/canonical.json`

`.aegis/` は引き続き local runtime 用の隠しディレクトリとし、
shared artifact は置かない。

理由:

- `.aegis/` の `.gitignore` 方針と衝突しない
- local runtime state と committed artifact の責務が混ざらない
- human review 時に存在が見えやすい

### D-4: bundle format は deterministic にする

同じ approved snapshot から export した bundle は、
常に byte-identical でなければならない。

そのため:

- `manifest.json` と `canonical.json` に `generated_at` のような時刻を入れない
- JSON key 順は固定する
- 配列順は primary key ベースで安定化する
  - `documents`: `doc_id ASC`
  - `edges`: `edge_id ASC`
  - `layer_rules`: `rule_id ASC`
  - `tag_mappings`: `tag ASC`, `doc_id ASC`
- 改行は `\n` に固定する

`manifest.json` の想定:

```json
{
  "format_version": 1,
  "bundle_file": "canonical.json",
  "snapshot_id": "2e59...",
  "knowledge_version": 30,
  "bundle_sha256": "abc123...",
  "includes_tag_mappings": true
}
```

`canonical.json` の想定:

```json
{
  "format_version": 1,
  "snapshot_id": "2e59...",
  "knowledge_version": 30,
  "documents": [],
  "edges": [],
  "layer_rules": [],
  "tag_mappings": []
}
```

### D-5: bundle には approved Canonical と compile parity に必要な補助情報だけを含める

Phase 1 の export 対象:

- approved `documents`
- approved `edges`
- approved `layer_rules`
- `snapshot_id`
- `knowledge_version`
- approved-resolvable な `tag_mappings`

Phase 1 で **含めない** もの:

- `observations`
- `proposals`
- `proposal_evidence`
- `compile_log`
- `adapter_meta`
- `init_manifest`

`tag_mappings` は Canonical DAG の外にある operational metadata だが、
shared clone 間で `expanded` の挙動差を減らすため、
bundle の adjunct section として同梱してよい。

### D-6: hash は bundle 入力として trust せず、hydrate 時に再検証する

bundle には `content_hash` や `bundle_sha256` を載せてよいが、
hydrate 側はそれを盲信しない。

- `bundle_sha256` は file integrity のために再計算して照合する
- 各 document の `content_hash` も `content` から再計算し、
  不一致なら hydrate を reject する

これにより、
「content hash は server-computed」
という既存原則を bundle 経路でも維持する。

### D-7: export / hydrate は MCP tool ではなく CLI とする

shared bundle の export / hydrate は low-frequency かつ
workspace / Git artifact を扱うローカル保守操作なので、
MCP tool surface には追加しない。

Phase 1 の想定 CLI:

- `aegis share-export`
- `aegis share-hydrate`

status surfacing は次に委ねる:

- `aegis doctor`
- `aegis stats`
- `compile_context.notices`

理由:

- low-frequency な workspace 操作を常設 MCP tool に載せたくない
- file I/O と Git review artifact の責務は CLI の方が自然
- ADR-007 の「対話ループ必須性で CLI/MCP を分ける」方針に一致する

### D-8: Phase 1 の hydrate は in-place merge ではなく whole-DB replica replacement とする

Phase 1 の `share-hydrate` は、
既存 DB の Canonical 部分だけを差し替える方式を採らない。

代わりに:

1. bundle から temp DB を新規構築する
2. schema / migrations を適用する
3. Canonical + `tag_mappings` + current snapshot を投入する
4. target DB と atomic swap する

この判断の理由:

- `knowledge_version` は単調増加であり、既存 DB とのマージは history semantics が難しい
- `compile_log` は `snapshots` に FK を持ち、Canonical だけの洗い替えでは整合性を崩しやすい
- `observations` / `proposals` / `compile_log` を保持しつつ current snapshot だけ巻き戻す・進めるのは
  guardrail と conflict policy が重い

したがって Phase 1 の hydrate は
**replica DB を丸ごと再生成する** 操作と定義する。

### D-9: `share-hydrate` は破壊的であることを前提に guardrail を置く

Phase 1 の `share-hydrate` は local DB を置き換えうるため、
次の guardrail を置く。

- target DB が未初期化ならそのまま hydrate してよい
- target DB が初期化済みなら `--replace` を明示要求する
- current snapshot が bundle と異なる場合は warning を強く出す
- local operational state は preserve されないことを明示する

つまり `share-hydrate` は
「安全な merge」ではなく
「人間が明示的に走らせる replica rebuild」である。

### D-10: authoring workflow と replica workflow を分ける

Phase 1 の標準運用は次とする。

**authoring workflow**

1. repo docs を更新
2. `maintenance` / `sync_docs` / approval を通して authoring DB を前進
3. `share-export` で approved snapshot を `aegis-share/` へ書き出す
4. Git commit / push

**replica workflow**

1. `git pull`
2. `share-hydrate --replace`
3. compile / read / local experimentation

replica DB 上で local `observations` を積むこと自体は許容してよいが、
re-hydrate 時に失われうる disposable state とみなす。

### D-11: share status は DB に保存せず、bundle と current snapshot から導出する

Phase 1 では新しい `project_share_meta` テーブルを作らない。

status は:

- repo 上の `aegis-share/manifest.json`
- local DB の current `snapshot_id`
- local DB の `knowledge_version`

から導出する。

想定状態:

```typescript
type ProjectShareState =
  | 'not_configured'
  | 'in_sync'
  | 'bundle_newer'
  | 'local_ahead'
  | 'diverged'
  | 'unreadable_bundle';
```

surfacing 先:

- `doctor`
- `stats`
- `compile_context.notices`

`notices` は P-1 の対象外なので、
時点依存の share status を載せてよい。

### D-12: ADR-016 と ADR-017 の境界を明確にする

ADR-016 が扱うのは:

- repo 上の source artifact
- authoring DB 内の compile unit
- drift detection / reconcile mode / proposal 化

ADR-017 が扱うのは:

- authoring DB で既に approved になった current snapshot
- repo に commit される shared bundle
- 別 clone の replica DB への hydration

要するに:

- **ADR-016**: `repo docs -> authoring DB`
- **ADR-017**: `authoring DB -> shared bundle -> replica DB`

である。

### D-13: delta bundle / in-place sync は Phase 2 へ送る

将来、
`pull` ごとの差分適用や local operational state preserving import が必要になる可能性はある。
しかし Phase 1 では扱わない。

後続フェーズで検討するもの:

- `from_snapshot_id -> to_snapshot_id` の delta bundle
- operational state preserving な in-place Canonical sync
- branch-aware / multi-bundle workflow

---

## 却下した代替案

### A-1: `.aegis/aegis.db` をそのまま Git 管理する

却下。
operational state まで混ざる上に、file-level diff / merge に向かない。

### A-2: shared bundle を runtime SoT にして compile が直接読む

却下。
SQLite read path を二重化し、既存の Repository / snapshot / audit モデルを崩す。

### A-3: `share-export` / `share-hydrate` を admin MCP tool として常設する

却下。
workspace / file / Git artifact 系の低頻度操作であり、
ADR-007 の CLI 判断基準に反する。

### A-4: Canonical だけを既存 DB に in-place import し、operational table は常に温存する

Phase 1 では却下。
FK、`knowledge_version`、divergence policy の扱いが重い。

---

## 実装フェーズ

### Phase 1: Shared bundle baseline

1. deterministic bundle schema を定義する
2. `share-export` CLI を追加する
3. `share-hydrate` CLI を追加する
4. `doctor` / `stats` / `compile_context.notices` に share status を surfacing する
5. README / setup flow に authoring / replica workflow を追加する

### Phase 2: Advanced synchronization

6. delta bundle の設計・実装
7. operational state preserving import の検討
8. branch-aware / multi-bundle workflow の検討

---

## 帰結

### 正の帰結

- approved Canonical を Git review 可能な artifact として配布できる
- live SQLite を Git に載せずに clone 間の compile parity を上げられる
- ADR-016 の drift reconciliation と責務分離できる
- CLI 化により MCP tool surface を膨らませずに済む

### 負の帰結

- Phase 1 の hydrate は destructive であり、local operational state を保持しない
- authoring workspace と replica workspace の役割分離を運用で理解する必要がある
- `aegis-share/` の commit 忘れ・hydrate 忘れという新しい手順ミスが生まれる

### 補足

Phase 1 は「merge を賢くやる」より
「shared snapshot を deterministic に配り、replica を安全に作り直せる」
ことを優先する。
高度な差分同期は、その基準線が運用に乗ってから拡張する。
