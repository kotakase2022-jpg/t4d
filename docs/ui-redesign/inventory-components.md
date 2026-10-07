# コンポーネント・デザイントークン棚卸し（UI シンプル化 2026-10-07 / 分析フェーズ）

- 対象: `feat/self-audit-2026-08-20` @ `ce86c09`。`src/components/{ui,shared,charts}` と、それを使う `src/app/**`
- 方法: grep と使い捨ての node 集計（JSX 開始タグを複数行で解析）。件数は `src/` のみ（`tests/` は数えていない）。行番号は ce86c09 時点
- 指示書の全文（scratchpad の `ui-directive-2026-10-07.md`）は指定パスに存在しなかったため、オーケストレータが渡した要約に基づく
- 本書は分析だけを扱う。コードは変更していない。機能・権限検査・API・データ項目の削除は提案しない（未使用の部品も「土台として使う」扱いにする）

## 0. 要約

| #   | 結論                                                                                                                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 部品は 59 ファイル（ui 19・shared 31・charts 9）。`Table`・`Badge`・`Card`・`Button`・`PageHeader`・`EmptyState` は広く使われている。一方で「一覧の標準機能」（FilterBar・Pagination・SortLink・ColumnSelector・BulkActionBar）を全部持つ画面は `enterprise/data/page.tsx` の 1 つだけ |
| 2   | 同じ意味を別の部品で描いている。編集は 5 通り、破壊的操作の確認は 4 通り（確認なしを含む）、URL タブと絞込チップは 9 通り以上、KPI タイルは 7 通り。状態バッジは `shared/badges.tsx` の外に 12 ファイル・約 45 個あり、「差戻し」の色が画面によって warning と danger に分かれている   |
| 3   | 主ボタンの規律がない。`Button` の既定が `primary` なので（button.tsx:28）、variant 未指定の 92 個がすべて主ボタンになる。主ボタンが 2 個以上あるファイルは 24、`variant="danger"` は 1 か所だけで、削除は outline で描かれている                                                       |
| 4   | 文字サイズのトークンがない。文字サイズは 1,973 か所すべてが `text-[Npx]` で、標準の `text-xs/sm` は 0 か所。任意値は全体で 2,312 か所あり、警告色の文字 `text-[#8a5d00]` が 100 か所、レイアウト用トークン（topbar・sidebar・row）は定義されているのに一度も使われていない             |
| 5   | 状態表示に穴がある。`loading.tsx` は 0、`LoadingState` は未使用、`EmptyState` で次の操作を示すのは 97 か所中 20 か所。本番の `ErrorState` は識別子しか表示せず、「何が・なぜ・どうする」が書かれていない                                                                               |

---

## 1. プリミティブ一覧（`src/components/ui`）

使用数は `ファイル数/JSX 数`。「定義」の欄は file:line。

| 部品                                                           | 定義                         | props・バリアント                                                                                                               | 使用数                                                                          | 所見                                                                                                                                                                                  |
| -------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`                                                       | button.tsx:37（cva :8-30）   | variant: primary・secondary・outline・ghost・danger・link／size: xs・sm・md・lg・icon／`asChild`。**既定は primary・sm**（:28） | 76/230                                                                          | 実際の使用は outline 161・既定 primary 92・ghost 21・secondary 9・式 10・danger 1（式。settings/page.tsx:504）・link 0。size は icon 3・lg 3・md 1                                    |
| `SubmitButton`                                                 | submit-button.tsx:18         | Button の props ＋ `pendingLabel`・`icon`。`useFormStatus` で送信中は無効化し、Loader2 を回す                                   | 35/65                                                                           | 送信中表示の唯一の実装で、良い作り。ただし状態バッジ（レビュー中など）も同じ Loader2 を使っており、意味が衝突する（§4.4）                                                             |
| `Badge`                                                        | badge.tsx:25（cva :5-20）    | tone: neutral・brand・success・warning・danger・outline                                                                         | 96/333                                                                          | warning の文字色は hex 直書き（:13 `text-[#8a5d00]`）。バッジ部品を使わずに直接書いた `<Badge>` が 83 ファイル・263 か所ある                                                          |
| `Card` 系 6 個                                                 | card.tsx:4-52                | Card・CardHeader・CardTitle（h2 13px）・CardDescription・CardContent・CardFooter                                                | Card 86/269、Header・Title 8/21、Content 6/9、Description 1/2、Footer 0         | 影は任意値（:8 `shadow-[0_1px_2px_rgba(23,32,51,0.04)]`）。ほとんどが装飾的な外枠として使われている（§4.12）                                                                          |
| `Collapsible`・`CollapsibleSection`                            | collapsible.tsx:64・:140     | summary・meta・defaultOpen・open・id・variant（card・plain）／id・title・summary・actions                                       | 17/28・8/12                                                                     | 規則（誠実さの注記は中に入れない）が docs/disclosure-first.md §10.4 にまとまっている。それでも、この部品を使わない素の `<details>` が app に 19 か所残っている（§4.6）                |
| `MoreInfo`                                                     | more-info.tsx:13             | label（必須）・defaultOpen                                                                                                      | 25/42                                                                           | 「この画面について」は `PageHeader.help` の中で使われる                                                                                                                               |
| `Dialog` 系 10 個                                              | dialog.tsx:8-99              | Content（`hideClose`）・Header・Footer・Title・Description                                                                      | 3 ファイル（master-forms・command-palette・help-dialog）                        | オーバーレイが hex（:20 `bg-[#0b1b34]/35`）。DialogFooter は 0 件。破壊的操作の確認には使われていない                                                                                 |
| `Drawer` 系 9 個                                               | drawer.tsx:12-93             | width: md 420・lg 560・xl 760（:22 任意値）                                                                                     | **0**                                                                           | ux-spec §6 では「詳細は Drawer も用意」としているが未使用。block-editor が独自にドロワーを組んでいる（block-editor.tsx:1406-1463、z-40／z-30）                                        |
| `DropdownMenu` 系 8 個                                         | dropdown-menu.tsx:8-99       | Content・Item・CheckboxItem・Label・Separator・Group                                                                            | 3 ファイル（selectors・role switcher・table-controls）                          | **行操作や「その他」メニューとしての使用は 0 件**（MoreHorizontal 系アイコンも 0 件）                                                                                                 |
| `Input`・`Textarea`                                            | input.tsx:4・:25             | ネイティブ属性。`aria-invalid` で枠が赤くなる                                                                                   | 33/115・26/37                                                                   | フォーカスリングが `ring-brand-100`（:15・:36）で、全体の `:focus-visible`（brand-600）と違う。この部品を使わない素の `<input type="text">` も 24 個ある                              |
| `Select` 系 7 個（Radix）                                      | select.tsx:8-93              | Trigger・Content・Item・Label                                                                                                   | 1 ファイル（selectors.tsx）                                                     | **素の `<select>` が 38 ファイル・100 個**あり、className の文字列は 19 種類（ほかに式が 42）。Server Action のフォームはネイティブを必要とするため、ネイティブの部品が欠けている状態 |
| `Checkbox`（Radix）                                            | checkbox.tsx:8               | Radix の props                                                                                                                  | **0**                                                                           | 素の `type="checkbox"` が 29 個あり、色は `accent-[#0b57a4]` 17 個と `accent-brand-600` が混在している                                                                                |
| `Table` 系 6 個                                                | table.tsx:4-61               | TH・TD に `align`。TH は h-8・11px・大文字（:37）、TD は h-9（:54）                                                             | 58/97 表（TR 203・TH 629・TD 644）                                              | sticky・並べ替え・選択・空状態は持たず、呼ぶ側が毎回組んでいる（§4.5）。素の `<table>` も 6 個ある（§4.5）                                                                            |
| `Tabs` 系 4 個（Radix）                                        | tabs.tsx:7-54                | List・Trigger・Content                                                                                                          | 1 ファイル（editor-right-pane）                                                 | URL で切り替えるタブは部品がなく、各画面が自作している（§4.8）                                                                                                                        |
| `Tooltip` 系・`Hint`                                           | tooltip.tsx:7-38             | Hint: label・children                                                                                                           | Hint は 3 か所（sidebar・demo-tour・header-context）。Provider は layout.tsx:31 | ネイティブの `title=` 属性が約 20 ファイル・36 か所（Badge 13・span 7 ほか）あり、キーボードとタッチでは読めない（§4.15）                                                             |
| `Progress`                                                     | progress.tsx:3               | value・tone・label                                                                                                              | 6/9                                                                             | `FractionBar` と役割が重なる                                                                                                                                                          |
| `StackedBar`・`StackedBarLegendChip`・`stackedBarSegmentClass` | stacked-bar.tsx:32・:72・:23 | segments・label・unit                                                                                                           | 1/2・1/3・2                                                                     | 主な利用者は StatusBreakdown                                                                                                                                                          |
| `Skeleton`                                                     | skeleton.tsx:3               | div の属性                                                                                                                      | 1（states.tsx 内のみ）                                                          | 実際の画面では使われていない                                                                                                                                                          |
| `Separator`                                                    | separator.tsx:7              | orientation                                                                                                                     | **0**                                                                           | —                                                                                                                                                                                     |

## 2. 共有部品（`src/components/shared`）

| 部品                                                                                                                                                             | 定義                                          | props（要点）                                                                                                                                                                                                                                                           | 使用数                                               | 所見                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PageHeader`                                                                                                                                                     | page-header.tsx:16                            | title・description・help・breadcrumbs・actions                                                                                                                                                                                                                          | 58/85（actions あり 40・help 25・パンくず 83）       | `actions` は任意の ReactNode で、主ボタンの数を制約していない。data/[dataPointId] では、状態に応じて提出（outline）・レビュー開始（outline）・差戻し（理由の入力欄つき）・承認（primary）が見出しに並ぶ（data/[dataPointId]/page.tsx:261-321）。下書きの段階で主操作になるはずの「提出」が outline になっている |
| `KpiCard`                                                                                                                                                        | page-header.tsx:69                            | label・value・suffix・href（必須）・tone・hint                                                                                                                                                                                                                          | 7/36                                                 | 数値は 22px、warning は hex（:88）。**同じ名前の別部品**が esg/kpi-card.tsx:278 にある                                                                                                                                                                                                                          |
| `SectionTitle`                                                                                                                                                   | page-header.tsx:113                           | title・action                                                                                                                                                                                                                                                           | 60/180                                               | CardHeader＋CardTitle、CollapsibleSection と並ぶ 3 つ目の「節の見出し」                                                                                                                                                                                                                                         |
| `badges.tsx` の 20 個                                                                                                                                            | badges.tsx:63-460                             | DataPointStatus・Availability・ValueKind・AggregationIncomplete・DataCoverage・ResponseStatus・Priority・Validation・Severity・Evidence・JobStatus・PbcStatus・TaskStatus・TestStatus・IssueSeverity・ScopeInclusion・DemoData・AiGenerated・ReadOnly・MembershipStatus | 28 ファイルから使用（各 1〜11 か所）                 | 状態の表（MAP）が部品ごとにあり、共通の登録簿がない。Priority・Job・Pbc・Scope は全状態に同じ CircleDot を使っており、アイコンが意味を運んでいない（:222・:309・:331・:399）                                                                                                                                    |
| `ScanStatusBadge`                                                                                                                                                | scan-status-badge.tsx:17                      | status                                                                                                                                                                                                                                                                  | 2                                                    | badges.tsx の外に置かれている                                                                                                                                                                                                                                                                                   |
| `ReferenceDateBadge`                                                                                                                                             | header-badges.tsx:11                          | label                                                                                                                                                                                                                                                                   | 1                                                    | —                                                                                                                                                                                                                                                                                                               |
| `EmptyState`・`ErrorState`・`PermissionDeniedState`・`LoadingState`・`RetryAction`                                                                               | states.tsx:35・:65・:116・:14・:96            | title・description・action・icon／title・description・onRetry・retryHref                                                                                                                                                                                                | 56/97・3/3（error.tsx のみ）・29/29・**0**・内部のみ | 常に `py-10`（:51・:82・:127）で、表の中でも 80px の余白が出る。action を渡しているのは 20/97。「何が・なぜ・どうする」の枠組みがない                                                                                                                                                                           |
| `FlashMessage`                                                                                                                                                   | flash.tsx:194（文言表 :12-192）               | searchParams（`?flash=`・`?error=`）                                                                                                                                                                                                                                    | 30/31                                                | 結果の通知はここに集約されている（良い）。ただし `useActionState` の結果を各フォームが独自の `<p>` で出す箇所が 19 ファイルある（§4.10）                                                                                                                                                                        |
| `FilterBar`・`ActiveFilterSummary`                                                                                                                               | filter-bar.tsx:29・:159                       | groups・searchPlaceholder・total・savedViews                                                                                                                                                                                                                            | 5・**0**                                             | 検索欄の幅が 280px 固定（:85）。チップは `button aria-pressed`（:107-117）。保存ビューは固定のプリセットだけ（:140-153）                                                                                                                                                                                        |
| `SortLink`・`ColumnSelector`                                                                                                                                     | table-controls.tsx:34・:72                    | column・label／columns・alwaysVisible（URL `cols`）                                                                                                                                                                                                                     | 各 1（data/page.tsx）                                | 列表示は URL だけに保持され、利用者ごとには保存されない                                                                                                                                                                                                                                                         |
| `Pagination`                                                                                                                                                     | pagination.tsx:8                              | page・pageSize・total・basePath・searchParams                                                                                                                                                                                                                           | 2（data・audit-trail）                               | —                                                                                                                                                                                                                                                                                                               |
| `BulkActionBar`（画面ローカル）                                                                                                                                  | app/enterprise/data/bulk-actions.tsx:16       | canWrite・canApprove                                                                                                                                                                                                                                                    | 1                                                    | `document` の change を拾って件数を数える（:29-39）。一括承認は確認なしの primary（:90）、一括差戻しは理由を入力しない（:79-89）                                                                                                                                                                                |
| `PreservingForm`                                                                                                                                                 | preserving-form.tsx:82                        | action・children                                                                                                                                                                                                                                                        | 4/5                                                  | エラー時に入力値を戻す。フォームの節分け・必須の表示は持たない                                                                                                                                                                                                                                                  |
| `CommandPalette`                                                                                                                                                 | command-palette.tsx:44                        | variant・hiddenHrefs・`extraEntries`                                                                                                                                                                                                                                    | 1（app-shell.tsx:230）                               | **`extraEntries` が一度も渡されていない**ため、ナビゲーションしか検索できない（データ・利用者・設定・最近使ったものは出ない）。Ctrl/Cmd+K（:72）と `/`（:77）                                                                                                                                                   |
| `RecordShortcuts`                                                                                                                                                | record-shortcuts.tsx:78                       | なし（`data-t4d-record`・`data-t4d-shortcut` を見る）                                                                                                                                                                                                                   | 1                                                    | j/k/e/c/s（:83-110）。画面上に表示されるヒントは FilterBar の placeholder だけ                                                                                                                                                                                                                                  |
| `DisclosureSteps`・`SsbjFlow`                                                                                                                                    | disclosure-steps.tsx:34・ssbj-flow.tsx:55     | steps（title・description・state・detail・action/href）                                                                                                                                                                                                                 | 1・2                                                 | 状態の表がほぼ同じ内容で重複している（disclosure-steps.tsx:28-32・ssbj-flow.tsx:41-45）                                                                                                                                                                                                                         |
| `AppShell`・`Sidebar`・`selectors`（Workspace・Period・Engagement・UserMenu）・`HeaderProjectContext`・`DemoRoleSwitcher`・`HelpDialog`・`DemoTour`・`BrandLogo` | app-shell.tsx:112 ほか                        | —                                                                                                                                                                                                                                                                       | 各 1〜4                                              | 寸法が任意値（app-shell.tsx:139 `h-[48px]`、sidebar.tsx:121 `w-[64px]`・`w-[224px]`）。同じ値のトークン（`--spacing-topbar`・`--spacing-sidebar*`）は定義済みなのに使われていない                                                                                                                               |
| `DemoSimulationNotice`・`DemoDataBadge`                                                                                                                          | demo-simulation-notice.tsx:11・badges.tsx:405 | —                                                                                                                                                                                                                                                                       | 3/4・2                                               | 誠実さの注記。統合後も常に表示する                                                                                                                                                                                                                                                                              |
| `CommentBox`・`MentionText`・`FileDropZone`・`DocumentPreview`・`LinkPending`                                                                                    | 各ファイル                                    | —                                                                                                                                                                                                                                                                       | 2・2・3・1/2・3                                      | `LinkPending` は遷移中の唯一の表示（ロード時の骨組みはない）                                                                                                                                                                                                                                                    |
| `nav-config.ts`・`nav-branch.ts`                                                                                                                                 | —                                             | —                                                                                                                                                                                                                                                                       | —                                                    | ナビゲーションの棚卸しは別文書の担当                                                                                                                                                                                                                                                                            |

## 3. 図（`src/components/charts`）

| 部品                                                                        | 定義                                | 使用数               | 所見                                                     |
| --------------------------------------------------------------------------- | ----------------------------------- | -------------------- | -------------------------------------------------------- |
| `ChartFrame`（figure＋表を Collapsible に）・`ChartDataTable`               | chart-frame.tsx:53・:97             | 4・内部のみ          | 表が素の `<table>`（:103）で、`Table` 部品と見た目が違う |
| `BarChart`・`LineChart`                                                     | bar-chart.tsx:61・line-chart.tsx:56 | 1・3                 | viewBox＋w-full。規則は §10.4 に定義済み                 |
| `FractionBar`・`StatusBreakdown`・`FunnelSteps`・`CategoryGrid`・`MiniBars` | 各ファイル                          | 9/12・11/14・2・3・2 | `Progress`（ui）と `FractionBar` は役割が重なる          |
| `series.tsx` の色・線種・凡例ヘルパー                                       | series.tsx:43-126                   | 1〜4                 | 色の順番を一元化している（良い）                         |

## 4. 不整合（同じ意味を別の部品で描いている）

### 4.1 編集（5 通り）

| 型                                                                   | 根拠                                                              | 問題                                                                  |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| アイコンだけの ghost ボタン（Pencil）→ Dialog                        | organizations/master-forms.tsx:269-279                            | 意味をアイコンだけで伝えている（aria-label はある）。見える文字がない |
| outline xs「編集」＋Pencil → その場でフォームを開閉                  | disclosures/ssbj/settings/materiality-manager.tsx:298-306         | —                                                                     |
| `<details>` の summary をリンク風にして「…を編集」→ 表の下にフォーム | disclosures/csrd/settings/matters/[topic]/page.tsx:304-306        | 開閉部品を操作として使っている。表の行と編集フォームが離れている      |
| 行のタイトルのリンク＋ghost xs「詳細」→ 詳細ページ                   | enterprise/data/page.tsx:333-338・:413-415                        | 同じ行から同じ行き先へのリンクが 2 つある                             |
| 別ページのエディタ（原稿）                                           | disclosure-projects/[projectId]/blocks/[blockId]/block-editor.tsx | （妥当）                                                              |

同じアイコンが操作と状態の両方に使われている: PencilLine は取込差分の「変更」状態（imports/standard/import-preview.tsx:39）、FilePen は原稿の「下書き」状態（blocks/status-badges.tsx:30）、Pencil は編集の操作。

### 4.2 削除・破壊的操作（確認の方式が 4 通り）

| 方式                                           | 根拠                                                                                                                                            | variant        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| その場で「削除しますか？」→ 削除する／やめる   | materiality-manager.tsx:308-334                                                                                                                 | outline        |
| 必須のチェック「範囲を確認しました」           | ghg/suppliers/page.tsx:244-259、dashboard/disclosure-home-view.tsx:631-641                                                                      | outline        |
| 確認なし（論理削除だが、DMA の確定を取り消す） | csrd/settings/matters/[topic]/page.tsx:276-286                                                                                                  | outline        |
| `window.confirm`（未保存のまま離れる）         | block-editor.tsx:401                                                                                                                            | —              |
| 破棄・取り下げ                                 | editor-ai-panel.tsx:527（候補を破棄・ghost）、review-decision-forms.tsx:141（取り下げ・ghost）、narrative-editor.tsx:729（入力を破棄・outline） | ghost／outline |

`variant="danger"` を使っているのは settings/page.tsx:504（許諾の取消）の 1 か所だけ。破壊的な文言を持つボタン 13 個は、すべて非破壊の操作と同じ見た目になっている。

### 4.3 承認・差戻し

- 承認: primary（data/[dataPointId]/page.tsx:316-321、question-view.tsx:403、review-panel.tsx:124、bulk-actions.tsx:90）、outline のリンク「承認フローへ」（data/[dataPointId]/page.tsx:304-311）、段階の承認（同 :815-822）。**一括承認は確認なし**
- 差戻し: 見出しの中に理由の入力欄＋outline（data/[dataPointId]/page.tsx:284-297。素の input で、:291 は Input 部品を使っていない）、一括差戻しは理由なし（bulk-actions.tsx:79）
- 「AI は確定しない」の原則は守られている（承認は常に人の Server Action）。見た目だけを統一する

### 4.4 状態バッジ（共通の登録簿がない）

| 意味               | 描き方の違い                                                                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 差戻し             | warning＋Undo2（badges.tsx:55・:197）／warning＋CircleDot（PBC「差戻し」:322）／**danger**＋Undo2（blocks/status-badges.tsx:25・:33、:85・:93）                                                                         |
| レビュー中・対応中 | brand＋**Loader2**（badges.tsx:54・:196・:339）。SubmitButton の「送信中」と同じ回転アイコンなので（submit-button.tsx:33）、「読込中」と誤読しうる                                                                      |
| 承認済み・完了     | Check（badges.tsx:56）／CheckCircle2（status-badges.tsx）／CircleCheck（:341）／アイコンなし（Job「完了」:300）                                                                                                         |
| 要確認             | warning＋CircleHelp（cdp/page.tsx:69）／warning・アイコンなし（imports/preview-table.tsx:28、badges.tsx:299）                                                                                                           |
| 確定済み           | success（csrd/draft/_components/draft-badges.tsx:27）／brand（imports/preview-table.tsx:31）                                                                                                                            |
| Mock の AI 出力    | 「Mock / AI未接続」（badges.tsx:414-418）／「デモ生成（Mock）」（csrd/requirements/_components/detail-badges.tsx:13-18）／フラッシュは「デモ生成」（flash.tsx:161）                                                     |
| 同じ名前で別の意味 | `EvidenceBadge`（badges.tsx:274 件数 ↔ financial-impact/_components/impact-badges.tsx:41 種類）、`ApplicabilityBadge`（disclosure-projects/_components/framework-badges.tsx:48 ↔ csrd/_components/csrd-badges.tsx:127） |

画面ローカルのバッジ定義は 12 ファイル（framework-badges 27 トーン定義・csrd-badges 17・analysis-badges 9・cdp/page 9・preview-table 8・trend-badges 7・status-badges 6・import-preview 5・draft-badges 5・narrative-badges 4・imports/standard/page 4・ai/page 4）。`type Tone =` は 5 ファイルで別々に定義されている。

### 4.5 表

| 項目                         | 現状                                                                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| sticky 見出し                | 97 表のうち 20。方式が 2 つある: `.t4d-sticky-head`（globals.css:118-123、背景 surface-muted・z-index 2）を 8 か所、`THead className="sticky top-0 z-10 bg-surface"`（背景 surface・z-10）を 12 か所。**残り 77 表は固定されない**               |
| 並べ替え・列表示・ページ送り | SortLink と ColumnSelector は data/page.tsx だけ。Pagination は 2 画面。それ以外は全件表示                                                                                                                                                       |
| 一括選択                     | 素の checkbox（data/page.tsx:324-331 `accent-[#0b57a4]`）。全選択はない（「全選択」「すべて選択」は 0 件）                                                                                                                                       |
| 行の操作                     | 行操作メニューは 0。`<TH className="w-16" aria-label="操作">` が 5 画面・6 か所（data:317・cdp:525・evidence:208・:222・imports:182・settings:276）にあり、中身はボタンを直接並べたもの                                                          |
| 展開できる行                 | 行の下に `<details>`（imports/preview-table.tsx:204、imports/standard/import-preview.tsx:311、outputs.tsx:445、reviews.tsx:153）                                                                                                                 |
| 先頭列の固定                 | `sticky left-0 z-[1] bg-surface` を 3 画面が別々に書いている（analysis/benchmark/page.tsx:55、trends/page.tsx:47、regulations/page.tsx:209・:225）                                                                                               |
| 素の `<table>`               | analysis/financial-impact/_components/iro-grid.tsx:46・ready-view.tsx:337、disclosure-projects/new/project-form.tsx:662、blocks/[blockId]/editor-right-pane.tsx:647、narratives/_components/narrative-editor.tsx:681、charts/chart-frame.tsx:103 |
| 色だけで状態を表している     | 単位の不一致を赤字だけで示している（data/page.tsx:379 `font-medium text-danger`。CLAUDE.md §2 に違反）                                                                                                                                           |

### 4.6 素の `<details>`（Collapsible を通らないもの 19 か所）

(auth)/login/page.tsx:79、assurance/.../sampling/page.tsx:130、block-editor.tsx:1109、editor-ai-panel.tsx:319・:533、review-panel.tsx:73・:157、_tabs/add-block-form.tsx:63、_tabs/outputs.tsx:445、_tabs/overview.tsx:212、_tabs/reviews.tsx:153、_tabs/settings.tsx:355、csrd/settings/matters/[topic]/page.tsx:304・:324、imports/preview-table.tsx:204、imports/standard/import-preview.tsx:311、narratives/[narrativeId]/page.tsx:239、narrative-editor.tsx:381、settings/security-card.tsx:124。
これらは `data-collapsible` を持たないため、collapsed-content-a11y.spec.ts と ui-integrity-audit の「折りたたみを全部開く」検査の対象から外れる。

### 4.7 ドロップダウン・選択

- 素の `<select>`: 38 ファイル・100 個。className は 19 種類＋式 42（例: `px-2 text-[13px]` が 19、`px-1.5 text-[12px]` が 12、`w-[280px] px-2 text-[12px]` が 4、`h-6 px-1 text-[11px]` が 2）
- Radix の Select は selectors.tsx だけ。Popover は ref-chip.tsx が `@radix-ui/react-popover` を直接使っている（ui に部品がない）
- 素の `<button>` が 20 個（13 ファイル）。自前でメニューを作っているものはない

### 4.8 タブ・絞込チップ（9 通り以上）

| 種類               | 根拠                                                                                                                                                                                                                             | 違い                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| URL タブ（下線）   | dashboard/page.tsx:74-92、disclosure-projects/[projectId]/page.tsx:117-132                                                                                                                                                       | 余白 `px-2.5 py-1.5`・gap-0.5・font-medium・brand-800 と、`px-3 py-2`・gap-1・font-semibold・brand-900。リングの扱いも違う |
| URL 絞込チップ     | _tabs/manuscripts.tsx:56-80、_tabs/reviews.tsx:69-82、_tabs/requirements.tsx:146-160、esg/page.tsx:52-64、narratives/new/page.tsx:76、trends/_components/trend-summary.tsx:50-64、financial-impact/_components/ready-view.tsx:54 | 選択中の枠が brand-300・brand-500・brand-600 とばらばら。`aria-current` も 'page' と 'true' が混在                         |
| ボタンのトグル     | `variant={x === f ? 'secondary' : 'outline'}` を 5 か所（ボタン集計の「式」）                                                                                                                                                    | —                                                                                                                          |
| FilterBar のチップ | filter-bar.tsx:107-117（`aria-pressed`）                                                                                                                                                                                         | —                                                                                                                          |
| Radix の Tabs      | editor-right-pane.tsx                                                                                                                                                                                                            | —                                                                                                                          |

### 4.9 ステップ表示

DisclosureSteps、SsbjFlow（状態の表が重複）、project-form.tsx:219-222（`aria-current="step"`）、standard-import.tsx:104（同）、PathwayFlow（financial-impact）。

### 4.10 通知（フラッシュ・インライン・警告枠）

- URL フラッシュ: `FlashMessage` を 30 画面が使う（成功は緑・エラーは赤。アイコン付き）
- `useActionState` の結果を独自の `<p>` で出しているもの: 19 ファイル（editor-ai-panel 7・block-editor 7・narrative-editor 4・project-form 4・review-decision-forms 4 ほか）
- 警告枠を直書きしているもの: `border-warning/40 bg-warning-soft` が 28 ファイル・37 か所、`border-danger/(30|40) bg-danger-soft` が 26 ファイル・31 か所。`role="alert"` は 24 ファイル・32 か所、`role="status"` は 15 ファイル・19 か所
- トースト用のライブラリはない（追加は不要。§6.13）

### 4.11 空・エラー・読込中

| 状態     | 現状                                                                                                                                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 空       | EmptyState 97 か所（action あり 20・description あり 48）。独自の空状態として `TrendEmptyState`（analysis/trends/page.tsx:157）、ほかに `<p>…ありません</p>` 形式が約 100 行（grep の近似値）                               |
| エラー   | `error.tsx` は 3 つ（app・enterprise・assurance）。本番の説明は `識別子: digest` だけ（enterprise/error.tsx）。フォームのエラーは `?error=`（flash.tsx:201-211）か actionState の文で、「どこを・どう直すか」の枠組みはない |
| 権限なし | PermissionDeniedState 29 画面（統一されている。良い）                                                                                                                                                                       |
| 読込中   | `loading.tsx` は 0、`LoadingState` は 0、`Skeleton` は 0（画面では未使用）。遷移中の表示は LinkPending の 3 か所だけ。送信中は SubmitButton が担う                                                                          |

### 4.12 外枠（Card）と節の見出し

- Card が 86 ファイル・269 か所。指示書が禁じる「全部カードの UI」「装飾的な枠・影」の主な発生源。上位: assurance testing 10、data/[dataPointId] 8、csrd・ssbj の requirements/[itemId] 各 8、question-view 8、evidence/[fileId] 8
- 節の見出しは 3 通り（CardHeader＋CardTitle 21、SectionTitle 180、CollapsibleSection 12）に加え、素の h2/h3 がそれぞれ 22。h2 の文字サイズは 13・12・15・14px、h3 は 12・13px と混在している
- KPI タイルは 7 実装: `KpiCard`（page-header.tsx:69）、`KpiCard`（esg/kpi-card.tsx:278）、`SummaryCard`（alerts/page.tsx:241）、`SummaryTiles`（ready-view.tsx:117）、`ReadinessCard`（ssbj/page.tsx:68）、`HomeCardLink`（disclosure-home-view.tsx:83）、csrd/_overview/overview-cards.tsx の 3 個。`GapCard` も同じ名前で 2 つある（ssbj/requirements/[itemId]/page.tsx:60、csrd/requirements/[itemId]/page.tsx:97）

### 4.13 主ボタンの数（「1 画面に主操作は 1 つ」）

既定の primary（variant 未指定の Button と SubmitButton）は 92 個・62 ファイル。そのうち 2 個以上あるファイルが 24 ある。上位: organizations/master-forms.tsx 4（:238・:385・:505・:594）、data/[dataPointId]/page.tsx 3（承認 :317・保存 :464・段階承認 :818）、csrd/collection/page.tsx 3、narrative-editor.tsx 3、settings/page.tsx 3（保存 :176・招待 :261・許諾 :462）。ほかに ssbj の settings・plans・requirements・draft・collection、cdp/import、assurance の issues・requests・testing など。部品の境界をまたぐと（画面＝複数ファイル）、さらに増える。

### 4.14 フォーカスリング（CLAUDE.md「Focus Ring を消さない」）

- 全体: globals.css:77-81（2px・brand-600 の outline）
- 上書きが 3 方式ある: `focus-visible:outline-none ring-2 ring-brand-600`（11 ファイル・22 か所）、`ring-brand-100` の淡いリング（input.tsx:15・:36、select.tsx:21、ほか 4 ファイル）、summary の内側に描く `outline-offset-[-2px]`（3 か所）
- `ring-brand-100`（#eaf3ff）は白地でほぼ見えない。枠の色が brand-500 に変わることで最低限の手がかりは残るが、ほかのリングと揃っていない

### 4.15 補足説明（Tooltip と title）

ネイティブ要素に付いた `title=` は約 20 ファイル・36 か所（Badge 13・span 7・TD 3・code 3 ほか。部品の `title` prop、たとえば SectionTitle 180・EmptyState 97 は数えていない）。Hint は 3 か所。title にしか書かれていない補足（例: DataPointStatusBadge の要再確認の理由 badges.tsx:74、AvailabilityBadge の理由 :114）は、キーボードとタッチの利用者に届かない。

### 4.16 必須と任意

`required` 属性は 142 個あるが、画面に「必須」と表示しているのは 31 か所、「任意」は 15 か所で、どちらも約 8 ファイルに偏っている（iro-form・standard-import・materiality-manager・applicability-decision-form ほか）。必須と任意を分けた節構成のフォームはない。

---

## 5. トークン監査

### 5.1 定義済みのトークン（`src/app/globals.css` の `@theme`。Tailwind v4 で設定ファイルはない）

| 種類       | 定義（行）                                                                                                                                                | 利用状況                                                                                                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 色         | brand-50〜950（:8-18）、surface・surface-muted・line・ink・ink-muted（:20-24）、warning・success・danger とその soft（:33-38）、info・info-soft（:39-40） | **info・info-soft は 0 か所**。warning の文字に使える色がない（#f5a800 は文字にすると読めない）ため、`text-[#8a5d00]` を 100 か所で直書きしている                                       |
| 角丸       | `--radius-t4d` 6px・`--radius-t4d-lg` 8px（:42-43）                                                                                                       | rounded-t4d 354 か所・119 ファイル、rounded-t4d-lg 25 か所。混在: `rounded-[4px]` 5、`rounded-[3px]` 3、`rounded-md/lg/sm/xl/full` 22 か所・16 ファイル                                 |
| 間隔       | `--spacing-topbar` 48・`--spacing-sidebar` 224・`--spacing-sidebar-collapsed` 64・`--spacing-row` 36（:46-49）                                            | **すべて 0 か所**。直書き: app-shell.tsx:139 `h-[48px]`、sidebar.tsx:121 `w-[64px]`・`w-[224px]`、block-editor.tsx:1417 `max-h-[calc(100vh-48px-2.75rem)]`、TD の `h-9`（table.tsx:54） |
| 文字       | フォントファミリーだけ（:51-54）。本文 13px は body に直書き（:71）                                                                                       | 文字サイズ・行の高さのトークンはない                                                                                                                                                    |
| 影・重なり | なし                                                                                                                                                      | 影は shadow-sm〜xl を 12 か所・11 ファイル、任意値 2 か所。z は 10・20・30・40・50・100（layout.tsx:27）・`z-[1]`・CSS の `z-index: 2` が混在                                           |
| 段組の境目 | なし                                                                                                                                                      | `min-[1366px]` 16、`min-[900px]` 7、`min-[1600px]`・`max-[1599px]` 各 3、`min-[1100px]` 1                                                                                               |
| その他     | スクロールバーが hex（globals.css:88 `#c6cfdb`・:94 `#a9b5c5`）                                                                                           | —                                                                                                                                                                                       |

### 5.2 任意値（`prefix-[値]`）の集計: 合計 2,312

| 分類                     | 件数  | 内訳（多い順）                                                                                                                                                                      |
| ------------------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文字サイズ `text-[Npx]`  | 1,973 | 12px 927・11px 846・13px 149・10px 18・20px 8・16px 7・14px 5・15px 4・18px 3・22px 3・11.5px 2。**標準の `text-xs/sm/base` は 0**                                                  |
| 文字色の hex             | 100   | `text-[#8a5d00]` 100（59 ファイル。上位: block-editor 7・disclosure-home-view 5・editor-right-pane 4・outputs 4・narrative-editor 4）                                               |
| accent の hex            | 17    | `accent-[#0b57a4]`（= brand-700）。iro-form 4・ssbj/settings 2・ssbj/requirements/[itemId] 2 ほか                                                                                   |
| 背景の hex               | 3     | `bg-[#0b1b34]/35・/25`（dialog.tsx:20、drawer.tsx:25、block-editor.tsx:1466）                                                                                                       |
| 幅                       | 118   | max-w 55（260px 8・320px 7・220px 6・200・280・360px 各 5…）、min-w 35（240・200・220・1280・1180・960・720px…）、w 28（280px 5・120px 3・90・140px 各 2・`w-[min(420px,100vw)]`…） |
| 段組の境目               | 30    | §5.1 のとおり                                                                                                                                                                       |
| grid-cols                | 25    | `[1fr_1.4fr]` 2、`[280px_1fr_360px]`、`[220px_minmax(0,1fr)_380px]`、`[96px_minmax(0,1fr)]`、`[88px_minmax(0,1fr)]` ほか                                                            |
| max-h                    | 20    | `70vh` 10・`60vh` 3・`calc(100vh-160px)` 2…                                                                                                                                         |
| 角丸・z・影・その他      | 26    | rounded 8・z 4・outline-offset 3・h 3・shadow 2・min-h 2・backdrop-blur・align・transition 各 1                                                                                     |
| 余白（p・m・gap・space） | 0     | 余白は Tailwind の目盛りを使っている（px-3 297・px-2 166・py-2 162・py-1.5 135・p-4 100・p-3 86）。問題は値より使い分けの規則がないこと                                             |

**任意値の多いファイル（上位 15）**: disclosures/ssbj/requirements/[itemId]/page.tsx 83・disclosures/csrd/requirements/[itemId]/page.tsx 66・narratives/_components/narrative-editor.tsx 54・blocks/[blockId]/block-editor.tsx 52・data/[dataPointId]/page.tsx 50・dashboard/disclosure-home-view.tsx 44・disclosures/csrd/collection/page.tsx 42・ssbj/settings/materiality-manager.tsx 41・disclosures/question-view.tsx 40・_tabs/outputs.tsx 39・csrd/settings/page.tsx 39・imports/standard/standard-import.tsx 38・imports/standard/import-preview.tsx 37・disclosure-projects/new/project-form.tsx 35・_tabs/overview.tsx 33。

**文字の太さ**: font-medium 274・font-semibold 184・font-normal 36。**行の高さ**: leading-relaxed 32・none 7・7 が 4・6 が 3・4 が 2・5 が 1。

---

## 6. 統合後のデザインシステム API（推奨）

方針: 既存の部品を土台にし、外から見える API を揃える。新しい npm 依存は足さない。`@tanstack/react-table` は package.json にあるが import は 0 件なので、使うなら README の「追加ライブラリと採用理由」へ追記する。`@radix-ui/react-label` も 0 件。Server Component・URL State・Server Action の方針は維持する。

### 6.1 Button と IconButton

```ts
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
// 現在の outline（161 個）は secondary に改名して統合する。
// 現在の secondary（塗り brand-100・9 個）はトグルの選択中表示なので SegmentedControl に移す。
// 既定値は primary から secondary に変える（主ボタンは明示した場合だけにする）。
<Button variant="primary" /> // DOM に data-variant="primary" を必ず出す（全 variant で data-variant を出す）
<IconButton label="… を編集" icon={<Pencil />} />  // aria-label と Hint を自動で付ける。label は必須（型で強制）
```

- `size` は xs（24）・sm（28）・md（32）の 3 つにする。lg（3 か所、financial-impact）は md に、`size="icon"`（3 か所）は IconButton に寄せる
- `danger` は「確定すると戻せない」操作だけに使い、原則として ConfirmDialog の確定ボタンに置く。きっかけのボタンは `ghost` か RowActions の破壊的な項目にする
- 自動検査: ui-integrity-audit に「`main` の中で、ダイアログの外にある、見えている `[data-variant="primary"]` は 1 個以下」を、主要画面のロール別に追加する。ダイアログの中は別に数え、1 個以下とする

### 6.2 PageActions（見出しの操作）

```tsx
<PageHeader title=… actions={
  <PageActions
    primary={{ label: '承認', icon: <Check/>, formAction, hidden: !canApprove }}
    secondary={[{ label: '差戻し…', onSelect: openReturnDialog }]}     // 見える副操作は 2 個まで
    more={[{ label: 'CSV 出力', href }, { label: '削除…', destructive: true, confirm: {...} }]} // 「その他」（文字付き）メニュー
  />} />
```

- 権限で許されない項目は出さない（サーバー側の検査はそのまま残す）。状態の都合で今は押せない項目は `disabledReason` を持たせ、理由を表示する
- 置き換え対象: data/[dataPointId]/page.tsx:261-321 の見出し（差戻しの理由欄はダイアログへ。状態に応じて主操作を 1 つ選ぶ: 下書き→提出、提出済み→承認）、master-forms・settings の主ボタン複数（§4.13）

### 6.3 RowActions と BulkActionBar（選択に応じた操作）

```tsx
<RowActions label={`${row.name} の操作`} primary={{ label: '開く', href }} items={[{ label: '編集', … }, { label: '削除…', destructive: true, confirm }]} />
<BulkActionBar formId="bulk-form" actions={[{ label: '一括提出', value: 'submitted' }, { label: '一括承認', value: 'approved', variant: 'primary', confirm: { title: (n) => `${n} 件を承認しますか` } }]} />
```

- RowActions は、主となる 1 操作（文字のリンク）と「その他」メニュー（DropdownMenu）の 2 段にする。アイコンだけで意味を伝えない
- BulkActionBar は data/bulk-actions.tsx を shared へ移す。選択が 0 件のときは出さない（何も選んでいなければ新規・検索・絞込だけが見える）。下端に固定し、部分失敗の結果欄（:99-111）はそのまま残す。一括承認と一括差戻しは ConfirmDialog を通し、差戻しの理由を必須にする

### 6.4 DataTable

```ts
interface DataTableColumn<Row> {
  key: string; header: string; cell: (row: Row) => React.ReactNode;
  align?: 'left' | 'right' | 'center'; sortable?: boolean;            // 並べ替えは URL ?sort&dir（SortLink と同じ）
  importance: 'primary' | 'secondary' | 'detail';                     // 最初に見せるのは primary と secondary だけ
  pinned?: 'left'; width?: 'xs' | 'sm' | 'md' | 'lg';                 // 幅をトークンにして w-[Npx] をなくす
}
<DataTable id="data-points" caption columns rows getRowId
  filters={FilterGroup[]} search={{ placeholder }} savedViews={[…]}  // FilterBar を内蔵
  page pageSize total basePath searchParams                          // Pagination を内蔵（既定 25 件）
  bulk={{ formId, actions }} rowActions={(r) => …} expandable={(r) => …}
  empty={<EmptyState kind="filtered" />} />
```

- 見出しは常に sticky にする（2 方式を 1 つにまとめる。背景は surface、z は `--z-sticky`）。先頭列の固定は `pinned` で表す（3 画面の直書きをなくす）
- 列の表示・非表示は URL の `cols` を正とする。利用者ごとの既定値は Cookie（`t4d_cols_<id>`）に保存し、サーバー描画の時点で反映する（レイアウトのずれを防ぐ。DB の変更は不要）。localStorage は描画後に読むことになり、ずれが出るため使わない
- 保存ビューは URL のクエリ文字列とし、既存のプリセットと「この条件を保存」（Cookie・利用者ごと）を並べる。共有は URL のコピーで行う
- 展開できる行は、行内の `<details>` 4 か所を `expandable` へ移す。行の詳細を一目見る用途は、未使用の Drawer を土台にする
- 段階移行: まず `Table` に `sticky` を既定で入れる → data/page.tsx を DataTable に置き換えて基準にする → 一覧の 7 画面（evidence・narratives・workflows・disclosure-projects・imports・cdp・csrd/requirements）→ 残り

### 6.5 フォーム: FormSection と Field

```tsx
<FormSection title="基本情報">  {/* 必須の項目だけを先に置く */}
  <Field label="指標名" required hint="…" error={state.fieldErrors?.name}><Input name="name" /></Field>
</FormSection>
<FormSection title="詳細（任意）" collapsible defaultOpen={hasValues}>…</FormSection>
```

- Field は、ラベル・「必須」の文字バッジ（色だけにしない）・`aria-describedby`（hint と error）・エラー文（何が・どう直すか）を出す
- 入力部品を揃える: ネイティブのまま見た目を揃えた `NativeSelect`（素の select 100 個・19 種類を置き換える）、`NativeCheckbox`（`accent-brand-700`。29 個）、`Input`・`Textarea`（素の text 入力 24 個）。Radix の Select と Checkbox は JS が必要な島だけで使う
- 既定値・前回値・複製は、既存の PreservingForm と「前年度から複製」の流れを Field の `defaultValue` で揃えて使う

### 6.6 状態: EmptyState・ErrorState・LoadingState

```tsx
<EmptyState kind="no-data" | "filtered" | "not-applicable" title action={…} size="compact" | "page" />
// filtered のときは「絞り込みを解除」を自動で付ける。no-data のときは action を必須にする（型で強制）
<ErrorState what="データを取得できませんでした" why="…" how="再読み込みするか、識別子を添えて管理者へ" digest onRetry />
<PageSkeleton variant="list" | "detail" />  // 各ルートグループの loading.tsx で使う。行の高さ = --spacing-row
```

- `size` は compact（py-4。表やカードの中）を既定にし、page（py-10）は画面全体が空のときだけにする（余白を減らす）
- TrendEmptyState と、`<p>…ありません</p>` 形式の約 100 行を EmptyState か `EmptyInline` に寄せる
- 誠実さ・権限の表示は今のまま残す（PermissionDeniedState は統一済み）

### 6.7 ConfirmDialog（破壊的操作）

```tsx
<ConfirmDialog trigger={<Button variant="ghost">削除</Button>} title="IRO を削除しますか"
  consequences={['論理削除です。履歴は残ります', 'DMA を確定していた場合は、確定を取り消します']}
  acknowledge="上記の範囲を確認しました"   // 範囲のあるリセットでは必須。範囲の 1 行はダイアログの本文に常に表示する
  confirmLabel="削除する" formAction={…} hiddenFields={{ iroId }} />
```

- 置き換え対象: §4.2 の 4 方式すべてと、一括承認・一括差戻し。デモのリセット 2 件（ghg/suppliers・disclosure-home-view）は「範囲の確認」を保ったままダイアログへ移す。E2E は「ダイアログを開いてからチェックする」形に直し、期待値は緩めない
- `window.confirm`（block-editor.tsx:401）は未保存のまま離れる場面専用の ConfirmDialog に置き換える

### 6.8 状態バッジの登録簿

```ts
// src/lib/ui/status-registry.ts（React に依存しない。テストからも引ける）
type Semantic = 'todo' | 'draft' | 'pending' | 'in_review' | 'returned' | 'done' | 'blocked' | 'error' | 'info';
const SEMANTIC: Record<Semantic, { tone: Tone; icon: LucideIcon }> = {
  todo: { tone: 'neutral', icon: CircleDashed }, draft: { tone: 'outline', icon: FilePen },
  pending: { tone: 'warning', icon: Hourglass }, in_review: { tone: 'brand', icon: Eye },        // Loader2 は使わない
  returned: { tone: 'warning', icon: Undo2 },    done: { tone: 'success', icon: CircleCheck },
  blocked: { tone: 'warning', icon: AlertTriangle }, error: { tone: 'danger', icon: XCircle }, info: { tone: 'neutral', icon: Info } };
export const STATUS = { dataPoint: { returned: { label: '差戻し', semantic: 'returned' }, … }, block: …, pbc: …, task: …, test: …, job: …,
  membership: …, response: …, narrative: …, csrdDraft: …, plan: …, coverage: …, dmaOutcome: … } as const;
<StatusBadge domain="block" value={status} />   // ラベル・アイコン・トーンは登録簿から決まる。補足は title ではなく sr-only か Hint で
```

- 同じ意味なら同じトーン・同じアイコンにする（差戻しは warning＋Undo2 に揃える）。名前の衝突（EvidenceBadge・ApplicabilityBadge）は、領域名を付けた名前に改名して解消する
- 誠実さ系のバッジ（DemoData・AiGenerated・AiCandidate・SampleMaster・Provisional・ReadOnly）は `HonestyBadge kind=…` にまとめる。Mock の文言は「デモ生成（Mock）」に統一し、flash.tsx:161 と揃える。**どれも常に表示し、Collapsible の中には入れない**
- 単体テスト: 登録簿のすべての状態について、ラベルとアイコンがあり、同じ semantic なら同じトーンであることを確かめる

### 6.9 Tabs・NavTabs・SegmentedControl

```tsx
<NavTabs ariaLabel="プロジェクトのタブ" items={[{ key, label, href, count? }]} current={tab} />       // URL タブ（§4.8 の 2 画面）
<SegmentedFilter ariaLabel="原稿の絞り込み" items={[{ value, label, count, href }]} current={filter} /> // URL の絞込チップ（7 画面と FilterBar）
// Radix の Tabs は、画面内でクライアント側に切り替える区画（editor-right-pane）だけに使う
```

`aria-current` は、タブなら `page`、絞込なら `true` に揃える（決めて揃える）。

### 6.10 Section・MetricTile（外枠を減らす）

```tsx
<Section title actions summary? collapsible? divider="top">…</Section>    // CardHeader・SectionTitle・CollapsibleSection の 3 通りを 1 つに。枠と影を付けない
<MetricStrip>{tiles}</MetricStrip>  <MetricTile label value unit denominator? delta? status? href? />  // KPI の 7 実装を 1 つに。カードではなく密な 1 行
```

- Card は「押せるタイル」と「浮かせる層」（Popover・Drawer）だけに使う。この移行で tests/unit/esg-data-project-pages.test.tsx:113 の `div.rounded-t4d-lg` による検索が壊れるため、`data-metric-tile` で探す形に直す（期待値は変えない）
- ダッシュボードは Attention → Action → Status → Insight の順に MetricStrip と表を並べる（画面の構成は画面棚卸しの担当）

### 6.11 Notice と ActionResult（通知を 1 つに）

```tsx
<Notice tone="info" | "success" | "warning" | "danger" title? role="status" | "alert">…</Notice>
<ActionResult state={actionState} />   // useActionState の結果（19 ファイル）を Notice で出す
<FlashMessage />                       // 中身を Notice にする。?flash と ?error の仕組みはそのまま
```

ESLint で `border-(warning|danger)/\d+ bg-\1-soft` の直書きを禁止し、Notice を使わせる。

### 6.12 Tooltip

アイコンボタンには `IconButton` の Hint を必須にする。`title=` は「省略された文字の全文」の用途だけに残す。状態の理由（例: badges.tsx:74・:114）は sr-only＋Hint にするか、見える 1 行にする。Tooltip を情報の唯一の置き場にしない。

### 6.13 フィードバックの方針

トースト用のライブラリは足さない（消える通知は必要な情報を隠すため、指示書の禁止事項に当たる）。完了の通知は今までどおり Notice（URL フラッシュ）に一本化する。

### 6.14 CommandPalette

`extraEntries` を AppShell から渡す。中身は、操作（新規作成・取込など。権限で絞る）、最近開いたもの（利用者ごと。localStorage。無くても動く）、設定ページ。データ（指標・要求事項・プロジェクト・Data Point）の検索には、読み取り専用の検索エンドポイントが必要になる。これはバックエンドの変更なので、必要性を確かめてから別に提案する（RLS・アプリ層の二重の認可が前提）。

---

## 7. トークン案と codemod の対応表

`@theme` に追加する（Tailwind v4。既存の名前は変えない）。標準の `text-*` は今 0 件なので、意味で名前を付けたトークンを新設する。

| トークン                                                                                              | 値                                              | 置き換え元（件数）                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--text-caption`（＋line-height 16px）                                                                | 11px                                            | `text-[11px]` 846                                                                                                                                                                                                                                                            |
| `--text-small`（18px）                                                                                | 12px                                            | `text-[12px]` 927・`text-[11.5px]` 2（目視で確認する）                                                                                                                                                                                                                       |
| `--text-body`（20px）                                                                                 | 13px                                            | `text-[13px]` 149（body の 13px と揃える）                                                                                                                                                                                                                                   |
| `--text-title-sm`・`--text-title`・`--text-title-lg`                                                  | 14・15・16px                                    | 5・4・7（ダイアログの題・h1・認証画面の h1）                                                                                                                                                                                                                                 |
| `--text-figure-sm`・`--text-figure`・`--text-figure-lg`                                               | 18・20・22px                                    | 3・8・3（強調する数値・KPI）                                                                                                                                                                                                                                                 |
| （置き換えない）                                                                                      | 10px                                            | `text-[10px]` 18 は、図の規則「11px 以上」（disclosure-first.md §10.4）に照らして目視で確認する                                                                                                                                                                              |
| `--color-warning-ink`                                                                                 | #8a5d00                                         | `text-[#8a5d00]` 100（badge.tsx:13・page-header.tsx:88 を含む）                                                                                                                                                                                                              |
| `--color-overlay`                                                                                     | #0b1b34                                         | `bg-[#0b1b34]/35・/25` 3                                                                                                                                                                                                                                                     |
| （既存）brand-700                                                                                     | —                                               | `accent-[#0b57a4]` 17 → `accent-brand-700`。`accent-brand-600` も揃える                                                                                                                                                                                                      |
| `--color-scrollbar`・`--color-scrollbar-hover`                                                        | #c6cfdb・#a9b5c5                                | globals.css:88・:94                                                                                                                                                                                                                                                          |
| （既存）`--spacing-topbar`・`--spacing-sidebar`・`--spacing-sidebar-collapsed`・`--spacing-row`       | 48・224・64・36                                 | `h-[48px]`→`h-topbar`、`w-[224px]`→`w-sidebar`、`w-[64px]`→`w-sidebar-collapsed`、`calc(100vh-48px-…)`→`calc(100vh-var(--spacing-topbar)-…)`                                                                                                                                 |
| `--spacing-field-sm`・`-md`・`-lg`、`--spacing-col-xs`〜`-lg`                                         | 200・280・360px／88・120・200・320px            | max-w・min-w・w の任意値 118 のうち、繰り返し使われるもの（280px は 5＋4、260・320・220・200px）。単発のものは個別に確認する                                                                                                                                                 |
| `--radius-t4d-sm`                                                                                     | 4px                                             | `rounded-[4px]` 5・`rounded-[3px]` 3。`rounded-md/lg` は t4d に寄せ、`rounded-full`（丸・バー）はそのまま残す                                                                                                                                                                |
| `--shadow-raised`・`--shadow-overlay`                                                                 | `0 1px 2px rgb(23 32 51/.04)`・`shadow-lg` 相当 | card.tsx:8、ssbj/requirements/page.tsx の任意値の影、Dialog・Drawer・Popover の shadow-md/lg/xl                                                                                                                                                                              |
| `--z-sticky-col`・`--z-sticky`・`--z-pane`・`--z-overlay`・`--z-modal`・`--z-popover`・`--z-skiplink` | 1・10・20・40・50・60・100                      | §5.1 の z の値を役割に対応させる（z-[1] は先頭列の固定、z-10 と globals.css:121 の `z-index: 2` は sticky 見出し、z-20・z-30・z-40 は block-editor の帯・覆い・ペイン、z-50 は Dialog・Menu・Select・Tooltip・ref-chip・demo-tour、z-100 は「本文へスキップ」layout.tsx:27） |
| `--breakpoint-wide`・`--breakpoint-xwide`                                                             | 1366px・1600px                                  | `min-[1366px]` 16、`min-[1600px]`・`max-[1599px]` 各 3。900px・1100px（8）は個別に確認する                                                                                                                                                                                   |

**codemod の手順**（実装段階で行う。今回は分析だけ）

1. `scripts/codemod-tokens.mjs`: 上の表を対応表として持つ。`className="…"`・`cn(…)`・`cva(…)` の中の文字列だけを、語の境界で完全一致したときに置き換える。対応表にない任意値は一覧にして出す（自動では置き換えない）
2. 置き換えた後に `pnpm lint && pnpm typecheck && pnpm test` を流し、E2E の ui-integrity-audit（1280・1440・1920px）と axe の検査で崩れがないことを確かめる。tests でクラス名に頼っている箇所は 1 か所だけ（esg-data-project-pages.test.tsx:113）
3. 再発を防ぐ: ESLint の `no-restricted-syntax` で、`text-\[\d+(\.\d+)?px\]`、`#[0-9a-fA-F]{3,8}` を含むクラス、`z-\d+`、`shadow-\[` を禁止する（定義ファイルは対象外にする）。ui-integrity-audit には `data-variant="primary"` の数の検査を追加する

---

## 8. 移行順序（指示書の段階に合わせる）と回帰の確かめ方

| 段階              | この文書で扱う部品                                                                                                   | 回帰の確かめ方                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Navigation        | CommandPalette の extraEntries、NavTabs                                                                              | メニューのすべての href に今までどおり到達できる（ナビの棚卸し文書と突き合わせる）                                          |
| Layout            | トークン（§7）・codemod、Section・MetricStrip、PageSkeleton と loading.tsx                                           | ui-integrity-audit・axe（コントラスト: warning-ink は現状の #8a5d00 のまま）                                                |
| Component         | Button（data-variant・既定値の変更）、IconButton、StatusBadge の登録簿、HonestyBadge、Notice、EmptyState・ErrorState | 登録簿の単体テスト、誠実さの注記が見えていること（collapsed-content-a11y・既存の禁止語検査を緩めない）                      |
| Table             | DataTable（sticky・pinned・cols の Cookie・保存ビュー・展開できる行）                                                | table-controls.spec.ts、77 表の sticky 化、一覧の件数が変わらないこと                                                       |
| Form              | FormSection・Field・NativeSelect・NativeCheckbox                                                                     | 必須の表示、Server Action のフォームが JS なしでも送れること                                                                |
| Contextual Action | PageActions・RowActions・BulkActionBar・ConfirmDialog                                                                | 主ボタンの数の検査、破壊的操作がすべてダイアログを通ること、権限のない役割では項目が出ないこと（デモの 6 役割 ＋ 監査法人） |
| Advanced          | 保存ビューの利用者ごとの保存、パレットのデータ検索（バックエンドが必要なら別に提案）                                 | RLS とアプリ層の認可を変えないこと（変えるなら二重に書き、`pnpm test:rls` を通す）                                          |

**守る制約**: 機能・業務ロジック・権限検査・API・データ項目は消さない。誠実さの注記（デモ・Mock・サンプル・未発効・試算・社内承認であって保証ではない）は常に見せる。AI の確定経路は作らない。テストは開いてから確かめる形に直し、期待値は緩めない。未使用の部品（Drawer・Checkbox・Separator・LoadingState・ActiveFilterSummary）は削除しない。DataTable・行の詳細・PageSkeleton の土台として使う。
