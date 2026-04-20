---
id: "015-04"
title: "approveProposalBundle() (all-or-nothing) 実装"
status: "done"
adr: "ADR-015"
phase: 3
priority: "P2"
depends_on: ["015-03"]
created: "2026-03-31"
closed: "2026-04-20"
closed_reason: ""
---

## 概要

複数 proposal をまとめた bundle の all-or-nothing 承認を実装する。preflight 検証と 1 トランザクション承認。

## 受け入れ条件

- [x] `preflightProposalBundle(bundle_id)` が全 leaf を検証し、leaf ごとの結果を返すこと
- [x] `approveProposalBundle(bundle_id)` が 1 tx / 1 knowledge_version / 1 snapshot で処理すること
- [x] 1 leaf でも失敗 → 全 rollback
- [x] bundle 内の proposal 間の依存関係が適切に処理されること
- [x] admin surface にツール登録
- [x] テスト追加

## 実装メモ

- Core: `Repository.preflightProposalBundle` / `approveProposalBundle`（`src/core/store/repository.ts`）、依存順序 `orderPendingBundleProposals`（`src/core/store/proposal-bundle-order.ts`）
- MCP: `aegis_preflight_proposal_bundle` / `aegis_approve_proposal_bundle`（admin のみ、`src/mcp/server.ts`）、`AegisService` 委譲（`src/mcp/services.ts`）
- テスト: `src/core/store/repository.test.ts`（Proposal bundle）、`src/mcp/services.test.ts`

## 完了メモ

実装は main に先行マージ済み。CriticalReview 対応: doc source / `update_doc` / ordering 失敗時の leaf 隔離、`retarget_edge` の bundle テスト、`deprecate(document)` と doc-source の `add_edge`／`retarget_edge` の Bundle conflict。CriticalReview はブロッキングなしで収束（2026-04-20）。
