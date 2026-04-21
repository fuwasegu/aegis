<div align="center">
  <img src="docs/assets/logo.png#gh-light-mode-only" alt="Aegis" width="500" />
  <img src="docs/assets/logo-dark.png#gh-dark-mode-only" alt="Aegis" width="500" />
</div>

# Aegis

**AIコーディングエージェント向け DAGベース決定的コンテキストコンパイラ**

[English README](README.md) | [技術解説ガイド](docs/technical-guide.ja.md)

Aegis は、AIコーディングエージェントにアーキテクチャガイドラインを強制する MCP サーバーです。RAG の代わりに、依存関係の DAG を使って対象ファイルに必要なドキュメントを決定的にコンパイルします。検索なし。ランキングなし。決定的。

## クイックスタート

1. IDE の MCP 設定に Aegis を追加（[インストール](#インストール)を参照）
2. AI エージェントに指示: *「Aegis を初期化してアダプタルールをデプロイして」*
3. エージェントが `aegis_init_detect` → `aegis_init_confirm` → `npx @fuwasegu/aegis deploy-adapters` を自動で実行

データベースはプロジェクトルートの `.aegis/aegis.db` に保存されます。`.aegis/` ディレクトリは自身の `.gitignore` を含むため、手動設定は不要です。

## インストール

Aegis は 2 つの MCP surface を使います — 両方が必要です:

| Surface | 役割 | ツール数 |
|---------|------|----------|
| **agent** | コンテキスト取得・オブザベーション記録など（Canonical Knowledge は変更不可） | 6 ツール（compile, observe, audit, known_tags, workspace_status, detect） |
| **admin** | 初期化・承認・トリアージ | 24 ツール（共通 6 + Admin 専用 18） |

> agent surface だけでは初期化もプロポーザル承認もできません。この分離により、AI エージェントが人間の承認なしにアーキテクチャルールを変更することを防ぎます。（[INV-6](docs/technical-guide.ja.md)）

### Cursor

`.cursor/mcp.json` に追加:

```json
{
  "mcpServers": {
    "aegis": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "agent"]
    },
    "aegis-admin": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "admin"]
    }
  }
}
```

初期化後、`deploy-adapters` で `.cursor/rules/aegis-process.mdc` が生成されます。「コードを書く前に Aegis に相談し、違反を見つけたら報告せよ」とエージェントに指示する Cursor ルールです。

### Claude Code

```bash
claude mcp add aegis -- npx -y @fuwasegu/aegis --surface agent
claude mcp add aegis-admin -- npx -y @fuwasegu/aegis --surface admin
```

<details>
<summary><code>.mcp.json</code> に手動で追加する場合</summary>

```json
{
  "mcpServers": {
    "aegis": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "agent"]
    },
    "aegis-admin": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "admin"]
    }
  }
}
```

</details>

初期化後、`deploy-adapters` で `CLAUDE.md` に `<!-- aegis:start -->` セクションが追加されます（無い場合は新規作成）。

### Codex

```bash
codex mcp add aegis -- npx -y @fuwasegu/aegis --surface agent
codex mcp add aegis-admin -- npx -y @fuwasegu/aegis --surface admin
```

<details>
<summary><code>.mcp.json</code> に手動で追加する場合</summary>

```json
{
  "mcpServers": {
    "aegis": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "agent"]
    },
    "aegis-admin": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "admin"]
    }
  }
}
```

</details>

初期化後、`deploy-adapters` で `AGENTS.md` に `<!-- aegis:start -->` セクションが追加されます（無い場合は新規作成）。

> **注意:** Codex の MCP サポートは CLI バージョンに依存します。MCP が利用できない場合でも、生成された `AGENTS.md` の指示に従ってエージェントは Aegis のガイドラインを参照できます。

## 使い方

### 1. プロジェクトを初期化する

Admin surface を使って、空のナレッジベースで Aegis を初期化:

```
aegis_init_detect({ project_root: "/path/to/your/project", skip_template: true })
aegis_init_confirm({ preview_hash: "<detect で返されたハッシュ>" })
```

空のナレッジベースが作成されます。次のステップでアーキテクチャドキュメントを追加します。

続けて CLI でアダプタルールと Agent Skills をデプロイ:

```bash
npx @fuwasegu/aegis deploy-adapters
npx @fuwasegu/aegis deploy-adapters --targets cursor,codex  # 対象を絞る場合
```

### 2. 開発中に使う

Agent surface が AI コーディングエージェントにツールを提供します。**expanded** コンテキスト（タグ由来のドキュメント）を使う推奨フローは、セッションごとに一度 `aegis_get_known_tags`（`tag_catalog_hash` をキャッシュ）し、続けて `intent_tags` を付けてコンパイルします:

```
aegis_get_known_tags({})
aegis_compile_context({
  target_files: ["src/core/store/repository.ts"],
  plan: "アーカイブ済みオブザベーション用の新しいクエリメソッドを追加",
  intent_tags: ["<known_tags で取得したタグ>"]
})
```

`intent_tags` を省略するのは、オプションのサーバー側 SLM タガー（`--slm` 有効時）に `plan` からタグ推論させたい場合に限ります（[ADR-004](docs/adr/004-slm-role-and-strategy.md)）。expanded を使わず SLM も使わない場合は `intent_tags: []` を渡します。

ベース DAG のみ（expanded をスキップ）。`intent_tags: []` により SLM 有無に関わらず expanded / SLM タギングを行いません:

```
aegis_compile_context({
  target_files: ["src/core/store/repository.ts"],
  plan: "アーカイブ済みオブザベーション用の新しいクエリメソッドを追加",
  intent_tags: []
})
```

編集対象ファイルに関連するアーキテクチャガイドライン、パターン、制約が返されます。

### 3. アーキテクチャドキュメントを追加する

初期化後、コードベースを分析してナレッジベースにドキュメントを追加します。**admin** surface の `aegis_import_doc` で `edge_hints` 付きのドキュメントを追加:

```
aegis_import_doc({
  file_path: "/absolute/path/to/docs/architecture-guide.md",
  doc_id: "architecture-guide",
  title: "アーキテクチャガイド",
  kind: "guideline",
  tags: ["architecture"],
  edge_hints: [
    { source_type: "path", source_value: "src/domain/**", edge_type: "path_requires" }
  ]
})
```

`file_path` を使うとディスクから直接内容を読み取るため、LLM コンテキストウィンドウによる切り詰めを回避できます。各インポートは `proposal_ids` を返すので、承認して有効化します。

インポートしたドキュメントをソースファイルと同期するには:

```
aegis_sync_docs()   # コンテンツハッシュで変更を検知し、update_doc プロポーザルを作成
```

`aegis_import_doc` と `aegis_sync_docs` はいずれも **admin** surface が必要です。詳細な一括インポート手順は `aegis-bulk-import` skill（`deploy-adapters` でデプロイ）を参照してください。

### 4. オブザベーションを報告

エージェントがガイドラインの不足や修正を発見した場合:

```
aegis_observe({
  event_type: "compile_miss",
  related_compile_id: "<compile_context から>",
  related_snapshot_id: "<compile_context から>",
  payload: { target_files: ["..."], review_comment: "エラーハンドリングのガイドラインが不足" }
})
```

### 5. プロポーザルをレビュー

オブザベーションは自動分析されプロポーザルになります。Admin surface でレビュー・承認:

```
aegis_list_proposals({ status: "pending" })
aegis_approve_proposal({ proposal_id: "<id>" })
```

## SLM 拡張コンテキスト — オプトイン

Aegis は llama.cpp エンジンを内蔵しており、オプションで SLM ベースの Intent Tagging を利用できます。SLM は**デフォルトで無効**です。決定的 DAG ベースのコンテキストは SLM なしでも完全に動作します。

有効にするには **agent** surface に `--slm` を追加:

```json
{
  "mcpServers": {
    "aegis": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "agent", "--slm", "--model", "qwen3.5-4b"]
    },
    "aegis-admin": {
      "command": "npx",
      "args": ["-y", "@fuwasegu/aegis", "--surface", "admin"]
    }
  }
}
```

SLM 有効時の初回起動で、選択されたモデルが `~/.aegis/models/` にダウンロードされます（全プロジェクトで共有）。

| モデル | サイズ | 説明 |
|--------|--------|------|
| `qwen3.5-4b` | ~2.5 GB | 推奨デフォルト — 高速・軽量 |
| `qwen3.5-9b` | ~5.5 GB | 高品質 — ベンチマークトップ |

HuggingFace URI を直接指定することも可能: `--model hf:user/repo:file.gguf`

> **レガシー:** Ollama ベースの推論を使いたい場合は `--ollama` フラグが利用可能です。`--ollama` 指定時は SLM が暗黙的に有効化されます。

## リファレンス

### MCP ツール — Agent Surface（6 ツール）

| ツール | 説明 |
|--------|------|
| `aegis_compile_context` | 対象ファイルの決定的コンテキストをコンパイル。`content_mode`（auto/always/metadata）と `max_inline_bytes` による出力サイズ制御に対応 |
| `aegis_observe` | オブザベーション記録（compile_miss, review_correction, pr_merged, manual_note, document_import, doc_gap_detected） |
| `aegis_get_compile_audit` | 過去のコンパイルの監査ログを取得 |
| `aegis_get_known_tags` | tag_mappings の意図タグ一覧（承認ドキュメントに紐づくもの）と `knowledge_version`、キャッシュ用 SHA-256 `tag_catalog_hash` |
| `aegis_workspace_status` | 読み取り専用のワークスペーススナップショット（最近のコンパイル領域、未解決 compile_miss、保留プロポーザル数） |
| `aegis_init_detect` | プロジェクト分析と初期化プレビュー生成 |

### MCP ツール — Admin Surface（追加 18 ツール、計 24）

| ツール | 説明 |
|--------|------|
| `aegis_init_confirm` | プレビューハッシュで初期化を確認 |
| `aegis_list_proposals` | プロポーザル一覧（ステータスフィルタ付き） |
| `aegis_get_proposal` | プロポーザル詳細とエビデンスの取得 |
| `aegis_approve_proposal` | 保留中のプロポーザルを承認 |
| `aegis_preflight_proposal_bundle` | 同一 `bundle_id` の保留プロポーザルをドライラン検証 |
| `aegis_approve_proposal_bundle` | バンドル単位で保留プロポーザルを一括承認（原子的） |
| `aegis_reject_proposal` | プロポーザルを理由付きで却下 |
| `aegis_check_upgrade` | テンプレートバージョンのアップグレード確認 |
| `aegis_apply_upgrade` | テンプレートアップグレードのプロポーザル生成 |
| `aegis_archive_observations` | 古いオブザベーションをアーカイブ |
| `aegis_get_stats` | ナレッジ集計とヘルスシグナル |
| `aegis_list_observations` | オブザベーション一覧（outcome フィルタ: proposed / skipped / pending） |
| `aegis_import_doc` | ドキュメントを Canonical Knowledge にインポート（`content` または `file_path` 指定） |
| `aegis_analyze_doc` | ADR-015: `content` または `file_path` を ImportPlan に分析（読み取り専用） |
| `aegis_analyze_import_batch` | ADR-015: 一括取り込み分析（ドキュメント横断の重複検知） |
| `aegis_execute_import_plan` | ADR-015: ImportPlan を `bundle_id` 共有のプロポーザルに具体化 |
| `aegis_process_observations` | 未分析のオブザベーションに対して分析パイプラインを実行 |
| `aegis_sync_docs` | ファイルアンカー済みドキュメントをソースファイルと同期 |

### CLI サブコマンド

| サブコマンド | 説明 |
|------------|------|
| `deploy-adapters` | IDE アダプタ設定（Cursor ルール、CLAUDE.md、AGENTS.md）と Agent Skills をデプロイ |

```bash
npx @fuwasegu/aegis deploy-adapters                         # 全アダプタをデプロイ
npx @fuwasegu/aegis deploy-adapters --targets cursor,codex  # 対象を指定
npx @fuwasegu/aegis deploy-adapters --project-root /path    # プロジェクトルートを指定
npx @fuwasegu/aegis deploy-adapters --db /path/to/aegis.db  # カスタム DB パスを指定
npx @fuwasegu/aegis --list-models                           # 利用可能な SLM モデル一覧
```

> **注意**: バージョン追跡はフルデプロイ（`--targets` なし）時のみ更新されます。部分デプロイではバージョン記録は更新されないため、「アダプタテンプレートが古い可能性があります」という通知は、フルデプロイを実行するまで残ります。

### CLI フラグ（MCP サーバーモード）

| フラグ | デフォルト | 説明 |
|--------|-----------|------|
| `--surface` | `agent` | `agent` または `admin` |
| `--db` | `.aegis/aegis.db` | SQLite データベースパス |
| `--templates` | `./templates` | 同梱テンプレートディレクトリ |
| `--template-dir` | | 追加テンプレート検索パス（ローカルが同梱を上書き） |
| `--slm` | false | SLM を有効化（拡張コンテキスト: Intent Tagging） |
| `--model` | `qwen3.5-4b` | SLM モデル名または HuggingFace URI（`--slm` 必須） |
| `--list-models` | | 利用可能なモデルを表示して終了 |
| `--ollama` | false | 内蔵 llama.cpp の代わりに Ollama を使用（`--slm` を暗黙的に有効化） |
| `--project-root` | `cwd()` | プロジェクトルート（repo-relative source_path 解決とデフォルト DB パスの基準） |
| `--ollama-url` | `http://localhost:11434` | Ollama API URL（`--ollama` 使用時） |

---

## 開発

### ビルド・テスト

```bash
npm run build    # TypeScript コンパイル
npm test         # 全テスト実行（406+）
npm run test:watch
```

<details>
<summary>ソースからビルド</summary>

```bash
git clone https://github.com/fuwasegu/aegis.git
cd aegis
npm install && npm run build
```

</details>

### アーキテクチャ

```
┌─ MCP層 (src/mcp/) ─────────────────────┐
│ ツール登録、Surface 分離                  │
└──────────────┬──────────────────────────┘
               │
┌─ Core層 (src/core/) ───────────────────┐
│ ContextCompiler, Repository, Init,      │
│ Automation (各種 Analyzer), Tagging     │
└──────────────┬──────────────────────────┘
               │
┌─ Adapters (src/adapters/) ──────────────┐
│ Cursor, Claude ルール生成                │
└──────────────┬──────────────────────────┘
               │
┌─ Expansion (src/expansion/) ────────────┐
│ llama.cpp エンジン, IntentTagger          │
└─────────────────────────────────────────┘
```

依存は下方向のみ。Core は MCP、Adapters、Expansion からインポートしません。

### 主要コンセプト

- **Canonical Knowledge（正典）**: 承認済みアーキテクチャドキュメント + DAG エッジ
- **Observation Layer**: エージェントが報告するイベント（コンパイルミス、修正提案、PR マージ）
- **Proposed Layer**: 人間の承認を必要とする自動生成プロポーザル
- **Snapshots**: Canonical Knowledge のイミュータブルなコンテンツアドレス可能バージョン

## ライセンス

ISC
