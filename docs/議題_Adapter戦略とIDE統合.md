# 議題: Adapter 戦略と IDE 統合

**起票日**: 2026-03-12
**ステータス**: 決定済み → [ADR-005](adr/005-adapter-strategy-and-ide-integration.md)

---

> **重要: この議題はゼロベースで議論すること。**
>
> 現在の仮実装では Cursor（`.cursor/rules/` に mdc を生成）と
> Claude Code（`CLAUDE.md` にセクション挿入）の2つのアダプタを作った。
> しかし「Aegis が IDE/エージェントにどこまで介入すべきか」の議論なしに、
> 「とりあえず設定ファイルを生成すればいいだろう」で作ってしまった。
> そもそも Adapter という概念が必要かも含めて、ゼロから考えること。

---

## 背景

Aegis は MCP サーバーなので、エージェントは MCP ツールを呼べば機能する。
しかし現実には「エージェントに Aegis ツールを使わせる」ために各 IDE/エージェント固有の
設定が必要であり、以下の仮実装がある:

### 仮実装の状態

- **Cursor Adapter** (`src/adapters/cursor/generate.ts`):
  - `.cursor/rules/aegis-process.mdc` を生成
  - `alwaysApply: true` でエージェントに Aegis の使い方を注入
  - `init_confirm` 成功時に自動デプロイ
  - 失敗しても無視（non-fatal）

- **Claude Adapter** (`src/adapters/claude/generate.ts`):
  - `CLAUDE.md` に `<!-- aegis:start -->` / `<!-- aegis:end -->` セクションを挿入
  - 既存内容は保持し、Aegis セクションだけ更新
  - 同じく `init_confirm` 時にデプロイ

- **Codex**: 未実装（README に手動設定手順を記載）

## 議論してほしいこと

### 1. Adapter は必要か

MCP の仕様上、`mcp.json` にサーバーを登録すればエージェントはツールを呼べる。
それに加えて Adapter（設定ファイル生成）が本当に必要か？

- **必要派の論点**: ツールの「呼び方」をエージェントに教える必要がある。いつ `compile_context` を呼ぶべきか、`observe` をどういうタイミングで使うか、は MCP スキーマだけでは伝わらない
- **不要派の論点**: ツールの description を充実させれば十分。Adapter はメンテ対象が増えるだけ
- **中間案**: Adapter ではなく、MCP の `resources` や `prompts` でエージェントに情報を提供する

### 2. Aegis はどこまで IDE に介入すべきか

現状は「設定ファイルを生成する」だけだが:

- プロジェクトの `.cursor/rules/` に勝手にファイルを書くのは侵襲的すぎないか？
- `CLAUDE.md` は Claude Code 専用。他のエージェント対応のたびにアダプタを増やすのか？
- ユーザーが手動で設定した内容を Aegis が上書きするリスクは？
- Git 管理下のファイルを Aegis が変更することの問題は？

### 3. デプロイのタイミング

- `init_confirm` 時に自動デプロイは適切か？
- ドキュメント更新（approve）のたびに再デプロイすべきか？
- ユーザーが明示的に呼ぶ MCP ツール（`aegis_deploy_adapters` 的な）にすべきか？

### 4. 対応すべきエージェント/IDE

- Cursor, Claude Code, Codex (OpenAI) は必須か？
- Windsurf, Copilot, Cline, Aider 等はどこまで対応すべきか？
- 各エージェントの「ルール注入方式」は異なる。抽象化は現実的か？

### 5. MCP 標準機能での代替

MCP には `resources` と `prompts` という仕組みがある:

- **Resources**: エージェントが参照できる静的データ。Aegis の使い方ガイドを resource として公開すれば、Adapter 不要では？
- **Prompts**: エージェントが使えるプロンプトテンプレート。ワークフロー定義に使えないか？
- これらの標準機能で Adapter の役割を完全に代替できるか？

## 仮実装の参考情報

- `src/adapters/cursor/generate.ts`: Cursor ルール生成
- `src/adapters/claude/generate.ts`: CLAUDE.md セクション挿入
- `src/adapters/index.ts`: バレルエクスポート
- `src/core/init/engine.ts`: `initConfirm` 内でアダプタデプロイを呼び出し

## 期待するアウトプット

1. Adapter 概念の要否判断
2. 必要な場合、対応範囲と優先度
3. デプロイタイミングの設計
4. MCP 標準機能（resources/prompts）の活用方針
5. IDE ファイルへの介入ポリシー

---

## ADR 化について

本議題の結論は **ADR（Architecture Decision Record）** として `docs/adr/` に記録すること。
ADR からは本議題ファイルを「議論の経緯」としてリンクする。

```markdown
## 関連議題
- [Adapter 戦略と IDE 統合](../議題_Adapter戦略とIDE統合.md)
```
