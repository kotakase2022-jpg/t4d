import Link from 'next/link';
import {
  Bot,
  CircleAlert,
  ClipboardList,
  Copy,
  Database,
  Download,
  FileText,
  Scale,
  Settings2,
  Target,
  UserCheck,
} from 'lucide-react';
import { carryOverSsbjAction, runSsbjGapAnalysisBulkAction } from '@/app/enterprise/actions';
import { previousComparablePeriod } from '@/lib/domain/period-comparability';
import { FractionBar } from '@/components/charts/fraction-bar';
import { FunnelSteps } from '@/components/charts/funnel-steps';
import { DataCoverageBadge } from '@/components/shared/badges';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import type { FilterGroup } from '@/components/shared/filter-bar';
import { FlashMessage } from '@/components/shared/flash';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible } from '@/components/ui/collapsible';
import { MoreInfo } from '@/components/ui/more-info';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import {
  APPLICABILITY_LABEL,
  AREA_LABEL,
  COVERAGE_LABEL,
  MATERIALITY_LABEL,
  PRIORITY_LABEL,
} from '@/lib/domain/ssbj';
import {
  CATEGORY_LABEL,
  MATERIALITY_LABEL as MATERIALITY_LEVEL_LABEL,
} from '@/lib/services/materiality';
import { loadEnterpriseShell } from '@/lib/services/shell';
import {
  filterRequirements,
  isOpenHighPriority,
  loadSsbjRequirementViews,
  loadSsbjScopeMapping,
  OPEN_HIGH_PRIORITY_QUERY,
  type SsbjRequirementView,
} from '@/lib/services/ssbj-gap';
import { DEFAULT_PAGE_SIZES, parsePage, parsePageSize } from '@/lib/table/columns';
import { mappingFunnelSteps } from '../_components/breakdown-items';

export const metadata = { title: 'SSBJ 要求事項の評価' };

const BASE_PATH = '/enterprise/disclosures/ssbj/requirements';

/** クエリを配列にする（FilterBar は同じキーを複数回付ける） */
function toList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** マッピング表のセル。●／— の形で示し、読み上げには言葉を渡す（色に頼らない） */
function MappingCell({ active }: { active: boolean }) {
  return (
    <span className={active ? 'font-semibold text-brand-700' : 'text-ink-muted'}>
      <span aria-hidden="true">{active ? '●' : '—'}</span>
      <span className="sr-only">{active ? '対象' : '対象外'}</span>
    </span>
  );
}

/**
 * SSBJ 要求事項の評価（plan §2 S19）。133 行の一覧を DataTable（25 件ずつ・検索・列の表示切替）にする。
 *
 * - 絞り込みのチップは「対応状況（最終判定）」「評価対象（適用区分）」の 2 群だけ。残りは「絞り込み ▾」
 * - 既定の列: 要求事項・適用区分・最終判定・優先度・担当部署。領域・重要性・AI による判定・紐づけは「列」から
 * - 見出しの操作は「その他」に: 未分析をまとめて分析（AI）・CSV 出力（出力の権限）・前年度の評価を引き継ぐ（F048）
 * 件数の流れ・適用中の基準・紐づけの 4 分類・「AI は候補」の 1 行は閉じない（docs/disclosure-first.md §10.4）。
 */
export default async function SsbjRequirementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();

  const loaded = await loadSsbjRequirementViews(shell.db, shell.ctx, shell.currentPeriod);
  if (!loaded) {
    return (
      <>
        <PageHeader title="SSBJ 要求事項の評価" autoBreadcrumbs />
        <div className="p-4">
          <EmptyState
            kind="not-applicable"
            title="SSBJ の要求事項マスターが登録されていません"
            description="要求事項マスターは管理者が登録します。登録されると、ここで評価を進められます。"
          />
        </div>
      </>
    );
  }

  const mapping = await loadSsbjScopeMapping(
    shell.db,
    shell.ctx,
    shell.currentPeriod,
    loaded.views,
  );
  const canWrite = can(shell.ctx, 'enterprise.disclosure.write');
  const canRunAi = can(shell.ctx, 'enterprise.ai.run');
  const canExport = can(shell.ctx, 'enterprise.export.run');

  // 前年度の評価の引継ぎ（F048）の引継ぎ元＝当期より前の、決算日が同じいちばん新しい報告期間
  // （引継ぎの Action と同じ選び方。暦年の期間を年度の前年にしない。plan K10）
  const previousPeriod =
    previousComparablePeriod(shell.currentPeriod, shell.periods, 'start') ?? undefined;

  // CSV は画面の絞り込みをそのまま引き継ぐ（見えている一覧と同じ行が出る）
  const exportParams = new URLSearchParams({ period: shell.currentPeriod.id });
  for (const key of [
    'area',
    'coverage',
    'materiality',
    'priority',
    'department',
    'linkage',
    'scope',
  ]) {
    for (const value of toList(query[key])) exportParams.append(key, value);
  }
  if (typeof query.q === 'string' && query.q !== '') exportParams.set('q', query.q);

  const filtered = filterRequirements(loaded.views, {
    area: toList(query.area),
    coverage: toList(query.coverage),
    materiality: toList(query.materiality),
    priority: toList(query.priority),
    department: toList(query.department),
    linkage: toList(query.linkage),
    scope: toList(query.scope),
    search: typeof query.q === 'string' ? query.q : undefined,
  });
  const pageSize = parsePageSize(query.size);
  const lastPage = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageNo = Math.min(parsePage(query.page), lastPage);
  const pageRows = filtered.slice((pageNo - 1) * pageSize, pageNo * pageSize);

  // 工程チップの件数は、リンク先の絞り込みと同じ関数で数える（数字とリンク先がズレない）
  const stages = [
    {
      step: '工程 1',
      title: '対象判定・重要性判断',
      icon: Scale,
      count: filterRequirements(loaded.views, { materiality: ['not_assessed'] }).length,
      countLabel: '重要性が未判定',
      query: 'materiality=not_assessed',
      description: '適用の有無と重要性を判断します。',
    },
    {
      step: '工程 2',
      title: '人工知能によるギャップ分析',
      icon: Bot,
      count: filterRequirements(loaded.views, { linkage: ['unanalyzed'] }).length,
      countLabel: '未分析',
      query: 'linkage=unanalyzed',
      description: '既存資料と突き合わせて判定の候補を作ります。',
    },
    {
      step: '工程 3',
      title: '担当者による確認',
      icon: UserCheck,
      count: filterRequirements(loaded.views, { coverage: ['unconfirmed'] }).length,
      countLabel: '確認待ち',
      query: 'coverage=unconfirmed',
      description: '候補を確認・修正して最終判定を入れます。',
    },
    {
      step: '工程 4',
      title: 'ギャップの優先順位付け',
      icon: Target,
      // 母集団は対応状況画面と同じ「評価対象・未対応」。以前は対象外を含む全件から数えており、
      // 対応状況画面（上位 8 件から数えていた）と数が食い違っていた（W0 O1）
      count: loaded.views.filter(isOpenHighPriority).length,
      countLabel: '優先度「高」（評価対象・未対応）',
      query: OPEN_HIGH_PRIORITY_QUERY,
      description: '重要性・期限・データの有無から着手順を決めます。',
    },
  ];
  const unanalyzed = stages[1]?.count ?? 0;

  // 担当部署は自由入力なので、実際に使われている値から選択肢を作る
  const departments = [
    ...new Set(loaded.views.map((v) => v.assessment.ownerDepartment).filter((d) => d !== '')),
  ].sort();

  // よく使う 2 群だけをチップに（plan §1.12-4）。残りは「絞り込み ▾」
  const filters: FilterGroup[] = [
    {
      key: 'coverage',
      label: '対応状況',
      options: [
        { value: 'covered', label: '対応済み' },
        { value: 'mostly_covered', label: 'おおむね対応' },
        { value: 'partial', label: '一部対応' },
        { value: 'not_covered', label: '未対応' },
        { value: 'unconfirmed', label: '未確認' },
      ],
    },
    {
      key: 'scope',
      label: '評価対象',
      options: [{ value: 'in_scope', label: '評価対象のみ（対象外・重要性なしを除く）' }],
    },
  ];
  const overflowFilters: FilterGroup[] = [
    {
      key: 'area',
      label: '領域',
      options: [
        { value: 'governance', label: 'ガバナンス' },
        { value: 'strategy', label: '戦略' },
        { value: 'risk', label: 'リスク管理' },
        { value: 'metrics', label: '指標及び目標' },
        { value: 'other', label: 'その他' },
      ],
    },
    {
      key: 'materiality',
      label: '重要性',
      options: [
        { value: 'material', label: '重要性あり' },
        { value: 'not_material', label: '重要性なし' },
        { value: 'not_assessed', label: '未判定' },
      ],
    },
    {
      key: 'priority',
      label: '優先度',
      options: [
        { value: 'high', label: '高' },
        { value: 'medium', label: '中' },
        { value: 'low', label: '低' },
      ],
    },
    {
      key: 'linkage',
      label: '紐づけ',
      options: [
        { value: 'document', label: '資料と紐づけ済み' },
        { value: 'data', label: 'データあり' },
        { value: 'unanalyzed', label: '未分析' },
        { value: 'none', label: '紐づけできず' },
      ],
    },
    ...(departments.length > 0
      ? [
          {
            key: 'department',
            label: '担当部署',
            options: departments.map((d) => ({ value: d, label: d })),
          },
        ]
      : []),
  ];

  const columns: DataTableColumn<SsbjRequirementView>[] = [
    {
      key: 'requirement',
      header: '要求事項',
      importance: 'primary',
      lockVisible: true,
      cell: (view) => (
        <div className="max-w-col-lg">
          <Link
            href={`${BASE_PATH}/${view.item.id}`}
            className="font-medium text-brand-700 underline-offset-2 hover:underline"
          >
            <span className="font-mono text-caption">{view.item.code}</span>{' '}
            {view.item.questionText}
          </Link>
          {view.plans.length > 0 && (
            <span className="mt-0.5 flex items-center gap-1 text-caption text-ink-muted">
              <ClipboardList className="size-3" aria-hidden="true" />
              対応計画 {view.plans.length} 件
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'area',
      header: '領域',
      importance: 'detail',
      cell: (view) => AREA_LABEL[view.area],
    },
    {
      key: 'applicability',
      header: '適用区分',
      importance: 'primary',
      cell: (view) => (
        <Badge tone={view.assessment.applicability === 'applicable' ? 'neutral' : 'outline'}>
          {APPLICABILITY_LABEL[view.assessment.applicability]}
        </Badge>
      ),
    },
    {
      key: 'materiality',
      header: '重要性',
      importance: 'detail',
      cell: (view) => (
        <Badge tone={view.assessment.materiality === 'material' ? 'brand' : 'neutral'}>
          {MATERIALITY_LABEL[view.assessment.materiality]}
        </Badge>
      ),
    },
    {
      key: 'ai',
      header: '人工知能による判定',
      importance: 'detail',
      cell: (view) =>
        view.assessment.aiStatus === null ? (
          <span className="text-caption text-ink-muted">未実施</span>
        ) : (
          <span className="flex items-center gap-1">
            <Bot className="size-3 text-ink-muted" aria-hidden="true" />
            <span className="text-small">{COVERAGE_LABEL[view.assessment.aiStatus]}</span>
          </span>
        ),
    },
    {
      key: 'linkage',
      header: '紐づけ',
      importance: 'detail',
      cell: (view) =>
        !view.analyzed ? (
          <span className="text-caption text-ink-muted">未分析</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {view.hasDocumentLink && (
              <Badge tone="neutral">
                <FileText className="size-3" aria-hidden="true" />
                資料
              </Badge>
            )}
            {/* 指標を求める要求事項は、全指標の値が揃って初めて「データあり」。
                一部だけなら不足する指標を名指しする（W0 O7。CSRD と同じ表記） */}
            {view.dataCoverage !== 'not_mapped' && (
              <DataCoverageBadge
                coverage={view.dataCoverage}
                missingNames={view.missingMetrics.map((m) => m.name)}
              />
            )}
            {!view.hasDocumentLink && view.dataCoverage === 'not_mapped' && (
              <Badge tone="warning">
                <CircleAlert className="size-3" aria-hidden="true" />
                なし
              </Badge>
            )}
          </span>
        ),
    },
    {
      key: 'final',
      header: '最終判定',
      importance: 'primary',
      cell: (view) =>
        view.assessment.finalStatus === null ? (
          <Badge tone="warning">
            <CircleAlert className="size-3" aria-hidden="true" />
            確認待ち
          </Badge>
        ) : (
          <StatusBadge domain="ssbjCoverage" value={view.assessment.finalStatus} />
        ),
    },
    {
      key: 'priority',
      header: '優先度',
      importance: 'secondary',
      cell: (view) => (
        <Badge
          tone={
            view.priority.priority === 'high'
              ? 'danger'
              : view.priority.priority === 'medium'
                ? 'warning'
                : 'neutral'
          }
        >
          {PRIORITY_LABEL[view.priority.priority]}
        </Badge>
      ),
    },
    {
      key: 'department',
      header: '担当部署',
      importance: 'secondary',
      cell: (view) => (
        <span className="text-caption">{view.assessment.ownerDepartment || '未設定'}</span>
      ),
    },
  ];

  const appliedStandards = [
    { label: '一般開示基準', applied: mapping.applied.general },
    { label: '気候関連開示基準', applied: mapping.applied.climate },
    { label: '実務対応（第1号）', applied: mapping.applied.practical },
  ];

  // 紐づけの集計対象（サービスと同じ: 適用基準の要求事項から対象外を除いたもの）
  const linkageBase = mapping.counts.afterStandards - mapping.counts.notApplicable;
  const linkageTiles = [
    {
      label: '資料と紐づけ済み',
      count: mapping.linkage.document,
      query: 'linkage=document',
      icon: FileText,
      note: '人工知能の分析で、取込資料に該当箇所が見つかった要求事項です',
    },
    {
      label: 'データあり',
      count: mapping.linkage.data,
      query: 'linkage=data',
      icon: Database,
      note: '要求する指標のすべてに当期の値が登録されている要求事項です（一部だけの項目は含めません）',
    },
    {
      label: '未分析',
      count: mapping.linkage.unanalyzed,
      query: 'linkage=unanalyzed',
      icon: Bot,
      note: '人工知能の分析を実行していない要求事項です',
    },
    {
      label: '紐づけできず',
      count: mapping.linkage.none,
      query: 'linkage=none',
      icon: CircleAlert,
      note: '分析済みだが、資料にもデータにも紐づかなかった要求事項です',
    },
  ];

  return (
    <>
      <PageHeader
        title="SSBJ 要求事項の評価"
        description={`${loaded.versionLabel} ／ ${shell.currentPeriod.label} ／ 対象判定から優先順位付けまでをこの画面で進めます`}
        autoBreadcrumbs
        actions={
          <PageActions
            more={[
              {
                // 133 項目を 1 件ずつ分析するのは現実的でないため、まとめ実行を用意する。
                // 判定はあくまで候補。最終判定は工程 3 の担当者確認で入る
                kind: 'submit',
                id: 'bulk-analyze',
                group: 'advanced',
                label: '未分析をまとめて分析（最大 20 件）',
                icon: <Bot aria-hidden="true" />,
                action: runSsbjGapAnalysisBulkAction,
                hidden: !canRunAi || unanalyzed === 0,
              },
              {
                kind: 'link',
                id: 'export-csv',
                group: 'export',
                label: 'CSV を書き出す（絞り込みを反映）',
                icon: <Download aria-hidden="true" />,
                href: `/api/exports/ssbj-requirements?${exportParams.toString()}`,
                download: true,
                hidden: !canExport,
              },
              {
                // 前年度の評価の引継ぎ（F048）。担当者が確認済みの要求事項は変えない（サービスの規則）
                kind: 'confirm',
                id: 'carry-over',
                label: '前年度の評価を引き継ぐ',
                icon: <Copy aria-hidden="true" />,
                action: carryOverSsbjAction,
                fields: { reportingPeriodId: shell.currentPeriod.id },
                hidden: !canWrite || !previousPeriod,
                confirm: {
                  tier: 'bulk',
                  title: '前年度の評価を引き継ぎますか',
                  scope: `${previousPeriod?.label ?? '前年度'} の評価を ${shell.currentPeriod.label} の要求事項へ引き継ぎます。`,
                  consequences: [
                    '適用区分・重要性・3 観点の対応状況を前年度の評価で上書きします。',
                    '今年度に担当者の確認（最終判定）が済んだ要求事項は変更しません。',
                    '基準の改正で追加・変更された要求事項や、前年度に完了していない要求事項には「再評価が必要」の印を付けます。',
                  ],
                  confirmLabel: '引き継ぐ',
                },
              },
            ]}
          />
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        {/* 旧・工程③〜⑥を 1 画面に統合。どの工程に何件残っているかを先頭で示す。
            段階の説明は下の「各工程の説明」に寄せて既定で閉じる（docs/disclosure-first.md §10.4）。
            説明側に段階名を重ねて書かない（段階名が画面に 2 回出ないように） */}
        <div className="space-y-1">
          <ul className="grid grid-cols-4 gap-2">
            {stages.map((stage) => (
              <li key={stage.title}>
                <Link
                  href={`${BASE_PATH}?${stage.query}`}
                  className="block h-full rounded-t4d-lg border border-line bg-surface p-3 shadow-raised transition-colors hover:border-brand-300 hover:bg-brand-50"
                >
                  <p className="flex items-center gap-1.5 text-caption text-ink-muted">
                    <stage.icon className="size-3.5" aria-hidden="true" />
                    {stage.step}
                  </p>
                  <p className="mt-1 text-body font-semibold text-ink">{stage.title}</p>
                  <p className="mt-1.5 text-small">
                    <span
                      className={`font-semibold tabular-nums ${stage.count > 0 ? 'text-brand-700' : 'text-ink-muted'}`}
                    >
                      {stage.countLabel} {stage.count} 件
                    </span>
                  </p>
                </Link>
              </li>
            ))}
          </ul>
          {/* 工程の説明は閉じるが、「AI は候補・確定は人」は誠実さの注記なので 1 行だけ外に見せる
              （docs/disclosure-first.md §10.4 の「閉じない」） */}
          <p className="flex items-center gap-1 text-caption text-ink-muted">
            <Bot className="size-3.5 shrink-0" aria-hidden="true" />
            人工知能の判定は候補です。最終判定は担当者が確認して入れます。
          </p>
          <MoreInfo label="各工程の説明">
            <ul className="space-y-0.5">
              {stages.map((stage) => (
                <li key={stage.title}>
                  <span className="mr-1.5 tabular-nums">{stage.step}</span>
                  {stage.description}
                </li>
              ))}
            </ul>
          </MoreInfo>
        </div>

        {/* 必要な要求項目のみが正しく表示されているか（SSBJ 要求事項とのマッピング） */}
        <Section
          title="SSBJ 要求事項とのマッピング"
          actions={
            <Button variant="secondary" size="xs" asChild>
              <Link href="/enterprise/disclosures/ssbj/settings">
                <Settings2 aria-hidden="true" />
                マテリアリティ・分析条件を変更する
              </Link>
            </Button>
          }
        >
          {/* 件数の流れ。「なぜこの件数なのか」を画面上で検算できるようにする（各段の件数は文字で書く） */}
          <div className="space-y-1 border-b border-line pb-2">
            <FunnelSteps label="要求事項の件数の流れ" steps={mappingFunnelSteps(mapping.counts)} />
            {/* 「正式基準マスター n 項目」が基準の全条項に見えないよう、収録範囲を閉じずに添える */}
            <p className="text-caption text-ink-muted">
              {loaded.coverageNote
                ? `収録範囲: ${loaded.coverageNote}。基準のすべての条項ではありません。`
                : '収録範囲が一部の場合、基準のすべての条項ではありません。'}
            </p>
            <p className="text-caption text-ink-muted">
              除外した件数: 対象外{' '}
              <span className="tabular-nums text-ink">{mapping.counts.notApplicable}</span>{' '}
              件・重要性なし{' '}
              <span className="tabular-nums text-ink">{mapping.counts.notMaterial}</span> 件
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b border-line py-2">
            <span className="text-caption text-ink-muted">適用中の基準:</span>
            {appliedStandards.map((s) => (
              <Badge key={s.label} tone={s.applied ? 'brand' : 'outline'}>
                {s.label} {s.applied ? '適用' : '適用外'}
              </Badge>
            ))}
            {!mapping.configured && (
              <Badge tone="warning">
                <CircleAlert className="size-3" aria-hidden="true" />
                分析条件が未設定のため既定（一般・気候）で表示中
              </Badge>
            )}
          </div>

          {mapping.rows.length === 0 ? (
            <EmptyState
              kind="no-data"
              title="マテリアリティが未登録です"
              description="「①マテリアリティ・分析条件の設定」で自社の重要課題を登録すると、要求事項との対応がここに表示されます。"
              action={
                <Button variant="secondary" size="sm" asChild>
                  <Link href="/enterprise/disclosures/ssbj/settings">
                    <Target aria-hidden="true" />
                    登録しに行く
                  </Link>
                </Button>
              }
            />
          ) : (
            // マテリアリティ × 基準の表と凡例は既定で閉じる（docs/disclosure-first.md §10.4。
            // 件数の流れと適用中の基準は上に見えている）。未登録の空状態は閉じない
            <Collapsible
              variant="plain"
              summary={`マテリアリティ × 基準の対応表（${mapping.rows.length} 件）`}
              className="py-1"
              bodyClassName="pl-0"
            >
              <div className="t4d-scroll-x">
                <Table>
                  <THead>
                    <TR>
                      <TH>マテリアリティ</TH>
                      <TH>区分</TH>
                      <TH>評価</TH>
                      <TH align="center">一般開示基準</TH>
                      <TH align="center">気候関連開示基準</TH>
                      <TH align="right">項目（対象指標）</TH>
                      <TH align="right">紐づく要求事項</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {mapping.rows.map((row) => (
                      <TR key={row.title}>
                        <TD className="font-medium text-ink">
                          <span className="flex items-center gap-1.5">
                            <Target className="size-3.5 text-ink-muted" aria-hidden="true" />
                            {row.title}
                          </span>
                        </TD>
                        <TD>{CATEGORY_LABEL[row.category]}</TD>
                        <TD>
                          <Badge tone={row.materiality === 'high' ? 'danger' : 'neutral'}>
                            {MATERIALITY_LEVEL_LABEL[row.materiality]}
                          </Badge>
                        </TD>
                        {/* 一般開示基準はサステナビリティ課題すべてが対象。
                            気候関連開示基準は、気候に関わる課題だけが対象になる */}
                        <TD align="center">
                          <MappingCell active={mapping.applied.general} />
                        </TD>
                        <TD align="center">
                          <MappingCell active={mapping.applied.climate && row.climate} />
                        </TD>
                        <TD align="right" className="tabular-nums">
                          {row.metricCount}
                        </TD>
                        <TD align="right" className="tabular-nums">
                          {row.linkedItemCount > 0 ? (
                            row.linkedItemCount
                          ) : (
                            <span className="text-ink-muted">0</span>
                          )}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
              <p className="pt-2 text-caption leading-relaxed text-ink-muted">
                ● = 開示対象になりやすい基準／— = 対象になりにくい基準。区分の判定は登録時と同じ規則
                （名前・内容・リスク・機会の記述に含まれる語）で行っています。「紐づく要求事項」は、
                マテリアリティの項目（対象指標）を要求する評価対象の要求事項の数です。
              </p>
            </Collapsible>
          )}
        </Section>

        {/* 必要な要求項目のうち、取込資料・データによって紐づけ可能／不可 */}
        <Section
          title="取込資料・データとの紐づけ"
          summary={
            <span className="text-caption text-ink-muted">
              対象外を除く {linkageBase} 件で集計。選ぶと一覧を絞り込みます
            </span>
          }
        >
          {/* 4 分類は重なりうる（資料とデータの両方に紐づく要求事項は両方に数える）ため、
              1 本の積み上げにせず、分類ごとに「n / 集計対象 件」の帯で示す（帯の幅が嘘にならないように） */}
          <ul className="grid grid-cols-4 gap-2 pb-1">
            {linkageTiles.map((tile) => (
              <li key={tile.label}>
                <Link
                  href={`${BASE_PATH}?${tile.query}`}
                  aria-label={`${tile.label} ${tile.count} / ${linkageBase} 件（一覧を絞り込む）`}
                  className="flex h-full items-start gap-1.5 rounded-t4d border border-line p-2.5 transition-colors hover:border-brand-300 hover:bg-brand-50"
                >
                  <tile.icon
                    className="mt-0.5 size-3.5 shrink-0 text-ink-muted"
                    aria-hidden="true"
                  />
                  <FractionBar
                    label={tile.label}
                    numerator={tile.count}
                    denominator={linkageBase}
                    className="flex-1"
                  />
                </Link>
              </li>
            ))}
          </ul>
          <MoreInfo label="紐づけの数え方" className="pb-2">
            <ul className="space-y-0.5">
              {linkageTiles.map((tile) => (
                <li key={tile.label}>
                  「{tile.label}」は、{tile.note}。
                </li>
              ))}
              <li>資料とデータの両方に紐づく要求事項は、両方に数えています。</li>
            </ul>
          </MoreInfo>
        </Section>

        <Section
          title={`要求事項（${filtered.length} 件）`}
          summary={
            <span className="text-caption text-ink-muted">
              要求事項を選ぶと、要求事項と現在の開示内容を並べて確認できます
            </span>
          }
        >
          <DataTable
            id="ssbj-requirements"
            caption="SSBJ 要求事項"
            columns={columns}
            rows={pageRows}
            getRowId={(view) => view.item.id}
            getRowLabel={(view) => view.item.code}
            searchParams={query}
            basePath={BASE_PATH}
            filters={filters}
            overflowFilters={overflowFilters}
            search={{ placeholder: '要求事項番号・見出し・担当部署で検索' }}
            savedViews={[
              {
                label: '未対応のみ',
                query: 'coverage=not_covered',
                description: '対応できていない要求事項',
              },
              {
                label: '優先度「高」（評価対象・未対応）',
                query: OPEN_HIGH_PRIORITY_QUERY,
                description: '初年度対応を優先する項目（対象外・重要性なし・対応済みを除く）',
              },
              {
                label: '確認待ち',
                query: 'coverage=unconfirmed',
                description: '担当者の確認が済んでいない項目',
              },
              {
                label: '紐づけできず',
                query: 'linkage=none',
                description: '資料にもデータにも紐づかない項目',
              },
            ]}
            userViews
            page={{
              page: pageNo,
              pageSize,
              total: filtered.length,
              sizes: DEFAULT_PAGE_SIZES,
            }}
            empty={{
              noData: {
                title: '評価する要求事項がありません',
                description: '分析条件で適用する基準を選ぶと、その基準の要求事項がここに並びます。',
                action: (
                  <Link
                    href="/enterprise/disclosures/ssbj/settings"
                    className="text-small text-brand-700 hover:underline"
                  >
                    分析条件を開く
                  </Link>
                ),
              },
              filtered: {
                title: '該当する要求事項がありません',
                description: '絞り込み条件を変更してください。',
              },
            }}
          />
        </Section>
      </div>
    </>
  );
}
