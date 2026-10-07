# Stage A 完了報告と Stage B への引継ぎ（docs/ui-redesign/plan.md §6.1 A9）

- 対象ブランチ: `feat/self-audit-2026-08-20`（コミット・push・デプロイはしていない）
- 本書は Stage B（6 スライス）が使う API・規則・未了の表の場所をまとめる。設計の正は plan.md

## 1. 部品と API（Stage B はこれを使う。`src/components/**`・`src/lib/ui/**` は B の間は凍結）

### 1.1 ボタン

| 部品           | パス                                  | 契約                                                                                                                                                                                                                                                                 |
| -------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`       | `src/components/ui/button.tsx`        | `variant: 'primary' \| 'secondary' \| 'quiet' \| 'ghost' \| 'danger' \| 'link'`（**既定 secondary**）、`size: 'xs' \| 'sm' \| 'md' \| 'lg'(非推奨) \| 'icon'(非推奨)`、`asChild`。DOM に常に `data-variant`・`data-size`。旧 outline＝secondary、旧 secondary＝quiet |
| `SubmitButton` | `src/components/ui/submit-button.tsx` | Button の props＋`pendingLabel`・`icon`。variant を書かなければ secondary                                                                                                                                                                                            |
| `IconButton`   | `src/components/ui/icon-button.tsx`   | `label`（必須。aria-label＋Hint）・`icon`・`variant?: 'ghost'\|'secondary'\|'danger'`・`size?: 'xs'\|'sm'`                                                                                                                                                           |

primary は画面（タブ・状態）ごとに 1 つ。`[data-variant="danger"]` は確認ダイアログの中だけ（E2E `primary-action-audit.spec.ts` が数える）。

### 1.2 操作の型（`src/lib/ui/actions.ts`。React 非依存）

```ts
type ServerAction = (formData: FormData) => void | Promise<void>;
interface ActionBase {
  id;
  label;
  icon?;
  hidden?;
  disabledReason?;
}
type ActionSpec =
  | (ActionBase & { kind: 'link'; href; download?; external? })
  | (ActionBase & { kind: 'submit'; action; fields?: Record<string, string>; pendingLabel? })
  | (ActionBase & { kind: 'confirm'; action; fields?; confirm: ConfirmSpec });
type MenuActionSpec = ActionSpec & {
  destructive?: boolean;
  group?: 'main' | 'export' | 'advanced';
};
interface ConfirmSpec {
  tier: 'irreversible' | 'bulk' | 'reversible';
  title;
  scope /* 範囲 1 行。常に本文 */;
  consequences?: string[];
  acknowledge?: { name; label };
  reason?: { name; label; required; placeholder? };
  preview?: ReactNode;
  confirmLabel;
  destructive?;
  extraFields?: ReactNode;
}
splitPageActions({ primary, secondary, more }); // secondary 3 つ目以降は more の先頭へ
orderMenuItems(items); // main → export → advanced、destructive は最後
```

### 1.2.1 状態で変わる操作（`src/lib/ui/state-actions.ts`。plan §1.15。React 非依存）

状態 × 権限から `StateActionPlan { primary: StateAction | null; secondary: StateAction[] (≤2); more: StateAction[] }` を返す純関数。`StateAction { id; label; disabledReason?; confirm?: ConfirmTier; reasonRequired?: true }`。画面はこれを ActionSpec（action・fields・ConfirmSpec の本文）に写すだけにする。権限の条件はサーバーの検査と同じ（`tests/unit/state-actions.test.ts`）。ラベルの「…」は入力を求めるダイアログ（MoreMenu は既に「…」で終わるラベルに重ねない）。

| 関数                                              | 入力                                                           | 主な結果                                                                                                                                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dataPointStateActions`                           | `{ status, can, valueSaved, hasValue, approvalStageLabel? }`   | 入力中: 保存／提出（値なしは `SUBMIT_WITHOUT_VALUE_REASON`）、提出済み: レビュー開始＋差戻し…、レビュー中: 承認／「「段階名」を承認」＋差戻し…、承認済み: その他に「承認済みの値を修正」。AI はその他 |
| `responseStateActions`                            | `{ status, can, hasResponse, isAiDraft?, hasPendingAiDraft? }` | 下書き: 保存（下書き）＋レビュー依頼、承認（兼務）はその他。レビュー中: 承認（AI のままは `AI_DRAFT_APPROVAL_REASON`）＋差戻し…                                                                       |
| `blockStateActions`                               | `{ status, can, isAssignedReviewer, blockedReason? }`          | 作成中: レビュー依頼＋版として保存、レビュー中（指名者）: レビューを完了する＋差し戻す…、最終承認待ち: 最終承認する（社内承認）（irreversible）                                                       |
| `importJobRowAction`・`importReviewScreenActions` | `(status, can)`                                                | 進捗を見る／確認して確定／結果を見る／エラーを見る、確認画面の「選択した行を確定」                                                                                                                    |
| `pbcFirmRowActions`・`pbcClientRowActions`        | `(status, can)`                                                | 受理＋差戻し…／回答を提出（secondary）                                                                                                                                                                |
| `testStateActions`                                | `{ status, can, preparedByMe }`                                | 作成完了として記録＋保存、作成済み: レビュー完了として記録（本人は `SELF_REVIEW_REASON`）                                                                                                             |
| `signoffStateActions`                             | `{ stage, can, blockers }`                                     | 「{段階} として Sign-off」（irreversible。blockers があれば押せない理由）。現行画面の「{氏名} として Sign-off」から変えるかは B6 が決める                                                             |
| `issueRowActions`                                 | `(status, can)`                                                | 解消として記録（secondary）                                                                                                                                                                           |

### 1.3 見出し・行・一括・確認

| 部品            | パス                         | 使い方                                                                                                                                                                                                                                                                    |
| --------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PageActions`   | `shared/page-actions.tsx`    | `<PageActions primary={…} secondary={[…]} more={[…]} moreLabel? openConfirmId? />` を `PageHeader actions` に渡す。並びは「その他 → secondary → primary（右端）」                                                                                                         |
| `MoreMenu`      | `shared/more-menu.tsx`       | `items: MenuActionSpec[]`、`label`（既定「その他」）。submit は隠しフォーム、confirm は ConfirmDialog を開く。押せない項目は理由を文字で出す。起動ボタンに `data-more-menu`                                                                                               |
| `RowActions`    | `shared/row-actions.tsx`     | `rowLabel`・`primary?: ActionSpec`（xs の secondary）・`items?: MenuActionSpec[]`。起動ボタンは文字「操作」＋読み上げ名「{rowLabel} の操作」                                                                                                                              |
| `ActionButton`  | `shared/action-button.tsx`   | ActionSpec 1 つを描く（disabledReason は aria-disabled＋Hint＋sr-only）                                                                                                                                                                                                   |
| `ConfirmDialog` | `shared/confirm-dialog.tsx`  | ConfirmSpec ＋ `action` か `formId`（既存フォームを送る。`submitter`・`formAction`・`multiFields`）・`trigger?`・`open/onOpenChange`・`defaultOpen`。確定は danger（irreversible）か primary の 1 つ。範囲は `[data-confirm-scope]`、確定ボタンは `[data-confirm-submit]` |
| `BulkActionBar` | `shared/bulk-action-bar.tsx` | `formId`・`name`（既定 selected）・`action?`・`actions: BulkActionSpec[]`・`pending?`・children（結果）。**選択 0 件ではバーを描かない**（フォームは残す）。内訳は行のチェックの `data-row-status`                                                                        |

`BulkActionSpec = { id, label, icon?, action?, submitter?: {name,value}, variant?, hidden?, confirm?: Omit<ConfirmSpec,'scope'> & { scope: (count, breakdown) => string } }`

### 1.4 一覧（`shared/data-table/*`）

```tsx
<DataTable<Row>
  id caption columns rows getRowId getRowLabel getRowStatus?
  searchParams basePath
  filters? overflowFilters? search={{ placeholder } | false}
  savedViews? userViews?
  page={{ page, pageSize, total, sizes? }}
  selection={{ formId, name?, isSelectable? }} bulkActions? bulkAction? bulkBar?
  rowActions={(row) => RowActionsProps | null} expand={(row) => ReactNode | null}
  empty={{ noData: { title, description?, action }, filtered?: { title?, description? } }}
  toolbarExtra?
/>
interface DataTableColumn<Row> { key; header; cell(row); importance: 'primary'|'secondary'|'detail';
  lockVisible?; sortKey?; align?; pinned?: 'left'; width?: 'xs'|'sm'|'md'|'lg'|'xl' }
```

- 列の表示は URL `cols` が正（`src/lib/table/columns.ts` の `visibleColumnKeys`・`colsParamFor`・`defaultColumnKeys`。既定は importance≠detail）。外した列は DOM に出ない
- 並べ替え `sort`・`dir`、ページ `page`・表示件数 `size`（`parsePage`・`parsePageSize`。候補 25/50/100）
- 絞り込みの結果 0 件は `EmptyState kind="filtered"`（解除リンクは列・並べ替え・件数を保つ）
- 全行 `data-t4d-record`、選択のチェックは `data-t4d-select`（`x` で切替）
- 保存ビュー（端末ごと）: `src/lib/table/views.ts`。`localStorage t4d.table.v1.<viewerKey>.<tableId>` と、既定ビューの索引 `t4d.table-defaults.v1.<viewerKey>`（パス → 条件）。**既定ビューは描画時に URL を書き換えない**。サイドバー・パレットのリンクを押した時点で `useListNavigation()`（`data-table/use-list-href.ts`）が条件を付けて移る。直接 URL では「既定のビュー: …（適用）」のリンクを出す
- `FilterBar` に `overflowGroups`（「絞り込み ▾」）・`userViews: { tableId, basePath }`・`extra`（件数の右）を足した
- `Table` は見出し固定が既定（`stickyHeader`、CSS は `:where(table[data-sticky-header]) > thead th`。詳細度 0 なので th のクラスが勝つ）

### 1.5 フォーム

| 部品                             | パス                                             | 契約                                                                                                                                                                                                                |
| -------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Field`                          | `ui/field.tsx`                                   | `label`・`name?`・`id?`・`required?`・`hint?`・`error?`・children は render-prop `(p) => <Input {...p} />`（id・required・aria-describedby・aria-invalid を渡す）。「必須」「任意」を文字で出す（`RequirementTag`） |
| `FormSection`                    | `ui/form-section.tsx`                            | `kind="required"`（fieldset。先頭に置く）／`"optional"`（details。既定で閉、値・エラーがあれば `open`）                                                                                                             |
| `NativeSelect`・`NativeCheckbox` | `ui/native-select.tsx`・`ui/native-checkbox.tsx` | `size?: 'xs'\|'sm'\|'md'`・`invalid?`／`label?`                                                                                                                                                                     |
| `CreatePanel`                    | `shared/create-panel.tsx`                        | `id`・`title`・`openParam?`（既定 new）・`searchParams`・`closeHref`。`?new=1` のときだけ描く（JS 不要）。`createPanelHref(basePath, searchParams, { open })`・`isCreatePanelOpen()`                                |

### 1.6 状態・通知

| 部品                                         | パス                             | 契約                                                                                                                                                                                                                                                   |
| -------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `EmptyState`                                 | `shared/states.tsx`              | `kind: 'no-data'`（action 必須）・`'filtered'`（resetHref）・`'not-applicable'`・`'done'`、`size?: 'compact'\|'page'`。kind 無しは旧来（ratchet が数える。B で kind を付ける）                                                                         |
| `ErrorState`                                 | 同上                             | `what`・`why`・`how`・`digest`・`onRetry`・`retryHref`・`homeHref`（旧 title/description も受ける）                                                                                                                                                    |
| `PermissionDeniedState`                      | 同上                             | `permission?: PermissionKey` を渡すと「必要な権限: 「…」。{持つ役割}に依頼してください」                                                                                                                                                               |
| `TableSkeleton`・`PanelSkeleton`             | 同上                             | 行の高さ `h-row`（ずれない）                                                                                                                                                                                                                           |
| `Notice`・`ActionResult`                     | `shared/notice.tsx`              | `Notice { tone: 'info'\|'success'\|'warning'\|'danger', title?, role?, action? }`、`ActionResult { state: { status: 'idle'\|'success'\|'error', message } }`                                                                                           |
| `FlashMessage`                               | `shared/flash.tsx`               | `searchParams`・`undo?: Record<flashKey, ReactNode>`（区分 3 の「元に戻す」）。文言はドメイン別 `shared/flash-messages/{data,ssbj-cdp,csrd,projects,analysis-master,assurance-settings}.ts`（各スライス所有）                                          |
| `GlobalErrorNotice`                          | `shared/global-error-notice.tsx` | AppShell が main の先頭に置く。画面が FlashMessage で `?error=` を出していなければ代わりに出す                                                                                                                                                         |
| `RouteError`                                 | `shared/route-error.tsx`         | 3 つの error.tsx が使う（何が・なぜ・どうする・識別子・ホームへ）                                                                                                                                                                                      |
| `StatusBadge`・`SemanticBadge`・`StatusIcon` | `shared/status-badge.tsx`        | `<StatusBadge domain="dataPoint" value="returned" detail? size? />`。登録簿 `src/lib/ui/status/registry.ts`（`STATUS`・`statusEntry`・`statusLabel`・`statusOptions`・`SEMANTIC_STYLE`）。ドメイン別ファイルは各スライス所有（registry.ts のコメント） |
| `HonestyBadge`                               | `shared/honesty-badge.tsx`       | `kind: 'demo-data'\|'mock-ai'\|'ai-candidate'\|'sample-master'\|'provisional'\|'read-only'\|'fictional'\|'estimate'\|'not-effective'`。文言固定。折りたたみの中に置かない                                                                              |

`badges.tsx` の状態バッジ（DataPoint・Response・Job・Pbc・Task・Test・Membership）は登録簿を通る薄いラッパーになった（ラベルは不変、アイコンと一部の色は意味ごとに統一）。DemoData・AiGenerated・ReadOnly はまだ旧来（B で HonestyBadge へ）。

### 1.7 配置・画面の骨格

| 部品                         | パス                            | 契約                                                                                                                                                                                |
| ---------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PageHeader`                 | `shared/page-header.tsx`        | 追加: `context?`（h1 の下の 1 行）、`breadcrumbsTail?: Crumb[]`／`autoBreadcrumbs?`（メニューから経路を作る）。手書きの `breadcrumbs` も可。aria-current は末尾だけ                 |
| `NavBreadcrumbs`             | `shared/nav-breadcrumbs.tsx`    | `navBreadcrumbsFor(items, pathname, { homeHref, preferredBranch?, tail? })`                                                                                                         |
| `Section`                    | `shared/section.tsx`            | `title`・`level?`・`summary?`・`actions?`・`collapsible`（true なら `id` 必須）・`defaultOpen?`・`open?`・`divider?`                                                                |
| `MetricStrip`・`MetricTile`  | `shared/metric-strip.tsx`       | `MetricTile { label, value, unit?, denominator?, delta?, status?: { semantic, label }, href?, hint? }`（`data-metric-tile`）                                                        |
| `AttentionStrip`             | `shared/attention-strip.tsx`    | `items: { key, label, count, href, semantic }[]`（0 件は描かない）                                                                                                                  |
| `NavTabs`・`SegmentedFilter` | `shared/nav-tabs.tsx`           | `ariaLabel`・`items: { key, label, href, count?, attention?, hidden? }[]`・`current`                                                                                                |
| `StepNav`                    | `shared/step-nav.tsx`           | `steps: { key, label, state: 'done'\|'current'\|'todo'\|'blocked', href?, note? }[]`（`aria-current="step"`）                                                                       |
| `CandidateDecision`          | `shared/candidate-decision.tsx` | `candidate?`・`decided?`・`adopt?`・`editAndConfirm?`・`manualConfirm?`・`run?`（各 `{ action, fields }`）・`canWrite`・`canRunAi`・`afterDecision?`・children（編集欄）・`labels?` |
| `MyWork`                     | `shared/my-work.tsx`            | `work: MyWorkModel`（`src/lib/services/my-work.ts` の `loadMyWork`）・`moreLinks?`                                                                                                  |

### 1.8 ナビ・パレット・役割

- `src/lib/ui/home-profile.ts`: `homeProfileOf(ctx)`／`homeProfileFor(can)`（approver・preparer・admin・reviewer・contributor・viewer）、`assuranceHomeProfileOf`、`defaultHomeTab`・`resolveHomeTab`、`canFor(ctx)`
- `src/lib/ui/task-verbs.ts`: `TASK_VERBS`・`availableTaskVerbs(can, { unitScopeIds, currentProjectId?, demo?, disclosureFirst? })`・`RECOMMENDATIONS`
- `src/components/shared/route-catalog.ts`: `ROUTE_CATALOG`（page.tsx 全 78 本を 79 項目で）・`routeForPath`・`canOpenRoute`・`resolveRouteHref`。**新しいページを作ったら必ず足す**（`route-catalog.test.ts` が落ちる）
- `src/lib/ui/palette.ts`: `buildPaletteEntries`・`arrangePaletteEntries`・`matchesPaletteQuery`
- `searchPaletteAction(query)`（`src/app/(common)/palette/actions.ts`）＋`searchPalette`（`src/lib/services/palette-search.ts`。読み取りだけ・2 文字以上・各 8 件・権限で種類を絞る）
- `ShellProvider`／`useShell`・`useViewerKey`・`useCan`（`shared/viewer-context.tsx`）。viewerKey は `${userId}:${organizationId}`
- `src/lib/ui/local-store.ts`（`LOCAL_KEYS`・`readLocal`・`writeLocal`。すべて try/catch）、`src/lib/ui/recent.ts`（最近使った画面）
- サイドバー: グループの開閉（`aria-label="{グループ} を折りたたむ／展開する"`、`aria-expanded`・`aria-controls`、`localStorage t4d.nav.v1.<viewerKey>`）。開示の閲覧権限が無い役割は「開示対応」（従来）／「開示プロジェクト」（開示優先）を既定で閉じる（`defaultCollapsedGroups`）。現在地の祖先は開いて描く
- 監査法人ツリー: 案件ホーム／保証契約／〔案件選択時〕計画（概要・スコープ）・実施（Data Room・母集団・サンプリング・保証手続・調書・PBC／資料依頼・指摘・例外）・結論（レビューNote・Sign-off）・記録（監査ログ・出力）／設定。案件未選択は「案件を選ぶと手続の画面が並びます」。現在地は single
- ヘッダー: 「検索 Ctrl K」（`data-t4d-palette-trigger`）、上端の `NavigationProgress`、`RecentTracker`
- ショートカット: `?` ヘルプ（用語集つき）、`g`＋h/d/w/i/s/c、`x`（`[data-t4d-select]`）、`n`（`[data-t4d-shortcut="new"]` を押す。新規作成の主操作に付ける）

### 1.9 トークン（`src/app/globals.css`）

文字 `text-caption(11)・small(12)・body(13)・title-sm(14)・title(15)・title-lg(16)・figure-sm(18)・figure(20)・figure-lg(22)`（line-height なし）、色 `warning-ink・overlay・scrollbar(-hover)・focus・selected`、角丸 `rounded-t4d-sm`、影 `shadow-raised・shadow-overlay`、段組 `wide:`(1366)・`xwide:`(1600)、幅 `w-field-sm/md/lg`・`w-col-xs〜xl`、z は `z-(--z-sticky-col|sticky|pane|pane-overlay|header|overlay|modal|popover|progress|skiplink)`。`cn()` は文字サイズのトークンを知っている（`src/lib/utils.ts`）。codemod は `node scripts/codemod-tokens.mjs --dry`。

## 2. 自動検査（B はこれを通す）

| 検査                   | ファイル                                                                                                                                                | B の作業                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server Action の到達性 | `tests/unit/server-action-reachability.test.ts`                                                                                                         | F048（B2）・F121（B6）に UI を付けたら `DECISION_PENDING` から外す                                                                                                                                                                                                                                                                                       |
| ルートの到達性（静的） | `tests/unit/route-reachability.test.ts`                                                                                                                 | 新ルートはリンクを置く                                                                                                                                                                                                                                                                                                                                   |
| ROUTE_CATALOG          | `tests/unit/route-catalog.test.ts`                                                                                                                      | 新ルート 3 本（B5）は C が足す（handoff に書く）                                                                                                                                                                                                                                                                                                         |
| 業務エラーが届く       | `tests/unit/action-error-surface.test.ts`                                                                                                               | `PENDING`（B4: 出力の 2 件、B6: 通知の 2 件、C: 認証の 4 件）を包んだら外す                                                                                                                                                                                                                                                                              |
| UI の段階的上限        | `tests/unit/ui-ratchet.test.ts`＋`docs/ui-redesign/ui-ratchet-baseline.json`                                                                            | 件数を増やさない。減らしたら `pnpm exec tsx scripts/ui-metrics.ts --baseline docs/ui-redesign/ui-ratchet-baseline.json`                                                                                                                                                                                                                                  |
| 危険な操作             | `tests/unit/dangerous-ops.test.ts`＋`tests/unit/fixtures/dangerous-ops/B1〜B6.ts`                                                                       | 自分の操作を確認・元に戻すへ移したら `status: 'done'`（起点ファイルも直す）                                                                                                                                                                                                                                                                              |
| 権限ゲート             | `tests/unit/permission-gates.test.ts` の `PAGE_CASES`                                                                                                   | R1（B6）・R2（B5）・R3（B1・B2・B5）・R4（B1）を直したら `status: 'done'`                                                                                                                                                                                                                                                                                |
| 状態登録簿             | `tests/unit/status-registry.test.tsx`                                                                                                                   | 文言を直しても空・ASCII だけにしない                                                                                                                                                                                                                                                                                                                     |
| 状態で変わる操作       | `tests/unit/state-actions.test.ts`                                                                                                                      | §1.2.1 の関数の結果を画面に写す。権限の条件を変えるならサーバーの検査と一緒に変える                                                                                                                                                                                                                                                                      |
| primary 監査（E2E）    | `tests/e2e/primary-action-audit.spec.ts`＋`tests/e2e/fixtures/primary-baseline/B1〜B6.ts`                                                               | Stage A で全件を記録済み（画面の数: B1 6・B2 23・B3 4・B4 0・B5 0・B6 9。単独実行の記録に、全件実行の分を merge で足した）。基準は画面ごとの「まだ許す primary・danger のボタンの名前」（数字は #）。基準に無い画面の違反・基準の画面での新しい名前は失敗。違反が無くなった基準の画面は警告（`stale-primary-baseline` の注記）。自分のファイルを空にする |
| 到達性（E2E）          | `tests/e2e/reachability.spec.ts` の `KNOWN_FORBIDDEN_EXPORTS`（R3。レビュー担当・拠点担当・最終承認者の 10 行）・`KNOWN_MENU_DENIED`（R5 と同種。3 行） | 直したら該当行を消す。起きなくなった例外は「表から消す」で失敗する（常に通るだけの表にしない）。出力のリンクは画面の中の fetch で取る（page.request はログインの Cookie を送らず 401 になる）                                                                                                                                                            |
| skip ガード            | `tests/support/skip-guard-reporter.ts`（`playwright*.config.ts` に配線）                                                                                | 基準 `tests/e2e/fixtures/skip-baseline.json` は `{"e2e": []}`（Stage A の全件実行で、条件付きの skip は 1 件も起きなかった）。基準に無い skip が出たら実行全体を失敗にする。L2 へ移した操作は「開いてから確かめる」に直す。serial で実行されなかったテストは数えない                                                                                     |
| 機能 → E2E             | `tests/e2e/feature-coverage.ts`＋`tests/unit/feature-coverage.test.ts`                                                                                  | spec を足したら表を直す                                                                                                                                                                                                                                                                                                                                  |

E2E のヘルパー（`tests/e2e/helpers.ts`）: `openMoreMenu(scope, label?)`・`openRowActions(scope, rowLabel)`・`confirmInDialog(page, { acknowledge?, reason?, reasonLabel? })`・`hasDisclosureDemoReset(page)`・`resetDisclosureDemo(page)`（その他 → ダイアログ → チェック → 実行）。

## 3. Stage A が画面・既存テストに入れた変更（B が前提にすること）

- ホーム（B1 所有）: 先頭に `MyWork`（Attention → 自分が次に行う作業。見出しは既存と同じ「自分が次に行う作業（N 件）」、行の CTA の文言・リンク先は開示ホームの myTasks と同じ）。開示ホームの MyTasks の節は MyWork へ吸収して削除。開示デモのリセットは見出しの「その他」→ 確認ダイアログ（`src/app/enterprise/dashboard/demo-reset.tsx`。`?confirm=reset-demo` で開いて描く）。開示の閲覧権限が無い利用者の既定タブは ESG経営（開示業務タブを出さない。`?tab=disclosure` を明示すれば従来どおり権限なしの説明）
- `enterprise/actions.ts`・`assurance/actions.ts` の業務エラーを `withUserFacingError` で `?error=` に載せた（平の Error で投げていた入力の誤りは ValidationError／NotFoundError に）。`AuthorizationError` の文は「この操作には「{権限名}」の権限が必要です。{持つ役割}に依頼してください。」（`.permission` に権限キー）
- `getSelectedPeriodId` を `src/lib/auth/selected-period.ts` へ移した（'use server' から外す）
- 共通ルートのレイアウトが開示優先モード・ヘッダーのプロジェクト・役割切替を渡す。監査法人のレイアウトに役割切替（契約責任者 → マネージャー → 担当者 → 法人管理者）
- ホームに「はじめに」（`src/components/shared/getting-started.tsx`・`src/lib/ui/getting-started.ts`）。MyWork の下に 1 行の帯で、役割別の 3 手順（タスク動詞）。閉じると `t4d.getting-started.v1.<viewerKey>` に記憶。読み込むまで描かない（閉じた人に一瞬も出さない）
- `CommentBox`: 送った本文を「送信中」の行として先に出す（useOptimistic）。入力欄は保存に成功してから空にする（失敗時は残す）。送信ボタンは SubmitButton（送信中…）
- 通知: 一覧を `src/app/(common)/notifications/notification-list.tsx`（client）に分け、既読を即時反映（useOptimistic。失敗すれば再描画で未読に戻る）。日時は従来どおりサーバーで formatJst。Server Action は不変（B6 が包む）
- 「原稿を書く」の「現在のプロジェクト」: プロジェクトの画面ではパス、それ以外は選択中の報告期間のプロジェクト（無ければ先頭）。`defaultProjectId`（task-verbs.ts）を AppShell・ホームが使う
- `MoreMenu`: 確認の項目の「…」は、ラベルが既に「…」で終わっていれば重ねない（state-actions のラベル「差戻し…」用）
- error.tsx の文言は「処理を完了できませんでした」（E2E の「エラー画面に落ちない」検査の文字列を 1 対 1 で置換。e2e 7 ファイル（grant-lifecycle・import-drag-drop・new-features-audit・security-audit・ssbj-gap・ssbj-settings-approval-draft・ui-affordances）と e2e-production・e2e-supabase の各 1 ファイル）
- 既存テストの直し（すべて plan §5.3 の 3 種類のどれか）: `nav-structure.spec.ts`（グループ開閉・監査法人ツリーのテストを追加）、`zz-disclosure-project.spec.ts`・`editor-draft-restore.stateless.ts`（リセットは「その他」を開いてから）、`home-ssbj-pages.test.tsx`・`csrd-self-audit-ui.test.tsx`（リセットのダイアログを開いて同じ検査）、`self-audit-3-ui.test.tsx`（variant の改名の 1 対 1）、`disclosure-ai-draft.test.ts`・`scope3-suppliers.test.ts`（権限キーを文ではなくエラーの属性で確かめる）、`demo-role-switch.test.ts`（監査法人の並びを追加）、`vertical-slices.spec.ts` 12（監査法人ツリーの「記録」「結論」グループの開閉ボタンの名前と部分一致するため、手続の「記録」ボタンと「結論」欄を本文 `#t4d-main` に絞り exact に。同じ部品・同じ検査）、`helpers.ts` の `setDisclosureFirst`（切替の通知が出るまで待つ。待たずに次の page.goto を始めると net::ERR_ABORTED になることがあった）。全 spec の locator を、グループの開閉ボタンの名前（「{グループ} を展開する／折りたたむ」）と照合し、衝突は上の 2 か所だけだった

## 4. Stage A でやっていないこと（C または B へ）

- codemod の画素差 0 の確認（Playwright のスクリーンショット）は行っていない。代わりに Tailwind の生成する宣言の同一性を確かめた（対応表の 17 組中 16 組が同一、`bg-overlay/35` は color-mix の対応ブラウザで同一）と、`cn()` の結果の同一性を unit で固定した
- `KpiCard` の `MetricTile` 化、`DemoDataBadge`・`AiGeneratedBadge`・`ReadOnlyBadge` の `HonestyBadge` 化、既存画面の DataTable・PageActions への移行（B）
- `?tab=`（組織・拠点: units・periods・campaigns・metrics・coverage／設定: features・members・invitations・security・grants）、`/enterprise/imports?job=needs_review`、`?filter=mine|returned` の受け手は B5・B6・B1・B4 が実装する（タスク動詞・パレットはこのキーで既に指している。未対応の間は画面がそのまま開く）
- 開示優先メニューで、開くと「アクセス権限がありません」になる項目が 3 つ見つかった（`reachability.spec.ts` の `KNOWN_MENU_DENIED`）: 拠点担当の「開示プロジェクト」（B4）、レビュー担当・最終承認者の「数値を登録（標準CSV）」（B1）。メニューの permission は固定テストのため変えていない（plan Q2）。画面側で解消するか、発注者確認で決める
- skip ガードの基準は、Stage A の変更を入れた状態の全件実行で記録した（変更前の基準ではない）。条件付きの `test.skip` は 1 件も起きなかったので基準は空（`{"e2e": [], "stateless": []}`。stateless も 25 件すべて実行され skip 0）
- primary の基準は単独実行（データが初期状態）で記録し、全件実行（`PRIMARY_AUDIT_RECORD=merge pnpm test:e2e`）で出た名前を足した（例: SSBJ 草案の「この内容で確定」は草案があるときだけ出る）。データの状態でボタンが出ない画面は警告だけで失敗しない（単独実行では SSBJ 草案のレビュー担当・最終承認者の 2 画面が警告になる）

## 5. 実行結果（2026-10-07 ローカル。E2E はほかの重い処理と並走させず単独実行）

| コマンド                                                                                             | 結果                                                          |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `pnpm lint`・`pnpm format:check`・`pnpm typecheck`                                                   | 合格                                                          |
| `pnpm test`                                                                                          | 180 ファイル・2,404 件合格（変更前 155 ファイル・2,028 件）   |
| `pnpm test:rls`                                                                                      | 2 ファイル・311 件合格。`pnpm check:rls` 合格（ポリシー 240） |
| `pnpm build`                                                                                         | 合格                                                          |
| `E2E_PORT=3217 pnpm test:e2e`（全件・PRIMARY_AUDIT_RECORD=merge）                                    | **351 件すべて合格・15.1 分**（変更前 324 件）                |
| `E2E_PORT=3217 pnpm exec playwright test tests/e2e/primary-action-audit.spec.ts`（検査モード・単独） | 10 件合格（警告 2: 上の §4）                                  |
| `E2E_PORT=3219 pnpm test:e2e:stateless`                                                              | 25 件すべて合格                                               |

途中の全件実行で見つかり直したもの: SSBJ 要求事項の詳細で業務エラーが 2 回出る（FlashMessage と AppShell の補い。補いを CSS の :has と本文の文の照合で抑止）、到達性の出力リンクの検査が 401 で素通りしていた（page.request → 画面内の fetch）、メニューからの到達が本文のリンクに先を越されて検査から漏れていた、serial で実行されなかったテストを skip と数えていた。全件実行の 1 回で、承認者の画面一巡（screen-audit）が CDP の設問の詳細で React #418（hydration の不一致）を 1 度だけ出した。次の全件実行では再現せず（以前の本番スモークでも一過性の #418 の記録がある。§4 の続き: C が観察する）
