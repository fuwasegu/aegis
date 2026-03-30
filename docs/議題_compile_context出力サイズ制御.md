# 議題: compile_context 出力サイズ制御

**起票日**: 2026-03-27
**ステータス**: 未着手

---

> **重要: この議題はゼロベースで議論すること。**
>
> 現在の compile_context は解決された全ドキュメントの content を
> 無制限にインラインで返す設計になっている。
> 「どうサイズを減らすか」だけでなく、「そもそもコンテキストの
> 配信形態はどうあるべきか」をゼロから考えてほしい。

---

## 解決すべき問題

`aegis_compile_context` の MCP ツールレスポンスが、MCP クライアント（Claude Code 等）の
トークン上限を超えるケースが発生した。実測値: **186,770 文字**。

クライアントはレスポンスをファイルに退避するが、エージェントはそのファイルを
逐次読み込む必要があり、ワークフローが大幅に劣化する。
Aegis の「呼べば必要なコンテキストが返る」という体験が破綻している。

## 前提条件

- Aegis は MCP サーバーとして動作する。呼び出し元は AI エージェント（Claude, Cursor, Codex 等）
- MCP クライアントごとにトークン上限が異なる。クライアントが上限を通知する仕組み（MCP の capability negotiation 等）は現時点では存在しない
- compile_context の結果は `CompiledContext` 型で、`base.documents`、`base.templates`、`expanded.documents` がサイズの主要因
- `ResolvedDoc` は `{doc_id, title, kind, content, relevance?}` — **content が全文インライン**
- DB の `documents` テーブルには `source_path` カラムがあるが、`ResolvedDoc` には含まれていない
- `source_path` は `import_doc` で `file_path` を指定した場合や `sync_docs` 用に保存される。全ドキュメントにあるとは限らない
- P-1 原則: 同じ入力 + 同じ knowledge_version = 同じ出力（決定論性の保証）

## 現状の設計

### compile_context のデータフロー

```
target_files
    │
    ▼
4-step DAG routing (path → layer → command → doc_depends_on 推移閉包)
    │
    ├── base.documents: ResolvedDoc[] (content 全文インライン)
    ├── base.templates: {name, content}[] (テンプレート全文インライン)
    ├── base.resolution_path: ResolvedEdge[]
    │
    ▼
Expanded context (plan + IntentTagger → tag_mappings)
    │
    ├── expanded.documents: ResolvedDoc[] (content 全文インライン)
    └── expanded.confidence / reasoning / resolution_path
```

### サイズが膨れる構造的要因

- **ドキュメント本文のインライン**: 1 doc が 5,000 文字 × 30 docs = 150,000 文字
- **テンプレートのインライン**: scaffold 用のコード雛形は特に大きい
- **expanded context**: base とは別にドキュメントが追加される
- **doc_depends_on の推移閉包**: 依存の連鎖で芋づる式に膨らむ
- **広い glob パターン**: `**/*` のような edge があると大量のドキュメントがヒットする

## 議論してほしいこと

### 1. コンテキスト配信の形態

content を全文インラインで返す現状の設計を維持すべきか、別の配信形態に移行すべきか。

**選択肢**:

- **A. 全文インライン維持（現状）**: サイズ制御は別の手段で行う
- **B. source_path があるドキュメントはパスだけ返す**: エージェントが必要な doc だけ Read する lazy loading 方式
- **C. 全ドキュメントでパス返し**: content を一切インラインで返さず、全てパス参照にする（`source_path` がない doc はどうする？）
- **D. 要約 + パス**: content の代わりに要約（先頭 N 行 or SLM 要約）を返し、全文が必要ならパスを Read

**論点**:

- `source_path` がない doc（テンプレート bootstrap 由来、content 直接指定の import）はどう扱うか
- エージェントが Read した時点の内容と Aegis が管理している `content_hash` が不一致になりうる問題（`sync_docs` 前に編集されたファイル）
- パス返しの場合、エージェントのツール呼び出し回数が増え、レイテンシとコストが上がる
- MCP サーバーがファイルを返す仕組み（MCP resources 等）を使うべきか

### 2. P-1（決定論性）への影響

compile_context の出力を変えることで、P-1 原則にどう影響するか。

- **全文インライン**: 出力そのものが決定論的。エージェントが受け取る情報も同一
- **パス返し**: compile 結果自体は決定論的だが、エージェントがファイルを読むタイミングで内容が変わりうる
- **truncation**: 同じ入力 + 同じ knowledge_version なら同じ truncation 結果 → P-1 は維持

P-1 は「compile の出力が決定論的」であることを保証するものであり、
「エージェントが最終的に読む内容」までは scope 外とも解釈できるが、
これは意図した解釈か？

### 3. サイズ制御の主体

誰がサイズを制御するか。

- **Aegis 側**: 閾値（`max_chars` 等）を持ち、超えたらトランケーション
- **呼び出し側**: compile_context の入力パラメータで制御（`max_chars`, `max_documents`, `include_content` 等）
- **知識ベース設計側**: edge や document の設計で膨張を防ぐ（運用で解決）
- **組み合わせ**: Aegis がデフォルト上限を持ち、呼び出し側がオーバーライド可能

MCP クライアントごとにトークン上限が違う前提で、
「安全なデフォルト値」は何文字くらいが適切か。

### 4. トランケーション時の情報保全

サイズ上限を超えた場合、何を残し何を落とすか。

- ドキュメント自体を落とす（`max_documents` 方式）
- ドキュメントのメタデータは残し content だけ省略する
- content を先頭 N 文字に切り詰める
- relevance が低い順に省略する（plan 指定時のみ有効）
- priority が低い順に省略する

落とされたドキュメントがあることをエージェントに通知すべきか。
「N 件のドキュメントが省略されました」のような warnings を入れるか。

### 5. テンプレートの扱い

`base.templates` は scaffold 時に使うコード雛形で、content が特に大きくなりがち。
テンプレートは `source_path` を持たない（DB の `template_origin` はテンプレート ID であってファイルパスではない）。

- テンプレートはドキュメントと同じ戦略でよいか、別扱いすべきか
- command が `scaffold` でないときはテンプレートを省略してよいか
- テンプレートだけで数万文字になりうる問題をどう解決するか

### 6. エージェント側のプロトコル変更

パス返しや truncation を導入する場合、エージェントの行動規範（Aegis Process Enforcement）に
変更が必要になる。

- 「返されたパスを自分で Read する」手順を CLAUDE.md / AGENTS.md に追記する必要があるか
- エージェントが Read すべき doc とスキップしてよい doc をどう判断させるか
- `relevance` スコアを Read 判断の指標に使えるか

### 7. 既存ユーザーへの影響と移行

- 既存の `import_doc` 済みデータには `source_path` がないものも多い。後から付与する migration パスは必要か
- デフォルト動作を変える場合、既存ユーザーの体験がどう変わるか（破壊的変更か）
- opt-in（従来がデフォルト）vs opt-out（新動作がデフォルト）

## 参考: 具体的なアプローチ案

### A案: content 省略 + source_path 返し（パスだけ返す）

`source_path` がある doc はパスだけ返し、ない doc は content をインライン返し。

```
ResolvedDoc (source_path あり):
  { doc_id, title, kind, source_path, relevance? }

ResolvedDoc (source_path なし):
  { doc_id, title, kind, content, relevance? }
```

### B案: max_chars / max_documents パラメータ追加

compile_context の入力に `max_chars` や `max_documents` を追加し、priority / relevance 順にトランケーション。

### C案: content の truncation

全体サイズが閾値を超えた場合、各ドキュメントの content を先頭 N 文字に切り詰める。
`source_path` があればパスを併記。

### D案: relevance フィルタの強化

plan が提供されている場合、relevance スコアが閾値以下のドキュメントを除外（または content を省略）。

### E案: ハイブリッド（A + B + D の組み合わせ）

1. `source_path` がある doc → デフォルトでパスだけ返す。エージェントが必要なら Read
2. `source_path` がない doc → content をインライン返し
3. 全体が `max_chars` を超える場合 → relevance 低い順に content を省略（メタデータは残す）
4. `include_content: true` オプションで従来動作を強制可能

## 期待するアウトプット

1. コンテキスト配信形態の方針決定（上記の各論点に対する結論）
2. P-1 原則の解釈の明確化
3. 実装計画（`ResolvedDoc` の型変更、`CompileRequest` のパラメータ追加、トランケーションロジック）
4. エージェントプロトコル（CLAUDE.md / AGENTS.md）の変更案

---

## ADR 化について

本議題の結論は **ADR（Architecture Decision Record）** として `docs/adr/` に記録すること。
ADR からは本議題ファイルを「議論の経緯」としてリンクする。

```markdown
<!-- ADR テンプレート例 -->
## 関連議題
- [compile_context 出力サイズ制御](../議題_compile_context出力サイズ制御.md)
```
