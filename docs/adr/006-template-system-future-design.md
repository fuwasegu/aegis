# ADR-006: テンプレートは bootstrap 用 seed source として維持し、配布は段階拡張する

**ステータス:** Implemented
**日付:** 2026-03-13

## 関連議題

- [テンプレートシステムの将来設計](../議題_テンプレートシステムの将来設計.md)

---

## コンテキスト

Aegis の `init` は、プロジェクトに最初の Canonical Knowledge を投入するための
bootstrap 手段を必要とする。
その役割を、現在は `templates/` 配下の seed documents / edges / layer rules が担っている。

この発想自体は妥当だが、現実装には未整理の点がある。

- テンプレート配布が npm 同梱前提
- 外部テンプレートや組織内テンプレートの導線がない
- upgrade がテンプレート起源データを十分に追跡していない
- バージョン比較や削除方針が粗い

テンプレートの存在理由と運用境界を明確にする必要がある。

---

## 決定

### D-1: テンプレート概念は維持する

テンプレートは Aegis に必要である。
理由は、`init` 時に
「プロジェクトの技術スタックに対して最初の seed knowledge を投入する」
決定的手段が必要だからである。

AI に初期文書をその場生成させる方式は、bootstrap 時点から非決定性を持ち込みすぎる。

### D-2: v1 は「単一選択プロフィール」で bootstrap する

init 時に選ぶのは 1 つの architecture profile とする。
複数テンプレートの自動合成は v1 では導入しない。

理由:

- 合成ルールの競合が複雑
- どの seed が何由来か分かりにくくなる
- v1 では import / observe による追加入力で十分補える

必要な追加知識は、bootstrap 後に import や manual proposal で増やす。

### D-3: 配布は「同梱 + ローカル追加」を採用する

v1 の配布方式は以下の組み合わせとする。

- Aegis パッケージ同梱の公式テンプレート
- ユーザーまたは組織が指定できるローカル追加テンプレートパス

中央レジストリやコミュニティ検索機能は v1 の範囲外とする。
まずは公式セットとローカル拡張で十分である。

### D-4: プロファイル選択は決定的なルールベースを維持する

プロファイル選択は現在の方向性を維持し、
ルールベースかつ evidence を返す仕組みを続ける。

重要なのは「完璧な自動選択」よりも、
なぜその profile が選ばれたかを人間が監査できることにある。

高信頼同点は block、低信頼単独候補は warn の方針も維持する。

### D-5: テンプレート version は semver として扱う

`template_version` は単純な文字列ではなく semver として扱う。
upgrade 判定は semver 比較に基づいて行う。

これにより、将来の patch / minor / major の意味づけが可能になる。

### D-6: template upgrade は admin 主導の制御された maintenance flow とする

template upgrade は Observation 起点ではなく、
admin が明示的に `check_upgrade` / `apply_upgrade` を実行する
管理操作と位置づける。

これは import とは異なり、
既知テンプレート差分から決定的に導かれる maintenance flow である。
そのため、bootstrap と同様に
「Observation evidence を持たない proposal を生成しうる制御された例外」
として明文化する。

ただし、Canonical 反映には常に人間承認を要求する。

### D-7: テンプレート起源データの provenance を保持する

upgrade を安全にするため、どの Document / Edge / LayerRule が
どのテンプレート version から入ったかを追跡できるようにする。

upgrade 判定は単なる現在状態比較ではなく、
template-owned entity と user-added entity を区別して行う。

### D-8: upgrade の削除は自動適用しない

テンプレート新版で seed が消えた場合でも、
既存 Canonical を自動削除しない。

削除相当の変更は、必要なら `deprecate` proposal として明示し、
人間が判断する。

### D-9: テンプレート言語は最小限に保つ

テンプレートの表現力は増やしすぎない。
v1 で許容するのは以下までとする。

- placeholder 展開
- deterministic な `when` 条件
- 必要最小限の boolean 条件結合

Jinja2 的なループ、任意スクリプト、複雑な制御構文は導入しない。
テンプレートをプログラミング言語化しない。

---

## 却下した代替案

### A-1: テンプレート不要、初期文書は人間または AI が都度作る

却下。bootstrap の再現性と導入速度が落ちる。

### A-2: 複数テンプレートの自動合成を v1 から導入する

却下。競合解決コストが高い。

### A-3: コミュニティレジストリを最初から作る

却下。品質管理と配布責務が重すぎる。

### A-4: upgrade で template 削除を自動反映する

却下。ユーザーの Canonical を過剰に侵襲する。

---

## 影響

### 実装タスク

1. テンプレート検索パスにローカル追加ディレクトリを導入する
2. `template_version` 比較を semver ベースへ切り替える
3. template-owned entity の provenance を保存する
4. upgrade 判定を provenance ベースに修正する
5. 削除系変更は `deprecate` proposal として扱う
6. `when` 条件を最小限の boolean 結合まで拡張する

### 維持される価値

- 決定的 bootstrap
- 人間確認付き init
- 監査可能な初期知識投入

---

## 備考

- 公式テンプレートは「正解の押し付け」ではなく、
  初期足場としての opinionated defaults である
- seed knowledge の不足やズレは、bootstrap 後の import / observe / proposal フローで補正する
