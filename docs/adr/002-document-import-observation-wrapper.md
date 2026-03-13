# ADR-002: 既存ドキュメント取り込みを専用 Observation と Wrapper Tool で扱う

**ステータス:** Accepted
**日付:** 2026-03-13
**Supersedes:** [ADR-001](./001-document-import-strategy.md)

## 関連議題

- [既存ドキュメント取り込み戦略](../議題_既存ドキュメント取り込み戦略.md)

---

## コンテキスト

Aegis は既存プロジェクトへ導入した直後から、既存の設計ドキュメント、ADR、運用ルールを
取り込める必要がある。一方で、Aegis の Write フローは
`Observation -> Proposed -> Canonical` を守ることが前提であり、
Proposal に evidence を持たない直接 import は P-3 と緊張する。

また、`compile_context` の base ルーティングは DAG エッジ起点であり、
孤立ドキュメントは発見されにくい。既存ドキュメント取り込みは
「文書を保存する」だけでなく、「知識グラフへ接続する」設計を伴う。

`manual_note` は汎用的な観測として有用だが、import 固有の責務
（明示メタデータ、接続ヒント、出典、未接続警告、専用 UX）を担わせるには
意味が広すぎる。

---

## 決定

### D-1: 既存ドキュメント取り込みは専用 Observation とする

既存ドキュメント取り込みは `manual_note` の拡張ではなく、
専用の Observation event type で表現する。
仮称は `document_import` とする。

これにより import は first-class なユースケースとしてモデル化される一方、
依然として Observation 起点であり、evidence chain を維持できる。

### D-2: MCP には専用 Wrapper Tool `aegis_import_doc` を提供する

ユーザーやエージェントに raw な `observe(document_import)` を直接使わせず、
import 専用の MCP ツール `aegis_import_doc` を提供する。

ただしこのツールは Canonical を直接変更しない。
内部では次の順で処理する。

1. `document_import` Observation を記録する
2. `DocumentImportAnalyzer` を実行する
3. `new_doc` と必要な `add_edge` Proposal を生成する
4. 生成された proposal を admin が approve/reject する

このツールは **admin surface only** とする。
既存ドキュメント取り込みは知識ベースの管理操作であり、
通常の coding session 中の agent surface に常設する責務ではない。

### D-3: コア primitive は `content + explicit metadata` とする

取り込みのコア入力はファイルパスではなく、以下の明示データとする。

```typescript
{
  content: string;
  doc_id: string;
  title: string;
  kind: DocumentKind;
  edge_hints?: EdgeSpec[];
  tags?: string[];
  source_path?: string;
}
```

`doc_id`, `title`, `kind` は必須とする。
frontmatter 解析、`# heading` 抽出、ファイル名からの補完などは
呼び出し側ラッパーの責務であり、Aegis コアでは推論しない。

### D-4: `file_path` はコア責務にしない

MCP サーバーはファイルシステム依存を前提としない。
そのため、Aegis コアおよび MCP ツールの正規入力は `content` とする。

もし IDE 統合や CLI が `file_path` ベースの利便性を提供したい場合は、
それは Aegis サーバー外のラッパーでローカルファイルを読み、
`content` に変換してから `aegis_import_doc` を呼び出す。

### D-5: メタデータ推論は呼び出し元に委ね、Aegis は検証に徹する

Aegis は `kind` 分類、`doc_id` 生成、タグ推論を内部では行わない。
呼び出し元の人間または LLM が決定する。

Aegis 側に残す責務は以下の検証である。

- `doc_id` フォーマット検証
- `kind` enum 検証
- `content` 空禁止
- `content_hash` のサーバー側再計算
- `edge_hints` の型整合チェック
- `doc_depends_on` の循環検知

### D-6: DAG エッジは任意入力だが、未接続 import は強く可視化する

`edge_hints` は任意とする。既存文書の完全な接続を import 時に要求すると
導入コストが上がりすぎるためである。

ただし、`edge_hints` も `tags` もないドキュメントは write-only になりやすい。
そのため単なる warning 返却だけでなく、proposal summary や review 画面で
「未接続 import」であることを明示する。

接続不足は後続の `compile_miss -> add_edge` 自動化で段階的に補う。

### D-7: バッチ import はサーバーに持ち込まない

`aegis_import_batch` は追加しない。
複数ファイル取り込みは呼び出し元がループで `aegis_import_doc` を呼ぶ。

理由は以下の通り。

- MCP ツールは atomic である方が扱いやすい
- 部分成功の扱いをサーバー内に持ち込まなくてよい
- エージェントや CLI は外側でループを書くのが容易

### D-8: tags と source_path の扱い

- `tags`: proposal approve 時に `tag_mappings` へ `source: 'manual'` で反映する
- `source_path`: provenance として proposal payload / audit に保持する

`source_path` のために `Document` スキーマは拡張しない。
これはルーティングの主キーではなく、出典追跡の補助情報だからである。

---

## 却下した代替案

### A-1: evidence なしの独立 `aegis_import_doc`

却下。P-3 と evidence chain を壊す。
`bootstrap` に続く第2の例外を増やすべきではない。

### A-2: `manual_note` へ一本化

却下。内部実装として流用できる部分はあるが、概念として広すぎる。
import 固有の責務と UX を `manual_note` に背負わせると、
観測モデルの意味が曖昧になる。

### A-3: Aegis 内蔵の正規表現または SLM による import 分析

却下。多言語・非定型ドキュメントに対して安定しない。
Aegis コアは決定と検証に集中し、推論は呼び出し元へ寄せる。

---

## 影響

### 実装タスク

1. `ObservationEventType` に `document_import` を追加する
2. `ObserveEvent` に `document_import` payload を追加する
3. `DocumentImportAnalyzer` を新設し、`new_doc` / `add_edge` draft を生成する
4. `AegisService` に `importDoc()` を実装し、内部で `observe + analyzeAndPropose` を実行する
5. MCP server に admin-only の `aegis_import_doc` を登録する
6. approve 時に `tags` を `tag_mappings` へ反映する
7. review 時に未接続 import を識別できる summary / warning を追加する
8. 仮実装の正規表現ベース import ロジックは削除する

### 整理対象

- `manual_note` は「人手メモ」「文書更新提案」の汎用観測として残す
- 既存の `aegis_import_doc` が file path 依存かつ evidence なしなら置き換える
- `parseFrontmatter()` のような補助処理は、必要なら呼び出し側ユーティリティへ移す

---

## 備考

- `doc_id` は英数字・ハイフン・アンダースコアのみを許可する
- import の primary UX は「専用ツール」であり、内部の正規形は「専用 Observation」である
- この ADR により、ADR-001 の「`manual_note` へ一本化する」決定は superseded となる
