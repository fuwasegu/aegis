# ADR-012: Compile Diagnostics と Audit Meta 拡張

**ステータス:** Proposed
**日付:** 2026-03-31

## 関連議題

- [改善議論レポート](../aegis-improvement-discussion-2026-03-31.md) — セクション 2.1, 2.6, 2.7
- [ADR-009: compile_context 出力サイズ制御](009-compile-context-output-size-control.md)
- [ADR-010: Document Ownership](010-document-ownership-and-reconciliation-model.md) — staleness 検知と ownership フィルタの整合

## コンテキスト

`compile_context` は `resolution_path`（どのエッジが発火したか）を返すが、
**なぜ特定のドキュメントが含まれなかったか**の説明がない。

エージェント視点の問題:
- 「近いが不一致だった glob パターン」が分からない
- 「budget で切り落とされたドキュメント」と「そもそもエッジが存在しないドキュメント」の区別がつかない
- layer 推論のミス（ファイルがどの layer に分類されたか）が不透明
- `compile_miss` の observation を書く際、`missing_doc` と `target_doc_id` のどちらを使うべきか判断材料がない

また、`compile_log` には `audit_meta` 列がまだ追加されていない（ADR-009 の TODO）。

## 決定

### 1. `audit_meta` に構造化診断データを記録

`compile_log` テーブルに `audit_meta` 列を追加し、以下を記録する:

```typescript
interface CompileAuditMeta {
  // ADR-009 由来
  delivery_stats: {
    inline_count: number;
    deferred_count: number;
    omitted_count: number;
    inline_bytes: number;
  };
  budget_utilization: {
    used_bytes: number;
    max_bytes: number;
  };

  // 本 ADR で追加
  budget_dropped: Array<{
    doc_id: string;
    bytes: number;
    reason: string;
  }>;
  near_miss_edges: Array<{
    edge_id: string;
    pattern: string;
    target_doc_id: string;
    reason: 'glob_no_match' | 'layer_mismatch' | 'command_mismatch';
  }>;
  layer_classification: Record<string, string | null>;
  policy_omitted_doc_ids: string[];

  // ADR-011 由来（共存）
  expanded_tagging?: ExpandedTaggingAudit;
}
```

### 2. `compile_context` に `debug_info` を公開

audit_meta に蓄積した情報をエージェントが利用可能な形で応答に含める。

```typescript
interface CompileDebugInfo {
  layer_classification: Record<string, string | null>;
  budget_dropped: Array<{ doc_id: string; bytes: number; reason: string }>;
  near_miss_edges: Array<{
    edge_id: string;
    pattern: string;
    target_doc_id: string;
    reason: 'glob_no_match' | 'layer_mismatch' | 'command_mismatch';
  }>;
}
```

- P-1 を壊さない: 診断情報はルーティングに影響しない付帯情報
- データソースは audit_meta と同一、公開経路が異なるだけ

### 3. `compile_audit` 契約テスト

- v1（audit_meta なし）/ v2（audit_meta あり）の後方互換性
- audit_meta の構造検証
- 失敗経路（BudgetExceededError）でも audit_meta が記録されること

### 4. Observability ツール（将来拡張）

Phase 2 として `aegis_get_stats` admin ツールを追加し、compile_log + observations + proposals からの集約分析を提供する:

```typescript
interface AegisStats {
  knowledge: { approved_docs; approved_edges; pending_proposals; knowledge_version };
  usage: { total_compiles; unique_target_files; avg_budget_utilization; most_referenced_docs; most_missed_patterns };
  health: { stale_docs_count; unanalyzed_observations; orphaned_tag_mappings };
}
```

## 実装フェーズ

### Phase 1: audit_meta 基盤 (本 ADR のスコープ)

1. `compile_log` テーブルに `audit_meta` TEXT 列を追加（ADR-013 の migration 基盤を使用）
2. `CompileAuditMeta` 型定義
3. `ContextCompiler` で `near_miss_edges`, `layer_classification`, `budget_dropped` を収集・記録
4. `AegisService` の audit 返却ロジック更新
5. 契約テスト追加

### Phase 2: 診断情報の公開

6. `compile_context` レスポンスに `debug_info` フィールド追加
7. `aegis_get_stats` admin ツール実装

## 依存関係

- **ADR-013 (Schema Migration)**: `audit_meta` 列追加の基盤として必要
- **ADR-011 (Intent Tagging)**: `expanded_tagging` フィールドを audit_meta に共存

## 帰結

### 正の帰結

- エージェントが「なぜ外れたか」を理解し、observation の質が向上
- compile_miss の `missing_doc` vs `target_doc_id` の判断材料が提供される
- 知識ベースの健全性をデータドリブンで判断可能に

### 負の帰結

- `near_miss_edges` の収集にはエッジ全走査が必要（パフォーマンス影響要測定）
- audit_meta のスキーマ進化管理が必要

### 維持される不変条件

- **P-1**: 診断情報はルーティングに影響しない付帯情報
- **P-3**: 変更なし
- **INV-6**: 診断情報は read-only
