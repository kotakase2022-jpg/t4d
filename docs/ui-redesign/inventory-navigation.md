# UI 再設計 — ナビゲーション・役割インベントリ（2026-10-07）

分析だけを行い、実装はしていない。対象は `feat/self-audit-2026-08-20` の `ce86c09`（2026-10-05）。根拠は `path:line` で示す。

> 指示書の全文（`…/scratchpad/ui-directive-2026-10-07.md`）は、指定の場所に存在しなかった（2026-10-07 に確認）。本書は依頼文に付いていた要約をもとに書いている。全文が手に入ったら、§9 の原則との対応をもう一度確かめること。

## 0. 要約

1. メニューは 3 本ある。従来ツリー（41 ノード・固有 href 31）、開示優先ツリー（44・34）、監査法人ツリー（フラット 14）。役割による違いは 9 個の href を隠すことだけで、拠点担当でも 31 行、閲覧者でも 40 行を常に全展開で見ている。
2. ホームも役割で変わらない（従来）。全社 KPI 9 枚と全社タスクを全員に出している。開示優先ホームでは、拠点担当・サプライヤーが最初に目にするのが「アクセス権限がありません」になる。
3. 業務（登録・修正・確認・承認）の入口が、非財務データのフィルタ・ワークフロー・アラート・通知に分かれている。拠点担当が入力したり差戻しを直したりするには 5 クリック、監査法人で未受領の PBC に届くには 4 クリックかかる（§7.1）。
4. メニュー外の画面が 11 ある（従来ツリーでは開示プロジェクト・ESG経営・標準 CSV も含む）。Command Palette はメニューしか検索しないため、どれも探し当てられない。監査法人ツリーでは、案件を選んでいないと 12 項目が同時に「現在地」になる。
5. 提案は 3 点。①メニュー木（明示要望とテストで固定されている）は変えない。②役割の違いは「役割別ホーム（Attention→Action→Status→Insight）」「タスク動詞のキュー」「Command Palette 拡張」で出す。③監査法人ツリーとパンくずは作り直す（§9）。

## 1. 範囲と数え方

| 対象             | 数                                                  | 根拠                          |
| ---------------- | --------------------------------------------------- | ----------------------------- |
| 画面（page.tsx） | 78（enterprise 55／assurance 15／共通・認証 8）     | `find src/app -name page.tsx` |
| 従来ツリー       | 41 ノード／固有 href 31／最大深さ 3                 | `nav-config.ts:105-374`       |
| 開示優先ツリー   | 44 ノード／固有 href 34／最大深さ 3                 | `nav-config.ts:428-494`       |
| 監査法人ツリー   | 14 ノード（うち案件配下 11）／深さ 1                | `nav-config.ts:752-787`       |
| 役割             | enterprise 8／assurance 6／platform 1               | `roles.ts:20-151`             |
| デモ利用者       | 11 人（企業 5 役割・監査法人 3 役割＋別テナント 2） | `fixtures/dataset.ts:146-258` |

- 「深さ」はサイドバーで何段入れ子になっているか（最上位が 1）。
- 「クリック数」はホームから操作対象に届くまでの最短クリック数。FilterBar のチップ 1 つを 1 クリックと数える（チップはその場で切り替わる。`filter-bar.tsx:100-124`）。値の入力は含めない。

## 2. App Shell（現状）

### 2.1 ヘッダー（`app-shell.tsx:139-221`、左から右）

| 要素             | 出す条件                                        | 動作・問題                                                                                           | 根拠                                                                                 |
| ---------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| ロゴ             | 常に                                            | `/enterprise/dashboard` か `/assurance/dashboard` へ                                                 | `app-shell.tsx:140-143`                                                              |
| ワークスペース   | 常に                                            | 候補が 1 件なら文字だけ。2 件以上ならドロップダウンで、切り替えると `homePathFor` へ移る             | `selectors.tsx:46-88`, `auth/actions.ts:159`                                         |
| 報告期間         | 企業かつ期間あり                                | Cookie に保存。表示はコード（FY）だけ。日付の範囲は、プロジェクトの文脈がある時、1600px 未満では隠す | `app-shell.tsx:159-177`, `selectors.tsx:101-154`                                     |
| 開示プロジェクト | `/enterprise/disclosure-projects/<id>` 配下だけ | 名前・範囲・別年度の警告                                                                             | `header-context.tsx:23-26,44-92`                                                     |
| 案件             | 監査法人                                        | 切り替えても下位パスを保つ。既定は `overview`                                                        | `selectors.tsx:162-197`                                                              |
| デモ表示 3 種    | Demo                                            | デモデータ／保持超過／デモ基準日                                                                     | `app-shell.tsx:186-196`                                                              |
| 役割切替（デモ） | Demo かつ候補 2 件以上                          | 企業 layout だけが候補を渡す。監査法人・共通ルートには出ない。切り替えた後も同じ画面に戻る           | `app-shell.tsx:200-202`, `enterprise/layout.tsx:34-41`, `demo-role-actions.ts:38,53` |
| 通知             | 常に                                            | `/notifications`（未読数バッジ）                                                                     | `app-shell.tsx:203-212`                                                              |
| ヘルプ           | 常に                                            | ショートカットの一覧だけ（ガイド・用語の説明は無い）                                                 | `help-dialog.tsx:14-22`                                                              |
| ユーザー         | 常に                                            | ロール名／プロフィール／ワークスペース選択／ログアウト                                               | `selectors.tsx:199-256`                                                              |

### 2.2 サイドバー（`sidebar.tsx`）

- 幅は 224px、折りたたむと 64px。折りたたみ状態は localStorage `t4d.sidebar.collapsed` に保存する（`:26,94-113,121`）。
- **子は常に全展開**。グループ単位では開閉できない（`:210-219,289-298`）。
- 現在地の付け方は 2 通り。従来ツリーと監査法人ツリーは「最上位と葉」（top-and-leaf）、開示優先ツリーは木全体で 1 つ（single）（`:69`, `nav-config.ts:606-664`）。同じ href が SSBJ と CSRD の両方にあるときは、sessionStorage `t4d.sidebar.branch` に覚えた枝を優先する（`nav-branch.ts`）。
- 権限で隠すかどうかは href 単位で判定する。サーバーは `navTreeFor(variant, null)` で隠す href を求め、クライアントがそれを全階層から除く（`app-shell.tsx:76-78`, `nav-config.ts:502-510`, `sidebar.tsx:44-55`）。
- デモ案内（DemoTour）は従来ツリーにだけ出る（`sidebar.tsx:152`）。

### 2.3 Command Palette（`command-palette.tsx`）

| 項目       | 現状                                                                                                                            | 根拠                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 起動       | Ctrl/Cmd+K で開閉する。`/` を押すと `[data-t4d-list-search]` にフォーカスする（その要素があるのは FilterBar を持つ 5 画面だけ） | `:64-87`, FilterBar 利用 5 画面 |
| 検索対象   | **メニューの木だけ**。secondary 以外の全ノードを経路ラベル付きで並べ、グループ見出しも 1 件と数える（重複 href も残る）         | `:22-38`                        |
| 追加候補   | `extraEntries` の受け口はあるが、**どこからも渡していない**                                                                     | `:47`, `app-shell.tsx:230`      |
| 空クエリ   | 木の順に先頭 30 件を出す（最近使った画面・役割のおすすめは無い）                                                                | `:89-97`                        |
| 一致方法   | ラベル＋グループ＋keywords の部分一致。並べ替えは無い                                                                           | `:92-96`                        |
| 文言       | プレースホルダーが「サンプリング、CDP、母集団」で、ワークスペースに関係なく企業と監査法人の語を混ぜている                       | `:138`                          |
| 出ないもの | データ（指標・拠点・要求事項コード・原稿）・操作（承認など）・利用者・設定の節・メニュー外の画面・通知・プロフィール            | —                               |

### 2.4 キーボード（`record-shortcuts.tsx:10-13`, `help-dialog.tsx:14-22`）

`Ctrl/Cmd+K`、`/`、`j`/`k`（`[data-t4d-record]` がある画面だけ：非財務データ・保証契約一覧）、`e`、`c`、`s`（下書き保存だけ）、`Esc`。`?` でヘルプを開く操作や、`g`＋キーで画面を移る操作は無い。

### 2.5 パンくず（`page-header.tsx:34-50`）

- 64 か所で、ページごとに手書きしている（メニューの木から作っていない）。
- 先頭の「企業ワークスペース」「監査法人ワークスペース」はリンクになっていない。
- **リンクの無いクランプにはすべて `aria-current="page"` が付く**（`:44-46`）。例えば SSBJ 対応状況では「企業ワークスペース」「開示対応」「SSBJ」の 3 つに付く。
- 共通ルートの「ホーム」は `/workspace`（ワークスペース選択）を指している（`notifications/page.tsx:41`, `profile/page.tsx:29`）。

| 画面                                                        | パンくず                                                 | メニューとのずれ                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `ssbj/requirements` (`:287`) / `csrd/requirements/[itemId]` | …SSBJ > **要求事項の評価**                               | メニューは「要求事項」                                                       |
| `ghg/suppliers` (`:85`)                                     | GHG > **サプライヤーデータ取込**                         | メニューは「Scope3データ取込 > Cat.1」                                       |
| `esg/*` (`esg/page.tsx:225`)                                | **ESG 経営**                                             | メニュー（開示優先）は「ESG経営」                                            |
| `alerts` (`:69,76`)                                         | アラート（h1 は「統合アラートセンター」）                | h1 とメニュー名が違う                                                        |
| `ghg` (`:165,179`)                                          | GHG（h1 も GHG）                                         | 葉の名前は「算定サマリー」、開示優先では「GHG算定」                          |
| `ssbj/*`, `csrd/*`, `cdp`, `[framework]`                    | 企業ワークスペース > **開示対応** > …                    | 開示優先ツリーなら「開示プロジェクト」。パンくずはツリーに関係なく従来の経路 |
| `workflows` (`:82`) / `data` / `evidence`                   | ワークフロー／非財務データ／（listLabel）                | 開示優先では「自分の作業・レビュー」／「定量データ」／「資料・証跡」         |
| `roadmap` (`:100`)                                          | 今後対応                                                 | メニューに無い                                                               |
| `disclosure-projects/[p]/blocks/[b]/recheck` (`:56`)        | 企業WS > 開示プロジェクト > 原稿 > 節名 > 再確認（5 段） | 画面の階層は 5 段（メニューは 2 段）                                         |

### 2.6 タブ・工程帯・画面内ナビ

| 種類               | 場所                                                                   | 状態の持ち方                       | 根拠                                                          |
| ------------------ | ---------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------- |
| ホームのタブ       | 開示業務／ESG経営（開示優先だけ。ESG経営タブの中身は従来ホーム）       | `?tab=esg`                         | `dashboard/page.tsx:53-128`                                   |
| プロジェクトのタブ | 概要／要求事項／原稿／レビュー・承認／出力／設定                       | `?tab=`                            | `disclosure-projects/[projectId]/page.tsx:24-31,117-137`      |
| 原稿編集の右ペイン | 要求事項／根拠資料／関連数値／前年／コメント                           | Radix Tabs（ローカル）             | `blocks/[blockId]/editor-right-pane.tsx:119-137`              |
| 工程帯（8 段）     | SSBJ 対応状況・CSRD 対応状況（各工程にリンク。設定画面への入口もここ） | サーバー計算                       | `ssbj-flow.tsx:55-119`, `csrd/_overview/overview-model.ts:31` |
| 3 段ステップ       | CDP                                                                    | サーバー計算                       | `disclosure-steps.tsx:34-73`, `cdp/page.tsx:158`              |
| 保存ビュー（固定） | 非財務データ・CDP・SSBJ 要求事項・CSRD 要求事項                        | URL クエリ（利用者は保存できない） | `filter-bar.tsx:140-150`, `data/page.tsx:256-271`             |

## 3. メニューツリー（正確な転記）

### 3.1 従来 `ENTERPRISE_NAV`（`nav-config.ts:105-374`。形は `tests/unit/nav-config.test.tsx:149-211` と `tests/e2e/nav-structure.spec.ts:25-70` で固定）

| 深  | ラベル                               | href                                    | permission                 | 備考（行）                                                                                             |
| --- | ------------------------------------ | --------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | ホーム                               | /enterprise/dashboard                   | —                          | `:106-111`                                                                                             |
| 1   | 開示対応                             | /enterprise/disclosures/ssbj            | —                          | `:112-212`。見出しが SSBJ と同じ href                                                                  |
| 2   | SSBJ                                 | /enterprise/disclosures/ssbj            | —                          | `:119-158`                                                                                             |
| 3   | 対応状況                             | /enterprise/disclosures/ssbj            | —                          | 同じ href が 3 つ目                                                                                    |
| 3   | 要求事項                             | …/ssbj/requirements                     | —                          |                                                                                                        |
| 3   | 対応計画                             | …/ssbj/plans                            | —                          |                                                                                                        |
| 3   | データ収集                           | …/ssbj/collection                       | —                          |                                                                                                        |
| 3   | 定性情報                             | /enterprise/narratives                  | enterprise.disclosure.read | `NARRATIVES_ITEM :73-79`。CSRD と共通、現在地は優先枝で決める                                          |
| 3   | 開示ドラフト                         | …/ssbj/draft                            | —                          |                                                                                                        |
| 2   | CDP                                  | /enterprise/disclosures/cdp             | —                          | `:159`                                                                                                 |
| 2   | CSRD                                 | /enterprise/disclosures/csrd            | enterprise.disclosure.read | `:160-208`                                                                                             |
| 3   | 対応状況                             | /enterprise/disclosures/csrd            | 同上                       |                                                                                                        |
| 3   | 要求事項                             | …/csrd/requirements                     | 同上                       | `alsoCurrentFor` で `/csrd/{UUID}` も現在地にする（`:183`）                                            |
| 3   | 対応計画／データ収集                 | …/csrd/plans, …/csrd/collection         | 同上                       |                                                                                                        |
| 3   | 定性情報                             | /enterprise/narratives                  | 同上                       | 共通項目                                                                                               |
| 3   | 開示ドラフト                         | …/csrd/draft                            | 同上                       |                                                                                                        |
| 2   | MSCI／FTSE                           | /enterprise/disclosures/msci, /ftse     | —                          | `:209-210`。**中身は「Phase 1 実装対象外」の案内だけ**（`[framework]/page.tsx:1-52`）                  |
| 1   | ESG データ（GHG以外）                | /enterprise/data                        | —                          | `:213-239`。見出しは 2 番目の子と同じ href                                                             |
| 2   | データ取込／非財務データ／Evidence   | /enterprise/imports, /data, /evidence   | —                          |                                                                                                        |
| 1   | GHG                                  | /enterprise/ghg                         | —                          | `:240-279`                                                                                             |
| 2   | 算定サマリー                         | /enterprise/ghg                         | —                          | 現在地は完全一致の時だけ（`:572-576`）                                                                 |
| 2   | Scope3データ取込                     | /enterprise/ghg/suppliers               | —                          |                                                                                                        |
| 3   | Cat.1                                | /enterprise/ghg/suppliers               | —                          | 旧名「サプライヤーデータ取込」は keywords に残している                                                 |
| 1   | 業務管理                             | /enterprise/workflows                   | —                          | `:280-305`                                                                                             |
| 2   | ワークフロー／アラート／レポート     | /workflows, /alerts, /reports           | —                          |                                                                                                        |
| 1   | AI Copilot                           | /enterprise/ai                          | —                          | `:306`                                                                                                 |
| 1   | 分析                                 | /enterprise/analysis/diagnosis          | —                          | `currentPrefix=/enterprise/analysis`（`:307-353`）                                                     |
| 2   | 現状診断                             | …/analysis/diagnosis                    | —                          |                                                                                                        |
| 2   | 規制対応度                           | …/analysis/regulations                  | enterprise.disclosure.read |                                                                                                        |
| 2   | 自社経年比較／他社比較／財務影響分析 | …/trends, /benchmark, /financial-impact | —                          |                                                                                                        |
| 1   | 管理                                 | /enterprise/organizations               | —                          | `:354-373`                                                                                             |
| 2   | 組織・拠点                           | /enterprise/organizations               | —                          | 中身は組織階層・報告期間・報告年度・収集キャンペーン・指標マスター（`organizations/page.tsx:120-332`） |
| 2   | 設定                                 | /enterprise/settings                    | enterprise.org.manage      |                                                                                                        |

### 3.2 開示優先 `ENTERPRISE_NAV_DISCLOSURE_FIRST`（`nav-config.ts:428-494`。最上位の並びは `nav-config.test.tsx:250-261` で固定）

| 深  | ラベル                                 | href                                    | 由来・備考                                                                     |
| --- | -------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | ホーム                                 | /enterprise/dashboard                   | keywords に「自分の作業」を足している（`:429-432`）                            |
| 1   | 開示プロジェクト                       | /enterprise/disclosure-projects         | 独自の画面（`:433-454`）                                                       |
| 2   | SSBJ（6 子）／CSRD（6 子・権限あり）   | 従来と同じ                              | 定性情報だけを **secondary**（現在地にしない）にした複製（`:398-410,439-440`） |
| 2   | その他の開示                           | /enterprise/disclosures/cdp             | 見出しが CDP と同じ href（`:441-451`）                                         |
| 3   | CDP／MSCI／FTSE                        | 従来と同じ                              |                                                                                |
| 2   | レポート出力                           | /enterprise/reports                     | 従来「レポート」を改名（`:452`）                                               |
| 1   | 情報・根拠                             | /enterprise/data                        | `:455-474`                                                                     |
| 2   | 定量データ／定性情報／資料・証跡／取込 | /data, /narratives, /evidence, /imports | 従来の項目を改名。定性情報はここが正規の位置                                   |
| 2   | 数値を登録（標準CSV）                  | /enterprise/imports/standard            | **従来ツリーには無い**（`:466-470`）                                           |
| 2   | GHG算定                                | /enterprise/ghg                         | 「算定サマリー」の改名                                                         |
| 2   | Scope3データ取込 > Cat.1               | /enterprise/ghg/suppliers               | 従来と同じ                                                                     |
| 1   | ESG経営                                | /enterprise/esg                         | **従来ツリーには無い**（`:476-480`）                                           |
| 1   | タスク・承認                           | /enterprise/workflows                   | `:481-490`                                                                     |
| 2   | 自分の作業・レビュー／アラート         | /workflows, /alerts                     | 中身は全社タスク（§6.6）で、「自分の」はレビュー節だけ                         |
| 1   | 分析（5 子）／管理（2 子）／AI Copilot | 従来と同じ                              | AI Copilot を最後に置いている（`:491-493`）                                    |

### 3.3 監査法人 `assuranceNav(engagementId)`（`nav-config.ts:752-787`。形を固定するテストは無い）

| ラベル                                                                                                                         | href（案件を選んでいる時）         | 案件未選択の時                                     | permission            |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | -------------------------------------------------- | --------------------- |
| 案件ホーム                                                                                                                     | /assurance/dashboard               | 同じ                                               | —                     |
| 保証契約                                                                                                                       | /assurance/engagements             | 同じ                                               | —                     |
| スコープ／Data Room／母集団／サンプリング／保証手続・調書／PBC／資料依頼／指摘・例外／レビューNote／Sign-off／監査ログ／Export | /assurance/engagements/{id}/{path} | **11 件とも /assurance/engagements**（`:754-759`） | —（画面側で判定）     |
| 設定                                                                                                                           | /assurance/settings                | 同じ                                               | assurance.firm.manage |

`/assurance/engagements/{id}/overview`（案件の概要）はメニューに無い。案件ホームの表・一覧・パンくず・案件セレクタの既定から入る（`dashboard/page.tsx:149`, `engagements/page.tsx:163`, `engagement-header.tsx:34`, `selectors.tsx:171`）。

## 4. メニュー外の画面（URL か画面内リンクでしか届かない）

詳細画面（`[id]`）は除く。「パレット」欄は Command Palette で見つかるかどうか。

| 画面                                                   | 従来ツリー | 開示優先ツリー | 画面内の入口（行）                                                                                                                                                    | パレット |
| ------------------------------------------------------ | ---------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| /enterprise/disclosure-projects (+/new)                | **無し**   | 有             | 開示優先ホーム（`disclosure-home-view.tsx:196,213,216`）、規制対応度の ESRS 40a 行（`services/analysis/regulations.ts:151`）だけ                                      | 従来 ×   |
| /enterprise/esg                                        | **無し**   | 有             | 財務影響分析（`financial-impact/_components/ready-view.tsx:421`）、開示優先ホームの ESG タブ（`dashboard/page.tsx:119`）                                              | 従来 ×   |
| /enterprise/imports/standard                           | **無し**   | 有             | データ取込（`imports/page.tsx:75`）                                                                                                                                   | 従来 ×   |
| /enterprise/esg/targets                                | 無し       | 無し           | ESG経営（`esg/page.tsx:228`）、KPI 詳細（`esg/[kpiKey]/page.tsx:332`）                                                                                                | ×        |
| /enterprise/disclosures/ssbj/settings                  | 無し       | 無し           | SSBJ 対応状況（`ssbj/page.tsx:137,415,448`）、要求事項（`requirements/page.tsx:368,414`）、デモ案内                                                                   | ×        |
| /enterprise/disclosures/csrd/settings (+matters)       | 無し       | 無し           | CSRD 工程①（`overview-model.ts:31`）、要求事項（`csrd/requirements/page.tsx:215,236`）、ドラフト（`csrd/draft/page.tsx:135`）                                         | ×        |
| /enterprise/disclosures/cdp/import                     | 無し       | 無し           | CDP（`cdp/page.tsx:158,204`）                                                                                                                                         | ×        |
| /enterprise/disclosures/ssbj/requirements/top-priority | 無し       | 無し           | **デモ案内だけ**（`demo-tour.tsx:77,85`。DemoTour は従来ツリーにしか出ない）。コメントには「対応状況画面から使う」とあるが、リンクは無い（`top-priority/page.tsx:8`） | ×        |
| /enterprise/roadmap（今後対応）                        | 無し       | 無し           | AI Copilot（`ai/page.tsx:335`）、MSCI/FTSE（`[framework]/page.tsx:73`）                                                                                               | ×        |
| /enterprise/narratives/new                             | 無し       | 無し           | 定性情報の一覧                                                                                                                                                        | ×        |
| /enterprise/analysis（入口）                           | —          | —              | 現状診断へ redirect する（`analysis/page.tsx:1-6`）                                                                                                                   | —        |
| /notifications・/profile・/workspace                   | ヘッダー   | ヘッダー       | ベル・ユーザーメニュー                                                                                                                                                | ×        |
| /assurance/engagements/{id}/overview                   | —          | —              | §3.3 のとおり                                                                                                                                                         | ×        |

メニュー外の画面を開くと、サイドバーの現在地が 1 つも付かない（試算: 従来ツリーの `/enterprise/esg`・`/roadmap`、開示優先ツリーの `/roadmap`・`/ssbj/settings`）。

## 5. 画面間リンク（主なハブ。行き先は scratchpad の静的走査で求め、リンク・revalidate・redirect の文字列を含む）

| 出発                     | 主な行き先                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| ホーム（従来）           | workflows?flag=overdue・data?status/flag・ssbj・ssbj/requirements?…・cdp・organizations・alerts・data/{id}（`legacy-home.tsx:47-371`） |
| ホーム（開示優先）       | project・project?tab=manuscripts&filter=mine・各カードの一覧・disclosure-projects(/new)・esg・各タスクの CTA                           |
| SSBJ 対応状況            | 工程帯 → requirements・plans・collection・draft・settings・imports                                                                     |
| CSRD 画面群              | csrd 6 画面・settings・data・imports・narratives                                                                                       |
| 分析（5 画面＋サービス） | 開示・データ・GHG・ESG・organizations・**settings**（後述 N-16）・alerts・workflows など 27 種                                         |
| 非財務データ             | data/{id}・cdp・disclosures/{x}・imports                                                                                               |
| データ取込               | data・evidence・imports/standard・imports/{job}・ssbj/draft                                                                            |
| 開示プロジェクト         | blocks・recheck・narratives・evidence・data・ssbj・ssbj/requirements/{x}                                                               |
| ワークフロー／アラート   | blocks（自分のレビュー）／data・cdp・workflows                                                                                         |
| 監査法人ホーム           | KPI 7 枚は**すべてフィルタ無しの /assurance/engagements**、表 → overview（`assurance/dashboard/page.tsx:59-118,149`）                  |
| 監査法人の案件概要       | testing・requests・issues・review-notes・data-room・signoffs（`overview/page.tsx:76-121`）                                             |

参照の多い行き先（文字列の出現回数）: /enterprise/data 52、data/{id} 27、csrd 26、cdp 24、workflows 24、ssbj 23、ssbj/requirements 18、evidence・ghg・ghg/suppliers・imports・organizations・settings 各 16。

## 6. 役割インベントリ

### 6.1 権限（企業。`roles.ts:20-95`。DB 側は `0002_identity.sql` で、両者の一致は `authorization.test.ts` が検査している）

| 権限 \ 役割           | 管理者 |     本社サステナ      | 拠点 | サプライヤー | レビュー | 最終承認 | 外部支援 | 閲覧 |
| --------------------- | :----: | :-------------------: | :--: | :----------: | :------: | :------: | :------: | :--: |
| org.manage            |   ✓    |                       |      |              |          |          |          |      |
| member.manage         |   ✓    |                       |      |              |          |          |          |      |
| period／metric.manage |   ✓    |           ✓           |      |              |          |          |          |      |
| grant.manage          |   ✓    | ✓（**UI 無し** N-09） |      |              |          |          |          |      |
| data.read             |   ✓    |           ✓           |  ✓   |      ✓       |    ✓     |    ✓     |    ✓     |  ✓   |
| data.write／submit    |   ✓    |           ✓           |  ✓   |      ✓       |          |          |          |      |
| data.review           |   ✓    |           ✓           |      |              |    ✓     |    ✓     |          |      |
| data.approve          |        |                       |      |              |          |    ✓     |          |      |
| evidence.read         |   ✓    |           ✓           |  ✓   |              |    ✓     |    ✓     |    ✓     |  ✓   |
| evidence.write        |   ✓    |           ✓           |  ✓   |      ✓       |          |          |          |      |
| import.run            |   ✓    |           ✓           |  ✓   |              |          |          |          |      |
| disclosure.read       |   ✓    |           ✓           |      |              |    ✓     |    ✓     |    ✓     |  ✓   |
| disclosure.write      |   ✓    |           ✓           |      |              |    ✓     |          |          |      |
| disclosure.approve    |        |                       |      |              |          |    ✓     |          |      |
| export.run            |   ✓    |           ✓           |      |              |          |    ✓     |          |      |
| ai.run                |   ✓    |           ✓           |      |              |          |          |          |      |
| pbc.respond           |   ✓    |           ✓           |  ✓   |              |          |          |          |      |
| common.audit.read     |   ✓    |                       |      |              |          |          |          |      |

### 6.2 権限（監査法人。`roles.ts:97-146`）

| 権限 \ 役割                        | 法人管理者 | 契約責任者 | マネージャー | 担当者 | 専門家 | 閲覧 |
| ---------------------------------- | :--------: | :--------: | :----------: | :----: | :----: | :--: |
| firm.manage                        |     ✓      |            |              |        |        |      |
| engagement.manage／scope／snapshot |            |     ✓      |      ✓       |        |        |      |
| engagement.read                    |            |     ✓      |      ✓       |   ✓    |   ✓    |  ✓   |
| population／sampling／pbc／issue   |            |     ✓      |      ✓       |   ✓    |        |      |
| testing.write／ai.run              |            |     ✓      |      ✓       |   ✓    |   ✓    |      |
| review.write                       |            |     ✓      |      ✓       |        |        |      |
| signoff.prepared                   |            |            |      ✓       |   ✓    |        |      |
| signoff.reviewed                   |            |     ✓      |      ✓       |        |        |      |
| signoff.partner                    |            |     ✓      |              |        |        |      |
| export.run／common.audit.read      |  監査のみ  |     ✓      |      ✓       |        |        |      |

### 6.3 デモ利用者（`dataset.ts:146-258`、切替の並び順は `demo-role.ts:38-57`）

| email                                               | 名前・職名                           | ロール                         | 担当範囲 | 切替ラベル                       |
| --------------------------------------------------- | ------------------------------------ | ------------------------------ | -------- | -------------------------------- |
| sustainability@demo.local                           | 海野 みどり／本社サステナ担当        | sustainability_manager         | 全社     | 作成担当                         |
| reviewer@demo.local                                 | 検見川 涼                            | reviewer                       | 全社     | レビュアー                       |
| approver@demo.local                                 | 承 花子／執行役員                    | approver＋reviewer             | 全社     | 最終承認者                       |
| enterprise-admin@demo.local                         | 青海 太郎／推進部長                  | enterprise_admin               | 全社     | 管理者                           |
| site-user@demo.local                                | 東 一郎／東日本工場                  | site_contributor               | east     | 拠点担当                         |
| assurance-partner／manager／staff／admin@demo.local | 保 統括／青葉 健／若葉 新／法人 管理 | partner／manager／staff／admin | —        | （監査法人には切替が出ない）     |
| other-enterprise-admin／other-assurance-manager     | 越権テスト用                         | —                              | —        | 一覧に出さない（featured=false） |

**依頼文との差**: supplier_contributor・external_advisor・viewer・specialist・assurance_viewer には**デモ利用者がいない**。これらの役割で何が見えるかは、権限から推定した値である（§6.4）。

### 6.4 役割 × 見えるメニュー（`hiddenNavHrefsFor` を全役割で実行した結果。scratchpad `nav-by-role.ts`）

| 役割                                   | 従来（/41） | 開示優先（/44） | 見えるが使わない・使えない項目（理由）                                                                                                                                                                                                                                           |
| -------------------------------------- | ----------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 企業管理者                             | 41          | 44              | MSCI/FTSE（未実装の案内）                                                                                                                                                                                                                                                        |
| 本社サステナ                           | 40          | 43              | MSCI/FTSE                                                                                                                                                                                                                                                                        |
| 拠点担当                               | 31          | 33              | 開示対応 > SSBJ 5 項目・CDP・MSCI・FTSE（開示の権限が無い。読むことはできる）、AI Copilot（ai.run 無し）、レポート（export.run 無し。押すと API が 403 `api/exports/*/route.ts:21-41`）、分析 4 項目、組織・拠点（閲覧のみ）、開示優先では「開示プロジェクト」（開くと権限なし） |
| サプライヤー（推定）                   | 31          | 33              | 拠点担当と同じに加え、データ取込・Scope3 取込（import.run 無し）、ワークフローの PBC（pbc.respond 無し）、Evidence 一覧（閲覧不可。登録だけ `evidence/page.tsx:173`）                                                                                                            |
| レビュー担当                           | 40          | 43              | データ取込・Scope3 取込（import.run 無し）、AI Copilot（ai.run 無し）、レポート（export.run 無し）、組織・拠点                                                                                                                                                                   |
| 最終承認者                             | 40          | 43              | データ取込・Scope3 取込、AI Copilot、組織・拠点                                                                                                                                                                                                                                  |
| 外部支援・閲覧（推定）                 | 40          | 43              | 書く系の画面はすべて閲覧のみ（取込・AI・レポート・ワークフロー）                                                                                                                                                                                                                 |
| 監査: 法人管理者                       | 14          | —               | **11 項目すべてが空の /assurance/engagements**（案件にアサインされていない。`dataset.ts:228`）。使うのは設定だけ                                                                                                                                                                 |
| 監査: 契約責任者／マネージャー／担当者 | 13          | —               | 担当者は監査ログ（common.audit.read 無し）・Export（export.run 無し）。どの役割にも「案件概要」の項目は無い                                                                                                                                                                      |
| 監査: 専門家・閲覧（推定）             | 13          | —               | スコープ・母集団・サンプリング・PBC・指摘・レビューNote・Sign-off・Export を見るだけ                                                                                                                                                                                             |

### 6.5 役割 × タスク × 実際に作業する画面

| 役割                 | 登録する                              | 修正する                                         | 確認する                                                                                                | 承認する                           | 集計する             | レポートを作る／開示する                                        | 分析する            | 管理する                                                                                 |
| -------------------- | ------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------- | --------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------- |
| 企業管理者           | 取込・標準CSV・data・evidence         | 差戻しデータ                                     | data 一次レビュー                                                                                       | —（approve 無し）                  | ghg・ghg/suppliers   | ssbj/csrd/cdp・projects・reports                                | analysis・esg       | **settings（機能設定・メンバー・招待・許諾）・organizations（期間・指標）・esg/targets** |
| 本社サステナ（作成） | 同上・narratives                      | 差戻し原稿（project ?filter=mine）・差戻しデータ | data 一次レビュー・ssbj/csrd 要求事項の評価                                                             | —                                  | ghg・Scope3          | **ssbj 6・csrd 6・cdp・projects/blocks・reports（中心の仕事）** | analysis・esg       | 期間・指標（organizations）・PBC 回答（workflows）                                       |
| 拠点担当             | **data（自拠点）・imports・evidence** | **差戻しデータ**                                 | 自拠点の状態                                                                                            | —                                  | —                    | —                                                               | （分析 4 は見える） | PBC 回答（workflows）                                                                    |
| サプライヤー（推定） | data（自社分）・evidence 登録         | 差戻し                                           | —                                                                                                       | —                                  | —                    | —                                                               | —                   | —                                                                                        |
| レビュー担当         | —                                     | —                                                | **data?flag=review_pending → data/{id}、原稿レビュー（workflows「自分のレビュー」・project レビュー）** | —                                  | —                    | 原稿の編集（disclosure.write）                                  | analysis            | —                                                                                        |
| 最終承認者           | —                                     | —                                                | 同上                                                                                                    | **data/{id} 承認・原稿の最終承認** | —                    | reports（export.run）                                           | analysis・esg       | —                                                                                        |
| 外部支援・閲覧       | —                                     | —                                                | 閲覧                                                                                                    | —                                  | —                    | —                                                               | analysis            | —                                                                                        |
| 監査: 契約責任者     | —                                     | —                                                | review-notes                                                                                            | **signoffs（partner）**            | —                    | exports                                                         | —                   | scope・engagements                                                                       |
| 監査: マネージャー   | data-room（snapshot）                 | issues                                           | review-notes                                                                                            | signoffs（prepared/reviewed）      | population・sampling | exports                                                         | —                   | scope・PBC                                                                               |
| 監査: 担当者         | population・sampling・testing         | issues                                           | PBC 受領                                                                                                | signoffs（prepared）               | —                    | —                                                               | —                   | —                                                                                        |
| 監査: 専門家         | testing（専門家メモ）                 | —                                                | data-room（閲覧）                                                                                       | —                                  | —                    | —                                                               | —                   | —                                                                                        |
| 監査: 法人管理者     | —                                     | —                                                | —                                                                                                       | —                                  | —                    | —                                                               | —                   | **assurance/settings だけ**                                                              |

### 6.6 役割 × ホームの現状

| ワークスペース・モード   | 誰に                   | いま出しているもの                                                                                                                                                                                                                                                                                 | 根拠                                                             |
| ------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 企業・従来（デモの既定） | **全役割で同じ**       | KPI 9 枚（期限超過／未提出／Validation Error／Evidence 不足／Review 待ち／承認率／SSBJ 対応度／SSBJ 未対応／CDP 準備度）→ 拠点別進捗 → 今日のタスク（7 日以内）→ 重要アラート → 期限超過 → 直近アクティビティ（閉）→ 警告帯 2 本。**件数もタスクもすべて全社**（自拠点・自分の担当に絞っていない） | `legacy-home.tsx:47-373`, `enterprise-data.ts:385-389,420-426`   |
| 企業・開示優先           | 開示の閲覧権限あり     | タブ（開示業務／ESG経営）→ 現在のプロジェクト → 4 カード → 自分が次に行う作業（原稿だけ・5 件。返却／レビュー／最終承認／再確認…）→ 分母付き進捗 → 拠点の未提出（閉）→ デモリセット                                                                                                                | `dashboard/page.tsx:53-143`, `disclosure-home-view.tsx:139-293`  |
| 企業・開示優先           | 拠点担当・サプライヤー | **最初の表示が「アクセス権限がありません」**（`role="alert"`）、その下に拠点の未提出（既定で閉）                                                                                                                                                                                                   | `disclosure-home-view.tsx:130-137,554-566`, `states.tsx:124-135` |
| 監査法人                 | 全役割で同じ           | KPI 7 枚（英語ラベル。すべてフィルタ無しの一覧へ）→ 案件の表。法人管理者には「アサインされている案件がありません」                                                                                                                                                                                 | `assurance/dashboard/page.tsx:41-170`                            |

## 7. 問題一覧

重大度: 高＝多くの役割の毎日の作業に効く、中＝特定の役割・作業、低＝表記・整合。

| ID   | 種別                       | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 根拠                                                                             | 影響する役割         | 重  |
| ---- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------- | --- |
| N-01 | 全部が L1                  | サイドバーは常に全展開（従来 41 行・開示優先 44 行）。L2・L3 という置き場所が無い。MSCI/FTSE（未実装の案内）まで毎日見る階層に並んでいる                                                                                                                                                                                                                                                                                                                                                                                                                            | `sidebar.tsx:210-219`, `[framework]/page.tsx:1-52`                               | 全員                 | 高  |
| N-02 | 役割で変わらない           | 役割の違いは 9 個の href を隠すことだけ。サイドバーでは拠点担当 31 行、閲覧者 40 行                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `nav-config.ts:77,166-205,327,370`, §6.4                                         | 拠点・承認・閲覧     | 高  |
| N-03 | ホームが役割で変わらない   | 従来ホームは全員に全社 KPI 9 枚・全社タスクを出す。拠点担当は自拠点の未提出・差戻しを、承認者は承認待ちを、ホームで直接見られない                                                                                                                                                                                                                                                                                                                                                                                                                                   | `legacy-home.tsx:47-146`, `enterprise-data.ts:385-389,420-426`                   | 全員                 | 高  |
| N-04 | 最初の画面が拒否           | 開示優先ホームで、拠点担当・サプライヤーの最初の表示が「アクセス権限がありません」（`role="alert"` で読み上げも割り込む）。本来の仕事（自拠点）は閉じた補助表示の中                                                                                                                                                                                                                                                                                                                                                                                                 | `disclosure-home-view.tsx:130-137,554-566`                                       | 拠点・サプライヤー   | 高  |
| N-05 | 機能単位のまとめ方         | 業務管理（ワークフロー／アラート／レポート）、管理、ESG データ、GHG は機能の名前でまとめたグループ。「承認する」「差戻しを直す」「PBC に答える」の入口は、非財務データのフィルタ・ワークフロー・アラート・通知に散らばっている                                                                                                                                                                                                                                                                                                                                      | §3.1, `workflows/page.tsx:38-50,237`, `alerts/page.tsx:91-201`                   | 全員                 | 高  |
| N-06 | 見出しと子の重複リンク     | 従来ツリー 9 href／19 リンク（`/disclosures/ssbj` は 3 か所）、開示優先ツリー 9 href／19 リンク（定性情報は 3 か所）。Command Palette も同じ画面を見出しと葉の 2 件で出す                                                                                                                                                                                                                                                                                                                                                                                           | scratchpad `nav-dupes.ts`, `command-palette.tsx:22-38`                           | 全員                 | 中  |
| N-07 | 同じ用件の入口が複数       | 期限超過（ホームの KPI＋カード・アラート `:201`）、未提出（ホームの KPI・アラート `:91`・開示ホーム）、PBC（ワークフロー `:237`・アラート `:123`）、検証エラー（ホーム・アラート `:155`・data?flag・現状診断 `diagnosis.ts:362`）                                                                                                                                                                                                                                                                                                                                   | 同左                                                                             | 作成・管理           | 中  |
| N-08 | 使わない項目が見える       | §6.4 のとおり。例: AI Copilot は ai.run を持たない 6 役割に見える。レポートは export.run を持たない役割にも出し、押すと 403。拠点担当に SSBJ 5 項目・CDP                                                                                                                                                                                                                                                                                                                                                                                                            | `reports/page.tsx:10-56`, `api/exports/*/route.ts`                               | 拠点・レビュー・閲覧 | 中  |
| N-09 | 権限はあるのに届かない     | 本社サステナは `enterprise.grant.manage` を持つ。だが許諾の UI は設定画面の中にしか無く、設定画面は `org.manage` で閉じている                                                                                                                                                                                                                                                                                                                                                                                                                                       | `roles.ts:55`, `settings/page.tsx:52-62,106,367`                                 | 本社サステナ         | 中  |
| N-10 | URL でしか届かない         | §4 の 11 画面。従来ツリーでは開示プロジェクト・ESG経営・標準 CSV も入る（開示優先ツリーにはある）。top-priority にはデモ案内からしか届かない                                                                                                                                                                                                                                                                                                                                                                                                                        | §4                                                                               | 作成・管理           | 中  |
| N-11 | Palette が地図の複製       | 検索するのはメニューだけで、`extraEntries` を使っていない。空クエリは木の順の先頭 30 件。データ・操作・最近・利用者・設定の節は検索できない。プレースホルダーが監査法人の語を混ぜている                                                                                                                                                                                                                                                                                                                                                                             | `command-palette.tsx:22-38,47,89-97,138`, `app-shell.tsx:230`                    | 熟練者               | 中  |
| N-12 | 監査法人の現在地           | 案件を選んでいないとき、`/assurance/engagements` で**12 項目に同時に aria-current と強調**が付く（試算）。選んでいるときも 2 つ（保証契約＋葉）。11 項目がフラットで工程の区切りが無い。法人管理者にも 11 項目を出す                                                                                                                                                                                                                                                                                                                                                | `nav-config.ts:652-657,754-759`, scratchpad `assurance-current.ts`               | 監査全員             | 中  |
| N-13 | 監査ホームの KPI           | KPI 7 枚がすべて無フィルタの `/assurance/engagements`。`docs/ux-spec.md` の「Filter 付き遷移」と違う。ラベルが英語（Active Engagements／High Issue…）                                                                                                                                                                                                                                                                                                                                                                                                               | `assurance/dashboard/page.tsx:59-118`                                            | 監査全員             | 中  |
| N-14 | 共通ルートでシェルが変わる | `/notifications`・`/profile` では `disclosureFirst`・役割切替・プロジェクトを渡していない。開示優先の組織でも従来メニューに切り替わり、役割切替が消える                                                                                                                                                                                                                                                                                                                                                                                                             | `(common)/layout.tsx:39-48` 対 `enterprise/layout.tsx:23-46`                     | 開示優先の組織       | 中  |
| N-15 | パンくず                   | 手書きで、メニュー名とずれている（§2.5）。開示優先でも従来の経路。リンクの無いクランプ全部に `aria-current="page"`（1 画面に最大 3 つ）。共通ルートの「ホーム」が `/workspace`                                                                                                                                                                                                                                                                                                                                                                                      | `page-header.tsx:44-46`                                                          | 全員（支援技術）     | 中  |
| N-16 | 行き先が違う               | 他社比較の修正リンク「報告期間の設定」が `/enterprise/settings`（管理者専用で、期間の節も無い）を指す。期間は organizations で管理している                                                                                                                                                                                                                                                                                                                                                                                                                          | `services/analysis/benchmark.ts:148`, `organizations/page.tsx:171`               | 管理者以外           | 中  |
| N-17 | 業務の言葉でない           | 「Validation Error」「Review 待ち」「Evidence 不足」（`legacy-home.tsx:69-92`）。UI に権限キー `enterprise.import.run` がそのまま出ている（`ghg/suppliers/page.tsx:154`）。同じ条件（submitted＋in_review）が「レビュー待ち」と「承認待ち」の 2 つの名前で出る（`data/page.tsx:251,269`, `enterprise-data.ts:165-166`）。「データ収集へ」ボタンの行き先が `/imports`（`data/page.tsx:281-283`）で、SSBJ/CSRD の「データ収集」とは別の画面。「ESG経営」がホームのタブ名（中身はデータ収集の進み具合）と画面名の両方に使われている（`dashboard/page.tsx:79,113-123`） | 同左                                                                             | 全員                 | 低  |
| N-18 | 役割切替                   | 監査法人には出ない。サプライヤー・外部支援・閲覧・専門家・監査閲覧のデモ利用者がいない。切り替えた後も同じ画面に戻るため、権限なしの画面に着地することがある                                                                                                                                                                                                                                                                                                                                                                                                        | `assurance/layout.tsx:18-25`, `dataset.ts:146-258`, `demo-role-actions.ts:38,53` | デモ                 | 低  |
| N-19 | 熟練者向けの操作が一部だけ | `/` が効くのは 5 画面、`j`/`k` は 2 画面。保存ビューは固定のプリセットで、利用者は保存できない。一括操作と列の表示切替は非財務データだけ                                                                                                                                                                                                                                                                                                                                                                                                                            | §2.3–2.6, `data/bulk-actions.tsx`                                                | 熟練者               | 低  |
| N-20 | 画面の階層が深い           | メニューは最大 3 段で問題ない。ただし画面の階層は 4〜5 段ある（プロジェクト > 原稿 > 節 > 再確認、CSRD > 設定 > トピック）。パンくずはあるが、メニューは 2 段目までしか現在地を示さない                                                                                                                                                                                                                                                                                                                                                                             | §2.5                                                                             | 作成・レビュー       | 低  |
| N-21 | 文書が古い                 | `docs/ux-spec.md` §3 の企業 Sidebar（12 項目）と §8 の KPI 7 種が実装（41 ノード・KPI 9）と合っていない                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `docs/ux-spec.md:56-66,118-124`                                                  | 開発                 | 低  |

### 7.1 3 クリックを超える作業（現状。ホームから数える）

| #   | 役割                 | 作業                                   | 最短経路                                                                                                                     | クリック数    |
| --- | -------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------- |
| C1  | 拠点担当（従来）     | 自拠点の未入力データを入れて提出する   | 非財務データ → 保存ビュー「自分の担当」→ チップ「未着手」→ 行 → 提出                                                         | 5（行まで 4） |
| C2  | 拠点担当             | 差戻しを直して再提出する               | 非財務データ → 自分の担当 → 差戻し → 行 → 提出（通知から入れば 3）                                                           | 5             |
| C3  | 拠点担当（開示優先） | C1 と同じ                              | 権限なしの表示 → 補助表示を開く → 拠点 → 行 → 提出                                                                           | 5             |
| C4  | 最終承認者           | データを最終承認する                   | KPI「Review 待ち」→ 行 → 承認。ただし名前が違い、一次レビュー前の行も混ざる（`status=in_review` のチップを使えば分けられる） | 3（＋1）      |
| C5  | 作成担当（従来）     | 開示プロジェクトを作る                 | 分析 > 規制対応度 → ESRS 40a 行のリンク → 新規作成（メニューにもパレットにも無い）                                           | 3＋探せない   |
| C6  | 管理者（従来）       | ESG KPI の目標を設定する               | 分析 > 財務影響分析 → ESG経営 → 目標                                                                                         | 3＋探せない   |
| C7  | 作成担当             | CSRD のトピック別 DMA を入れる         | CSRD 対応状況 → 工程① → トピック（パレットで探せない）                                                                       | 3             |
| C8  | 作成担当             | 監査法人へのアクセス許諾               | 届かない（N-09）                                                                                                             | —             |
| C9  | 監査 担当者          | 未受領の PBC を処理する                | KPI「PBC 未受領」→ 無フィルタの一覧 → 案件 → PBC → 該当行                                                                    | 4             |
| C10 | 全員                 | 特定の指標・拠点・要求事項コードを開く | パレットではデータを探せない → メニュー → 一覧で検索 → 行                                                                    | 3〜4          |

## 8. 変えてはいけないもの（明示要望・固定テスト）

| 対象                                                                                                     | 固定している場所                                                                                                |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 従来ツリーの形全体（ラベル・href・入れ子・permission・並び）                                             | `tests/unit/nav-config.test.tsx:149-211`、`tests/e2e/nav-structure.spec.ts:25-70`（最上位 8 つの順・SSBJ 6 子） |
| SSBJ 6 子（…データ収集 → 定性情報 → 開示ドラフト）、CSRD 6 子（ダブル・マテリアリティ。設定は工程①から） | 同上、`docs/disclosure-first.md` §9.1 ①③・§10.1 ①                                                               |
| 分析は AI Copilot と 管理 の間、子は 現状診断／規制対応度／自社経年比較／他社比較／財務影響分析          | 同上 §9.1 ②・§10.1 ②③、`nav-structure.spec.ts:240-263`（拠点担当には 4 子）                                     |
| GHG > 算定サマリー／Scope3データ取込 > Cat.1                                                             | `nav-config.ts:240-279`（2026-09-15 指示）                                                                      |
| ESG データ（GHG以外）> データ取込／非財務データ／Evidence                                                | `nav-config.ts:213-239`                                                                                         |
| 開示優先ツリーの最上位の順、その他の開示への格納、secondary は 2 つだけ                                  | `nav-config.test.tsx:250-335`                                                                                   |
| 現在地: 開示優先はちょうど 1 つ、従来は「最上位＋葉」（GHG＋Cat.1）                                      | `nav-config.test.tsx:903-911` ほか                                                                              |
| 従来ホームの KPI カードとリンク（A39）                                                                   | `legacy-home.tsx:20`                                                                                            |
| 2026-10-02 の文字量削減（説明は既定で閉じる・グラフ化）、誠実さの注記は閉じない                          | `docs/disclosure-first.md` §10.4、`page-header.tsx:11-15`                                                       |

## 9. 提案: 役割ベース＋タスクベースのナビゲーションとホーム（実装はしていない）

### 9.1 Before → Problem → Principle → After

| 領域             | Before                                 | Problem                | Principle（指示書）                              | After（提案）                                                                                                                                                                                                                                                   |
| ---------------- | -------------------------------------- | ---------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| メニュー木       | 41〜44 行を常に全展開                  | N-01, N-06             | Progressive Disclosure・浅い階層                 | **木の形は変えない**（§8）。グループ単位で開閉できるようにする（既定は開いたまま。利用者が閉じたら localStorage に覚える。現在地の祖先は常に開く）。形が変わらないため、unit・E2E の形のテストはそのまま通る                                                    |
| 役割の差         | 9 href を隠すだけ                      | N-02, N-08             | Role-based UI                                    | 役割の差はメニューでは出さず、①ホーム、②パレットのおすすめ、③各画面の主操作で出す。権限を合わせる（AI Copilot に `ai.run`、データ取込に `import.run`、レポートに `export.run`）のは**発注者に確認してから**（形のテストを新しい形で厳密に固定し直す。緩めない） |
| ホーム           | 役割で変わらない／拒否画面             | N-03, N-04             | Dashboard の順は Attention→Action→Status→Insight | §9.2 の役割別ホーム。従来 KPI の行（A39）は「Status」として残し、その**上に**「次にやること」を足す                                                                                                                                                             |
| タスク           | フィルタ・ワークフロー・アラートに散在 | N-05, N-07, C1–C4      | Task-based UI・Smart defaults                    | §9.3 のタスク動詞キュー。新しい画面は作らず、既存 URL にフィルタを付けて名前を与える                                                                                                                                                                            |
| 探す             | メニューの複製                         | N-10, N-11, C5–C7, C10 | Recognition over recall・Cmd+K                   | §9.4 パレット（最近・操作・画面〔重複を除く〕・メニュー外の画面・データ）                                                                                                                                                                                       |
| 監査法人         | フラット 14、現在地が最大 12           | N-12, N-13             | 浅く、区切る                                     | §9.5                                                                                                                                                                                                                                                            |
| パンくず・シェル | 手書き・ずれ・aria-current が複数      | N-14, N-15, N-16       | 1 つの意味に 1 つの部品                          | §9.6                                                                                                                                                                                                                                                            |

### 9.2 役割別ホーム（同じ URL `/enterprise/dashboard`。並びは Attention → Action → Status → Insight）

| 段                    | 内容                                                                                                                                                          | 出し方                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Attention（1 行の帯） | 自分に関係する期限超過・差戻し・承認後の再確認の件数だけ（0 件の項目は出さない）                                                                              | 役割と担当範囲で絞る（`unitScopeIds`・担当者）                                                                   |
| Action（表 1 つ）     | 「次にやること」: 区分（登録／修正／確認／承認／開示／回答）・対象・期限・理由・**主操作 1 つ**。既存の `MyTasks` 表の形をデータ点・PBC・取込エラーにも広げる | 開示優先の `disclosure-home.ts` の myTasks と、§9.3 のキューの先頭 N 件をまとめる                                |
| Status                | 従来: KPI 9 枚（A39 のまま）／開示優先: 4 カード＋分母付き進捗                                                                                                | 開示の権限が無い役割には、開示のカード（SSBJ/CDP）を「全社の状況」として既定で閉じる（**要確認**: A39 との関係） |
| Insight               | 分析 5 画面への 1 行のリンク                                                                                                                                  | 閲覧の役割だけはこの段を上に出す                                                                                 |

| 役割           | Action の中身（既存の URL）                                                                                                                                                                                 | 主操作                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 拠点担当       | 自拠点の未着手・下書き（`/enterprise/data?unit=<自拠点>&status=not_started&status=draft`）、差戻し（`&status=returned`）、PBC（`/enterprise/workflows`）                                                    | データを入力する                          |
| 本社サステナ   | 差戻し原稿（`project?tab=manuscripts&filter=mine`）、一次レビュー（`/enterprise/data?status=submitted`）、取込エラー（`/enterprise/imports`）、SSBJ 未対応（`ssbj/requirements?scope=in_scope&coverage=…`） | 次の原稿を書く                            |
| レビュー担当   | `/enterprise/data?status=submitted`、自分のレビュー（`listMyReviewTasks`）                                                                                                                                  | 次をレビューする                          |
| 最終承認者     | `/enterprise/data?status=in_review`、最終承認（myTasks の `final_approval`）                                                                                                                                | 次を承認する（人が押す。AI は確定しない） |
| 企業管理者     | 本社サステナと同じに加えて、準備の不足（期間・指標マスター・メンバー招待の期限・許諾）                                                                                                                      | （準備が整っていなければ）設定を開く      |
| 閲覧・外部支援 | Action は空。Insight を上に出す                                                                                                                                                                             | —                                         |

### 9.3 タスク動詞 → 既存画面の対応（新しい画面は作らない）

| 動詞           | 行き先（既存）                                                                                                              | 補足                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 登録する       | `/enterprise/imports`、`/enterprise/imports/standard`、`/enterprise/data?unit=…&status=not_started`、`/enterprise/evidence` | 担当範囲があれば既定で `unit` を付ける（Smart default。いまは保存ビューに手で切り替えている `data/page.tsx:256-265`）   |
| 修正する       | `/enterprise/data?status=returned`、`project?tab=manuscripts&filter=mine`                                                   |                                                                                                                         |
| 確認する       | `/enterprise/data?status=submitted`、`/enterprise/workflows`（自分のレビュー）                                              | 「レビュー待ち」と「承認待ち」の名前の重複（N-17）を解く                                                                |
| 承認する       | `/enterprise/data?status=in_review`、project レビュー・承認タブ                                                             |                                                                                                                         |
| 集計する       | `/enterprise/ghg`、`/enterprise/ghg/suppliers`、`/enterprise/analysis/trends`                                               |                                                                                                                         |
| レポートを作る | `/enterprise/reports`、`ssbj/draft`、`csrd/draft`、project 出力タブ                                                         | export.run が無い役割には出さない                                                                                       |
| 開示する       | `ssbj`、`csrd`、`cdp`、`/enterprise/disclosure-projects`                                                                    |                                                                                                                         |
| 分析する       | `/enterprise/analysis/*`、`/enterprise/esg`                                                                                 |                                                                                                                         |
| 管理する       | `/enterprise/organizations`、`/enterprise/settings`、`/enterprise/esg/targets`、`ssbj/settings`、`csrd/settings`            | 許諾（N-09）は要判断: grant.manage を持つ役割に設定画面の許諾の節だけを開くか、作成担当から権限を外すか（2 層で同時に） |

### 9.4 Command Palette（L3 の主な入口）

1. `extraEntries` を使う（受け口は既にある `command-palette.tsx:47`）。グループは 最近開いた（localStorage、利用者ごと）→ 操作（§9.3 の動詞。権限で絞る）→ 画面（**href で重複を除き**、葉の経路ラベルを使う）→ メニュー外の画面（§4 の 11 画面。権限で絞る）→ 設定の節（設定・組織・拠点のアンカー）。
2. クエリが空のときは「最近 5 件＋役割のおすすめ」を出す（木の先頭 30 件をやめる）。
3. データ検索（指標名・拠点名・要求事項コード・原稿名）は Server Action で行い、RLS と `can` を通した結果だけを返す。バックエンドへの追加は読み取りだけ。理由は C10 で、要判断。
4. プレースホルダーをワークスペースごとに分ける（N-11）。`?` でヘルプを開けるようにする。

### 9.5 監査法人ワークスペース（形を固定するテストが無いので、作り直してよい範囲）

| 変更                                                                                                                                                                                                    | 解消する問題      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| 案件を選んでいないときは、案件配下の 11 項目を出さず、「案件を選ぶ」1 項目にする                                                                                                                        | N-12（現在地 12） |
| 案件配下を 4 グループ・2 段にする（計画: 概要・スコープ／実施: Data Room・母集団・サンプリング・保証手続・調書・PBC／結論: 指摘・例外・レビューNote・Sign-off／記録: 監査ログ・Export）。「概要」を足す | N-12、概要が無い  |
| 法人管理者（案件なし）には 案件ホーム・保証契約・設定 だけを出す                                                                                                                                        | §6.4              |
| 監査法人ホームの KPI を、案件と状態で絞った行き先にし、日本語の業務名に直す                                                                                                                             | N-13              |
| 役割切替（デモ）を監査法人 layout にも渡す                                                                                                                                                              | N-18              |

### 9.6 パンくず・シェル（不具合の修正。形は変えない）

- パンくずは描画中のツリー（従来／開示優先）から作り、詳細画面だけ末尾に対象名を足す。`aria-current` は末尾の 1 つだけにする。先頭はホームへのリンクにする（N-15）。
- 共通ルートの layout でも `disclosureFirst`・`demoRoleChoices`・`projects` を渡す（N-14）。
- 他社比較の「報告期間の設定」は `/enterprise/organizations` へ向ける（N-16）。
- 業務の言葉に直す（N-17）。テストの期待値を書き換える場合は、新しい文言で厳密に固定し直す。

### 9.7 段階実装案（指示書の順: Navigation → Layout → …）と影響するテスト

| 段  | 内容                                                            | 形のテストへの影響                                                                                     | リスク               |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------- |
| N1  | §9.6 の不具合修正（共通 layout・パンくずの aria-current・N-16） | 無し（パンくずの文言を固定している E2E があれば更新）                                                  | 低                   |
| N2  | 監査法人ツリー §9.5                                             | 監査法人の E2E（サイドバーのラベル固定は見当たらない）                                                 | 低                   |
| N3  | パレットの拡張 §9.4（1・2・4）                                  | `nav-config.test.tsx:1029-1093`（候補の重複除去を新しい形で固定）                                      | 低                   |
| N4  | ホームの Action 段 §9.2（既存の上に足すだけ）                   | ホームの E2E。A39 の KPI はそのまま                                                                    | 中                   |
| N5  | グループの開閉（既定は開）                                      | 無し（既定で開いているため `toBeVisible` は通る）                                                      | 低                   |
| N6  | 役割ごとに既定で閉じるグループ（例: 拠点担当の 開示対応）       | siteUser でクリックする E2E を確認する（`nav-structure.spec.ts:240-263` は数と分析の子だけを見ている） | 中・**要確認**       |
| N7  | メニューの permission を画面の権限に揃える（N-08）              | `nav-config.test.tsx:149-211,364-408`、`nav-structure.spec.ts` を新しい形で固定し直す                  | 中・**要発注者確認** |
| N8  | パレットのデータ検索 §9.4-3                                     | 新しい unit・RLS テスト                                                                                | 中・要判断           |

### 9.8 回帰の確認（Missing／Broken／Changed）

- §4 の 11 画面、§3 の全 href（従来 31・開示優先 34・監査法人 14）、詳細画面へのリンクが、変更後もメニュー・画面内リンク・パレットのどれかから開けること。
- 権限の 2 層（`roles.ts` と `0002_identity.sql`）は変えない。変える場合は `authorization.test.ts` で一致を確かめる。
- 固定テスト（§8）は**緩めない**。形を変える段（N6・N7）は、発注者の確認を取ってから新しい形で厳密に固定し直す。
