# 議題: Observation → Automation パイプライン設計

**起票日**: 2026-03-12
**ステータス**: 決定済み → [ADR-003](adr/003-observation-automation-pipeline.md)

---

> **重要: この議題はゼロベースで議論すること。**
>
> 現在の仮実装では4つの Analyzer を作り、悲観的ロックで並行性を制御し、
> Observation → Proposal への変換ロジックを実装した。
> しかし **肝心の「誰がいつ `analyzeAndPropose` を呼ぶのか」が未定義** であり、
> パイプライン全体のワークフローが設計されていない。
> 部品はあるがパイプラインがない。ゼロから考えること。

---

## 背景

Aegis の Observation パイプラインは以下の仮実装がある:

### 実装済みのもの

- **`aegis_observe` ツール**: エージェントが観測イベントを記録する MCP ツール
- **4つの Analyzer**:
  - `RuleBasedAnalyzer`: `compile_miss` + `missing_doc` → `add_edge` 提案
  - `ReviewCorrectionAnalyzer`: `review_correction` → `update_doc` 提案
  - `PrMergedAnalyzer`: `pr_merged` → パスカバレッジの `add_edge` 提案
  - `ManualNoteAnalyzer`: ユーザーのメモ → `new_doc` / `update_doc` 提案
- **`analyzeAndPropose`**: 未分析の Observation を取得 → Analyzer で分析 → Proposal 作成
- **悲観的ロック**: 分析開始時に `analyzed_at` を設定、失敗時にリセット
- **セマンティック重複排除**: 同一内容の pending Proposal が既にあればスキップ

### 未実装・未設計のもの

- **トリガー機構**: `analyzeAndPropose` は内部関数で MCP に公開されていない。誰が呼ぶ？
- **実行タイミング**: バッチ？ リアルタイム？ イベント駆動？
- **Analyzer の選択ロジック**: 全 Analyzer を毎回走らせる？ イベントタイプで振り分け？
- **フィードバックループ**: Proposal が reject されたとき、同じ Observation は再分析される？ されない？

## 議論してほしいこと

### 1. パイプラインのトリガー

`analyzeAndPropose` をいつ・誰が呼ぶか:

| 方式 | 概要 | メリット | デメリット |
|------|------|---------|-----------|
| Agent が明示呼び出し | `aegis_analyze` ツールを公開 | シンプル、Agent の制御下 | Agent が呼び忘れる可能性 |
| observe 時に同期実行 | `aegis_observe` の中で自動分析 | リアルタイム、漏れなし | レイテンシ増大、observe が重くなる |
| バックグラウンドループ | 定期ポーリング / cron | 非同期で軽い | 常駐プロセス必要、タイミング曖昧 |
| compile 時に同期実行 | `compile_context` のついでに | 自然なタイミング | compile が遅くなる、責務混在 |
| しきい値トリガー | N件以上未分析が溜まったら実行 | バランス良い | 実装が複雑 |

### 2. Observation の寿命管理

- 分析済み Observation はいつまで保持する？
- `aegis_archive_observations` はあるが、誰がいつアーカイブする？
- アーカイブの基準は何か（日数？ 件数？ Proposal 承認後？）

### 3. Analyzer のアーキテクチャ

- Analyzer を追加するとき、プラグイン的に差し込めるか？
- Analyzer 間の依存関係や優先度はあるか？
- 1つの Observation が複数の Analyzer にマッチする場合の挙動は？
- SLM を使う Analyzer を作る場合、SLM 無効時はどうする？

### 4. Proposal 品質の保証

Analyzer が自動生成する Proposal の品質をどう担保するか:

- すべて人間レビュー必須（現状: INV-6 の通り）
- 自動承認してもよい低リスクカテゴリはあるか？
- 的外れな Proposal を大量生成するリスクへの対処
- Proposal の reject が Observation にフィードバックされる仕組み

### 5. `aegis_observe` のイベント設計

現在のイベントタイプ:

- `compile_miss` — コンテキストの不足を検出
- `review_correction` — コードレビューでの指摘を記録
- `pr_merged` — PR マージを記録
- `manual_note` — 自由記述のメモ

これで十分か？ 足りないイベントタイプはあるか？
イベントの payload 設計は適切か？

## 仮実装の参考情報

- `src/core/automation/propose.ts`: ProposeService
- `src/core/automation/rule-analyzer.ts`, `review-correction-analyzer.ts`, `pr-merged-analyzer.ts`, `manual-note-analyzer.ts`: 各 Analyzer
- `src/mcp/services.ts`: `analyzeAndPropose` の呼び出しロジック（悲観的ロック含む）
- `src/core/store/repository.ts`: `markObservationsAnalyzed`, `resetObservationsAnalyzed`

## 期待するアウトプット

1. トリガー方式の決定
2. Observation のライフサイクル設計
3. Analyzer アーキテクチャの方針（プラグイン可否、選択ロジック）
4. 自動承認の可否とその基準
5. イベントタイプの過不足レビュー

---

## ADR 化について

本議題の結論は **ADR（Architecture Decision Record）** として `docs/adr/` に記録すること。
ADR からは本議題ファイルを「議論の経緯」としてリンクする。

```markdown
## 関連議題
- [Observation 自動化パイプライン設計](../議題_Observation自動化パイプライン設計.md)
```
