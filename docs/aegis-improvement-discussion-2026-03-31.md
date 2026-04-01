# Aegis 改善議論レポート — 2026-03-31

> **参加者**: Claude (Opus 4.6) + Codex
> **対象**: Aegis v2 — DAG-based Deterministic Context Compiler
> **方法**: リポジトリ全体の独立調査 → クロスレビュー → 統合

---

## 1. 現状の総括

Aegis は **DAG ベースの決定的コンテキストコンパイラ** として、174 テスト・全パスの安定した基盤を持つ。P-1（決定性）・P-3（人間承認）・INV-6（エージェント読み取り専用）の設計原則が一貫しており、読み取りパス（4 ステップルーティング）と書き込みパス（Observation → Proposal → Canonical）の分離が明確。

ADR-009（delivery-aware compile）が現在進行中で、budget 制御による出力サイズ管理が Phase 1 に到達している。

**強み:**
- 決定的設計の徹底（同一入力 → 同一出力）
- 監査証跡の網羅性（compile_id, snapshot_id, proposal evidence）
- テスト比率 5:1（テスト 43K LOC / 本番 7K LOC）
- Analyzer アーキテクチャの拡張性

---

## 2. 発見した改善領域

### 2.1 compile_miss の診断情報不足（優先度: 最高）

**現状:** `compile_context` は `resolution_path`（どのエッジが発火したか）を返すが、**なぜ特定のドキュメントが含まれなかったか**の説明がない。

**エージェント視点の問題:**
- 「近いが不一致だった glob パターン」が分からない
- 「budget で切り落とされたドキュメント」と「そもそもエッジが存在しないドキュメント」の区別がつかない
- layer 推論のミス（ファイルがどの layer に分類されたか）が不透明
- `compile_miss` の observation を書く際、`missing_doc` と `target_doc_id` のどちらを使うべきか判断材料がない

**提案:**
```typescript
interface CompileDebugInfo {
  // どの layer にマッチしたか（または unmatched）
  layer_classification: Record<string, string | null>;
  // budget により inline 候補から外れたドキュメント（delivery state ではなく、inline 割り当て時の選定経緯）
  budget_dropped: Array<{ doc_id: string; bytes: number; reason: string }>;
  // 評価されたが不一致だったエッジ（近似マッチ）
  near_miss_edges: Array<{
    edge_id: string;
    pattern: string;
    target_doc_id: string;
    reason: 'glob_no_match' | 'layer_mismatch' | 'command_mismatch';
  }>;
}
```

- `near_miss_edges` があれば、エージェントは「このパターンを広げれば拾えた」と自己判断でき、observation の質が上がる
- P-1 を壊さない（診断情報は出力の付帯情報であり、ルーティングロジックに影響しない）

**議論での合意:** 両者とも最重要と認識。エージェントが自律的にフィードバックループを回すために不可欠。

---

### 2.2 フィードバックループの自動化基盤（優先度: 高）

**現状:** `process_observations`, `archive_observations`, `sync_docs`, `check_upgrade` は全て手動トリガー。運用では observation が溜まり続ける。

**議論での合意:**
- `compile_context` に混ぜるべきではない（P-1/INV-6 違反になる）
- admin 側の **CLI worker / cron ジョブ** として切り出すのが正しい
- MCP ツールとしてではなく、`main.ts` のサブコマンドとして実装

**提案アーキテクチャ:**
```
npx aegis maintenance              # 全メンテナンス操作を一括実行
npx aegis maintenance --schedule   # crontab 相当の定期実行設定

実行内容:
1. process_observations（未分析 observation の処理）
2. sync_docs（source_path とのハッシュ不一致検知）
3. archive_observations（90日超 observation のアーカイブ）
4. check_upgrade（テンプレート更新チェック）
```

**スコープ制限:** 自動 **承認** は行わない（P-3 堅守）。自動化は「提案の生成」と「状態の検知」まで。

---

### 2.3 マイグレーションフレームワーク（優先度: 高）

**現状:** `migrateSourcePaths()` はアドホックな列存在チェック型。`compile_log` には `audit_meta` 列がまだ追加されていない（ADR-009 の TODO）。

**問題:**
- スキーマ変更が増えると監査不能になる
- 「どのバージョンのスキーマで動いているか」が分からない
- ロールバック不可能

**提案:**
```sql
-- 新テーブル
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

```typescript
// src/core/store/migrations/
// 001_initial.ts
// 002_add_audit_meta.ts
// 003_normalize_source_paths.ts

interface Migration {
  version: number;
  name: string;
  up(db: Database): void;
}

function runMigrations(db: Database, migrations: Migration[]): void {
  const applied = getAppliedVersions(db);
  for (const m of migrations.filter(m => !applied.has(m.version))) {
    db.transaction(() => {
      m.up(db);
      recordMigration(db, m.version, m.name);
    });
  }
}
```

**議論での合意:** 現状の列存在チェック型は初期段階では十分だったが、ADR-009 で `audit_meta` 追加が必要な今が移行の好機。

---

### 2.4 マルチエージェント協調（優先度: 中）

**現状:** 複数エージェントが同一プロジェクトで作業する場合の設計が未考慮。

**議論での合意:**
- **コンテキスト共有**より**状態共有**が先
- 共有すべきは raw context ではなく作業状態:
  - 「このパスで未解決 compile_miss がある」
  - 「この領域は proposal review 待ち」
  - 「agent A が既にこのファイルの context を取得済み」

**提案:**
```typescript
// compile_log を活用した状態可視化 API
interface WorkspaceStatus {
  // 直近 N 時間の compile 対象ファイル（他エージェントの作業領域）
  active_regions: Array<{ path_pattern: string; last_compiled: string; agent_id?: string }>;
  // 未解決の compile_miss（重複観測の抑制に有用）
  unresolved_misses: Array<{ target_files: string[]; missing_doc?: string; count: number }>;
  // review 待ち proposal 数
  pending_proposal_count: number;
}
```

- `compile_log` に `agent_id` 列を追加（オプション、エージェント自己申告）
- 決定性を壊さない（状態情報は参考情報であり、ルーティングに影響しない）

---

### 2.5 ドキュメントライフサイクルの規約不足（優先度: 中）

**現状:**
- `deprecated` ドキュメントは read path から除外されている（`status = 'approved'` フィルタ）— 実装は正しい
- しかし「いつ deprecate するか」「何で置き換えるか」「tag_mappings の掃除」の規約がない

**問題点（Codex 指摘）:**
- 置換関係（doc A は doc B に置き換えられた）の追跡がない
- `tag_mappings` が deprecated doc を指したまま残る可能性
- `source_path` とのズレ（imported doc が source 側で削除/大幅変更されたケース）の検知が弱い
- **stale knowledge がエージェントにとって最も危険**

**提案:**
1. **Deprecation with replacement**: `deprecate` proposal に `replaced_by_doc_id` フィールドを追加
2. **Tag cleanup on deprecate**: `approveProposal` の deprecate 処理で、対象 doc の `tag_mappings` を自動削除
3. **Staleness detection in sync_docs**: hash 不一致だけでなく、source_path が削除されたケースも検知 → 自動 observation 生成
4. **Compile-time staleness warning**: `source_path` 付きドキュメントで、最終 sync が N 日以上前なら `warnings` に追加

---

### 2.6 Observability（可観測性）の不足（優先度: 中）

**現状:** `compile_audit` は個別の compile_id で取得可能だが、集約分析 API がない。

**提案:**
```typescript
// 新 admin ツール: aegis_get_stats
interface AegisStats {
  // 知識ベースの規模
  knowledge: {
    approved_docs: number;
    approved_edges: number;
    pending_proposals: number;
    knowledge_version: number;
  };
  // 直近 N 日の利用統計
  usage: {
    total_compiles: number;
    unique_target_files: number;
    avg_budget_utilization: number;  // ADR-009
    most_referenced_docs: Array<{ doc_id: string; count: number }>;
    most_missed_patterns: Array<{ pattern: string; count: number }>;
  };
  // ヘルスチェック
  health: {
    stale_docs_count: number;         // sync 未実施が N 日超
    unanalyzed_observations: number;
    orphaned_tag_mappings: number;    // deprecated doc を指す tag
  };
}
```

- エージェントが「知識ベースが健全か」を判断する材料になる
- admin が「どの領域に知識が不足しているか」をデータドリブンで判断できる

---

### 2.7 テスト戦略の優先順位（優先度: 中）

**未カバー領域（重要度順）:**

| 領域 | 重要度 | 理由 |
|------|--------|------|
| `compile_audit` の契約テスト | 最高 | ADR-009 で audit_meta が追加される。契約が壊れると監査不能 |
| observation claim/rollback の競合テスト | 高 | 複数 admin が同時に process_observations を叩くケース |
| 大規模 DAG + budget allocator の負荷テスト | 高 | 100+ docs でのパフォーマンス特性が不明 |
| `detector.ts` のユニットテスト | 中 | スタック検出が壊れると init が機能しない |
| `upgrade.ts` のユニットテスト | 中 | テンプレートアップグレードが壊れるとデータ損失の可能性 |
| ファイル I/O エラーパス | 低 | 実運用での遭遇頻度は低い |

**議論での合意:** テスト未カバー箇所の数より優先順位が重要。エージェント品質に直結するものから着手。

---

### 2.8 CLI / 運用ツールの成熟度（優先度: 低〜中）

**現状:**
- `deploy-adapters` CLI は `main.ts` にサブコマンドとして実装済み（Codex の指摘で確認）
- ただし周辺の運用 CLI（maintenance, stats, health-check）が未整備

**提案:**
```
npx aegis serve --surface agent     # 既存
npx aegis serve --surface admin     # 既存
npx aegis deploy-adapters           # 既存
npx aegis maintenance               # 新規: 定期メンテナンス一括実行
npx aegis stats                     # 新規: 知識ベース統計
npx aegis doctor                    # 新規: ヘルスチェック
```

---

## 3. 優先順位マトリクス

```
影響度 ↑
       │  [2.1 診断情報]     [2.2 自動化基盤]
  高   │       ★★★              ★★★
       │
       │  [2.3 migration]   [2.5 ライフサイクル]
  中   │       ★★               ★★
       │  [2.7 テスト戦略]  [2.4 マルチAgent]
       │       ★★               ★★
       │                    [2.6 Observability]
  低   │                         ★
       │                    [2.8 CLI]
       │                         ★
       └──────────────────────────────→ 実装コスト
            低        中        高
```

---

## 4. 推奨ロードマップ（改訂版）

> **設計原則:** `compile_audit` 拡張を土台に据え、診断・triage・テスト・WorkspaceStatus が同一基盤に乗る構成にする。

### Phase 1: compile_audit 拡張 + スキーマ基盤
> compile_audit が全ての起点。ここが固まると後続の全フェーズが同じ土台に乗る。

1. **`schema_migrations` フレームワーク導入** — `audit_meta` 列追加を最初のマイグレーションにする。ad hoc な列存在チェックを延命しない
2. **`compile_audit` 拡張** — `audit_meta` に以下を記録:
   - `delivery_stats`（inline/deferred/omitted 件数・バイト数）
   - `budget_utilization`（使用量/上限）
   - `budget_dropped`（budget により inline 候補から外れたドキュメントの doc_id・バイト数・理由。delivery state の `omitted` とは別概念で、inline 割り当て時の選定経緯を記録する）
   - `near_miss_edges`（評価されたが不一致だったエッジ）
   - `layer_classification`（各 target_file の layer 分類結果）
   - `policy_omitted_doc_ids`（ポリシーで除外されたドキュメント）
3. **`compile_audit` 契約テスト** — v1/v2 の後方互換性、audit_meta の構造検証

### Phase 2: 診断情報の compile_context 公開
> Phase 1 で audit に蓄積した情報を、エージェントが利用可能な形で公開する。

4. **`compile_context` に `debug_info` 追加** — Phase 1 で audit_meta に蓄積した `near_miss_edges`, `layer_classification`, `budget_dropped` を応答に含める（P-1 を壊さない: 診断情報はルーティングに影響しない付帯情報。データソースは audit_meta と同一で、公開経路が異なるだけ）
5. **observation 競合テスト** — 複数 admin が同時に `process_observations` を叩くケースの排他制御検証
6. **大規模 DAG 負荷テスト** — 100+ docs, 500+ edges での budget allocator パフォーマンス特性

### Phase 3: admin CLI maintenance + フィードバック自動化
> Phase 1-2 が安定した上で、運用自動化を載せる。

7. **`maintenance` CLI サブコマンド** — `process_observations` → `sync_docs` → `archive_observations` → `check_upgrade` の orchestration（P-1/INV-6 堅守: 自動承認は行わない）
8. **`sync_docs` の staleness 検知強化** — hash 不一致だけでなく、source_path 削除・大幅変更の検知 → 自動 observation 生成
9. **`detector.ts` / `upgrade.ts` ユニットテスト**

### Phase 4a: ライフサイクル規約（write side）
> 既存の `deprecate` proposal と `tag_mappings` の仕組みを拡張し、ドキュメント退役の規約を整備する。

10. **Deprecation with replacement** — `deprecate` proposal に `replaced_by_doc_id` フィールド追加、`tag_mappings` 自動クリーンアップ（`approveProposal` の deprecate 処理に組み込み）

### Phase 4b: 可観測性（read side）
> Canonical mutation を増やさず、compile_log・observations・proposals からの集計として実装する。

11. **`aegis_get_stats` / `aegis doctor`** — 知識ベース統計・ヘルスチェック（read model として切り出し）
12. **compile-time staleness warning** — source_path 付きドキュメントで最終 sync が N 日超なら warnings に追加

### Phase 5: マルチエージェント + スケール
> Phase 1-4 の基盤上に協調機能を載せる。

13. **`compile_log` への `agent_id` 追加**（オプション、自己申告）
14. **`WorkspaceStatus` API** — compile_log + observations + proposals から集計（Canonical mutation なし）
15. **migration replay テスト** — 全マイグレーションの順序実行・冪等性検証

---

## 5. 議論のハイライト

### 合意点
- **compile_audit 拡張が全ての起点** — 診断情報・triage・テスト・WorkspaceStatus が同一基盤に乗る（Codex 提案、Claude 同意）
- **compile_miss の診断情報**が最重要改善点（両者一致）
- フィードバック自動化は **admin CLI worker** として切り出すべき（P-1/INV-6 堅守）
- マルチエージェントは「コンテキスト共有」より「**状態共有**」が先
- テストは未カバー数より**優先順位**（エージェント品質直結のものから）
- マイグレーションフレームワークは ADR-009 のスキーマ変更が好機
- **WorkspaceStatus と可観測性** は read model（compile_log + observations + proposals からの集計）として切り出し、Canonical mutation を増やさない。**ライフサイクル規約**（deprecation with replacement, tag cleanup）は既存の write 機構（`approveProposal` の deprecate 処理）の拡張として実装する（Phase 4a/4b の分離に対応）

### Codex からの重要な指摘
- `deploy-adapters` CLI は実装済み（`main.ts` L242）。未成熟なのは周辺の運用 CLI
- `deprecated` の read path 除外は実装上正しい。問題は「どう退役させ、何で置き換えるか」の規約
- `compile_context` が返す `resolution_path` は「何が当たったか」だけ。**「なぜ外れたか」**がエージェントには必要
- stale knowledge がエージェントにとって最も危険。sync_docs の自動化 + staleness warning が必要
- **実装順の依存関係**: `compile_audit` 拡張 → 診断情報公開 → maintenance CLI → ライフサイクル → マルチエージェントの順が正しい。各フェーズが前のフェーズの土台を使う

### Claude からの重要な指摘
- `compile_log` に `audit_meta` 列がまだない（ADR-009 TODO）。マイグレーション基盤なしに追加するとアドホックが増える
- `tag_mappings` の削除ポリシーが未定義。deprecated doc を指す orphaned mapping が発生しうる
- Observation アーカイブの自動トリガーがない（90 日ポリシーはドキュメントのみ）
- budget utilization のトレンド追跡 API がない

### メタ考察: この議論自体の活用
- **この文書を Canonical に取り込まないと agent に効かない**（Codex 指摘）
- 現状の `compile_context` は汎用ガイド（Architecture Root, Testing Guidelines）しか返さない
- この議論結果を agent の行動規範にするなら、admin surface で `aegis_import_doc` → edge 設定が次の一手
- ただし、このドキュメントは「改善計画」であり「規範」ではない。Canonical に入れるなら、各改善領域を個別の guideline ドキュメントに分解し、実装完了に合わせて段階的に取り込むのが P-3 の趣旨に沿う

---

## 付録: 検証済みの事実

| 項目 | 実態 |
|------|------|
| `deploy-adapters` CLI | `main.ts` L242 に実装済み |
| `deprecated` の read path 除外 | `repository.ts` で `status = 'approved'` フィルタ済み |
| `compile_log` スキーマ | `audit_meta` 列なし（schema.ts L132-139） |
| マイグレーション機構 | `migrateSourcePaths()` のみ（アドホック列存在チェック） |
| 定期実行基盤 | なし（`server.ts` L28 に「periodically」のヒントテキストのみ） |
| `near_miss` / 診断情報 | `compiler.ts` に実装なし。`resolution_path` のみ |
| `schema_version` テーブル | 存在しない |
