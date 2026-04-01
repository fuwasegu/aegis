---
id: "015-04"
title: "approveProposalBundle() (all-or-nothing) 実装"
status: "open"
adr: "ADR-015"
phase: 3
priority: "P2"
depends_on: ["015-03"]
created: "2026-03-31"
closed: ""
closed_reason: ""
---

## 概要

複数 proposal をまとめた bundle の all-or-nothing 承認を実装する。preflight 検証と 1 トランザクション承認。

## 受け入れ条件

- [ ] `preflightProposalBundle(bundle_id)` が全 leaf を検証し、leaf ごとの結果を返すこと
- [ ] `approveProposalBundle(bundle_id)` が 1 tx / 1 knowledge_version / 1 snapshot で処理すること
- [ ] 1 leaf でも失敗 → 全 rollback
- [ ] bundle 内の proposal 間の依存関係が適切に処理されること
- [ ] admin surface にツール登録
- [ ] テスト追加
