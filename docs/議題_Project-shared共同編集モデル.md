# 議題: Project-shared Canonical の共同編集モデル

**起票日**: 2026-05-18
**ステータス**: ADR-018 として決定済み

---

## 結論サマリ

**B案を採用。ADR-017 を置き換えず、上位に collaborative authoring source を足す新 ADR (ADR-018) として進める。**

確定事項:

| 論点 | 結論 |
|------|------|
| ADR-017 との関係 | 置き換えではなく上位に新レイヤー追加。bundle は distribution artifact のまま |
| approval model | 2-lane: DB-native（従来の Observation → Proposal → Approve）+ source-native（PR merge → materialize） |
| `knowledge_version` | Phase 1 では現行 semantics を維持。shared identity が必要なら `source_revision` を別導入 |
| PR merge = approval | source-native lane 限定で可。全体への一般化は禁止 |
| ファイル構造 | `documents/<doc_id>.md` + frontmatter。`edges/` は source type 単位で分割。`tag-mappings.json` は一括許容 |
| local overlay | Phase 1 不要 |
| Phase 1 の閉ループ | shared source → lint/format → materialize to authoring DB → share-export → share-hydrate replica |

禁止事項:

1. `compile_context` は shared source を直接読まない
2. source-native lane でも validate / hash recompute を必須にする
3. PR merge = approval は source-native lane 限定
4. Phase 1 では local overlay を扱わない

## 未解決論点

以下は Phase 2 以降で検討する:

- local overlay の設計（clone ローカルの未公開 knowledge diff の compile への反映方法）
- delta materialize（全量ではなく差分適用）
- AI-assisted conflict resolution の範囲と制約
- authoring DB → shared source の再生成 / bootstrap export
- CI integration の具体的な構成（`share-lint` を PR check にどう組み込むか）
- `knowledge_version` の将来的な再定義の必要性

## ADR

- **[ADR-018: Collaborative Project-Share Authoring](adr/018-collaborative-project-share-authoring.md)** — 本議題の結論を正式に記録

## 関連ドキュメント

- [ADR-017: Project-Shared Canonical Bundle と Replica Hydration](adr/017-project-shared-canonical-distribution.md)
- [ADR-016: Source Artifact と Compile Unit の分離、および Drift Reconciliation モデル](adr/016-source-artifact-compile-unit-and-drift-reconciliation.md)
- [ADR-010: Document Ownership と Reconciliation モデル](adr/010-document-ownership-and-reconciliation-model.md)
- [Aegis Technical Guide](technical-guide.md)
- [議題: Aegis 主導ドキュメント運用と Single Source of Truth](議題_Aegis主導ドキュメント運用とSingle Source of Truth.md)
