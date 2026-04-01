---
id: "015-11"
title: "マルチエージェント協調 (agent_id + WorkspaceStatus)"
status: "open"
adr: "ADR-015"
phase: 6
priority: "P3"
depends_on: ["012-02"]
created: "2026-03-31"
closed: ""
closed_reason: ""
---

## 概要

`compile_log` に `agent_id` 列を追加し、WorkspaceStatus API で複数エージェントの作業状態を可視化する。

## 受け入れ条件

- [ ] `compile_log` に `agent_id` TEXT 列追加（migration、オプション）
- [ ] `compile_context` の request に `agent_id?: string` 追加
- [ ] `WorkspaceStatus` API 実装（active_regions, unresolved_misses, pending_proposal_count）
- [ ] Canonical mutation なし（read model として切り出し）
- [ ] テスト追加
