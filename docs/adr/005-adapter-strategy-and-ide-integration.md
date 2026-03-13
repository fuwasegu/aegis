# ADR-005: Adapter は opt-in の配布レイヤとし、自動デプロイしない

**ステータス:** Implemented
**日付:** 2026-03-13

## 関連議題

- [Adapter 戦略と IDE 統合](../議題_Adapter戦略とIDE統合.md)
- [SLM の役割と活用戦略](./004-slm-role-and-strategy.md)

---

## コンテキスト

Aegis は MCP サーバーであり、本来の統合点は MCP の tools/resources/prompts である。
一方、実際のエージェント運用では
「いつ `compile_context` を呼ぶか」
「どのタイミングで `observe` するか」
を IDE / エージェントに覚えさせる必要がある。

この問題に対して、現実装は Cursor と Claude Code の設定ファイルへ
直接書き込む Adapter を持っている。
しかし、`init_confirm` 後の自動デプロイは次の懸念を生む。

- ユーザーのプロジェクトファイルへ自動で介入する
- Git 管理下のファイルを予期せず変更する
- IDE ごとに実装を増やし続ける負債を作る

標準 MCP 機能と IDE 固有ファイル改変の境界を整理する必要がある。

---

## 決定

### D-1: Adapter 概念は残すが、Aegis コアとは分離した convenience layer とする

Adapter は不要ではない。
MCP スキーマだけでは運用手順をエージェントに十分教えきれないため、
永続的なルール注入のための bridge は価値がある。

ただし、Adapter は Aegis の本体価値ではない。
本線は MCP 標準機能であり、Adapter は opt-in の利便機能とする。

### D-2: Aegis の一次配布面は MCP の tools/resources/prompts とする

エージェントへの使い方提示は、まず MCP 標準機能で提供する。

- tools: API の意味
- resources: Aegis 運用ガイド
- prompts: 推奨ワークフロー

Adapter は、これら標準面だけでは十分な行動誘導ができない環境に対する
二次的な補助として位置づける。

### D-3: Adapter のデプロイは明示実行のみとする

`init_confirm` 時の自動デプロイはやめる。
Adapter 生成・更新は、admin の明示操作でのみ行う。

仮称は `aegis_deploy_adapters` とする。

これにより、Aegis が勝手にワークスペースファイルを変更することを避け、
導入責任を人間に明示的に残せる。

### D-4: first-party 対応は Cursor と Claude Code に限定する

v1 の first-party Adapter 対象は以下に限定する。

- Cursor
- Claude Code

他のエージェント / IDE は、当面 MCP 標準面とドキュメントで対応する。
stable な永続ルール注入面が確認できるまでは、むやみに Adapter を増やさない。

### D-5: Adapter は管理境界の外を上書きしない

Adapter がファイルへ書き込む場合は、必ず Aegis 管理領域を明示する。

- 専用ファイルを新規作成する
- 既存ファイルでは managed block のみを更新する

ユーザーが書いた非管理領域を上書きしない。
Aegis は IDE 設定の所有者にならない。

### D-6: 再デプロイは明示トリガーのみとする

Proposal approve や knowledge 更新のたびに自動再デプロイしない。
必要なら管理者が明示的に再生成する。

Adapter は「現在の推奨運用を配布するもの」であり、
知識ベースと完全同期を強制する対象ではない。

### D-7: Adapter 失敗は常に non-fatal とする

Adapter の生成や更新に失敗しても、
Aegis の core 機能は起動・利用可能でなければならない。

MCP サーバーとしての価値と IDE 便宜機能は分離する。

---

## 却下した代替案

### A-1: Adapter 不要、tools description だけで十分

却下。運用手順の定着には弱い。

### A-2: `init_confirm` 後の自動デプロイ

却下。侵襲性が高く、ユーザーの所有権を侵す。

### A-3: 全 IDE / 全エージェントへ一気に対応

却下。抽象化コストが高く、維持できない。

---

## 影響

### 実装タスク

1. `init_confirm` から自動 Adapter デプロイを外す
2. admin-only の `aegis_deploy_adapters` ツールを追加する
3. Aegis 利用ガイドを MCP resource / prompt として公開する
4. Adapter 実装を managed file / block 更新に限定する
5. Cursor / Claude 用の first-party Adapter を維持し、それ以外は保留する

### 運用ポリシー

- Aegis は IDE の設定を勝手に変えない
- ユーザーが適用タイミングを選ぶ
- Adapter は core と独立に壊れてよい

---

## 備考

- Adapter の目的は「Aegis を使えるようにする」ことではなく、
  「Aegis を正しく使う運用をエージェントに定着させる」ことにある
- そのため、標準 MCP 面の整備が常に先であり、Adapter はその補助である
