# Aegis: Agent-Driven Tagging Design

**日付:** 2026-03-31
**ステータス:** 設計合意済み（未実装）
**関連:** ADR-004 (SLM Role and Strategy), aegis-knowledge-optimization-design-2026-03-31.md

---

## 背景と問題提起

Aegis は SLM (Small Language Model) を使って `expanded` コンテキストの intent tagging を行う機能を持つ。
SLM は opt-in であり、既定は `llama.cpp` + `qwen3.5-4b` (Q4_K_M)、Ollama は代替バックエンドとして利用可能。
しかし以下の問題がある:

1. **精度**: ローカル SLM (4B params) の分類精度は、呼び出し元 Agent (Claude/Codex) に比べて大幅に劣る
2. **環境依存**: `node-llama-cpp` / Ollama のインストール、GPU/CPU 要件、モデルダウンロード (~2.5GB) が導入障壁
3. **マシン選択性**: SLM が実用的に動作するマシンが限られる
4. **将来の knowledge optimization (Phase 5)** でも同じ問題が拡大する

### 核心的な洞察

> Aegis を呼ぶのは常に AI Agent (Claude, Codex, Cursor 等) である。
> Agent 自身が高性能 LLM なのだから、SLM に期待している「自然言語理解・分類」を
> Agent に担わせれば、精度は桁違いに上がり、環境依存は消える。

---

## 設計原則

### P-agent: Agent provides intelligence; Aegis provides determinism

SLM がサーバー内で担っていた「自然言語からの推論」を、呼び出し元 Agent に委譲する。
Aegis は受け取った構造化入力を決定的に処理する pure compiler に徹する。

これは ADR-004 の核心原則をより強く守る:
- **P-1 (決定性)**: `intent_tags` は request の一部 → 同じ request + same knowledge_version = same output
- **P-3 (人間承認)**: 変更なし
- **D-3 (SLM を write path に入れない)**: primary path から SLM を外すことで、write path への非決定的推論の混入リスクをさらに低減する。SLM は fallback として残るが、Agent 提供の `intent_tags` が優先される

### ADR-004 との関係

ADR-004 D-2 の「サーバー内で閉じた agent 非依存推論」の価値は見直しが必要:
- この価値は「呼び出し元が非 LLM の場合」にのみ有効
- 実際の利用シーンの 95%+ は LLM Agent からの呼び出し
- 非 LLM クライアント (CLI スクリプト等) のためには SLM をフォールバックとして残す

---

## 具体的な変更設計

### 1. CompileRequest に `intent_tags` パラメータを追加

```typescript
// src/core/types.ts
export interface CompileRequest {
  target_files: string[];
  target_layers?: string[];
  command?: string;
  plan?: string;
  /**
   * Agent-provided intent tags. Takes priority over SLM tagger.
   *
   * Semantics:
   * - undefined (omitted): SLM fallback is permitted (if plan + tagger available)
   * - []: Agent explicitly declares "no expanded context needed" — SLM fallback is skipped
   * - ["tag1", "tag2"]: Agent-selected tags — used directly, SLM fallback is skipped
   */
  intent_tags?: string[];
  max_inline_bytes?: number;
  content_mode?: ContentMode;
}
```

**`plan` は `intent_tags` 使用時も引き続き有用**: `plan` は tagging だけでなく、
`relevance` スコア計算 (`extractPlanTerms` → `computeRelevance`) や delivery 順序にも影響する。
`intent_tags` を渡す場合でも `plan` は省略すべきでない。

### 2. ContextCompiler の expanded context ロジックを拡張

```typescript
// src/core/read/compiler.ts — expanded context section
// Priority: intent_tags (Agent) > SLM tagger > none

let tagNames: string[] = [];
let tagsSource: 'agent' | 'slm' | null = null;

if (request.intent_tags !== undefined) {
  // Agent explicitly provided tags (possibly empty)
  if (request.intent_tags.length > 0) {
    // Normalize: dedupe, stable sort, exact match (case-sensitive)
    const deduped = [...new Set(request.intent_tags)].sort();
    const knownTags = new Set(this.repo.getAllTags());
    const validTags: string[] = [];
    const unknownTags: string[] = [];

    for (const t of deduped) {
      const trimmed = t.trim();
      if (!trimmed) continue;
      if (knownTags.has(trimmed)) {
        validTags.push(trimmed);
      } else {
        unknownTags.push(trimmed);
      }
    }

    if (unknownTags.length > 0) {
      warnings.push(
        `Unknown intent tags ignored: [${unknownTags.join(', ')}]. ` +
        'Use aegis_get_known_tags to get the current tag catalog.'
      );
    }

    tagNames = validTags;
    tagsSource = 'agent';
  } else {
    // intent_tags: [] — Agent explicitly opted out of expanded context
    expandedDocIds = [];
    expandedHasResult = true;
    expandedReasoning = 'Agent explicitly provided empty intent_tags (no expanded context requested)';
    tagsSource = 'agent';
  }
} else if (request.plan && this.tagger) {
  // SLM fallback (existing behavior)
  try {
    const knownTags = this.repo.getAllTags();
    const tags = await this.tagger.extractTags(request.plan, knownTags);
    tagNames = tags.map((t) => t.tag);
    tagsSource = 'slm';
  } catch (err) {
    warnings.push(`Expanded context skipped: tagger failed (${(err as Error).message})`);
  }
}

// tag_mappings lookup (deterministic, unchanged)
if (tagNames.length > 0) {
  const candidates = this.repo.getDocumentsByTags(tagNames);
  // ... existing dedup and allocation logic ...
}
```

### 3. `aegis_get_known_tags` ツールの追加 (agent surface)

```typescript
// src/mcp/server.ts — agent surface に追加

server.tool(
  'aegis_get_known_tags',
  'Get available intent tags for expanded context. Cache by tag_catalog_hash; pass tags to compile_context via intent_tags parameter.',
  {},
  async () => {
    const result = service.getKnownTags();
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  },
);
```

```typescript
// src/mcp/services.ts

getKnownTags(): {
  tags: string[];
  knowledge_version: number;
  tag_catalog_hash: string;
} {
  const tags = this.repo.getAllTags();
  const snapshot = this.repo.getCurrentSnapshot();
  // tag_catalog_hash: Agent がキャッシュ判定に使う (primary cache key)
  // knowledge_version は参考値。tag_mappings は operational metadata なので
  // knowledge_version と完全連動しない可能性があるため、
  // cache invalidation は tag_catalog_hash を主キーとする。
  const catalogHash = createHash('sha256')
    .update(tags.join('\0'))
    .digest('hex')
    .slice(0, 16);

  return {
    tags,
    knowledge_version: snapshot?.knowledge_version ?? 0,
    tag_catalog_hash: catalogHash,
  };
}
```

**将来拡張**: Agent 側の分類品質を上げるため、`descriptions?: Record<string, string>`
（タグごとの説明文）を追加可能。v1 では未提供とし、フィールド自体を返さない。
追加時は `tag_catalog_hash` の計算にも descriptions を含める。

### 4. `intent_tags` の正規化方針

Agent / adapter 実装のブレを防ぐため、以下を仕様化する:

- **Dedupe**: 重複タグは除去（`[...new Set(intent_tags)]`）
- **Stable sort**: 正規化後のタグ配列はソート済みで扱う（audit の再現性のため）
- **Case sensitivity**: exact match（case-sensitive）。タグ `"auth"` と `"Auth"` は別物
- **Whitespace**: 前後空白は trim する。空文字列のタグは除外
- **Unknown tags**: warning 付きで除外（lookup には使わない）。valid tags が残ればそれで expanded を構築

### 5. Audit に machine-readable な tagging メタデータを記録

`reasoning` 文字列だけでなく、`audit_meta` に構造化データを追加:

```typescript
// audit_meta に追加するフィールド
interface ExpandedTaggingAudit {
  tags_source: 'agent' | 'slm' | null;
  requested_tags: string[];    // intent_tags の生値 (正規化前)
  accepted_tags: string[];     // known tags にマッチしたもの
  ignored_unknown_count: number;
  matched_doc_count: number;
}
```

`ExpandedTaggingAudit` は `CompileAuditMeta` (`src/core/types.ts`) に組み込み、
`aegis_get_compile_audit` のレスポンスとして公開する。
具体的には以下の 3 箇所が更新対象:

- `CompileAuditMeta` 型定義 (`src/core/types.ts`)
- `ContextCompiler.getCompileAudit()` の返却構築 (`src/core/read/compiler.ts`)
- `AegisService` の audit 返却ロジック (`src/mcp/services.ts`)

これにより、SLM fallback 利用率 (`tags_source` の分布) と
unknown tag 発生率 (`ignored_unknown_count`) を外部から追跡可能にする。

**失敗経路での保証**: `ExpandedTaggingAudit` は budget exceeded による失敗経路
(`BudgetExceededError` catch 内の `failAuditMeta` 構築) でも必ず埋める。
expanded context の tag 解決は budget 計算より前に完了するため、
失敗時にも `tags_source`, `requested_tags`, `accepted_tags`, `ignored_unknown_count` は確定している。
`matched_doc_count` は allocator 到達前でも `expandedCandidates.length` から取得可能。

対象箇所:
- `CompileAuditMeta` 型定義 (`src/core/types.ts`)
- 正常経路の `auditMeta` 構築 (`src/core/read/compiler.ts` allocator 後)
- 失敗経路の `failAuditMeta` 構築 (`src/core/read/compiler.ts` BudgetExceededError catch 内)
- `AegisService` の audit 返却 (`src/mcp/services.ts`)

`reasoning` は引き続き人間可読な要約として残す:

```typescript
expandedReasoning = tagsSource === 'agent'
  ? `Agent-provided tags: [${tagNames.join(', ')}]; matched: ${filtered.map(c => c.doc_id).join(', ')}`
  : `SLM-extracted tags: [${tagNames.join(', ')}]; matched: ${filtered.map(c => c.doc_id).join(', ')}`;
```

---

## Agent 側のワークフロー（Adapter 更新）

### 影響範囲

以下の全てが更新対象:
- `CLAUDE.md` — Agent ワークフロー記述
- `.cursor/rules/` — Cursor adapter 生成テンプレート
- `AGENTS.md` — Codex adapter
- `src/adapters/types.ts` — `AdapterConfig.toolNames` に `getKnownTags` を追加
- `src/mcp/services.ts` — adapter 生成ロジック
- `README.md` / `README.ja.md` — ツール数・ワークフロー記述の更新

### Adapter に組み込むフロー

```markdown
### Aegis Consultation (with intent tagging)

1. **Get tag catalog** (once per session, cache by `tag_catalog_hash`):
   ```
   aegis_get_known_tags() → { tags, knowledge_version, tag_catalog_hash }
   ```

2. **Classify intent** — From your plan, select relevant tags from the catalog.

3. **Compile context**:
   ```
   aegis_compile_context({
     target_files: [...],
     plan: "your plan",
     intent_tags: ["selected", "tags"],
   })
   ```

If tag catalog is empty, omit `intent_tags` (not `[]`). An empty catalog means
the SLM fallback will also return no tags, so expanded context will be empty either way.
Use `intent_tags: []` only when you explicitly want no expanded context.
```

### ツール呼び出し回数について

- `aegis_get_known_tags` は **セッション開始時に 1 回** で十分
- `tag_catalog_hash` が変わらない限りキャッシュ有効
- `intent_tags` が空の場合、`plan` ベースの SLM フォールバックが機能するので、
  Agent が tags を選べないときは単に省略すればよい

---

## Phase 5 (knowledge optimization) への影響

議論履歴で計画された Phase 5 の SLM advisory 機能は、
全て **Agent 委譲パターン** で代替可能:

| 機能 | SLM 方式 (旧計画) | Agent 委譲方式 (新計画) |
|---|---|---|
| ドキュメント分割候補 | Aegis 内 SLM が分析 | `optimization/` が分割トリガーを検知 → 診断結果を返す → Agent が分割案を生成 → proposal |
| miss クラスタ命名 | SLM が要約 | `aegis_list_observations` 結果を Agent が要約 (Agent の通常能力) |
| draft 文面生成 | SLM がドラフト | Agent が `payload.proposed_content` に書く (`review_correction` では `payload.target_doc_id` と対、`manual_note` では `payload.target_doc_id` or `payload.new_doc_hint` と対で必要) |
| 意味的陳腐化検知 | SLM が Level 4 判定 | `staleness` Level 1-3 結果を Agent に返す → Agent が意味的判断 |

### 設計への帰結

`optimization/` 層は **純粋に決定的な診断・候補生成** に集中:
- edge-candidate-builder: 構造推論、miss パターン、co-change (全て決定的)
- edge-validation: 正規形 glob、impact simulation (全て決定的)
- doc-refactor: hybrid threshold、分割トリガー (全て決定的)
- staleness: Level 1-3 (全て決定的)
- import-plan: セクション解析、重複検知、coverage delta (全て決定的)

SLM / LLM が必要な判断は全て Aegis の外（Agent 側）で行われ、
結果が Aegis のツール引数として戻ってくる。

---

## Ollama / SLM の位置づけ

### 完全削除ではなくフォールバック化

```
intent_tags (Agent 提供) > SLM fallback (llama.cpp / Ollama) > なし
```

- `src/expansion/` ディレクトリは残す
- `IntentTagger` ポートは残す
- `main.ts` の `--slm`, `--ollama`, `--model` フラグは残す
- ただし primary path ではなくなる
- ADR-004 を改訂: SLM の位置づけを「primary」→「fallback for non-LLM clients」に変更

### 将来的な削除判断

SLM fallback の利用率が 0 に近づいた場合、将来のバージョンで deprecate → 削除を検討。
ただし現時点では残すコストが低いため、互換性を優先。

---

## Surface / Tool 数の更新

| Surface | 現状 | 変更後 |
|---|---|---|
| Agent | 4 tools | **5 tools** (+aegis_get_known_tags) |
| Admin | 16 tools | **17 tools** (+aegis_get_known_tags) |

`aegis_get_known_tags` は read-only なので INV-6 に違反しない。
Agent surface に追加しても安全。

`AdapterConfig.toolNames` に `getKnownTags: string` を追加。

---

## 実装順

1. `CompileRequest` に `intent_tags?: string[]` を追加 (`types.ts`)
2. `ContextCompiler.compile()` の expanded ロジックを拡張 (`compiler.ts`)
   - 正規化 (dedupe, sort, trim)
   - `intent_tags: []` = explicit opt-out
   - `intent_tags: undefined` = SLM fallback permitted
3. `audit_meta` に `ExpandedTaggingAudit` フィールド追加 (`compiler.ts`)
4. `AegisService.getKnownTags()` 実装 (`services.ts`)
5. `aegis_get_known_tags` ツール登録 (`server.ts`)
6. `AdapterConfig.toolNames` 拡張 (`adapters/types.ts`)
7. Adapter 更新 (CLAUDE.md, .cursor/rules/, AGENTS.md) — ワークフローに intent_tags を組み込み
8. README.md / README.ja.md — ツール数・ワークフロー記述の更新
9. テスト追加:
   - Agent-provided tags が SLM より優先されること
   - `intent_tags: []` で expanded が opt-out されること
   - unknown tags が warning 付きで除外されること
   - 正規化 (dedupe, sort, case-sensitive) の検証
10. ADR-004 改訂 — SLM の位置づけを fallback に変更

---

## unknown tag の扱い

Agent が古い tag catalog で推論した場合、一部の tags が存在しない可能性がある。

**方針: warning 付きで無視、破壊しない**

- unknown tags は `tag_mappings` lookup から除外
- `warnings` に unknown tags を列挙 → Agent に `aegis_get_known_tags` の再取得を促す
- valid tags が 1 つでもあれば expanded context は返す
- 全て unknown → expanded は `{ documents: [] }` (tags はあったが結果なし)

これにより、stale cache の Agent でも compile_context が壊れることはない。

---

## P-1 (決定性) の保証

`intent_tags` は `CompileRequest` の一部として `compile_log.request` に記録される。

**同じ `intent_tags` + same `knowledge_version` = same output** — P-1 は完全に維持される。

Agent が毎回異なる tags を渡す可能性はあるが、それは「request が異なる」ことであり、
P-1 の違反ではない。これは既存の `plan` パラメータと同じ性質。

ただし、`intent_tags` は `plan` + SLM の出力より **再現性が高い** とも言える。
なぜなら Agent が明示的に選んだ tags は、SLM の確率的出力より安定するから。

正規化 (dedupe + sort) により、Agent が tags を異なる順序で渡しても同一結果になる。

**決定性の基準は normalized `intent_tags` + その他の request フィールド + knowledge state の全体に対して定義する。**

`compile_log.request` には正規化前の raw `intent_tags` を保存する（入力の忠実な記録）。
P-1 が保証する「同じ request = 同じ output」は、正規化後の全入力に対して成立する:
- `["b", "a"]` と `["a", "b"]` → 正規化後に同一 → 同じ output（P-1 成立）
- `["a", "x"]` と `["a", "y"]`（`x`, `y` が unknown）→ unknown tag 名が `warnings` に出るため **output は異なる**（P-1 は「異なる normalized request」として正しく扱う）

つまり、`warnings` に含まれる unknown tag 名も出力の一部であり、
`accepted_tags` だけでなく `intent_tags` 全体（unknown 含む）が出力を決定する。
raw request は audit 用の記録であり、P-1 の同一性判定には normalized form を使う。
