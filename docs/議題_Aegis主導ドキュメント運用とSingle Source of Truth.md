# 議題: Aegis 主導ドキュメント運用と Single Source of Truth

**起票日**: 2026-03-31
**ステータス**: 未着手

---

> **重要: この議題はゼロベースで議論すること。**
>
> 現在の `source_path` / `sync_docs` 実装は、ADR-009 の delivery-aware compile を
> 成立させるための第一段階であり、将来の最終形ではない可能性が高い。
> 「既存の Markdown ファイルをどう参照するか」だけでなく、
> **Aegis がドキュメント運用のどこまでを担うべきか**をゼロから考えてほしい。

---

## 解決すべき問題

ADR-009 により、`aegis_compile_context` は `source_path` を持つドキュメントを
`deferred` として返せるようになった。一方で、`source_path` がないドキュメントは
mandatory inline となり、`sync_docs` による再同期の対象にもならない。

この性質は、今後 Aegis 内でドキュメントを論理分割・要約・再構成していくほど
重大になる。

- 実ファイルを更新しても、Aegis の Knowledge Pool 側が古いまま残る可能性がある
- 「1 つの物理ファイル」と「compile に使う論理ドキュメント単位」が一致しなくなる
- `source_path` が単なるファイルパス参照なので、論理分割後の provenance が表現できない
- Aegis が単なるインデックスなのか、ドキュメント運用の control plane なのかが曖昧

このままでは、出力サイズ問題は解決できても、**stale knowledge** がより危険な問題として残る。

## 前提条件

- Aegis は Canonical Knowledge を SQLite に保持し、Observation → Proposal → Approve のガバナンスを持つ
- `documents` テーブルの `source_path` は任意であり、全ドキュメントに存在するわけではない
- `aegis_import_doc` に `file_path` を渡した場合は `source_path` が保存される
- `sync_docs` は `source_path` を持つドキュメントだけを対象に、ファイル全文との hash 比較で再同期を行う
- `source_path` がないドキュメントは compile 時に mandatory inline となる
- compile に必要な論理ドキュメント単位は、必ずしも実ファイル単位と一致しない
- P-1（決定性）、P-3（人間承認）、INV-6（agent surface から Canonical を直接変更しない）は維持する

## 現状の設計

### 1. ファイル起点の取り込み

- `file_path` import:
  実ファイルを読み、`content` と `source_path` を両方保存する
- `content` import:
  DB の `content` だけが正本になり、再取得元は残らない

### 2. 再同期の前提

`sync_docs` は `source_path` があるドキュメントについてのみ、
ファイル全文を読み直して hash を比較し、差分があれば `update_doc` proposal を作る。

つまり現状は、

- `source_path` あり doc:
  「workspace 上のファイルに anchored された knowledge」
- `source_path` なし doc:
  「Aegis 内だけに存在する knowledge」

という 2 種類の知識が混在している。

### 3. ADR-009 との関係

ADR-009 の `deferred` 配信は `source_path` あり doc を効率よく返す仕組みであり、
staleness 問題そのものを解決するものではない。
むしろ、将来 doc 分割が進むほど provenance の弱さが露出しやすくなる。

## 議論してほしいこと

### 1. Aegis の役割は何か

Aegis を次のどこに置くべきか。

- **A. Index / Mirror**
  既存ファイル群が正本で、Aegis はそれをインデックスして compile に使う
- **B. Canonical Source of Truth**
  Aegis の Canonical Knowledge が正本で、repo 上の Markdown は projection / materialization
- **C. Document Control Plane**
  正本の所在はケースごとに異なるが、create / update / split / merge / deprecate は
  原則すべて Aegis を通して行う

どれを目指すかで、`source_path` の意味も `sync_docs` の責務も変わる。

### 2. ドキュメント更新の唯一の窓口を Aegis にするか

「Single Source of Truth」を Aegis DB に置くのか、
それとも「Single Point of Control」を Aegis に置くのかを明確にしたい。

特に以下を決める必要がある。

- 人間が `docs/*.md` を直接編集してよいか
- 論理ドキュメントの作成・更新・分割・統合を Aegis ツール経由に限定するか
- Aegis 管理外のファイル変更をどう検知し、どう reconcile するか

### 3. `source_path` は十分か

現在の `source_path` は「この doc はこのファイル由来」という 1 本の参照しか持てない。
論理分割や再構成を考えると、将来的には以下のような richer provenance が必要かもしれない。

```typescript
interface SourceRef {
  path: string;
  kind: 'file' | 'heading' | 'range' | 'chunk' | 'generated';
  heading?: string;
  start_line?: number;
  end_line?: number;
  generator?: string;
}
```

議論すべき点:

- 物理ファイル 1 個から複数の論理 doc をどう表現するか
- Aegis 生成の要約 doc / 派生 doc をどう追跡するか
- hash 比較はファイル全文ではなく範囲単位にすべきか

### 4. 論理分割と物理分割を誰が管理するか

将来のドキュメント分割には少なくとも 2 パターンある。

- **物理分割**:
  実ファイル自体を複数ファイルに分ける
- **論理分割**:
  実ファイルはそのまま、Aegis 内の doc 単位だけ細かくする

ここで決めたいのは、

- Aegis が物理分割までハンドリングするのか
- doc_id の永続性をどう保つか
- split / merge 時の置換関係や deprecation をどう管理するか

### 5. `sync_docs` は将来どうあるべきか

現状の `sync_docs` は file-backed doc の full-file hash 比較でしかない。
もし Aegis をドキュメント運用の中心に寄せるなら、`sync_docs` は単なる同期ではなく
**reconcile / refresh** に進化する必要がある。

候補:

- file-backed doc のみを同期する現状維持
- `source_ref` ベースで heading / range 単位の再同期を行う
- Aegis 生成 doc の upstream 変更を dependency graph として追跡する
- stale な derived doc に warning / proposal を自動生成する

### 6. ガバナンスと UX をどう両立するか

Aegis がドキュメント運用を握るほど、使い勝手も重要になる。

- 人間が気軽に直したいときの操作は何か
- Aegis 外編集を全面禁止するのか、後で取り込めばよいのか
- split / merge / materialize を proposal 承認の対象にするか
- agent surface にはどこまで許すか

### 7. 既存データをどう移行するか

今すでに `source_path` なしで入っている Canonical doc をどう扱うか。

- 手で provenance を付け直すか
- `content` import 由来 doc を段階的に file-backed に寄せるか
- 「Aegis 内だけの canonical doc」として明示的に分類するか

## 参考: ありうる設計の方向性

### A案: Files as SoT

repo 上の Markdown / テキスト群を正本とし、Aegis はそれを index / compile する。

**利点:**
- Git と相性がよい
- 既存のドキュメント運用に寄せやすい

**欠点:**
- 論理 doc 分割や派生 doc 管理が弱い
- stale knowledge を防ぐには provenance をかなり強化する必要がある

### B案: Aegis as Canonical SoT

Aegis の `documents` が正本で、repo 上のファイルは projection。
人間の編集も Aegis を通す。

**利点:**
- 論理 doc を第一級で扱える
- split / merge / deprecate を Aegis 内で一貫管理できる

**欠点:**
- Git 上の編集フローが変わる
- materialize / export / conflict resolution が大きな実装テーマになる

### C案: Aegis as Control Plane

正本の場所は 1 つに固定しないが、ドキュメント lifecycle 操作は原則すべて Aegis を通す。
file-backed doc と canonical-only doc を明示的に区別して管理する。

**利点:**
- 現行からの移行が現実的
- stale knowledge の危険な領域をルール化できる

**欠点:**
- 二重モデルの運用規約をきちんと設計しないと曖昧さが残る

## 現時点の仮説

現時点では **C案（Aegis as Control Plane）** がもっとも現実的に見える。

- file-backed な knowledge は `source_path` / 将来の `source_ref` で anchored に保つ
- Aegis 内だけの canonical doc は明示的に「human-authored / canonical-only」と分類する
- doc の create / update / split / merge / deprecate は原則 Aegis を通す
- 将来、必要なら B案へ進める

ただしこの仮説に引っ張られず、Aegis の最終像として何が最も自然かを議論したい。

## 期待するアウトプット

1. Aegis の役割定義
   Index / Mirror なのか、Control Plane なのか、Canonical SoT なのか
2. provenance モデルの方針
   `source_path` 継続か、`source_ref` への拡張か
3. ドキュメント lifecycle の運用ルール
   create / update / split / merge / materialize / deprecate をどう扱うか
4. stale knowledge を防ぐための実装計画
   `sync_docs` 拡張、分類ルール、migration 方針

---

## 関連ドキュメント

- [既存ドキュメントの取り込み戦略](議題_既存ドキュメント取り込み戦略.md)
- [compile_context 出力サイズ制御](議題_compile_context出力サイズ制御.md)
- [ADR-009: compile_context 出力サイズ制御](adr/009-compile-context-output-size-control.md)

## ADR 化について

本議題の結論は、必要に応じて新しい ADR として `docs/adr/` に記録すること。
ADR からは本議題ファイルを「議論の経緯」としてリンクする。
