# ADR-014: Maintenance CLI とフィードバック自動化

**ステータス:** Proposed
**日付:** 2026-03-31

## 関連議題

- [改善議論レポート](../aegis-improvement-discussion-2026-03-31.md) — セクション 2.2, 2.5, 2.8

## コンテキスト

`process_observations`, `archive_observations`, `sync_docs`, `check_upgrade` は全て手動トリガー。
運用では observation が溜まり続け、stale doc が放置される。

これらを `compile_context` に混ぜると P-1/INV-6 違反になるため、
admin 側の CLI サブコマンドとして切り出す。

## 決定

### 1. `maintenance` CLI サブコマンド

```
npx aegis maintenance              # 全メンテナンス操作を一括実行
npx aegis maintenance --dry-run    # 変更せずレポートのみ

実行内容（順序固定）:
1. process_observations — 未分析 observation の処理
2. sync_docs — source_path とのハッシュ不一致検知
3. archive_observations — 90日超 observation のアーカイブ
4. check_upgrade — テンプレート更新チェック
```

**スコープ制限:** 自動 **承認** は行わない（P-3 堅守）。
自動化は「提案の生成」と「状態の検知」まで。

### 2. `sync_docs` の staleness 検知強化

現状の hash 不一致検知に加え:
- **source_path 削除検知**: ファイルが存在しない場合 `not_found` として報告（ADR-010 Phase 1）
- **大幅変更検知**: hash 不一致 + 変更率が閾値超の場合、observation を自動生成
- **compile-time staleness warning**: `source_path` 付きドキュメントで最終 sync が N 日以上前なら `warnings` に追加

### 3. ドキュメントライフサイクル規約

#### Deprecation with replacement

`deprecate` proposal に `replaced_by_doc_id` フィールドを追加:
- `approveProposal` の deprecate 処理で、対象 doc の `tag_mappings` を自動削除
- 置換関係（doc A は doc B に置き換えられた）の追跡が可能に

#### Tag cleanup on deprecate

`approveProposal` の deprecate 処理に `tag_mappings` クリーンアップを組み込む:
- deprecated doc を指す orphaned mapping の自動削除
- `aegis_get_stats` の health check で orphaned mapping を検出可能に

### 4. `doctor` / `stats` CLI サブコマンド

```
npx aegis doctor    # ヘルスチェック
npx aegis stats     # 知識ベース統計
```

`aegis_get_stats` admin ツール（ADR-012）の CLI ラッパーとして実装。

### 5. CLI 体系の整理

```
npx aegis serve --surface agent     # 既存
npx aegis serve --surface admin     # 既存
npx aegis deploy-adapters           # 既存
npx aegis maintenance               # 新規: 定期メンテナンス
npx aegis stats                     # 新規: 知識ベース統計
npx aegis doctor                    # 新規: ヘルスチェック
```

## 実装フェーズ

### Phase 1: maintenance CLI (本 ADR の主スコープ)

1. `main.ts` に `maintenance` サブコマンド追加
2. orchestration ロジック（process → sync → archive → check_upgrade）
3. `--dry-run` モード

### Phase 2: staleness 強化

4. `sync_docs` の source_path 削除検知
5. compile-time staleness warning
6. `maintenance` で staleness 結果をレポート

### Phase 3: ライフサイクル規約

7. `deprecate` proposal に `replaced_by_doc_id` フィールド追加
8. `approveProposal` deprecate 処理で `tag_mappings` 自動クリーンアップ

### Phase 4: 可観測性 CLI

9. `doctor` サブコマンド実装
10. `stats` サブコマンド実装

## 依存関係

- **ADR-010 (Document Ownership)**: `sync_docs` の対象フィルタが `ownership = 'file-anchored'` に変更
- **ADR-012 (Compile Diagnostics)**: `aegis_get_stats` の基盤データ

## 帰結

### 正の帰結

- observation の滞留を防ぎ、フィードバックループが回る
- stale knowledge の早期検知・警告
- ドキュメント退役時の orphaned mapping を自動クリーンアップ

### 負の帰結

- CLI サブコマンドの管理コスト
- `maintenance` の実行タイミングは運用者の責任（cron 等の外部スケジューラに委ねる）

### 維持される不変条件

- **P-1**: maintenance は read path に影響しない
- **P-3**: 自動承認は行わない。提案の生成と検知まで
- **INV-6**: CLI は admin 権限で実行
