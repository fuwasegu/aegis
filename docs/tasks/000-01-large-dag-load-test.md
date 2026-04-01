---
id: "000-01"
title: "大規模 DAG + budget allocator の負荷テスト"
status: "open"
adr: ""
phase: 2
priority: "P2"
depends_on: ["012-01"]
created: "2026-03-31"
closed: ""
closed_reason: ""
---

## 概要

100+ docs, 500+ edges での budget allocator パフォーマンス特性を計測する。near_miss_edges 収集のコストも含む。

## 受け入れ条件

- [ ] 100+ docs, 500+ edges のテストフィクスチャが用意されていること
- [ ] compile_context のレイテンシが許容範囲内であること（目標: < 500ms）
- [ ] near_miss_edges 収集を含むオーバーヘッドが計測されていること
- [ ] ボトルネックが特定・文書化されていること
