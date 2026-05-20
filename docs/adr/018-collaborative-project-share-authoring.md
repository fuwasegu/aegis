# ADR-018: Collaborative Project-Share Authoring

**ステータス:** Proposed
**日付:** 2026-05-18

## 関連ドキュメント

- [ADR-017: Project-Shared Canonical Bundle と Replica Hydration](017-project-shared-canonical-distribution.md)
- [ADR-016: Source Artifact と Compile Unit の分離、および Drift Reconciliation モデル](016-source-artifact-compile-unit-and-drift-reconciliation.md)
- [ADR-010: Document Ownership と Reconciliation モデル](010-document-ownership-and-reconciliation-model.md)
- [議題: Project-shared Canonical の共同編集モデル](<../議題_Project-shared共同編集モデル.md>)

---

## コンテキスト

ADR-017 は approved Canonical を deterministic な bundle artifact (`aegis-share/`) として
repo に同梱し、各 clone が local replica DB に hydrate する仕組みを確立した。
これは onboarding / CI / read-only agent に強い一方、
一般的なチーム authoring には以下のズレがある:

- `canonical.json` は single-file JSON であり、diff / conflict resolution が困難
- `share-hydrate` は whole-DB replacement であり、local operational state を消す
- 複数人が並行して知識を改善し、Git branch / PR / merge で取り込みたいという期待に応えられない

本 ADR は、ADR-017 を**置き換えない**。
ADR-017 の distribution model の上に、
**human-editable source レイヤーを追加する新しい authoring mode** を定義する。

---

## Non-goals

Phase 1 で明示的にスコープ外とするもの:

- local overlay（clone ローカルの未公開 knowledge diff）
- AI による自動 conflict resolution
- delta bundle / in-place sync
- `knowledge_version` semantics の変更
- `snapshot_id` の再定義
- 中央 authoring service / DB

---

## 決定

### D-1: ADR-017 を置き換えず、上位に collaborative authoring source を足す

ADR-017 の 3 面モデル（authoring DB / shared bundle / hydrated replica）はそのまま維持する。

本 ADR が追加するのは:

- **shared source**: Git 管理される human-editable なファイル群
- **materialize**: shared source を authoring DB に適用する CLI
- **lint / format**: shared source の整合性を保証するツール

bundle (`aegis-share/canonical.json`) は引き続き distribution artifact として残る。
shared source と bundle は別レイヤーであり、フローは:

```
shared source → materialize → authoring DB → share-export → bundle → share-hydrate → replica DB
```

### D-2: 2-lane approval model

Canonical mutation の承認経路を 2 つの lane に分ける。

| Lane | 承認の位置 | 用途 |
|------|-----------|------|
| **DB-native lane** | Observation → Proposal → `aegis_approve_proposal` | agent-driven な知識改善。従来どおり |
| **source-native lane** | shared source への PR merge → materialize | 人間主導の共同編集 |

両 lane は排他ではなく共存する。

- DB-native lane は現行の Observation → Proposal → Approve をそのまま使う
- source-native lane では、PR merge 自体を人間承認として扱う
- source-native lane の materialize でも validate / hash recompute は必須

**禁止事項:**
PR merge = approval を Aegis 全体の approve semantics に一般化しないこと。
source-native lane の承認は、shared source authoring に限定する。

### D-3: `knowledge_version` は Phase 1 では現行 semantics を維持する

現行の `knowledge_version` は DB 内で単調増加し、
`snapshot_id` は `knowledge_version` を含めて生成される。
ADR-017 の project-share status も `knowledge_version` + `snapshot_id` 前提である。

Phase 1 では:

- `knowledge_version` semantics を崩さない
- materialize は DB の approve 経路を経由するため、`knowledge_version` は自然に増加する
- shared identity が必要になった場合は `source_revision` / manifest hash を別途導入する
- `snapshot_id` 再定義は別 ADR レベルとする

### D-4: shared source のファイルフォーマット

shared source は `aegis-share/source/` に配置する。
人間が diff / review しやすい構成とする。

```
aegis-share/
  manifest.json           # ADR-017 の distribution bundle (既存)
  canonical.json          # ADR-017 の distribution bundle (既存)
  source/                 # 本 ADR で追加する collaborative authoring source
    documents/
      <doc_id>.md         # frontmatter + Markdown body
    edges/
      path-requires.json  # source_type 単位で分割
      layer-requires.json
      command-requires.json
      doc-depends-on.json
    layer-rules.json
    tag-mappings.json
```

#### documents

各ドキュメントは `<doc_id>.md` として配置する。
frontmatter に metadata を持ち、body がドキュメント本文:

```markdown
---
doc_id: architecture-guide
title: Architecture Guide
kind: guideline
ownership: file-anchored
source_path: docs/architecture-guide.md
---

ここにドキュメント本文を書く。
```

`content_hash` は frontmatter に含めない。materialize 時にサーバー側で再計算する。

#### edges

`edges.json` 1 枚ではなく、source type 単位で分割する。
これにより、collaborative 編集時の hotspot（全 edge が 1 ファイルに集中する問題）を回避する。

各ファイルは edge の配列:

```json
[
  {
    "edge_id": "e-arch-domain",
    "source_value": "src/domain/**",
    "target_doc_id": "architecture-guide",
    "edge_type": "path_requires",
    "priority": 1,
    "specificity": 10
  }
]
```

`source_type` は各 edge ファイル名から暗黙的に導出する（`path-requires.json` → `source_type: "path"`）。

#### layer-rules / tag-mappings

それぞれ単一 JSON ファイルとする。
Phase 1 では hotspot になりにくい規模のため、分割は不要。

### D-5: lint / format 境界

shared source を materialize する前に、整合性を保証する lint / format ステップを必須とする。

最低限の検証:

- JSON / YAML / frontmatter の parse 可能性
- required fields の存在確認
- duplicate ID の検出
- dangling reference の検出（edge が存在しない document / doc_id を参照していないか）
- deterministic formatting（key 順、配列順の正規化）

Phase 1 の想定 CLI:

- `aegis share-lint` — 検証のみ（exit 1 on error）
- `aegis share-format` — deterministic formatting を適用

### D-6: materialize の boundary

materialize は shared source を読み取り、authoring DB に適用する操作。

Phase 1 の materialize は:

1. shared source を parse / validate する
2. `content_hash` を body から再計算する（shared source 上の hash は trust しない）
3. 現在の DB 状態と diff を取る
4. 差分から proposal を生成し、source-native auto-approve mode では同一実行内で approve まで完了する

auto-approve mode は source-native lane 専用。
PR merge 済み = 人間承認済みという前提で、
materialize 時に proposal → approve を一括で行う。
Canonical mutation・`knowledge_version` bump・snapshot 生成は、既存の approve 経路に揃える。

**禁止事項:**
`compile_context` が shared source を直接読むことは禁止する。
runtime SoT は常に DB である。

### D-7: Guardrails

本 ADR で明示する禁止事項:

1. **`compile_context` は shared source を直接読まない** — runtime SoT は DB のみ
2. **source-native lane でも validate / hash recompute を必須にする** — shared source の content_hash を trust しない
3. **PR merge = approval は source-native lane 限定** — DB-native lane の approve semantics を変更しない
4. **Phase 1 では local overlay を扱わない** — shared base + operational state の 2 層のみ

---

## Phase plan

### Phase 1: 閉ループの確立

目標: shared source → lint/format → materialize to authoring DB → share-export → share-hydrate replica

1. shared source ファイルフォーマットの確定と parser 実装
2. `share-lint` CLI
3. `share-format` CLI
4. `share-materialize` CLI（auto-approve mode 付き）
5. authoring DB → shared source bootstrap 生成（初期導入用）
6. README / setup guidance の更新

### Phase 2: 運用改善

7. CI integration（`share-lint` を PR check に組み込む）
8. conflict assist（formatting / reference update の補助）
9. `share-export` と shared source の双方向同期

### Phase 3: 高度な同期

10. local overlay の設計・実装
11. delta materialize（差分適用）
12. AI-assisted conflict resolution の検討

---

## ADR-017 との関係

| 責務 | ADR-017 | ADR-018 |
|------|---------|---------|
| bundle format | `manifest.json` + `canonical.json` | 変更なし（そのまま使う） |
| distribution | `share-export` → `share-hydrate` | 変更なし |
| authoring source | なし | `aegis-share/source/` を追加 |
| materialize | なし | shared source → authoring DB |
| lint / format | なし | `share-lint` / `share-format` |
| approval | DB-native のみ | 2-lane（DB-native + source-native） |

ADR-017 は distribution layer であり、ADR-018 は authoring layer である。
両者は独立して機能し、ADR-018 を導入しなくても ADR-017 単体で完結する。

---

## 却下した代替案

### A-1: ADR-017 を collaborative mode で置き換える

却下。
ADR-017 の distribution model は onboarding / CI / replica に引き続き有効。
置き換えではなく上位追加が安全。

### A-2: `knowledge_version` を local sequence 化する

Phase 1 では却下。
`snapshot_id` が `knowledge_version` を含んで生成されること、
project-share status が `knowledge_version` + `snapshot_id` 前提であることから、
Phase 1 で semantics を崩すとリグレッションが大きい。

### A-3: PR merge = approval を Aegis 全体に一般化する

却下。
DB-native lane（Observation → Proposal → Approve）との二重化を招く。
source-native lane 限定として明示する。

### A-4: `edges.json` を単一ファイルにする

却下。
collaborative 編集では全 edge が 1 ファイルに集中し、
Git conflict の hotspot になりやすい。
source type 単位での分割を採用する。

---

## 帰結

### 正の帰結

- Git / PR / code review と自然に整合する共同編集が可能になる
- ADR-017 の distribution model を壊さずに authoring mode を追加できる
- lint / format / materialize の境界により、壊れた状態の DB 適用を防げる
- 2-lane model により、agent-driven と human-driven の知識改善が共存できる

### 負の帰結

- shared source と bundle の 2 つの artifact が `aegis-share/` に共存し、役割の理解が必要
- materialize は新しい CLI コマンドと概念を導入する
- Phase 1 では local overlay を扱わないため、clone ローカルの知識差分は DB-native lane に限られる
- source-native lane の auto-approve は、通常の Aegis ガバナンスとは異なる承認経路であることを運用者が理解する必要がある
