# 議題: Adapter デプロイの自動化とツール削減

**起票日**: 2026-03-13
**ステータス**: 議論中
**関連 ADR**: [ADR-005](adr/005-adapter-strategy-and-ide-integration.md)（部分撤回の提案）

---

## 背景

ADR-005 で「Adapter デプロイは init_confirm から分離し、明示的な `aegis_deploy_adapters` ツールで行う」と決定した。
しかし運用してみて以下の問題が浮上した。

### 問題 1: ツールがコンテキストを食う

`aegis_deploy_adapters` はプロジェクト導入時に1回、テンプレートアップグレード時にたまに使う程度。
にもかかわらず MCP ツールとして常時登録されており、エージェントのツール一覧のコンテキストを消費する。
Aegis は admin surface だけでも 12 ツールあり、「数回しか使わない管理系ツール」が占める割合が無視できない。

### 問題 2: ユーザー体験が悪い

init_confirm 後に「次は aegis_deploy_adapters を呼んでください」という追加ステップが必要。
ユーザーの期待は「入れるだけで全部勝手にやってほしい」。

### 参考: Kiri MCP Server のアプローチ

[Kiri](https://github.com/CAPHTECH/kiri) は MCP サーバー起動時にインデックス処理を自動実行する。
MCP ツールとしてインデックスを公開せず、サーバープロセスの起動処理として行っている。
これにより「install → configure → restart → 動く」のフローが実現されている。

## 提案

### `init_confirm` にアダプタデプロイを再統合する

- `init_confirm` 成功時に、自動でアダプタ（Cursor .mdc, CLAUDE.md, AGENTS.md）をデプロイ
- `aegis_deploy_adapters` ツールを削除
- 再デプロイが必要な場合は `init_detect` → `init_confirm` を再実行すればよい

### 代替案

1. **サーバー起動時に自動チェック** — DB に init 済みデータがあり adapter ファイルが無ければ自動生成。ただし project_root の取得方法に課題あり
2. **CLI サブコマンド化** — `npx @fuwasegu/aegis deploy-adapters` として MCP ツールではなく CLI で提供。ツール一覧を汚さない
3. **現状維持** — ADR-005 のまま。ただしユーザー体験の問題は残る

## 議論してほしいこと

1. **init_confirm への再統合は妥当か？** ADR-005 で分離した理由（adapter 失敗で init 全体が巻き戻るリスク）は、non-fatal 処理で回避できるか
2. **adapter デプロイの冪等性** — 再 init 時に既存の adapter ファイルをどう扱うか（上書き / マーカーベースの部分更新 / スキップ）
3. **今後のツール数削減の方針** — `aegis_process_observations` など他の「低頻度 admin ツール」も同様に削減すべきか
4. **MCP resources/prompts での代替可能性** — adapter（設定ファイル生成）自体を廃止し、MCP 標準機能で代替する方向はあるか

## 現状の実装参照

- `src/mcp/services.ts` `deployAdapters()` — 現在の adapter デプロイ実装
- `src/mcp/services.ts` `initConfirm()` — init 確認処理（現在は adapter を呼ばない）
- `src/mcp/server.ts` `aegis_deploy_adapters` — ツール登録
- `src/adapters/` — Cursor, Claude, Codex の各アダプタ実装

---

## ADR 化について

本議題の結論は **ADR** として `docs/adr/` に記録すること。
ADR-005 の更新（Superseded or Amended）としてもよい。
ADR からは本議題ファイルを「議論の経緯」としてリンクする。

```markdown
## 関連議題
- [Adapter デプロイの自動化とツール削減](../議題_Adapterデプロイの自動化とツール削減.md)
- [Adapter 戦略と IDE 統合](../議題_Adapter戦略とIDE統合.md)（前回議論）
```
