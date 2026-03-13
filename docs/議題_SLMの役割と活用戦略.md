# 議題: SLM の役割と活用戦略

**起票日**: 2026-03-12
**ステータス**: 決定済み → [ADR-004](adr/004-slm-role-and-strategy.md)

---

> **重要: この議題はゼロベースで議論すること。**
>
> 現在の仮実装では SLM を Intent Tagging（`plan` テキストからタグを抽出し、
> `expanded` コンテキストを追加する）にのみ使っている。
> しかし「SLM を何に使うか」自体が未議論のまま実装に入った。
> Intent Tagging という用途が正しいかどうかも含めて、ゼロから考えること。

---

## 背景

Aegis は `node-llama-cpp` を通じてローカル SLM（Qwen 3.5 4B/9B）を利用できる。
この機能は「サクッと」以下の設計で実装された:

- **用途**: Intent Tagging のみ
- **入力**: `plan` フィールドのテキスト
- **出力**: `IntentTag[]`（JSON grammar 制約で生成）
- **効果**: タグに対応するドキュメントを `expanded` コンテキストに追加
- **フォールバック**: SLM 無効時は expanded が空になるだけ（best-effort）
- **KNOWN_TAGS**: `main.ts` にハードコード

## 議論してほしいこと

### 1. SLM を Aegis 内で使うべきか

そもそもローカル SLM を Aegis に組み込む価値はあるのか。

- 呼び出し元（Claude/GPT）はすでに高性能 LLM。SLM でやることを LLM に任せた方が高品質では？
- SLM の利点（オフライン、低コスト、高速、プライバシー）は Aegis のユースケースで活きるか？
- SLM が必要な理由を「呼び出し元 LLM にはできないこと」で説明できるか？
  - 例: 呼び出し元はツール呼び出し結果を見るだけで、前処理には介入できない
  - 例: Aegis 内部で完結する推論は外部に出したくない

### 2. SLM の用途候補

SLM をどういうタスクに使うのが最も効果的か。候補:

| 用途 | 概要 | 仮実装の状態 |
|------|------|-------------|
| Intent Tagging | plan からタグ抽出 → expanded context | 実装済み |
| ドキュメント分類 | kind/tags の自動推定 | 未実装（正規表現で仮対応） |
| エッジ推定 | 新規ドキュメントの DAG 接続先推定 | 未実装 |
| Observation 分析 | 観測イベントから提案を自動生成 | ルールベースで実装済み |
| ドキュメント要約 | 長文ドキュメントのサマリ生成 | 未検討 |
| セマンティック検索 | ドキュメント間の類似度計算 | 未検討 |

### 3. Intent Tagging の設計は正しいか

現在の設計への疑問:

- `KNOWN_TAGS` が `main.ts` にハードコードされている。タグの管理はどうあるべきか？
  - DB に入れるべき？ テンプレートで定義？ ドキュメントの kind から自動導出？
- `plan` フィールドのテキスト品質は呼び出し元エージェント依存。品質が低い場合どうなる？
- `expanded` コンテキストの有用性は実際にどの程度か？ ベースコンテキストだけで十分では？
- grammar 制約による JSON 生成は品質を保証するが、「タグの意味的正確性」は保証しない

### 4. SLM 無効時の体験

`--no-slm` フラグで SLM を無効にできるが:

- SLM 依存の機能が best-effort で消えるのは UX として受容できるか？
- SLM がないと Aegis の価値が大幅に下がるなら、依存として受け入れるべきでは？
- SLM がなくても Aegis の価値が十分なら、そもそも SLM 機能は必要なのか？

### 5. モデル選択とリソース消費

- 4B モデルの品質は Intent Tagging に十分か？ 他のタスクには？
- GPU なし環境での推論速度は実用的か？
- モデルのダウンロード（~2.5GB）をユーザーに強いるのは適切か？
- `~/.aegis/models/` のストレージ管理は誰がやる？

## 仮実装の参考情報

- `src/expansion/llama-engine.ts`: node-llama-cpp ラッパー
- `src/expansion/llama-intent-tagger.ts`: grammar 制約付き Intent Tagging
- `src/expansion/models.ts`: モデルカタログ（qwen3.5-4b, qwen3.5-9b）
- `src/core/tagging/tagger.ts`: IntentTagger ポート（インターフェース）
- `src/core/read/compiler.ts`: expanded コンテキストで tag_mappings を参照

## 期待するアウトプット

1. SLM を Aegis で使うべきかの判断
2. 使うなら、どの用途に限定するかの優先順位付け
3. Intent Tagging の継続/廃止/改善の方針
4. SLM 無効時のフォールバック戦略
5. タグ管理の設計方針

---

## ADR 化について

本議題の結論は **ADR（Architecture Decision Record）** として `docs/adr/` に記録すること。
ADR からは本議題ファイルを「議論の経緯」としてリンクする。

```markdown
## 関連議題
- [SLM の役割と活用戦略](../議題_SLMの役割と活用戦略.md)
```
