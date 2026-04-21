# Aegis Knowledge Optimization 設計 — 2026-03-31

> **参加者**: Claude (Opus 4.6) + Codex
> **前提**: [改善議論レポート 2026-03-31](./aegis-improvement-discussion-2026-03-31.md) の Phase 1-5 ロードマップ上に構築
> **関連 ADR**: ADR-004 (SLM 戦略), ADR-008 (compile_miss triage), ADR-009 (delivery-aware compile)

---

## 1. 問題の定義

Aegis のコンパイル精度は「どのドキュメントが存在し、どの Edge でルーティングされるか」に完全に依存する。しかし現状：

1. **ドキュメントの粒度設計が人間任せ** — 1つの文書に複数の関心事が混在すると不要なコンテキストまで配信される。細かすぎると Edge 管理が爆発する
2. **Edge（glob → doc）の設計が人間任せ** — 最適な構成を考えるのは専門知識が必要
3. **既存ドキュメントの取り込みが生のまま** — `aegis_import_doc` は既存文書をそのまま取り込むが、Aegis 向けに最適化された粒度・構造ではない（ADR-002 の 1 source → 1 doc 前提）
4. **陳腐化検知がハッシュ比較のみ** — `sync_docs` は意味的な乖離を検知できない

**求める革新**: 人間が「良いドキュメントと Edge を設計する」のではなく、**Aegis が既存のプロジェクト資産を分析し、最適なドキュメント分割・Edge 構成・更新タイミングを自律的に提案する**仕組み。

---

## 2. 設計原則

### 2.1 SLM boundary（ADR-004 拡張）

```
SLM may hypothesize; deterministic code validates; human approves.
```

ADR-004 は D-3 で「SLM を write path に入れない」と定めている。本設計はこれを以下のように精緻化する：

| 層 | 決定的に保つ | SLM advisory を許容 |
|----|------------|-------------------|
| read path | ルーティング、audit、coverage 計測 | — (変更なし) |
| optimization | 候補 glob 生成、impact simulation、閾値判定、validation | 非構造テキストの分解候補、miss クラスタの要約、draft 文面 |
| write path | proposal dedupe、approve 時の mutation 適用 | — (変更なし) |

SLM が生成するものは全て **diagnostic output** であり、Canonical を直接更新しない。ADR-004 D-7（将来の SLM 用途も read-only 補助に限定）の趣旨を維持しつつ、**optimization 層という新しい advisory 領域**を明示的に設ける。

### 2.2 source asset ≠ delivery unit

現状の `aegis_import_doc` は 1 source → 1 doc 前提（ADR-002）。本設計は N:M のマッピングを導入する：

- 1つの README → 3つの delivery unit に分割可能
- 複数の source asset → 1つの統合 delivery unit に合成可能

**Phase 1 では新テーブルを作らない。** `documents` テーブルに `source_refs_json` カラムを追加し、provenance を記録する。既存の `source_path` はそのまま残す（単一 source の doc 用）。`source_assets` テーブルへの正式分離は、`source_refs` を query する実需が証明されてから。

```typescript
// source_refs_json の構造（実装・MCP は `src/core/types.ts` の SourceRef と同一契約）
interface SourceRef {
  asset_path: string; // repo 相対の元ファイルパス
  anchor_type: 'file' | 'section' | 'lines';
  /** whole-file は空可。section / lines は見出しパスや行範囲など（非空必須） */
  anchor_value: string;
}
// 早期ドラフトでは heading_path / line_range / symbol_id 案も検討したが、
// 実装では section（見出しアンカー）と lines（行範囲）に整理した。
// 自由文 anchor は不可 — 決定的に再解決可能な anchor のみ
```

### 2.3 sync_docs の責務分離

`source_refs_json` と legacy `source_path` は **両方載り得る**（例: import の `file_path` + 追加の `source_refs`）。論理ソース数は **`source_path` と各 ref の `asset_path` の distinct 集合**で数える（実装: `sourceRefCountFromDocument`）。

- **distinct アセットが 1** で、かつ whole-file に相当する場合（単一の `source_path`、または単一の `file` anchor ref など）: 従来どおり **`sync_docs` の whole-file hash sync** の対象になり得る
- **distinct アセットが複数**: whole-file hash は行わず、**`optimization/staleness.ts`**（および multi-source の `sync_docs` 連携）側で扱う。Level-3 の fingerprint 対象パスは `source_refs_json` 上の `asset_path` に、併存する legacy `source_path` も **和集合**で入れる（`linkedPathsForMultiSourceStaleness`）— 主ファイルと補助 ref だけの二重化を取りこぼさない。
- **単一ファイルへの slice アンカーだけ**（`section` / `lines`）：whole-file で本文と突き合わせられない。**`path_requires`** で当該ファイルへルーティングされていれば Level-3 の fingerprint が及ぶ。それ以外は hash sync／multi-source staleness の既定経路には乗らない（slice 単体の自動同期は未実装）。

単一アセットは機械的に全文同期しやすいが、複数アセットを束ねた delivery unit は optimization・セマンティック側の問題になる。

---

## 3. アーキテクチャ: `optimization/` 層の新設

### 3.1 層の分離

```
src/core/optimization/       — 「何をすべきか」を計算する層
  edge-candidate-builder.ts   — Edge 推論ロジック（3ソース）
  edge-validation.ts          — 包含判定、impact simulation
  doc-refactor.ts             — 分割トリガー検知、分割計画
  staleness.ts                — 意味的陳腐化検知（Level 1-4）
  import-plan.ts              — 初回取り込み分析

src/core/automation/          — 「いつ/どう実行するか」を制御する層
  analyzers/
    rule-analyzer.ts           — 既存（compile_miss → add_edge）
    review-correction-analyzer.ts  — 既存
    coverage-analyzer.ts       — NEW: optimization/edge-candidate を呼ぶ adapter
    doc-refactor-analyzer.ts   — NEW: optimization/doc-refactor を呼ぶ adapter
    staleness-analyzer.ts      — NEW: optimization/staleness を呼ぶ adapter
  propose.ts                   — 既存 ProposeService
```

**設計根拠:**
- `automation/` は Observation → Proposal の orchestration 層
- `optimization/` は candidate generation, validation, planning の層
- `import-plan.ts` は observation 起点ではなく admin request 起点の planner なので `optimization/` に配置
- analyzer は `optimization/` を呼ぶ **adapter** に留まる

### 3.2 `doc_gap` = derived observation（proposal ではない）

ADR-008 D-2 は `target_doc_id` からの自動 proposal 生成を見送った。現行実装の `RuleBasedAnalyzer` は placeholder 付き `update_doc` を出しており、ADR との不整合がある。

**決定:** `update_doc` を除去し、代わりに `doc_gap_detected` derived observation を emit する。

理由：
- proposal は「承認すると Canonical が変わる」単位。`doc_gap` は mutation ではなく診断
- `doc_gap_detected` は将来の `DocRefactorAnalyzer` や `KnowledgeCoverageAnalyzer` の **入力** になる
- observation → (optimization 層で分析) → proposal の 2-hop フローが自然に成立

```typescript
// doc_gap_detected observation schema
interface DocGapPayload {
  gap_kind: 'content_gap' | 'split_candidate' | 'routing_gap';
  target_doc_id?: string;        // 内容が不足していた doc（content_gap の場合）
  scope_patterns: string[];      // normalized dir globs
  evidence_observation_ids: string[];
  evidence_compile_ids: string[];
  metrics: {
    exposure_count: number;      // この doc が配信された compile 回数
    content_gap_count: number;   // content_gap として報告された回数
    distinct_clusters: number;   // 異なる path cluster からの参照数
    cohort_gap_rate: number;     // 同 kind/layer 内での相対 gap 率
  };
  suggested_next_action: 'review_doc' | 'split_doc' | 'create_doc';
  algorithm_version: string;     // 再現性用。閾値変更時に古い gap を invalidate 可能
}
```

将来 triage 状態が増えて observation では窮屈になったら `findings` テーブルに昇格する。逆に `proposal_type='doc_gap'` を先に入れると approve/reject の意味が濁る。

---

## 4. Edge 自動推論

### 4.1 3つの推論ソース

#### Source 1: コード構造からの静的推論（完全決定的）

```typescript
interface PathCluster {
  pattern: string;           // 正規形 glob: "path/to/dir/**"
  files: string[];
  common_imports: string[];
  layer_hint: string;
  confidence: 'high' | 'medium' | 'low';
}

// ディレクトリ構造 + import グラフから path cluster を生成
// SLM 不要、完全決定的
```

#### Source 2: compile_miss パターンからの学習（決定的集計 + SLM 要約）

```typescript
interface MissCluster {
  target_pattern: string;    // 頻出する target_files のパターン
  miss_count: number;
  common_missing_docs: string[];
  suggested_edge: { glob: string; target_doc_id: string };
  // ↑ ここまで決定的。以下は SLM advisory
  slm_rationale?: string;
}
```

#### Source 3: co-change 分析（決定的、maintenance-built cache）

```typescript
interface CoChangePattern {
  code_pattern: string;
  doc_pattern: string;
  co_change_count: number;
  total_code_changes: number;
  confidence: number;
}
```

**co-change の実行戦略:**
- request path に入れず、`maintenance` CLI の増分ジョブとして実行
- 初回のみ full scan、以後は `last_processed_commit` から増分更新
- 結果は cache テーブルに保存
- `edge-candidate-builder` は cache を読むだけ（cache がなければ graceful degradation）

### 4.2 Validation 設計

**glob 包含判定:**
- optimizer 生成の候補 glob は `path/to/dir/**` 正規形に制限 → 包含判定は prefix 比較で決定的
- 手書きの任意 glob は exact duplicate のみ厳密判定、包含は `unknown` 扱い

**impact simulation:**
- `compile_log.request.target_files` と `base_doc_ids` を使い、「この edge があったら何が変わっていたか」を計算
- Phase 1 のメトリクス:
  - `matched_compile_count`: この edge があれば doc が追加されていた compile 数
  - `observed_recovery_count`: そのうち compile_miss として報告されていた数
  - `silent_expansion_count`: miss 報告なしで追加されるケース（≠ 不要の証拠）
- **注: `over-delivery` とは呼ばない。** 無 observation は不要の証拠ではない

**compile_audit 依存:**
- `add_edge` 候補の粗い validation は compile_audit 拡張なしで先行可能
- `retarget_edge`（既存 edge との比較）は audit 拡張待ち

```typescript
interface EdgeValidationResult {
  target_exists: boolean;
  duplicate: boolean;
  subsumes: Edge | null;       // 正規形 glob のみ判定
  subsumed_by: Edge | null;    // 正規形 glob のみ判定
  impact: {
    matched_compile_count: number;
    observed_recovery_count: number;
    silent_expansion_count: number;
  };
}
```

---

## 5. ドキュメント分割

### 5.1 分割トリガー（hybrid threshold）

静的閾値のみでは初期 KB で過敏、大規模で鈍感になる。hybrid 閾値を採用：

```typescript
interface RefactorTrigger {
  // 絶対下限: 初期 KB での過敏反応を防止
  min_exposure_count: 10;
  min_content_gap_count: 3;
  // 相対閾値: cohort は全 doc ではなく同 kind/layer
  gap_rate_threshold: max(0.15, cohort_median * 3);
  // 構造的条件
  min_distinct_clusters: 2;
}
```

**`relevance_ratio` は Phase 1 では導入しない。** 現状 Aegis には positive feedback（「このドキュメントは役に立った」）がない。absence of miss は relevance の証拠ではない。Phase 1 の proxy は `gap_rate + cluster dispersion`。

将来 positive feedback が必要になった場合は、`compile_feedback` / `doc_feedback` observation を新設し、`insufficient_doc_ids` / `unnecessary_doc_ids` を明示的に収集する。

### 5.2 分割フロー

```
Step 1 (決定的): 分割トリガー検知
  - hybrid threshold に基づく自動検知
  - doc_gap_detected (gap_kind: 'split_candidate') observation を emit

Step 2 (SLM advisory): 分割候補の生成
  - SLM にドキュメント全文 + miss パターンを渡す
  - section boundaries + suggested doc_id + edge hints を生成

Step 3 (決定的 validation):
  - 分割候補が既存 edge と矛盾しないか検証
  - 分割後の compile_miss 解消をシミュレーション
  - カバレッジの回帰がないか確認

Step 4 (Proposal bundle 生成):
  - new_doc × N + retarget_edge × M + deprecate × 1
  - 人間が approve/reject/modify
```

---

## 6. Proposal bundle と承認

### 6.1 primitive の拡張

現行の proposal_type: `add_edge | update_doc | new_doc | deprecate | bootstrap`

追加:
- `retarget_edge` — 既存 edge の glob 変更
- `remove_edge` — edge の削除

### 6.2 `approveProposalBundle()` = all-or-nothing

bundle は「一緒に入らないと壊れる変更集合」であり、部分適用を許すと設計が崩れる。

```
preflightProposalBundle(bundle_id)
  → 全 leaf を current state に対して検証
  → leaf ごとの error を返す
  → 人間が修正 or bundle を分割

approveProposalBundle(bundle_id)
  → lock 下で再検証
  → 1 tx / 1 knowledge_version / 1 snapshot
  → 1 leaf でも失敗 → 全 rollback
```

**部分適用したいケースは bundle を割るべき。** bundle の定義上、partial success は矛盾。

---

## 7. 初回取り込みの革新

### 7.1 単票取り込み

```
aegis_analyze_doc (新 admin tool — read-only)
  入力: source_path or content
  処理:
    1. (決定的) セクション構造の解析
    2. (決定的) 既存 KB との重複検知
    3. (決定的) path cluster との関連性推論
    4. (SLM advisory) 分割提案 + edge hint + tag 候補
  出力: ImportPlan
    - suggested_units: Array<{ doc_id, content_slice, edge_hints, tags }>
    - overlap_warnings: Array<{ existing_doc_id, similarity }>
    - coverage_delta: "この取り込みで未カバー領域がどれだけ減るか"

aegis_execute_import_plan (新 admin tool — generates proposals)
  入力: ImportPlan + human modifications
  処理: proposal bundle を生成（approve は別途人間が行う）
```

### 7.2 一括取り込み

20+ ドキュメントの場合、単票を 20 回回す UX にはしない：

```
analyze_import_batch
  入力: source_paths[]
  処理:
    - 全文書を横断した重複検知・分割候補・coverage delta を算出
    - ドキュメント間の関連性も考慮
  出力: BatchImportPlan
    - plans: ImportPlan[]（文書ごと）
    - cross_doc_overlap: Array<{ docs: string[], overlap_section: string }>
    - total_coverage_delta

aegis_execute_import_plan(batch_plan)
  → 1 bundle_id にまとめて proposal 群を生成
  → 承認もその bundle の proposal 群だけを対象にする
```

---

## 8. 意味的陳腐化検知

```
Level 1 (決定的): source_path のハッシュ不一致 — 現状の sync_docs
Level 2 (決定的): source_path の消失・リネーム検知
Level 3 (決定的): 参照コードの変更検知
  - delivery unit が edge で紐付くファイル群の git diff を分析
  - "この doc が参照する関数名/クラス名が rename/delete された" を検知
Level 4 (SLM advisory): 意味的乖離の仮説生成
  - doc の内容と現在のコードを比較
  - 「このドキュメントの記述は現在の実装と乖離している可能性がある」を observation として提示
```

Level 1-3 は完全に決定的。Level 4 だけが SLM で、出力は observation として admin に提示されるのみ。

---

## 9. 統合ロードマップ

> 前回レポートの Phase 1-5 に今回の設計を統合

### Phase 0: ADR-008 整合 + doc_gap 導入
1. `RuleBasedAnalyzer` の placeholder `update_doc` を除去
2. `doc_gap_detected` derived observation の導入
3. ADR-008 を更新して追認
4. ADR-010 として本設計の Phase 0 部分を記録

### Phase 1: compile_audit 拡張 + schema_migrations（前回レポートと同一）
1. `schema_migrations` フレームワーク導入
2. `compile_audit` 拡張（near_miss_edges, layer_classification, budget_dropped 等）
3. `compile_audit` 契約テスト

### Phase 2: Edge mutation primitive + bundle approval
4. `retarget_edge`, `remove_edge` primitive 追加
5. `approveProposalBundle()` 実装（preflight + all-or-nothing）
6. `compile_context` debug_info 公開（Phase 1 の audit_meta を応答に含める）

### Phase 3: optimization 層の新設
7. `core/optimization/` ディレクトリ新設
8. `edge-candidate-builder`（構造推論 + miss パターン）
9. `edge-validation`（正規形 glob 包含判定 + impact simulation）
10. `doc-refactor`（hybrid threshold + 分割トリガー）
11. `staleness`（Level 1-3 決定的検知）
12. `automation/` に analyzer adapter 追加
13. co-change cache infrastructure（`maintenance` CLI の増分ジョブ）

### Phase 4: ドキュメント取り込み革新
14. `optimization/import-plan.ts`
15. `aegis_analyze_doc`（単票）/ `analyze_import_batch`（一括）
16. `source_refs_json` カラム追加
17. `sync_docs` 責務分離（単一 source = hash sync、複数 source = staleness analyze）

### Phase 5: SLM advisory 投入
18. ドキュメント分割候補の section boundary 推定
19. miss クラスタの命名・要約
20. `update_doc` / `new_doc` の draft 文面生成
21. Level 4 意味的陳腐化検知
22. 全て diagnostic output、Canonical 直接更新なし

### Phase 6+: 前回レポートの Phase 4-5
- ライフサイクル規約（deprecation with replacement, tag cleanup）
- 可観測性（aegis_get_stats, aegis doctor）
- マルチエージェント（agent_id, WorkspaceStatus）

---

## 10. ADR 影響

### ADR-004 (SLM 戦略) への影響

- D-3「SLM を write path に入れない」: **維持**。optimization 層の SLM 利用は write path ではなく advisory 層
- D-7「将来の SLM 用途も read-only 補助に限定」: **拡張**。`optimization/` 層を明示的な advisory 領域として追加。ただし SLM output は diagnostic であり、Canonical 更新の判断主体にはしない

### ADR-008 (compile_miss triage) への影響

- D-2「`target_doc_id` からの自動 proposal 生成は行わない」: **進化**。placeholder `update_doc` を除去し、`doc_gap_detected` derived observation に置き換え。ADR-008 D-4 の「compile_audit 拡張後に再検討」に沿う形
- 現行実装との不整合（`RuleBasedAnalyzer` の placeholder `update_doc`）を解消

---

## 11. 議論のハイライト

### 合意点
- **SLM boundary**: `SLM may hypothesize; deterministic code validates; human approves.`
- **source asset ≠ delivery unit**: N:M マッピング。Phase 1 は `source_refs_json`、テーブル分離は deferred
- **`doc_gap` = derived observation**: proposal ではなく診断。`proposal_type` に追加しない
- **proposal bundle = all-or-nothing**: 部分適用は bundle を割ることで対応
- **co-change = maintenance-built cache**: request path に入れない
- **glob 包含判定**: optimizer 候補は正規形に制限、手書きは exact duplicate のみ
- **閾値は hybrid**: 絶対下限 + 相対閾値（cohort は同 kind/layer）
- **positive feedback の不在を認める**: `relevance_ratio` は Phase 1 では導入しない
- **`optimization/` と `automation/` の責務分離**: analyzer は optimization を呼ぶ adapter

### Codex からの重要な指摘
- 「無 observation は不要の証拠ではない」— `silent_expansion` という命名と、positive feedback 機構の将来設計
- `doc_gap` は proposal ではなく derived observation — approve/reject の意味を濁らせない
- `approveProposalBundle()` の部分適用は bundle の定義に矛盾 — 部分適用したいなら bundle を割れ
- glob 包含判定を正規形に制限 — 任意 glob の包含判定は計算困難、実装も脆弱
- co-change 分析は maintenance-built cache — request path のレイテンシに影響させない
- `source_refs_json` 導入時に `sync_docs` の責務分離が必要
- ADR-008 と現行実装のズレ（placeholder `update_doc`）は先に解消すべき

### Claude からの重要な指摘
- source asset ≠ delivery unit の根本問題提起 — ADR-002 の 1:1 前提を超える必要性
- Edge 自動推論の 3 ソース（コード構造、compile_miss、co-change）の体系化
- impact simulation の設計 — 過去の compile_log を使った prospective replay
- ドキュメント分割の 4-step フロー — 決定的トリガー → SLM 候補 → 決定的 validation → bundle
- 意味的陳腐化検知の 4 レベル設計 — Level 1-3 決定的、Level 4 のみ SLM
- 初回取り込みの 2-step UX（analyze_doc → execute_import_plan）

---

## 付録: 検証済みの前提

| 項目 | 実態 |
|------|------|
| ADR-004 D-3 | SLM を write path に入れない — **維持** |
| ADR-008 D-2 | `target_doc_id` からの自動 proposal なし — **進化** (doc_gap observation へ) |
| `RuleBasedAnalyzer` placeholder | ADR-008 D-2 との不整合あり — Phase 0 で解消 |
| `compile_audit` | `audit_meta` 列なし、near_miss なし — Phase 1 で拡張 |
| proposal_type | `add_edge\|update_doc\|new_doc\|deprecate\|bootstrap` のみ — Phase 2 で拡張 |
| `source_refs` | 存在しない — Phase 4 で `source_refs_json` として追加 |
| `source_assets` テーブル | 存在しない — 実需証明後に正式化 |
| `optimization/` ディレクトリ | 存在しない — Phase 3 で新設 |
| co-change cache | 存在しない — Phase 3 で新設 |
| positive feedback 機構 | 存在しない — 将来検討 |
