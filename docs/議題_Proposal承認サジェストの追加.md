# 議題: Proposal 承認サジェストの追加

**起票日**: 2026-03-25
**ステータス**: 完了

---

## 背景

`compile_context` のレスポンスには `notices` フィールドがあり、エージェントに運用上のアクションを促す仕組みがある。

### 現行の notices

| 条件 | メッセージ |
|---|---|
| `adapterOutdated` フラグが true | `deploy-adapters` を実行してください |
| 未処理 Observation が 5 件以上 | `aegis-triage` スキルを実行するか、`aegis_process_observations` で処理してください |

### 欠けているもの

**pending 状態の Proposal が溜まっていても、エージェントも人間も気づかない。**

現状のフロー:

1. Observation が記録される
2. notices で「Observation が溜まっている」と通知 → 人間が `aegis_process_observations` を実行
3. Proposal が生成される
4. **← ここで通知がない**
5. 人間が思い出したときに `aegis_list_proposals` を確認 → 承認 / 却下

ステップ 4 に notices がないため、Proposal が生成されても放置される可能性がある。Observation のトリアージを促す仕組みはあるのに、その結果生まれた Proposal の承認を促す仕組みがない。

## 提案

`compile_context` の notices に、pending Proposal の件数に基づくサジェストを追加する。

### 実装イメージ

```typescript
// compiler.ts の notices 構築部分
const pendingProposalCount = this.repo.countPendingProposals();
if (pendingProposalCount > 0) {
  notices.push(
    `${pendingProposalCount} proposal(s) awaiting review. ` +
    'Call aegis_list_proposals on the admin surface to review and approve/reject.'
  );
}
```

### 検討事項

#### 1. しきい値

Observation は 5 件以上で通知しているが、Proposal は 1 件から通知すべきか？

| 方式 | メリット | デメリット |
|---|---|---|
| 1 件から通知 | 承認漏れを防げる | 毎回の compile で notices が出てノイズになりうる |
| N 件以上で通知 | ノイズが少ない | 少数の重要な Proposal を見逃す |
| 経過時間ベース（N 日以上 pending） | 緊急度を反映 | `proposals` テーブルに `created_at` が必要（既にある？） |

Proposal は人間が意図的に作ったもの（Observation → 分析 → 生成）なので、Observation より重要度が高い。1 件から通知するのが適切かもしれない。

#### 2. メッセージの粒度

件数だけか、Proposal の種類（`add_edge` / `update_doc` / `new_doc`）も含めるか:

- シンプル: `3 proposal(s) awaiting review.`
- 詳細: `3 proposal(s) awaiting review (2 add_edge, 1 update_doc).`

#### 3. Repository メソッド

`countPendingProposals()` が必要。既存の `getPendingProposalsByType` は型指定が必須なので、全型横断のカウントメソッドを追加する。

#### 4. P-1 との関係

`notices` は P-1（決定性）の対象外と既に定義されている（`types.ts` のコメント: `Operational notices (P-1 excluded)`）。compile_log にも記録されない。pending Proposal の件数はサーバーの状態に依存するので、P-1 除外の `notices` に置くのは設計上正しい。

## 影響範囲

- `src/core/read/compiler.ts` — notices 構築ロジックに追加
- `src/core/store/repository.ts` — `countPendingProposals()` メソッド追加
- `src/core/read/compiler.test.ts` — notices テスト追加

## 関連

- `src/core/read/compiler.ts` L269-285 — 現行の notices 構築
- `src/core/types.ts` L202-203 — notices の P-1 除外定義
- [議題: Observation 自動化パイプライン設計](議題_Observation自動化パイプライン設計.md)
