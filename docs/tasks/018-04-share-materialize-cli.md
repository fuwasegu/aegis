---
id: "018-04"
title: "share-materialize CLI"
status: "done"
adr: "ADR-018"
phase: 9
priority: "P0"
depends_on: ["018-01", "018-02", "018-03"]
created: "2026-05-19"
closed: "2026-05-20"
closed_reason: "implemented"
---

## 概要

shared source を authoring DB に取り込み、
source-native lane の Canonical を前進させる `share-materialize` CLI を実装する。
Phase 1 は local overlay を扱わず、shared source から DB snapshot を更新する最小閉ループを作る。

## 受け入れ条件

- [ ] `share-materialize` CLI が追加されること
- [ ] 既定入力が `aegis-share/source/` であること
- [ ] materialize 前に parse / validate が走ること
- [ ] document `content_hash` を body から再計算すること
- [ ] 現在の DB state と shared source の差分から proposal 相当の変更集合を導出できること
- [ ] source-native auto-approve mode で proposal → approve → snapshot 更新まで完了できること
- [ ] materialize 後の `compile_context` は shared source ではなく DB を読むままであること
- [ ] `knowledge_version` が既存 semantics のまま増加すること
- [ ] `--dry-run` 相当で diff summary のみ確認できること
- [ ] テスト追加

## 設計詳細

### Phase 1 の閉ループ

1. source parse
2. lint validation
3. content hash recompute
4. DB diff
5. proposal-like change set
6. auto-approve mode では既存 approve 経路で snapshot 更新

### Guardrail

- shared source を `compile_context` が直接読まないこと
- parse / lint failure 時は DB を変更しないこと
- auto-approve は source-native lane 専用であること

## 実装対象

- 新規 `src/core/project-share/materialize.ts`
- `src/main.ts`
- 必要なら repository / proposal apply 周辺
- テスト (`src/core/project-share/materialize.test.ts`, `src/main-cli.test.ts` 相当)

## テスト観点

- valid source から DB を前進できること
- dry-run が DB を変更しないこと
- malformed source で DB 変更なしに fail すること
- materialize 後に `share-export` した bundle が source と compile parity を保つこと

