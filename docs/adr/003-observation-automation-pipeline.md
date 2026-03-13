# ADR-003: Observation 自動化パイプラインは admin 明示処理とする

**ステータス:** Implemented
**日付:** 2026-03-13

## 関連議題

- [Observation 自動化パイプライン設計](../議題_Observation自動化パイプライン設計.md)
- [既存ドキュメント取り込み戦略](./002-document-import-observation-wrapper.md)

---

## コンテキスト

Aegis には `aegis_observe`、各種 Analyzer、`analyzeAndPropose`、
悲観的 claim による並行制御が既に存在する。
しかし、誰がいつ Observation を Proposal 化するかが未定義である。

ここで `observe` 時に自動で Proposal 化すると、次の問題が起きる。

- `observe` は agent surface から呼べるが、Proposal 生成は admin 権限と強く結びつく
- stdio MCP サーバーでは常駐ワーカー前提の設計が重い
- `compile_context` に副作用を混ぜると P-1 の責務分離が崩れる
- write path のレイテンシと失敗モードが `observe` に流入する

Observation は「事実の記録」、Proposal 化は「管理者による知識候補生成」として、
責務を分ける必要がある。

---

## 決定

### D-1: `aegis_observe` は append-only の記録 API に留める

`aegis_observe` は Observation Layer への書き込みだけを行う。
Analyzer 実行や Proposal 生成は内部で自動実行しない。

これにより、agent surface は引き続き
「読み取り + Observation 記録」に限定され、INV-6 の境界が明瞭になる。

### D-2: Proposal 化は admin-only の明示処理で行う

未分析 Observation を Proposal 化する処理は、
admin surface の明示操作として実行する。
仮称は `aegis_process_observations` とする。

この処理は以下を行う。

1. 未分析 Observation を取得する
2. `analyzed_at` を先に設定して claim を取る
3. 対応 Analyzer を実行する
4. Proposal を永続化する
5. 失敗時は claim をリリースする

stdio MCP に適した、明示的で再実行可能なワークフローとする。

### D-3: admin wrapper tool は `observe + process` を内包してよい

`aegis_import_doc` のような admin-only ラッパーツールは、
内部で Observation 記録と Proposal 化を続けて実行してよい。

ただし、これは wrapper の利便性であり、基礎原則は変わらない。
共通 primitive は常に
`Observation -> Analyzer -> Proposal -> Approve` である。

### D-4: Analyzer 選択は固定レジストリ方式とする

Analyzer は event type ごとの固定マッピングで管理する。
汎用プラグインシステムは導入しない。

理由:

- event type が責務境界として十分に機能する
- 実行順序や競合を設計しやすい
- v1 の規模でプラグイン機構は過剰

### D-5: Proposal の自動承認は導入しない

Analyzer が生成した Proposal はすべて人間レビュー必須とする。
自動承認カテゴリは設けない。

P-3 の本質は「人間承認を通った知識のみが Canonical になる」ことであり、
自動承認はこの差別化を弱める。

### D-6: Observation の再分析ポリシーを明示する

- Proposal が reject された場合:
  evidence Observation の `analyzed_at` をリセットし、再分析可能に戻す
- Analyzer が「確定的に何も出せない」と判断した Observation:
  analyzed のままとし、無限再試行を避ける
- Analyzer / proposal 永続化が失敗した場合:
  claim をリリースし、再試行可能に戻す

### D-7: Observation のアーカイブは「resolved 済み evidence」に限定する

Observation をアーカイブしてよいのは、以下をすべて満たす場合のみとする。

- analyzed 済み
- 紐づく Proposal が存在しない、または全て resolved
- 一定日数経過している

アーカイブの実行自体は admin の明示操作
`aegis_archive_observations` とする。
バックグラウンド自動実行は導入しない。

### D-8: event type は `document_import` を追加する

`manual_note` は汎用メモ / 人手提案用のイベントとして残すが、
既存ドキュメント取り込みは `document_import` として独立させる。

これにより、import 固有の payload と Analyzer を自然に表現できる。

---

## 却下した代替案

### A-1: `observe` 時の同期自動実行

却下。surface 境界が曖昧になり、`observe` の責務が重くなりすぎる。

### A-2: `compile_context` 時の自動処理

却下。read path に副作用を持ち込むため、P-1 と責務分離に反する。

### A-3: 常駐バックグラウンドループ

却下。stdio MCP サーバーの運用モデルと相性が悪い。

### A-4: 汎用 Analyzer プラグイン機構

却下。v1 では複雑さの方が大きい。

---

## 影響

### 実装タスク

1. admin-only の `aegis_process_observations` ツールを追加する
2. event type -> analyzer の固定レジストリを `AegisService` に持たせる
3. `document_import` event type と専用 Analyzer を追加する
4. `archiveOldObservations()` を「resolved 済み evidence のみ」対象に修正する
5. wrapper tool が必要な場合は、内部で `observe + process` を呼ぶ

### 維持される性質

- agent surface は Observation 記録まで
- Proposal 生成と Canonical 更新は admin 側
- reject 後の再分析と重複排除は維持

---

## 備考

- `analyzeAndPropose` は internal primitive のままでよい
- 将来 SLM ベース Analyzer を追加しても、この ADR のトリガー方針は変わらない
