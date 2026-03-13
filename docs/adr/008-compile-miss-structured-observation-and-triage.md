# ADR-008: compile_miss は構造化 Observation + admin triage で対応する

**ステータス:** Accepted
**日付:** 2026-03-13

## 関連

- [ADR-003: Observation 自動化パイプラインは admin 明示処理とする](./003-observation-automation-pipeline.md)
- [改善計画 (compile_miss パイプライン v4)](/Users/hirosugu.takeshita/.cursor/plans/compile-miss_pipeline_539b64a6.plan.md)

---

## コンテキスト

ドッグフーディングにおいて、agent が `compile_miss` を報告しても
RuleBasedAnalyzer がスキップし、プロポーザルが生成されないケースが判明した。

具体例: agent は review_comment に
「ts-mcp-repository-guidelines が archived_at の意味を説明していなかった」
と対象ドキュメントを特定しているが、
`missing_doc` フィールドがないため analyzer は何も出せない。

この問題に対し、3 回の Codex レビューを経て以下の選択肢を検討・却下した。

---

## 決定

### D-1: `compile_miss` payload に `target_doc_id` を追加する（構造化メタデータ）

`compile_miss` の payload 型に `target_doc_id?: string` を追加する。
これは「内容が不足していた base ドキュメント」を構造的に記録するためのフィールドである。

対象は `base.documents[*].doc_id` のみとする。
expanded / template 由来のドキュメントは対象外である。

理由:
- `compile_audit` の `base_doc_ids` で検証可能な範囲に限定する
- `expanded_doc_ids` は `AnalysisContext` に渡されておらず、template は `base.templates` に別出しされている
- スコープを広げると adapter 指示が曖昧になり、agent が skip を踏みやすい

### D-2: `target_doc_id` からの自動 proposal 生成は行わない

`target_doc_id` は構造化メタデータとしてのみ保存する。
RuleBasedAnalyzer のコード変更は行わない。

既存の `missing_doc` → `add_edge` パスは変更せずそのまま残す。
`target_doc_id` は将来の拡張ポイントとして予約する。

#### 却下した自動 proposal パス

**A: `target_doc_id` → `update_doc`**

却下。`update_doc` は完成済み文書全文を置換する前提であり、
review_comment の単純追記は品質が低い。
さらに `doc_id` 単位の重複判定により、
雑な自動追記案が 1 件 pending になると、
より良い後続 observation もブロックされる。

review_comment からの文書全文生成には SLM 等の仕組みが必要であり、
現時点では対応できない。

**B: `target_doc_id` → `add_edge`**

却下。`compile_miss` の意味は「返ってきた文書の内容が不足していた」であり、
「edge が不足していた」ではない。
さらに `compile_audit` に resolution_path がないため、
analyzer は「本当に path_requires を増やすべき miss なのか」
「既存の layer/command/doc dependency で十分だったのか」を判定できない。
低シグナルな `add_edge` を増やすリスクがある。

### D-3: admin triage 用の `aegis_list_observations` ツールを提供する

admin が見落とさず observation を triage できるよう、
`aegis_list_observations` を admin surface ツールとして追加する。

outcome の判定は `proposal_evidence` テーブルへの LEFT JOIN で行う:

- `pending`: `analyzed_at IS NULL`
- `proposed`: `analyzed_at IS NOT NULL` かつ `proposal_evidence` に該当レコードあり
- `skipped`: `analyzed_at IS NOT NULL` かつ `proposal_evidence` に該当レコードなし

`analyzed_at` 単体では判定できない。
`analyzeAndPropose` は analyzer 実行前に全 observation を analyzed 扱いにするため、
proposal が生成されたものも skip されたものも同じく `analyzed_at` が入る。

### D-4: 自動 proposal の新規パス追加は compile_audit の拡張後に再検討する

`target_doc_id` からの自動 proposal を将来的に実現するには、
少なくとも以下が必要である:

- `compile_audit` に resolution_path 相当を追加し、
  「どの edge 経由でその doc が返ったか」を保持する
- analyzer が「edge 不足」vs「内容不足」を判定できるようにする
- `update_doc` 用の proposed_content を SLM 等で生成する仕組み

これらが整うまで、`target_doc_id` は構造化メタデータとして蓄積し、
admin が手動で判断する運用とする。

---

## 影響

### 実装タスク

1. `src/core/types.ts` の compile_miss payload 型に `target_doc_id?: string` を追加する
2. `src/mcp/services.ts` の validation で `target_doc_id` を optional として受け入れる
3. adapter 指示テンプレートの compile_miss 例に `target_doc_id` を追加し、
   `base.documents[*].doc_id` のみ対象と明記する
4. `aegis_list_observations` admin ツールを追加する
   - `proposal_evidence` テーブルへの LEFT JOIN で outcome を判定する
5. テストを追加する

### ADR-003 との関係

この ADR は ADR-003 の方針を維持する。

- D-1 (observe は append-only) → `target_doc_id` は保存のみ、副作用なし
- D-2 (proposal 化は admin 明示処理) → admin triage ツールで可視化
- D-4 (analyzer 選択は固定レジストリ) → RuleBasedAnalyzer の変更なし
- D-6 (再分析ポリシー) → 既存動作への影響なし

---

## 備考

- この ADR は「compile_miss の情報を構造化して蓄積し、admin が判断する」という
  段階的アプローチを採る
- 自動 proposal の精度向上は、compile_audit の情報量拡充と
  SLM による content 生成が整ってから取り組む
- Codex レビュー 3 回を経て、自動化の範囲を段階的に絞り込んだ結果である
