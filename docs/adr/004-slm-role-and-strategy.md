# ADR-004: SLM は optional な拡張コンテキスト補助に限定する

**ステータス:** Accepted
**日付:** 2026-03-13

## 関連議題

- [SLM の役割と活用戦略](../議題_SLMの役割と活用戦略.md)

---

## コンテキスト

現実装では、SLM は `compile_context.plan` から intent tags を抽出し、
`tag_mappings` を使って `expanded` コンテキストを返す用途にのみ使われている。

この方向性自体は Aegis の read path と相性がよいが、
次の設計判断が未整理だった。

- SLM が Aegis の本質機能か、補助機能か
- write path にも推論を入れるか
- タグ語彙をどこで管理するか
- モデル取得や起動コストを誰が負担するか

Aegis の中核価値は、決定的な DAG ルーティングと人間承認を伴う知識管理である。
SLM はその中核を置き換えるべきではない。

---

## 決定

### D-1: SLM は optional 機能であり、Aegis の成立条件にしない

SLM は Aegis の必須依存にしない。
SLM が無効または利用不能でも、Aegis は
決定的コンテキストコンパイラとして十分に機能することを前提とする。

SLM 無効時に失われてよいのは、`expanded` のような補助的価値のみである。

### D-2: v1 での正式用途は `expanded context` のみとする

SLM の正式用途は、`compile_context.plan` から意図タグを抽出し、
`expanded` コンテキストを返す read-only 補助に限定する。

これは以下の性質を持つため、Aegis と整合的である。

- Canonical を直接変更しない
- best-effort で失敗してもコア read path を壊さない
- 呼び出し元 LLM に依存せず、Aegis サーバー内で閉じて実行できる

### D-3: SLM を write path に入れない

以下の用途には Aegis 内 SLM を使わない。

- ドキュメント import 時の `doc_id` / `kind` / tags 推定
- DAG edge 推定
- Observation からの Proposal 自動生成
- Canonical ドキュメント要約や書き換え

これらは Canonical 変更や知識構造に影響しやすく、
決定性・責務分離・監査性を損なうためである。

### D-4: タグ語彙はプロジェクトローカルに管理し、ハードコードしない

SLM に渡す候補タグは、`main.ts` の定数ではなく
プロジェクトの永続状態から決定する。

v1 の方針:

- 候補タグは `tag_mappings` に存在する tag 群から導出する
- 初期タグはテンプレート seed や manual tagging で増やす
- 候補タグが空なら、expanded context も空でよい

これにより、タグ空間はプロジェクトごとに収束し、
グローバル固定語彙への依存を避けられる。

### D-5: `IntentTagger` は「許可されたタグ集合」に対して動作する

SLM は自由生成ではなく、
呼び出し時に与えられた候補タグ集合から選ぶ classifier として扱う。
Grammar 制約や JSON 制約は継続する。

この設計により、
「有効な形式」と「有効な語彙」を同時に制約できる。

### D-6: SLM の利用は明示的 opt-in とする

大きなモデル取得、起動時間、ローカル資源消費を考慮し、
SLM は明示的に有効化されたときだけ使う。

デフォルト体験は以下とする。

- SLM 無効: base context のみで起動
- SLM 有効だが初期化失敗: warning を出して継続
- SLM 有効かつ利用可能: expanded context を追加

自動的な大容量モデルダウンロードを前提にしない。

### D-7: 将来の SLM 用途も read-only 補助に限定する

将来 SLM を拡張する場合も、v1 の原則は維持する。

許容されるのは、例えば次のような read-only 補助である。

- expanded context の改善
- explanation / rationale の補足
- 検索候補や関連文書候補の提示

Canonical 更新の判断主体にはしない。

---

## 却下した代替案

### A-1: SLM を import / edge 推定 / Observation 分析に広げる

却下。Aegis の write path に非決定的推論が入り込みすぎる。

### A-2: `KNOWN_TAGS` のグローバル固定セットを維持する

却下。プロジェクトごとの文脈に追従できず、メンテナンス負荷も高い。

### A-3: SLM をデフォルト必須にする

却下。Aegis の導入障壁を不必要に上げる。

---

## 影響

### 実装タスク

1. タグ候補取得を `main.ts` の定数から repository 起点へ移す
2. `IntentTagger` の入出力を「候補タグを受け取る classifier」方向に整理する
3. SLM 無効をデフォルトにし、明示 opt-in フラグへ切り替える
4. `compile_context` のレスポンスで base と expanded の責務差を維持する

### 維持される原則

- base context は決定的
- expanded context は best-effort
- SLM の失敗は非致命

---

## 備考

- Aegis が SLM を持つ意義は、「呼び出し元 LLM の品質代替」ではなく、
  サーバー内で閉じた補助推論を agent 非依存に提供する点にある
- grammar-constrained generation は形式保証として継続する
