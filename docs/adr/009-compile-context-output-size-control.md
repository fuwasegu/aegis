# ADR-009: compile_context 出力サイズ制御

**ステータス:** Accepted
**日付:** 2026-03-28

## 関連議題

- [compile_context 出力サイズ制御](../議題_compile_context出力サイズ制御.md)

## コンテキスト

`aegis_compile_context` の MCP ツールレスポンスが、MCP クライアント（Claude Code 等）の
トークン上限を超えるケースが発生した（実測: 186,770 文字）。
クライアントはレスポンスをファイルに退避するが、エージェントはそのファイルを
逐次読み込む必要があり、Aegis の「呼べば必要なコンテキストが返る」体験が破綻している。

### 構造的要因

- ドキュメント本文の全文インライン（1 doc 5,000 文字 x 30 docs = 150,000 文字）
- テンプレートの全文インライン（scaffold 用コード雛形は特に大きい）
- expanded context による追加ドキュメント
- doc_depends_on の推移閉包による芋づる式膨張
- 広い glob パターンによる大量ヒット

### 既存の型（変更対象）

```typescript
// 現行 ResolvedDoc — content が全文インライン
interface ResolvedDoc {
  doc_id: string;
  title: string;
  kind: DocumentKind;
  content: string;
  relevance?: number;
}

// 現行 CompileRequest — サイズ制御パラメータなし
interface CompileRequest {
  target_files: string[];
  target_layers?: string[];
  command?: string;
  plan?: string;
}
```

## 決定

### D-1: ハイブリッド配信方式（修正版 E 案）

ドキュメントの配信方式を `delivery` フィールドで 3 値に分類する。

| delivery | 意味 | content | 再取得手段 |
|---|---|---|---|
| `inline` | 本文をレスポンスに含む | あり | — |
| `deferred` | source_path を返し、エージェントが Read | なし | source_path で Read |
| `omitted` | budget 超過により省略 | なし | budget を上げて再 compile |

**doc は atomic に扱う。** 1 件の content を途中で切る仕様は導入しない。
`inline` か `deferred`/`omitted` のどちらかに振る。
これにより `content_hash` の一貫性が保たれ、プロトコルが単純になる。

### D-2: ResolvedDoc v2 型

```typescript
interface ResolvedDoc {
  doc_id: string;
  title: string;
  kind: DocumentKind;

  // 配信状態
  delivery: 'inline' | 'deferred' | 'omitted';
  content?: string;          // delivery === 'inline' のときのみ
  source_path?: string;      // DB に存在すれば delivery を問わず常に返す
  content_bytes: number;     // UTF-8 バイト長。常に返す（Read 判断の材料）
  content_hash: string;      // 常に返す（Read 後の一貫性検証用）
  omit_reason?: string;      // delivery === 'omitted' のとき

  relevance?: number;        // plan 指定時のみ
}
```

**`source_path` は `delivery` と排他的ではない。** DB に `source_path` があれば
`delivery='inline'` のときも返す。短文をインラインで読んだ後に元ファイルを開きたい
ケースに対応する。

### D-3: CompileRequest v2 型

```typescript
interface CompileRequest {
  target_files: string[];
  target_layers?: string[];
  command?: string;
  plan?: string;

  // 新規
  max_inline_bytes?: number;  // デフォルト: 131,072 (128KB)
  content_mode?: 'auto' | 'always' | 'metadata';  // デフォルト: 'auto'
}
```

### D-4: content_mode の 3 値

| content_mode | source_path あり | source_path なし | policy 省略 | budget 省略 |
|---|---|---|---|---|
| `auto` | deferred（短い doc はインライン） | inline | 適用 | 適用 |
| `always` | inline | inline | **無効** | 適用 |
| `metadata` | deferred | **mandatory inline** | 適用 | 適用 |

- `always` は「policy omission を無効化する best-effort full inline。budget omission は残る」。
  guarantee ではない。budget 超過時はドキュメントが deferred/omitted になりうる。
- `metadata` でも `source_path` のない doc は mandatory inline。再取得手段がないため。
- **注意:** 上表の「policy 省略」列は通常ドキュメントに対するもの。テンプレートには D-10 の
  template policy（`command !== 'scaffold'` → omitted）が優先適用される。
  `content_mode='always'` のときのみ template policy も無効化される。

### D-5: auto モードの短い doc インライン閾値

`content_mode='auto'` のとき、`source_path` がある doc でも
`content_bytes <= 2048` ならインラインで返す。
Read の往復コストの方が高いケースを削減する。

定数: `AUTO_INLINE_THRESHOLD_BYTES = 2048`

閾値の単位は budget と同じ UTF-8 bytes で統一する（D-6 準拠）。
`chars` と `bytes` が混在すると実装時にブレるため、全てのサイズ関連定数を bytes に揃える。

### D-6: budget 単位と計測方法

- **単位: UTF-8 bytes。** パラメータ名 `max_inline_bytes`。
- **計測: `Buffer.byteLength(content, 'utf8')`。**
- **デフォルト: 131,072 bytes (128KB)。**
- `chars`（JS `.length`）は多言語環境で不安定。内部も外部も bytes で統一する。
- 直感性は adapter 層で preset を提供して解決する:
  - `compact`: 65,536 bytes (~64KB)
  - `standard`: 131,072 bytes (~128KB, デフォルト)
  - `full`: 524,288 bytes (~512KB)

### D-7: metadata-first allocation

`max_inline_bytes` は **inline content 専用の budget** である。
メタデータやレスポンス構造のオーバーヘッドはこの budget の外にある。
これにより、呼び出し側が「content にどれだけ入るか」を直接制御できる。

inline content の budget 配分は metadata 確定後に行う。

```
1. 全 doc のメタデータ（delivery, doc_id, title, kind, source_path,
   content_bytes, content_hash, resolution_path, warnings 等）を先に構築
   → この時点では全 doc を delivery='deferred' or 'omitted' として仮配置
2. effective_budget = max_inline_bytes（content 専用。metadata は budget 外）
3. stable order（D-8）に従い、effective_budget 内で doc を inline に振る
   → 各 doc の content_bytes を減算。budget が足りなくなった時点で残りは deferred/omitted
```

`max_inline_bytes` は content 専用なので、metadata の serialize サイズは計算不要。
レスポンス全体のサイズ上限が必要になった場合は、将来的に `max_response_bytes` を
別パラメータとして追加する余地がある（本 ADR では導入しない）。

### D-8: 省略アルゴリズムの stable order（P-1 準拠）

budget 超過時の省略順は固定。同じ入力 + 同じ knowledge_version + 同じ budget →
同じ省略結果を保証する。

```
1. class: expanded → base.documents → base.templates
2. relevance (降順、null は末尾) → priority (降順)
3. tie-break: doc_id (昇順、辞書順)
```

省略の逆順（class 内で最も優先度が低いものから省略）で inline budget を消費する。
relevance は plan 依存だが、plan も入力の一部なので P-1 は維持される。

### D-9: mandatory inline と budget 超過エラー

`source_path` のない doc は mandatory inline。budget 超過時に deferred にできないため、
mandatory inline だけで budget を超えた場合は **error を返す**。

**返却形態: MCP tool error（`isError: true`）として返す。**
`CompiledContext` の typed union にはしない。理由:

- budget 超過は「正常なコンパイル結果の一種」ではなく「実行不能」を意味する
- MCP クライアントが error を認識してエージェントに伝搬する経路が既にある
- `CompiledContext` の型を union にすると、全ての消費側に分岐を強制する

```typescript
// server.ts での返却
return {
  content: [{
    type: 'text',
    text: JSON.stringify({
      error: 'BUDGET_EXCEEDED_MANDATORY',
      compile_id: 'abc-123',  // audit 追跡用
      message: 'Mandatory inline documents exceed max_inline_bytes',
      mandatory_bytes: 245000,
      max_inline_bytes: 131072,
      offending_doc_ids: ['doc:arch-overview', 'doc:api-spec', 'doc:data-model']
      // サイズ降順で返す → 最初の数件を分割 or source_path 付与で解決
    })
  }],
  isError: true
};
```

実装上は `ContextCompiler.compile()` が `BudgetExceededError` を throw し、
`server.ts` の tool handler で catch して `isError: true` に変換する。
`AegisService` は throw をそのまま伝搬する（catch しない）。

**失敗 compile の audit 記録:** `BudgetExceededError` を throw する **前に**
compile_log を書き込む。`audit_meta` に `budget_exceeded: true` を記録する。
これにより、失敗した compile もテレメトリ上で観測可能になる。

```
compile flow:
  1. DAG routing → doc 収集
  2. allocator 実行 → delivery 割り当て
  3. mandatory inline budget 超過を検知
  4. compile_log 書き込み（audit_meta.budget_exceeded = true）  ← throw の前
  5. BudgetExceededError を throw
```

compile_id は allocator 実行前に生成済み（現行実装と同様）なので、
error レスポンスにも compile_id を含めることができる。
管理者は `aegis_get_compile_audit` でこの compile_id を引けば、
どの doc が offending だったかを audit_meta から確認できる。

silent drop はしない。これは「知識ベース設計の破綻」シグナルであり、
管理者がドキュメントを分割するか `source_path` を付与するか、
呼び出し側が budget を上げるかの判断を促す。

### D-10: テンプレートの v2 型と policy 省略

現行の `base.templates` は `{ name: string; content: string }[]` であり、
`delivery` / `content_bytes` / `content_hash` / `omit_reason` を表現できない。

**テンプレートを `ResolvedDoc` に統一する。** template は既に `documents` テーブルに
`kind='template'` として格納されており、compiler が `{ name, content }` に変換している。
v2 ではこの変換を廃止し、`base.templates` の要素も `ResolvedDoc` 型にする。

```typescript
// v2: base.templates も ResolvedDoc[] に
interface CompiledContext {
  // ...
  base: {
    documents: ResolvedDoc[];
    resolution_path: ResolvedEdge[];
    templates: ResolvedDoc[];  // was { name: string; content: string }[]
  };
}
```

これにより:
- テンプレートにも `delivery`, `content_bytes`, `content_hash`, `omit_reason` が付く
- D-8 の stable order でテンプレートもドキュメントと同じ allocator ロジックで処理できる
- `source_path` がないテンプレートは mandatory inline 扱い（D-9 と一貫）

**policy 省略:** `command !== 'scaffold'` のとき、テンプレートの content を省略する。
`delivery='omitted'`、`omit_reason='policy:non_scaffold_command'` で明示。

`content_mode='always'` のときは policy 省略が無効化されるため、
テンプレートもインラインで返す（D-4 の表に準拠）。

**wire 互換:** テンプレートの型変更は breaking change。Phase 1 では `schema_version: 2`
で区別し、v1 クライアントは `always` モードで `{ name: doc.title, content: doc.content }` に
フォールバックする adapter 側の変換で対応する（D-14 と連動）。

### D-11: source_path の正規化規約

| 項目 | 仕様 |
|---|---|
| 形式 | repo-relative（例: `src/core/types.ts`） |
| 基準 | 入力パスを repo root からの相対パスに正規化して保存 |
| workspace 外 | 禁止。repo root 外のパスは reject |
| symlink | 正規化する（`realpath` → repo-relative に変換） |
| 返却時 | compile_context はそのまま repo-relative で返す |

**repo root の取得:** `AegisService` のコンストラクタまたは `main.ts` で
`--project-root` 引数（デフォルト: `process.cwd()`）から取得し、
`Repository` または正規化ユーティリティに注入する。

**全 write path での正規化:**

| 経路 | 正規化対象 | 検証 |
|---|---|---|
| `import_doc` の `file_path` | `realpath(file_path)` → repo-relative に変換し `source_path` として保存 | workspace 外 reject |
| `import_doc` の `content` + `source_path` | `source_path` を repo-relative に正規化して保存 | workspace 外 reject |
| `sync_docs` の Read | repo root + `source_path` で絶対パスを復元して `existsSync` / `readFileSync` | — |

現行の `services.ts` は `source_path` を直接 `existsSync` / `readFileSync` に渡しているが、
repo-relative に変更後は **repo root を結合して絶対パスに復元する** 必要がある。

**既存データの migration:** DB に absolute path が入っている行は、
migration で repo root を strip して repo-relative に変換する。
repo root が不明な行（別マシンの absolute path 等）は `source_path = NULL` にフォールバックする。

エージェントが Read する際の絶対パス解決はエージェント側の責務。

### D-12: observe プロトコルの明確化

| 状況 | observe すべきか | 理由 |
|---|---|---|
| `omitted` doc が実際に必要だった | No | budget 制約。`max_inline_bytes` を上げて再 compile で解決 |
| `deferred` doc を Read したら hash mismatch | No | workspace drift。`sync_docs` で解決 |
| `inline` の content が不十分・不正確 | Yes (`compile_miss`) | knowledge defect |
| 必要な doc が compile 結果に一切含まれない | Yes (`compile_miss`) | edge 不足 |
| compile 結果のガイドラインに従ったが問題 | Yes (`review_correction`) | content defect |

- **`omitted` は budget 制約** → 設定で解決。knowledge defect ではない。`compile_miss` にしない。
- **`deferred` の hash mismatch は workspace drift** → `sync_docs` で解決。knowledge defect ではない。

### D-13: compile audit の拡張

compile_log テーブルに `delivery_stats` 等の新フィールドを追加する。

**DB schema 変更が必要。** 現行の `compile_log` テーブルは以下の 5 カラム:

```sql
compile_log (
  compile_id       TEXT PRIMARY KEY,
  snapshot_id      TEXT NOT NULL,
  request          TEXT NOT NULL,      -- JSON: CompileRequest
  base_doc_ids     TEXT NOT NULL,      -- JSON: string[]
  expanded_doc_ids TEXT,               -- JSON: string[] | null
  created_at       TEXT NOT NULL
)
```

`request` カラムに `content_mode` と `max_inline_bytes` は含まれる（CompileRequest の一部）が、
`delivery_stats`, `budget_utilization`, `policy_omitted_doc_ids` を格納するカラムがない。

**対応: `audit_meta` TEXT カラムを追加する。** 新しい audit 情報は全てこの JSON カラムに格納する。

```sql
ALTER TABLE compile_log ADD COLUMN audit_meta TEXT;
-- NULL = v1 compile（delivery 導入前）。v2 以降は JSON。
```

```typescript
// audit_meta の shape
interface CompileAuditMeta {
  delivery_stats: {
    inline_count: number;
    inline_total_bytes: number;
    deferred_count: number;
    deferred_total_bytes: number;   // Read された場合の想定サイズ
    omitted_count: number;
    omitted_total_bytes: number;
  };
  budget_utilization: number;       // inline_total_bytes / max_inline_bytes (0.0-1.0)
  budget_exceeded: boolean;         // mandatory inline で超過したか
  policy_omitted_doc_ids: string[]; // policy で省略された doc
}
```

**外部 API としての CompileAuditV2:**

```typescript
interface CompileAuditV2 {
  compile_id: string;
  snapshot_id: string;
  knowledge_version: number;
  request: CompileRequest;
  base_doc_ids: string[];
  expanded_doc_ids: string[] | null;
  // audit_meta から展開
  delivery_stats: CompileAuditMeta['delivery_stats'] | null;
  budget_utilization: number | null;
  budget_exceeded: boolean | null;
  policy_omitted_doc_ids: string[] | null;
  created_at: string;
}
```

v1 の compile_log（`audit_meta = NULL`）を読み出す際は、新フィールドを全て `null` で返す。
これにより既存の `getCompileAudit` は後方互換を維持する。

### D-14: schema_version とロールアウト

レスポンスに `schema_version` を追加する。

```typescript
interface CompiledContext {
  schema_version: 2;  // v1: 現行、v2: delivery 導入
  // ...
}
```

**ロールアウト:** single-step。サーバー v2 対応・adapter 更新・デフォルト `auto` を同時リリース。

当初は Phase 1（`always` 既定）→ Phase 2（`auto` 既定）の段階ロールアウトを計画していたが、
以下の運用条件により段階分割は不要と判断し、single-step に統合した:

- adapter（cursor, claude, codex）は同一リポジトリで同時更新可能
- 利用者が実質 1 人であり、外部互換性の制約がない
- `always` を引きずるコスト（サイズ削減が効かない）が段階的安全性より大きい

`content_mode: "always"` は明示指定の退避路として残す。

## 実装順序

1. **型定義更新** (`src/core/types.ts`) — `ResolvedDoc` v2（delivery 3 値）、`CompileRequest` v2（content_mode, max_inline_bytes）、`CompiledContext` v2（schema_version, templates を `ResolvedDoc[]` に）、`BudgetExceededError`、`CompileAuditMeta`
2. **DB schema migration** (`src/core/store/schema.ts`) — `compile_log` に `audit_meta TEXT` カラム追加。`source_path` の repo-relative 正規化 migration
3. **source_path 正規化ユーティリティ** — repo root 注入、全 write path（import_doc, sync_docs）での正規化/検証。`services.ts` の `existsSync`/`readFileSync` を repo root 結合に修正
4. **compile allocator 実装** (`src/core/read/compiler.ts`) — metadata-first allocation、stable order、budget error（`BudgetExceededError` throw）、template を `ResolvedDoc` として処理
5. **MCP 入出力配線** (`src/mcp/services.ts`, `src/mcp/server.ts`) — 新パラメータの受け渡し、zod schema 更新、`BudgetExceededError` → `isError: true` 変換
6. **audit 記録** — `audit_meta` への `delivery_stats`, `budget_utilization` 等の書き込み、`getCompileAudit` の v1/v2 互換読み出し
7. **adapter / protocol 更新** — CLAUDE.md, adapter 生成ロジック、observe プロトコル（D-12）の明記
8. **テスト** — compiler unit tests（allocator, stable order, budget error）、service integration tests（source_path 正規化）、E2E

## 却下した選択肢

### content の途中切り詰め（C 案）

各ドキュメントの content を先頭 N 文字に切り詰める方式。
エージェントが中途半端な情報で誤判断するリスクがあり、
`content_hash` が使えなくなる（切り詰めた content の hash は元と不一致）。
doc は atomic に扱うべきであり、この方式は採用しない。

### content 直接インラインのまま max_documents で制限（B 案単体）

ドキュメント数で切ると、小さいが重要なドキュメントが落ちるリスクがある。
サイズとは無関係なメトリクスで制限するのは不適切。

### MCP Resources による配信

MCP の `resources` 機能でドキュメントを配信する方式。
クライアント対応が揃うまで時期尚早。`source_path` ベースで進め、
将来 `resource_uri` に差し替えられるよう `source_path` を抽象化可能な状態に留める。

### fail-closed モード（`content_mode: 'strict'`）

budget 超過時に必ず error を返すモード。
現時点では `metadata` + mandatory inline の error 経路で十分であり、
モードを増やす複雑性に見合わない。必要になれば後から追加する。
