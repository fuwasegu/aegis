---
id: "000-01"
title: "大規模 DAG + budget allocator の負荷テスト"
status: "done"
adr: ""
phase: 2
priority: "P2"
depends_on: ["012-01"]
created: "2026-03-31"
closed: "2026-04-18"
closed_reason: ""
---

## 概要

100+ docs, 500+ edges での budget allocator パフォーマンス特性を計測する。near_miss_edges 収集のコストも含む。

## 受け入れ条件

- [x] 100+ docs, 500+ edges のテストフィクスチャが用意されていること
- [x] compile_context のレイテンシが許容範囲内であること（ローカル自動検証は目標 `<500ms`、CI は遅い環境向けにテスト既定で `<750ms`。`AEGIS_LARGE_DAG_PERF_MAX_MS` で上書き）
- [x] near_miss_edges 収集を含むオーバーヘッドが計測されていること
- [x] ボトルネックが特定・文書化されていること

## 完了メモ

実装: `src/core/read/compiler.large-dag.perf.test.ts`。（1）ルーティング負荷: 120 doc・520 path エッジ。（2）allocator 負荷: 同上に加え source_path + 2KB ×120 の本文と `max_inline_bytes=50000` で budget_dropped が多数発生することを検証。

計測の代表値（開発マシン・単発）: 両ケース合計 wall 〜100ms 級、`near_miss_edge_scan_ms` は数〜数十 ms。ボトルネックは routing の全エッジ scan + picomatch；allocator 側はインライン予算割当のためのソート／走査。
