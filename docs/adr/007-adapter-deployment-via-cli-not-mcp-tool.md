# ADR-007: Adapter 配布は MCP ツールではなく CLI / setup flow で行う

**ステータス:** Implemented
**日付:** 2026-03-13

## 関連議題

- [Adapter デプロイの自動化とツール削減](../議題_Adapterデプロイの自動化とツール削減.md)
- [Adapter 戦略と IDE 統合](../議題_Adapter戦略とIDE統合.md)
- [ADR-005: Adapter は opt-in の配布レイヤとし、自動デプロイしない](./005-adapter-strategy-and-ide-integration.md)

---

## コンテキスト

ADR-005 では、Adapter を Aegis core から分離した convenience layer と位置づけ、
`init_confirm` からの自動デプロイをやめ、
admin の明示 MCP ツール `aegis_deploy_adapters` で配布する方針を採用した。

この判断により、
「Aegis が勝手に workspace の IDE 設定ファイルを書き換える」
という侵襲性は下げられた。
一方で、運用してみると別の問題が見えてきた。

- `aegis_deploy_adapters` は導入時と稀な再配布時しか使わない低頻度ツールである
- それでも admin surface の常設ツール一覧に載り続け、会話コンテキストを消費する
- `init_confirm` の直後に追加でもう 1 ツール呼び出しが必要になり、導入 UX が悪い

ただし、この問題を
「`init_confirm` に adapter 配布を戻す」
だけで解決するのは適切ではない。

理由:

- `non-fatal` 化で解決できるのは「adapter 失敗で init 全体が失敗する」問題だけである
- ADR-005 が避けたかった本質には
  「Canonical 初期化ツールが workspace ファイルを書き換える所有権の問題」
  も含まれている
- adapter の再配布は init 後にも必要になりうるが、
  現在の `init_confirm` は初期化済みプロジェクトで再実行できない

つまり、必要なのは
「adapter 配布を自動化して UX を良くすること」
であって、
「workspace 変更を MCP ツールとして常設すること」
でも
「`init_confirm` 自体に workspace 変更責務を戻すこと」
でもない。

---

## 決定

### D-1: ADR-005 の基本原則は維持する

以下の原則は維持する。

- Adapter は Aegis core ではなく opt-in の convenience layer である
- MCP の tools/resources/prompts が一次配布面である
- Adapter は managed file / managed block のみを更新する
- Adapter 失敗は常に non-fatal とする

この ADR は Adapter 概念を撤回しない。
変更するのは「配布のインターフェース」である。

### D-2: `aegis_deploy_adapters` は MCP ツールとしては提供しない

adapter 配布は MCP tool surface から外す。
`aegis_deploy_adapters` のような低頻度・workspace 変更系の管理操作を、
常設の MCP ツールとして公開しない。

MCP ツール一覧には、原則として次を優先して残す。

- エージェントが通常の task loop で必要とする操作
- admin が review / approval loop で対話的に使う操作

adapter 配布はそのどちらでもなく、ローカル環境のセットアップ作業である。

### D-3: adapter 配布は CLI / setup flow で提供する

adapter 配布は、MCP ツールではなくローカル CLI として提供する。

想定インターフェース:

- `aegis init --deploy-adapters`
- `aegis deploy-adapters --project-root <path> [--targets cursor,claude,codex]`

これにより、
初回導入では「初期化と配布をまとめて 1 コマンドで実行」でき、
再配布では「init を再実行せず adapter だけ更新」できる。

### D-4: `aegis_init_confirm` は Canonical 初期化専用のまま保つ

`aegis_init_confirm` は Canonical Knowledge を bootstrap する admin 操作であり、
workspace 上の IDE 設定ファイルを書き換える責務を持たせない。

detect → confirm → deploy を 1 体験にまとめたい場合は、
CLI 側が orchestration する。
MCP の `init_confirm` 自体は purity を保つ。

### D-5: 再配布トリガーは明示 CLI のみとする

adapter の再配布は以下では行わない。

- `init_confirm` 再実行
- proposal approve 時の自動フック
- サーバー起動時の自動検出

必要なときに、利用者が明示的に CLI を実行する。
これにより、workspace 変更の責任とタイミングを人間が保持する。

### D-6: adapter の冪等性と結果分類を明示する

adapter は現在の方針どおり、
managed file / managed block のみを書き換える。

加えて、配布結果は少なくとも次を区別できるようにする。

- `created`
- `updated`
- `skipped`
- `conflict`
- `failed`

「失敗を握りつぶして黙る」のではなく、
non-fatal でありつつ結果は呼び出し元へ返す。

### D-7: ツール数削減の基準は「低頻度」ではなく「対話ループ必須性」とする

今後の admin ツール削減は、
単に使用頻度だけで決めない。

判断基準は、
その操作が
「エージェントや admin の対話ループの中で、その場で MCP として呼べる必要があるか」
である。

- 必要が低いローカル保守操作は CLI 化を優先する
- review や approval に直結する操作は MCP に残す

`aegis_deploy_adapters` は前者に属する。
`aegis_process_observations` など他ツールは、この基準で個別に再評価する。

### D-8: resources/prompts は強化するが、adapter の完全代替とはみなさない

MCP resource / prompt は引き続き強化する。
特に prompt は、Aegis の推奨ワークフローを標準面で伝えるために有効である。

ただし、adapter の役割は
「永続的なルール注入」
であり、標準 MCP 面だけで完全に代替できるとは現時点では見なさない。

標準面を first-class にしつつ、
adapter は必要な環境向けの二次的補助として残す。

---

## 却下した代替案

### A-1: `init_confirm` へ adapter 配布を再統合する

却下。
UX は改善するが、
Canonical 初期化と workspace 変更の責務が再び混ざる。
ADR-005 が整理した所有権境界を壊す。

### A-2: `aegis_deploy_adapters` を MCP ツールのまま維持する

却下。
導入時の利便性よりも、
常設ツール一覧のノイズとコンテキスト消費の方が大きい。

### A-3: サーバー起動時に adapter の欠落を自動検出して生成する

却下。
project root の決定、複数 workspace、Git 管理下ファイルの自動変更など、
責務と副作用が重い。

### A-4: adapter 自体を廃止し、resources/prompts のみで対応する

却下。
現時点では、運用ルールの永続注入としては弱い。
MCP 標準面は主軸だが、adapter を完全に不要とはしない。

---

## 影響

### 実装タスク

1. `aegis_deploy_adapters` の MCP ツール登録を削除する
2. adapter 配布を呼ぶ CLI サブコマンドを追加する
3. 初回導入を 1 ステップ化するため、`init` 系 CLI から opt-in で adapter 配布を呼べるようにする
4. adapter 配布結果を `created/updated/skipped/conflict/failed` で返す
5. README / AGENTS / CLAUDE の記述を「MCP ツール実行」から「CLI / setup flow」へ更新する
6. MCP prompt を追加し、標準面のワークフロー誘導を強化する

### ADR-005 との関係

この ADR は ADR-005 の基本方針を維持しつつ、
以下を更新する。

- ADR-005 D-3「admin の明示 MCP ツールで配布する」を supersede する
- ADR-005 D-6「明示トリガーのみ」を維持しつつ、その実体を MCP tool ではなく CLI に置き換える

---

## 備考

- この ADR は「adapter を自動化したい」という要求を、
  「MCP に常設ツールを増やさず、setup flow へ逃がす」ことで解く
- 目的は、ツール数削減と導入 UX 改善を両立しつつ、
  workspace 所有権の境界を守ることにある
