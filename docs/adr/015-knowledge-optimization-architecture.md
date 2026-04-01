# ADR-015: Knowledge Optimization アーキテクチャ

**ステータス:** Proposed
**日付:** 2026-03-31

## 関連議題

- [Knowledge Optimization Design](../aegis-knowledge-optimization-design-2026-03-31.md)
- [改善議論レポート](../aegis-improvement-discussion-2026-03-31.md) — セクション 2.4
- [ADR-004: SLM Role and Strategy](004-slm-role-and-strategy.md)
- [ADR-008: compile_miss Structured Observation and Triage](008-compile-miss-structured-observation-and-triage.md)
- [ADR-010: Document Ownership](010-document-ownership-and-reconciliation-model.md)

## コンテキスト

Aegis のコンパイル精度は「どのドキュメントが存在し、どの Edge でルーティングされるか」に完全に依存する。
しかし現状:

1. **ドキュメントの粒度設計が人間任せ** — 混在する関心事が不要コンテキストの配信を引き起こす
2. **Edge の設計が人間任せ** — 最適な glob 構成には専門知識が必要
3. **既存ドキュメントの取り込みが生のまま** — Aegis 向けに最適化された粒度ではない
4. **陳腐化検知がハッシュ比較のみ** — 意味的な乖離を検知できない

### ADR-008 との不整合

ADR-008 D-2 は `target_doc_id` からの自動 proposal 生成を見送った。
しかし現行の `RuleBasedAnalyzer` は placeholder 付き `update_doc` を出しており不整合がある。

## 決定

### 1. SLM boundary の精緻化

```
SLM may hypothesize; deterministic code validates; human approves.
```

| 層 | 決定的に保つ | SLM/Agent advisory を許容 |
|----|------------|------------------------|
| read path | ルーティング、audit | — |
| optimization | 候補生成、validation、閾値判定 | テキスト分解候補、要約、draft 文面 |
| write path | proposal dedupe、approve 時の mutation | — |

ADR-011 の P-agent 原則により、SLM advisory の多くは Agent 委譲で代替可能。

### 2. `optimization/` 層の新設

```
src/core/optimization/
  edge-candidate-builder.ts  — Edge 推論ロジック（3ソース）
  edge-validation.ts         — 包含判定、impact simulation
  doc-refactor.ts            — 分割トリガー検知、分割計画
  staleness.ts               — 意味的陳腐化検知（Level 1-4）
  import-plan.ts             — 初回取り込み分析
```

**`automation/` との責務分離:**
- `automation/` = Observation → Proposal の orchestration 層
- `optimization/` = candidate generation, validation, planning の層
- analyzer は `optimization/` を呼ぶ **adapter** に留まる

### 3. `doc_gap_detected` = derived observation（proposal ではない）

`RuleBasedAnalyzer` の placeholder `update_doc` を除去し、
`doc_gap_detected` derived observation に置き換える。

```typescript
interface DocGapPayload {
  gap_kind: 'content_gap' | 'split_candidate' | 'routing_gap';
  target_doc_id?: string;
  scope_patterns: string[];
  evidence_observation_ids: string[];
  evidence_compile_ids: string[];
  metrics: {
    exposure_count: number;
    content_gap_count: number;
    distinct_clusters: number;
    cohort_gap_rate: number;
  };
  suggested_next_action: 'review_doc' | 'split_doc' | 'create_doc';
  algorithm_version: string;
}
```

理由: proposal は「承認すると Canonical が変わる」単位。`doc_gap` は mutation ではなく診断。

### 4. Edge 自動推論（3ソース）

1. **コード構造からの静的推論** (完全決定的): ディレクトリ構造 + import グラフ → PathCluster
2. **compile_miss パターンからの学習** (決定的集計): 頻出 target_files パターン → MissCluster
3. **co-change 分析** (決定的、maintenance-built cache): コード変更とドキュメント参照の相関

co-change は request path に入れず、`maintenance` CLI の増分ジョブとして実行。

### 5. Edge Validation

- **glob 包含判定**: optimizer 候補は `path/to/dir/**` 正規形に制限 → prefix 比較で決定的
- **impact simulation**: `compile_log` を使い「この edge があったら何が変わっていたか」を計算
- 手書きの任意 glob は exact duplicate のみ厳密判定

### 6. ドキュメント分割（hybrid threshold）

```typescript
interface RefactorTrigger {
  min_exposure_count: 10;
  min_content_gap_count: 3;
  gap_rate_threshold: max(0.15, cohort_median * 3);
  min_distinct_clusters: 2;
}
```

分割フロー: 決定的トリガー検知 → Agent が分割案生成 → 決定的 validation → proposal bundle

### 7. Proposal bundle と承認

#### 新 primitive

- `retarget_edge` — 既存 edge の glob 変更
- `remove_edge` — edge の削除

#### `approveProposalBundle()` = all-or-nothing

```
preflightProposalBundle(bundle_id) → leaf ごとの検証結果
approveProposalBundle(bundle_id) → 1 tx / 1 knowledge_version / 1 snapshot
```

部分適用したいケースは bundle を割るべき。

### 8. 意味的陳腐化検知（4 レベル）

- **Level 1** (決定的): source_path のハッシュ不一致 — 現状の sync_docs
- **Level 2** (決定的): source_path の消失・リネーム検知
- **Level 3** (決定的): 参照コードの変更検知（関数名/クラス名の rename/delete）
- **Level 4** (Agent advisory): 意味的乖離の仮説生成 → observation として提示

### 9. 初回取り込みの革新

```
aegis_analyze_doc (新 admin tool — read-only)
  → ImportPlan: suggested_units[], overlap_warnings[], coverage_delta

aegis_execute_import_plan (新 admin tool — generates proposals)
  → proposal bundle 生成（approve は別途人間が行う）
```

一括取り込み（20+ ドキュメント）は `analyze_import_batch` で横断分析。

### 10. `source_refs_json` カラム（N:M マッピング）

```typescript
interface SourceRef {
  asset_path: string;
  anchor_type: 'file' | 'heading_path' | 'line_range' | 'symbol_id';
  anchor_value?: string;
}
```

Phase 1 では `documents` テーブルに `source_refs_json` TEXT カラムを追加。
`source_assets` テーブルへの正式分離は実需証明後。

### 11. マルチエージェント協調（将来拡張）

- `compile_log` に `agent_id` 列追加（オプション、自己申告）
- `WorkspaceStatus` API — compile_log + observations + proposals から集計
- Canonical mutation なし（read model として切り出し）

## 実装フェーズ

### Phase 0: ADR-008 整合 + doc_gap 導入

1. `RuleBasedAnalyzer` の placeholder `update_doc` を除去
2. `doc_gap_detected` derived observation の導入
3. ADR-008 を更新して追認

### Phase 1: Edge mutation primitive + bundle approval

4. `retarget_edge`, `remove_edge` primitive 追加
5. `approveProposalBundle()` 実装（preflight + all-or-nothing）

### Phase 2: optimization 層の新設

6. `core/optimization/` ディレクトリ新設
7. `edge-candidate-builder`（構造推論 + miss パターン）
8. `edge-validation`（正規形 glob 包含判定 + impact simulation）
9. `doc-refactor`（hybrid threshold + 分割トリガー）
10. `staleness`（Level 1-3 決定的検知）
11. `automation/` に analyzer adapter 追加
12. co-change cache infrastructure

### Phase 3: ドキュメント取り込み革新

13. `optimization/import-plan.ts`
14. `aegis_analyze_doc` / `analyze_import_batch`
15. `source_refs_json` カラム追加
16. `sync_docs` 責務分離

### Phase 4: Agent advisory 投入

17. Level 4 意味的陳腐化検知（Agent 委譲）
18. ドキュメント分割候補の section boundary 推定（Agent 委譲）

### Phase 5: マルチエージェント

19. `compile_log` への `agent_id` 追加
20. `WorkspaceStatus` API

## 依存関係

- **ADR-012 (Compile Diagnostics)**: impact simulation に compile_log の audit_meta が必要
- **ADR-013 (Schema Migration)**: source_refs_json, doc_lineage 等のスキーマ変更基盤
- **ADR-010 (Document Ownership)**: source_refs と ownership の整合
- **ADR-011 (Intent Tagging)**: Agent advisory パターンの基盤（P-agent 原則）
- **ADR-014 (Maintenance CLI)**: co-change cache の更新基盤

## 帰結

### 正の帰結

- Edge/ドキュメント設計の専門知識への依存を低減
- 知識ベースの自律的な進化基盤を提供
- ADR-008 との不整合を解消
- Agent 委譲パターンにより SLM 環境依存をさらに低減

### 負の帰結

- `optimization/` 層の実装・テストコスト
- `doc_gap_detected` 導入により既存の `RuleBasedAnalyzer` の書き換えが必要
- proposal bundle の all-or-nothing は UX の柔軟性を制限する（意図的なトレードオフ）

### 維持される不変条件

- **P-1**: optimization の出力は proposal であり、ルーティングに直接影響しない
- **P-3**: 全ての Canonical mutation は人間承認必須
- **D-3**: SLM/Agent advisory は write path に入らない
- **INV-6**: optimization ツールは admin surface のみ
