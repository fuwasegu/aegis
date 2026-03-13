# Aegis Technical Guide

Aegis の内部で使われている決定論的アルゴリズムとアーキテクチャの設計判断を解説するドキュメント。

## 目次

1. [コンテキストコンパイルの4ステップルーティング](#1-コンテキストコンパイルの4ステップルーティング)
2. [Specificity と Priority による決定論的ソート](#2-specificity-と-priority-による決定論的ソート)
3. [レイヤ解決アルゴリズム](#3-レイヤ解決アルゴリズム)
4. [Init プロファイルスコアリング](#4-init-プロファイルスコアリング)
5. [Snapshot とコンテンツアドレス可能バージョニング](#5-snapshot-とコンテンツアドレス可能バージョニング)
6. [Pessimistic Claim パターン（同時実行安全性）](#6-pessimistic-claim-パターン同時実行安全性)
7. [Proposal 重複排除（Semantic Key）](#7-proposal-重複排除semantic-key)
8. [Preview Hash による TOCTOU 防止](#8-preview-hash-による-toctou-防止)
9. [SLM Intent Tagging と Grammar-Constrained Generation](#9-slm-intent-tagging-と-grammar-constrained-generation)
10. [不変条件（Invariants）](#10-不変条件invariants)

---

## 1. コンテキストコンパイルの4ステップルーティング

Aegis のコア機能。`compile_context` はファイルパスから必要なドキュメントを **検索ではなくグラフ走査** で決定的に解決する。

### アルゴリズム

```
入力: target_files, target_layers?, command?, plan?

Step 1: path_requires
  ├─ 全 path_requires エッジを取得
  ├─ 各エッジの source_value (glob) を target_files に対してマッチング (picomatch)
  └─ マッチしたエッジ → ソート → 対象 doc_id を収集

Step 2: layer_requires
  ├─ レイヤ解決（→ §3）で対象レイヤ名を決定
  ├─ 全 layer_requires エッジの source_value とレイヤ名をマッチング
  └─ マッチしたエッジ → ソート → 対象 doc_id を収集

Step 3: command_requires
  ├─ request.command が存在する場合のみ
  ├─ 全 command_requires エッジの source_value と完全一致
  └─ マッチしたエッジ → ソート → 対象 doc_id を収集

Step 4: doc_depends_on 推移閉包
  ├─ Step 1-3 で収集した doc_id 群を起点に
  ├─ doc_depends_on エッジを再帰的に辿る（BFS/推移閉包）
  └─ 到達可能な全 doc_id を収集

出力: documents[] + resolution_path[] + templates[]
```

### 決定論性の保証

同じ入力に対して **常に同じ出力** を返す。これが RAG との根本的な違い。

- エッジのソートが決定的（→ §2）
- ドキュメントの表示順も決定的
- UUID（compile_id）以外のすべてのフィールドが再現可能

### 計算量

- Step 1: O(E_path × F) — E_path: path_requires エッジ数, F: target_files 数
- Step 2: O(R × F + E_layer × L) — R: layer_rules 数, L: 解決レイヤ数
- Step 3: O(E_cmd) — E_cmd: command_requires エッジ数
- Step 4: O(V + E_dep) — 標準的なグラフ走査

通常のプロジェクトでは全ステップ合計 O(数百) 程度で十分高速。

---

## 2. Specificity と Priority による決定論的ソート

複数のエッジが同じドキュメントを指す場合、表示順序を一意に決定する必要がある。

### ソートキー（3段階）

```
1. specificity DESC  — より具体的なパターンが優先
2. priority ASC      — 小さい数値が高優先度
3. edge_id ASC       — 最終タイブレーカ（UUID の辞書順）
```

### Specificity の計算

glob パターンの「具体性」をスコア化する:

```
src/**              → specificity 低（広範囲にマッチ）
src/core/**         → specificity 中
src/core/store/*.ts → specificity 高（狭い範囲にマッチ）
```

具体的な計算ロジック:
- パスの `/` セパレータ数をベースにする
- `**` は汎用的なので重みが低い
- リテラルのディレクトリ名は重みが高い

### edge_id タイブレーカの重要性

specificity と priority が完全に同じエッジが存在しうる。edge_id（UUID）の辞書順で最終的なタイブレーカとする。これは **テンプレートの seed_edges が生成順に決定的な ID を持つ** ため、実質的にテンプレート定義順を反映する。

---

## 3. レイヤ解決アルゴリズム

ファイルパスからアーキテクチャレイヤを推定する。

### アルゴリズム

```
入力: target_files[], layer_rules[]

1. layer_rules をソート:
   specificity DESC → priority ASC → rule_id ASC

2. 各 target_file について:
   a. ソート済みルールを上から順にマッチング
   b. 最初にマッチしたルールの layer_name を採用
   c. マッチしなければスキップ

3. 結果: 重複排除されたレイヤ名の集合
```

### First-match wins の設計理由

最も具体的なルールが先にマッチするようソートされているため、`src/core/store/*.ts` → `infrastructure` と `src/**` → `application` が共存しても、前者が優先される。

### 明示的指定

`target_layers` が明示的に渡された場合、推論はスキップされる（ユーザーの明示的な意図を尊重）。

---

## 4. Init プロファイルスコアリング

プロジェクトのスタックを検出し、最適なテンプレートを選択する。

### スタック検出

```
detectStack(projectRoot):
  ├─ package.json 存在？ → has_npm = true
  ├─ tsconfig.json 存在？ → has_typescript = true
  ├─ composer.json 存在？ → has_composer = true
  ├─ requirements.txt / pyproject.toml 存在？ → has_python = true
  └─ src/ 存在？ → has_src = true
```

### プロファイルスコアリング

各テンプレートは `manifest.yaml` に `detection_rules` を持つ:

```yaml
detection_rules:
  - check: file_exists
    target: package.json
    weight: 3
  - check: file_contains
    target: package.json
    pattern: "@modelcontextprotocol/sdk"
    weight: 5
```

スコア = Σ(マッチしたルールの weight)

### プロファイル選択の決定論性

```
1. score DESC でソート
2. score が同じ場合 → profile_id ASC でソート（辞書順タイブレーカ）
3. トップの confidence が 'high' かつ同スコアが複数 → block（曖昧）
4. トップの confidence が 'low' → warn（進行可能だが注意喚起）
5. タイ（非 high）→ warn して辞書順で最初のものを auto-select
```

---

## 5. Snapshot とコンテンツアドレス可能バージョニング

### 設計

Canonical Knowledge のバージョンは **イミュータブルな Snapshot** として管理される。

```
knowledge_meta.current_version = 1, 2, 3, ...  (単調増加)

Snapshot #3:
  ├─ snapshot_docs: [{doc_id, content_hash}, ...]
  ├─ snapshot_edges: [{edge_id, source_type, ...}, ...]
  └─ snapshot_layer_rules: [{rule_id, path_pattern, ...}, ...]
```

### 単調増加バージョン (INV-4)

```
approveProposal():
  1. current_version を読む
  2. new_version = current_version + 1
  3. Snapshot を new_version で作成
  4. knowledge_meta.current_version を更新
  → SQLite トランザクション内で原子的に実行
```

ロールバックは不可。バージョンは絶対に減らない。

### Content Hash

ドキュメントの `content_hash` は SHA-256。同じ内容 → 同じハッシュ → 変更検出が可能。

### 監査性 (INV-5)

`compile_log` テーブルが全コンパイルを記録:
- どの Snapshot を使ったか
- どのドキュメントが返されたか（base + expanded）
- リクエスト内容

→ 「なぜこのドキュメントが返されたのか」を事後的に追跡可能。

---

## 6. Pessimistic Claim パターン（同時実行安全性）

### 問題

`analyzeAndPropose` は非同期。複数の MCP クライアントが同時に呼び出すと、同じ Observation を二重処理するリスクがある。

### 解決策: Pessimistic Claim

```
analyzeAndPropose():
  1. 未分析 Observation を取得
  2. 即座に analyzed_at を SET（= claim を取る）
  3. 非同期で analyzer.analyze() を実行
  4. 成功 → proposals を作成
  5. 失敗 → analyzed_at を NULL に戻す（= claim をリリース）
```

```
時間軸 →
────────────────────────────────────────────
Call A: [claim] ─── [analyze] ─── [propose] ✓
Call B:         [claim: 空] → 即完了（何もない）
────────────────────────────────────────────
```

### リカバリ

analyze() だけでなく propose() の失敗も catch して claim をリリース。これにより、一時的なエラーで Observation が永久にスタックすることを防ぐ。

---

## 7. Proposal 重複排除（Semantic Key）

### 問題

同じ意味の Proposal が複数作られると、管理者に二重レビューを強いる。

### Semantic Key

各 proposal_type ごとに「意味的に同一」を判定するキーを抽出:

```
add_edge:  → "{source_type}:{source_value}:{target_doc_id}:{edge_type}"
new_doc:   → "{doc_id}"
update_doc: → "{doc_id}"
deprecate: → "{entity_type}:{entity_id}"
bootstrap: → "bootstrap"
```

### グローバルスコープ

重複チェックは **全 pending proposal** に対して行われる（Observation スコープではない）。これにより:

- 異なる Observation から同じ `update_doc` が提案されても1つだけ作られる
- 管理者は1回のレビューで済む

---

## 8. Preview Hash による TOCTOU 防止

### 問題

`init_detect` と `init_confirm` は別々の呼び出し。間にテンプレートファイルが変更されたら、ユーザーが確認したプレビューと実際にマテリアライズされるデータが異なる可能性がある。

### 解決策

```
init_detect():
  1. テンプレートを解決
  2. 全生成データ（docs, edges, layer_rules）をJSON化
  3. SHA-256 ハッシュを計算 = preview_hash
  4. preview_hash とデータをインメモリキャッシュに保存

init_confirm(preview_hash):
  1. キャッシュから preview_hash でルックアップ
  2. マッチしなければ → エラー（TOCTOU 検出）
  3. マッチすれば → キャッシュのデータをそのまま使用
```

preview_hash はドキュメント内容のハッシュ、エッジ構造、プレースホルダ値をすべて含む。1ビットでも変われば異なるハッシュになる。

---

## 9. SLM Intent Tagging と Grammar-Constrained Generation

### 目的

`compile_context` の `plan` パラメータからユーザーの意図を抽出し、DAG ルーティングでは到達しないドキュメントを「拡張コンテキスト」として返す。

### アルゴリズム

```
1. plan テキストを SLM に入力
2. 事前定義されたタグリスト（例: state_mutation, db_migration, ...）から
   関連するタグを JSON 形式で出力させる
3. タグ → tag_mappings テーブルでドキュメントにマッピング
4. base context に含まれないドキュメントのみを expanded として返す
```

### Grammar-Constrained Generation (llama.cpp)

node-llama-cpp の Grammar 機能を使い、SLM の出力を **トークン生成レベルで** JSON スキーマに制約する:

```typescript
const grammar = await llama.createGrammarForJsonSchema({
  type: 'object',
  properties: {
    tags: { type: 'array', items: { type: 'string' } }
  }
});
```

これにより:
- JSON パース失敗が原理的に起こらない
- 「JSONっぽいが壊れた出力」の対処が不要
- 小型モデルでも高い成功率

### モデル管理

```
~/.aegis/models/             ← 全プロジェクト共有
  ├─ qwen2.5-1.5b-instruct-q4_k_m.gguf
  └─ ...

初回起動時に HuggingFace から自動ダウンロード（resolveModelFile）
```

---

## 10. 不変条件（Invariants）

Aegis が維持する6つの不変条件:

### INV-1: データ整合性
- 全エッジの `target_doc_id` が既存ドキュメントを参照
- `doc_depends_on` が DAG を形成（循環なし）
- FK 制約 + アプリケーションレベルのバリデーション

### INV-2: DAG 整合性
- `doc_depends_on` エッジが閉路を形成しないことをトランザクション時に検証
- 推移閉包計算が有限回で終了することを保証

### INV-3: Snapshot 不変性
- Snapshot 作成後、その内容は変更不可
- `snapshot_docs`, `snapshot_edges`, `snapshot_layer_rules` は INSERT-only

### INV-4: 単調増加バージョン
- `knowledge_meta.current_version` は常に +1
- 減少やスキップは起きない
- SQLite トランザクションで原子性を保証

### INV-5: 監査可能性
- 全 `compile_context` 呼び出しが `compile_log` に記録される
- 全 Proposal が作成〜解決まで追跡可能
- Observation → Proposal の証拠チェーン（`proposal_evidence`）

### INV-6: 権限分離
- Agent Surface: 読み取りと Observation 書き込みのみ（4ツール）
- Admin Surface: Canonical 変更を含む全操作（14ツール）
- AI エージェントが直接アーキテクチャを変更することを構造的に防止
