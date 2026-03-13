# ADR-001: 既存ドキュメント取り込み戦略

**ステータス:** Superseded by [ADR-002](./002-document-import-observation-wrapper.md)
**日付:** 2026-03-13

## 関連議題

- [既存ドキュメント取り込み戦略](../議題_既存ドキュメント取り込み戦略.md)

## 注記

この ADR は、取り込みを `manual_note` へ一本化する方針を記録したものだが、
後続の再検討により superseded となった。
現行の判断は [ADR-002](./002-document-import-observation-wrapper.md) を参照。

---

## コンテキスト

Aegis は現在、テンプレートの seed documents からしかドキュメントを取り込めない。
ユーザーが既に持っている設計ドキュメント、ADR、運用ルールなどは
Canonical Knowledge に存在せず、compile_context に反映されない。

「既存プロジェクトに Aegis を入れたらすぐ効く」体験のために、
既存ドキュメントの取り込み手段が不可欠である。

## 決定

### D-1: 取り込み経路は `manual_note` Observation 経由とする

既存のドキュメントインポートは **新しい MCP ツールを追加せず**、
`aegis_observe(event_type: "manual_note")` の payload 拡張で実現する。

**理由:**

- P-3 の Normative「Proposal は必ず 1 つ以上の Observation を根拠として持つ」を遵守する
- `bootstrap` に続く「第2の例外」を作ると、例外が増殖する悪い前例になる
- `ManualNoteAnalyzer` の `new_doc_hint` パスが既にこのユースケースの大部分をカバーしている
- Observation → Analyzer → Proposal → Approve の evidence chain が自然に構築される

**却下された代替案:**

- **独立 `aegis_import_doc` ツール**: evidence なしの proposal 生成は P-3 違反。
  既に仮実装で `evidence_observation_ids: []` になっていることが判明した
- **`bootstrap` と同列の例外扱い**: bootstrap は init 時の一回限りの特殊操作。
  繰り返し実行されるインポートを同列にすべきでない

### D-2: コア primitive は `content` + 明示メタデータ

MCP ツールにファイルパスを渡すのではなく、ドキュメントの内容（content）を渡す。

`manual_note` payload の拡張:

```typescript
{
  content: string;           // ドキュメント本文（必須）
  new_doc_hint: {            // 新規ドキュメント用（必須）
    doc_id: string;          // 英数字+ハイフン+アンダースコア
    title: string;
    kind: DocumentKind;      // 'guideline' | 'pattern' | 'constraint' | 'template' | 'reference'
  };
  edge_hints?: EdgeSpec[];   // DAG エッジ指定（任意）
  tags?: string[];           // tag_mappings 登録用（任意）
  source_path?: string;      // 出典ファイルパス（メタデータ、任意）
}
```

EdgeSpec:

```typescript
interface EdgeSpec {
  source_type: 'path' | 'layer' | 'command' | 'doc';
  source_value: string;
  edge_type: 'path_requires' | 'layer_requires' | 'command_requires' | 'doc_depends_on';
  priority?: number;         // default: 100
}
```

**理由:**

- MCP サーバーがファイルシステムにアクセスする必要がなくなる（セキュリティ・移植性）
- 呼び出し元エージェントは既にファイルを読んでいるケースがほとんど
- リモート MCP サーバー化にも対応可能
- `doc_id`, `title`, `kind` を必須とすることで推測を排除し、決定論性を担保

### D-3: メタデータの決定は呼び出し元に委ねる

`kind` 分類、`doc_id` 生成、タグ推論を Aegis 内部で行わない。
呼び出し元の LLM（Claude, GPT, Codex）または人間が決定する。

**理由:**

- 正規表現ベースの kind 分類は多言語対応が破綻する（仮実装で実証済み）
- SLM 依存は SLM 無効環境で動かない
- 呼び出し元の LLM は既に十分な分類能力を持つ
- frontmatter からの抽出は呼び出し元のラッパー責務とする

**Aegis 側に残す検証:**

- `doc_id` フォーマット: `/^[a-z0-9][a-z0-9_-]*$/`
- `kind` enum: `'guideline' | 'pattern' | 'constraint' | 'template' | 'reference'`
- `content` 空禁止
- `content_hash` サーバー側再計算
- `edge_hints` の型整合チェック + 循環検知

### D-4: DAG エッジは段階的に育てる

取り込み時のエッジ指定はオプショナル。孤立ノードは許容するが、
`edges` も `tags` もない場合は response に warning を含める。

**エッジ構築のワークフロー:**

1. ドキュメント取り込み（observe → analyze → propose → approve）
2. エージェントがコーディング中に `compile_context` → 必要なドキュメントが出ない → `compile_miss`
3. automation が `add_edge` proposal を生成 → admin が approve
4. DAG が自律的に育つ

### D-5: tags と source_path の保存タイミング

- **tags**: proposal が approve された時点で `tag_mappings` テーブルに `source: 'manual'` で登録
- **source_path**: proposal の payload 内に保持するのみ。`Document` テーブルにカラム追加しない

**理由:**

- `tag_mappings` は Canonical DAG 外の別テーブルであり、Canonical 変更と同時に反映するのが自然
- `source_path` は provenance 情報で compile_context のルーティングには使わない。
  スキーマ変更を最小限に抑える

### D-6: バッチ取り込みは呼び出し元のループに委ねる

`aegis_import_batch` のようなバッチツールは作らない。

**理由:**

- MCP ツールは atomic な操作であるべき
- バッチの途中でのエラー（部分成功）のハンドリングが複雑化する
- 呼び出し元エージェントはループ処理が得意
- ディレクトリスキャン → ファイル読み取り → observe 呼び出しのループは
  エージェント側で自然に記述できる

### D-7: ワークフローは 1 ショット proposal 方式

init の detect → confirm パターン（2ステップ）は採用しない。

1. エージェント/人間が `observe(manual_note)` でドキュメント内容を投入
2. `analyzeAndPropose` が `new_doc` + `add_edge` proposals を生成
3. admin が `list_proposals` → `get_proposal` → `approve_proposal` / `reject_proposal`

既存の proposal レビューワークフローがそのまま使える。

## 影響

### 実装タスク

1. **`manual_note` payload 拡張**: `edge_hints`, `tags`, `source_path` フィールドの追加
2. **`ManualNoteAnalyzer` 拡張**: `edge_hints` から `add_edge` draft を生成するロジック追加
3. **`approveProposal` 拡張**: payload に `tags` がある場合、approve 時に `tag_mappings` に反映
4. **observe バリデーション拡張**: `new_doc_hint` の `doc_id` フォーマット検証、`edge_hints` の型整合チェック
5. **仮実装 (`src/core/import/`) の削除**: `importer.ts`, `import.test.ts`, `index.ts` を削除。
   `services.ts` の `importDoc` メソッドと MCP server の `aegis_import_doc` ツール登録も削除
6. **warning response**: edges も tags もない `new_doc_hint` に対し、response に warning を含める

### 削除対象

- `src/core/import/importer.ts` — 正規表現分析、ファイルパス依存、evidence なし proposal 生成
- `src/core/import/import.test.ts`
- `src/core/import/index.ts`
- `services.ts` の `importDoc()` メソッド
- `server.ts` の `aegis_import_doc` ツール登録

### 残す価値のあるコード

- `parseFrontmatter()` — 呼び出し元ラッパーが frontmatter 付き content を渡す場合のユーティリティとして、
  将来的に別パッケージに切り出す可能性がある。ただし Aegis コアには含めない

## 備考

- `doc_id` の命名規約は英数字・ハイフン・アンダースコアのみ（`/^[a-z0-9][a-z0-9_-]*$/`）。
  呼び出し元への指示例: 「doc_id は英語のケバブケースで付けてください（例: `error-handling-guide`）」
- `allow_isolated` フラグは導入しない。warning で十分であり、フラグの複雑さに見合わない
