# ADR-011: Agent-Driven Intent Tagging

**ステータス:** Proposed
**日付:** 2026-03-31

## 関連議題

- [Agent-Driven Tagging Design](../aegis-agent-driven-tagging-design-2026-03-31.md)
- [ADR-004: SLM Role and Strategy](004-slm-role-and-strategy.md)
- [ADR-010: Document Ownership](010-document-ownership-and-reconciliation-model.md) — tag_mappings と ownership の整合
- [Knowledge Optimization Design](../aegis-knowledge-optimization-design-2026-03-31.md)

## コンテキスト

Aegis は SLM (Small Language Model) を使って expanded context の intent tagging を行う。
しかし以下の問題がある:

1. **精度**: ローカル SLM (4B params) の分類精度は、呼び出し元 Agent (Claude/Codex) に比べて大幅に劣る
2. **環境依存**: `node-llama-cpp` / Ollama のインストール、GPU/CPU 要件、モデルダウンロード (~2.5GB) が導入障壁
3. **マシン選択性**: SLM が実用的に動作するマシンが限られる

### 核心的な洞察

Aegis を呼ぶのは常に AI Agent (Claude, Codex, Cursor 等) である。
Agent 自身が高性能 LLM なのだから、SLM に期待している「自然言語理解・分類」を
Agent に担わせれば、精度は桁違いに上がり、環境依存は消える。

## 決定

### 1. P-agent 原則: Agent provides intelligence; Aegis provides determinism

SLM がサーバー内で担っていた「自然言語からの推論」を、呼び出し元 Agent に委譲する。
Aegis は受け取った構造化入力を決定的に処理する pure compiler に徹する。

- **P-1 (決定性)**: `intent_tags` は request の一部 → 同一 request + same knowledge_version = same output
- **P-3 (人間承認)**: 変更なし
- **D-3 (SLM を write path に入れない)**: primary path から SLM を外すことで、非決定的推論の混入リスクをさらに低減

### 2. `CompileRequest` に `intent_tags` パラメータを追加

```typescript
export interface CompileRequest {
  target_files: string[];
  target_layers?: string[];
  command?: string;
  plan?: string;
  intent_tags?: string[];   // NEW
  max_inline_bytes?: number;
  content_mode?: ContentMode;
}
```

**セマンティクス:**
- `undefined` (省略): SLM fallback を許可（plan + tagger がある場合）
- `[]`: Agent が明示的に「expanded context 不要」と宣言 → SLM fallback もスキップ
- `["tag1", "tag2"]`: Agent が選択したタグ → 直接使用、SLM fallback スキップ

### 3. 優先順位: Agent > SLM > なし

```
intent_tags (Agent 提供) > SLM fallback (llama.cpp / Ollama) > なし
```

- `intent_tags` が明示的に提供された場合、SLM tagger は呼ばれない
- `intent_tags` が省略された場合、既存の SLM fallback が機能する（後方互換）

### 4. `aegis_get_known_tags` ツールの追加 (agent surface)

Agent がタグカタログを取得し、セッション中キャッシュするためのツール。

```typescript
getKnownTags(): {
  tags: string[];
  knowledge_version: number;
  tag_catalog_hash: string;  // キャッシュ判定用
}
```

- read-only なので INV-6 に違反しない
- Agent surface / Admin surface 両方に登録
- Agent はセッション開始時に 1 回呼び、`tag_catalog_hash` でキャッシュ判定

### 5. `intent_tags` の正規化

- **Dedupe**: 重複タグは除去
- **Stable sort**: 正規化後のタグ配列はソート済み（audit の再現性）
- **Case sensitivity**: exact match（case-sensitive）
- **Whitespace**: 前後空白は trim、空文字列は除外
- **Unknown tags**: warning 付きで除外。valid tags が残ればそれで expanded を構築

### 6. Audit に構造化メタデータを記録

```typescript
interface ExpandedTaggingAudit {
  tags_source: 'agent' | 'slm' | null;
  requested_tags: string[];
  accepted_tags: string[];
  ignored_unknown_count: number;
  matched_doc_count: number;
}
```

失敗経路（`BudgetExceededError`）でも必ず記録する。

### 7. ADR-004 の位置づけ変更

ADR-004 D-2 の「サーバー内で閉じた agent 非依存推論」の価値を見直す:
- SLM の位置づけを「primary」→「fallback for non-LLM clients」に変更
- `src/expansion/` ディレクトリ、`IntentTagger` ポート、CLI フラグは残す
- 将来利用率が 0 に近づいた場合に deprecate → 削除を検討

### 8. Surface / Tool 数の更新

| Surface | 現状 | 変更後 |
|---|---|---|
| Agent | 4 tools | **5 tools** (+aegis_get_known_tags) |
| Admin | 16 tools | **17 tools** (+aegis_get_known_tags) |

## 実装フェーズ

### Phase 1: Core (本 ADR のスコープ)

1. `CompileRequest` に `intent_tags?: string[]` を追加
2. `ContextCompiler.compile()` の expanded ロジックを拡張
3. `audit_meta` に `ExpandedTaggingAudit` を追加
4. `AegisService.getKnownTags()` 実装
5. `aegis_get_known_tags` ツール登録
6. テスト追加

### Phase 2: Adapter 更新 (後続タスク)

7. `AdapterConfig.toolNames` 拡張
8. Adapter 更新 (CLAUDE.md, .cursor/rules/, AGENTS.md)
9. README.md / README.ja.md 更新
10. ADR-004 改訂

## 帰結

### 正の帰結

- Agent の高い言語理解能力を活用し、tagging 精度が大幅に向上
- SLM 環境依存が primary path から排除され、導入障壁が低下
- P-1（決定性）が強化される（Agent の明示的タグ > SLM の確率的出力）
- 後方互換: `intent_tags` 省略時は既存動作を維持

### 負の帰結

- Agent 側のワークフロー更新が必要（adapter 経由で誘導）
- ツール呼び出し回数が 1 回増える（`aegis_get_known_tags`、ただしセッション中 1 回）
- SLM フォールバックの二重パス維持による実装複雑度の微増

### 維持される不変条件

- **P-1**: 決定性。`intent_tags` は request の一部として `compile_log` に記録
- **P-3**: 人間承認。変更なし
- **INV-6**: `aegis_get_known_tags` は read-only
