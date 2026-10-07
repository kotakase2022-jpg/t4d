import Link from 'next/link';
import {
  ArrowLeft,
  Bot,
  CircleAlert,
  CircleDashed,
  ClipboardList,
  FileCheck2,
  Settings2,
  UserCheck,
} from 'lucide-react';
import { FunnelSteps } from '@/components/charts/funnel-steps';
import { DataCoverageBadge, ResponseStatusBadge } from '@/components/shared/badges';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import type { FilterGroup } from '@/components/shared/filter-bar';
import { FlashMessage } from '@/components/shared/flash';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { MoreInfo } from '@/components/ui/more-info';
import { can } from '@/lib/authorization/can';
import { CSRD_SECTION_LABEL } from '@/lib/domain/csrd';
import { COVERAGE_LABEL } from '@/lib/domain/ssbj';
import { formatNumber } from '@/lib/format/datetime';
import {
  filterCsrdRequirements,
  loadCsrdRequirementViews,
  type CsrdRequirementView,
} from '@/lib/services/csrd/requirements';
import { loadDisclosureWorkspace, type DisclosureQuestionRow } from '@/lib/services/disclosure';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { DEFAULT_PAGE_SIZES, parsePage, parsePageSize } from '@/lib/table/columns';
import type { SsbjCoverageStatus } from '@/types/domain';
import {
  ApplicabilityBadge,
  CoverageStatusBadge,
  PerspectiveBadges,
  PlanPriorityBadge,
  SampleMasterBadge,
} from '../_components/csrd-badges';
import { DoubleMaterialityNote } from '../settings/_components/materiality-note';
import {
  CSRD_OPEN_HIGH_PRIORITY_QUERY,
  CSRD_REQUIREMENTS_PATH,
  matchesRequirementData,
  parseRequirementDataQuery,
  parseRequirementQuery,
  searchCsrdRequirements,
  type RequirementDataFacts,
} from './form-input';

export const metadata = { title: 'CSRD 要求事項の評価' };

const BASE = '/enterprise/disclosures/csrd';

/** 一覧の 1 行: 評価（サービス）とデータ・回答の事実（ギャップ分析と同じ数え方） */
interface RequirementRow {
  view: CsrdRequirementView;
  gap: DisclosureQuestionRow | undefined;
  facts: RequirementDataFacts | undefined;
}

/** 3 観点の 1 セル（評価行が無ければ未確認）。ラベルとアイコンを併記する（色だけで表さない） */
function CoverageCell({ status }: { status: SsbjCoverageStatus }) {
  return <CoverageStatusBadge status={status} />;
}

/** 担当者の確認の状態。AI の候補の後に人が確認していなければ「確認待ち」 */
function ReviewCell({ view }: { view: CsrdRequirementView }) {
  if (view.awaitingReview) {
    return (
      <Badge tone="warning">
        <CircleAlert className="size-3" aria-hidden="true" />
        確認待ち
      </Badge>
    );
  }
  if (view.reviewState === 'human') {
    return (
      <Badge tone="success">
        <UserCheck className="size-3" aria-hidden="true" />
        確認済み
      </Badge>
    );
  }
  return (
    <Badge tone="neutral">
      <CircleDashed className="size-3" aria-hidden="true" />
      未確認
    </Badge>
  );
}

/** 当年値。異なる指標は足さず、指標ごとに並べる（Scope2 の 2 方式も別々。値の無い指標は「値なし」） */
function CurrentValueCell({ gap }: { gap: DisclosureQuestionRow | undefined }) {
  if (!gap || gap.metricValues.length === 0) {
    return <span className="text-caption text-ink-muted">—</span>;
  }
  if (gap.metricValues.length === 1) return <>{formatNumber(gap.currentValue)}</>;
  return (
    <ul className="space-y-0.5 text-caption">
      {gap.metricValues.map((v) => (
        <li key={v.metric.id} className="whitespace-nowrap">
          <span className="text-ink-muted">{v.metric.name}: </span>
          {v.currentValue === null ? (
            <span className="text-warning-ink">値なし</span>
          ) : (
            formatNumber(v.currentValue)
          )}
        </li>
      ))}
    </ul>
  );
}

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** 並べ替え（サーバー側。URL の sort・dir）。既定はマスターの順のまま */
function sortRows(
  rows: RequirementRow[],
  sort: string | undefined,
  dir: string | undefined,
): RequirementRow[] {
  const sign = dir === 'desc' ? -1 : 1;
  if (sort === 'code') {
    return [...rows].sort((a, b) => sign * a.view.item.code.localeCompare(b.view.item.code));
  }
  if (sort === 'priority') {
    // 優先度の無い（評価対象外の）要求事項は向きに関わらず最後に置く
    const rank = (row: RequirementRow) =>
      row.view.priority ? (PRIORITY_ORDER[row.view.priority.priority] ?? 3) : null;
    return [...rows].sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra === null || rb === null) return ra === null ? (rb === null ? 0 : 1) : -1;
      return sign * (ra - rb);
    });
  }
  return rows;
}

const COLUMNS: DataTableColumn<RequirementRow>[] = [
  {
    key: 'requirement',
    header: '要求事項',
    importance: 'primary',
    lockVisible: true,
    pinned: 'left',
    sortKey: 'code',
    width: 'lg',
    cell: ({ view }) => (
      <>
        <Link
          href={`${CSRD_REQUIREMENTS_PATH}/${view.item.id}`}
          className="font-medium text-brand-700 underline-offset-2 hover:underline"
        >
          <span className="font-mono text-caption">{view.item.code}</span> {view.item.questionText}
        </Link>
        {view.plans.length > 0 && (
          <span className="mt-0.5 flex items-center gap-1 text-caption text-ink-muted">
            <ClipboardList className="size-3" aria-hidden="true" />
            対応計画 {view.plans.length} 件
          </span>
        )}
      </>
    ),
  },
  {
    key: 'section',
    header: '節',
    importance: 'detail',
    cell: ({ view }) => (
      <span className="whitespace-nowrap text-caption">
        {view.section ? CSRD_SECTION_LABEL[view.section] : '判定できない'}
      </span>
    ),
  },
  {
    key: 'applicability',
    header: '適用',
    importance: 'primary',
    cell: ({ view }) => <ApplicabilityBadge applicability={view.applicability} />,
  },
  {
    key: 'perspectives',
    header: '適用になった観点',
    importance: 'detail',
    cell: ({ view }) =>
      view.applicability.kind === 'material' ? (
        <PerspectiveBadges perspectives={view.applicability.perspectives} />
      ) : (
        <span className="text-caption text-ink-muted">
          {view.applicability.kind === 'always' ? '重要性に関わらず' : '—'}
        </span>
      ),
  },
  {
    key: 'disclosure',
    header: '開示',
    importance: 'detail',
    cell: ({ view }) => (
      <CoverageCell status={view.assessment?.disclosureStatus ?? 'unconfirmed'} />
    ),
  },
  {
    key: 'dataStatus',
    header: 'データ',
    importance: 'detail',
    cell: ({ view }) => <CoverageCell status={view.assessment?.dataStatus ?? 'unconfirmed'} />,
  },
  {
    key: 'process',
    header: '業務プロセス',
    importance: 'detail',
    cell: ({ view }) => <CoverageCell status={view.assessment?.processStatus ?? 'unconfirmed'} />,
  },
  {
    key: 'combined',
    header: '総合',
    importance: 'primary',
    cell: ({ view }) => <CoverageCell status={view.combined} />,
  },
  {
    key: 'priority',
    header: '優先度',
    importance: 'secondary',
    sortKey: 'priority',
    cell: ({ view }) =>
      view.priority ? (
        <PlanPriorityBadge priority={view.priority.priority} />
      ) : (
        <span className="text-caption text-ink-muted">評価対象外</span>
      ),
  },
  {
    key: 'ai',
    header: 'AI の候補',
    importance: 'detail',
    cell: ({ view }) =>
      view.assessment?.aiStatus ? (
        <span className="flex items-center gap-1 whitespace-nowrap text-small">
          <Bot className="size-3 text-ink-muted" aria-hidden="true" />
          {COVERAGE_LABEL[view.assessment.aiStatus]}
        </span>
      ) : (
        <span className="text-caption text-ink-muted">未実施</span>
      ),
  },
  {
    key: 'review',
    header: '担当者の確認',
    importance: 'secondary',
    cell: ({ view }) => <ReviewCell view={view} />,
  },
  {
    key: 'required',
    header: '必須',
    importance: 'detail',
    cell: ({ view }) =>
      view.item.required ? (
        <Badge tone="brand">
          <FileCheck2 className="size-3" aria-hidden="true" />
          必須
        </Badge>
      ) : (
        <span className="text-caption text-ink-muted">—</span>
      ),
  },
  {
    key: 'availability',
    header: '承認済みデータ',
    importance: 'detail',
    cell: ({ gap }) =>
      !gap || gap.dataCoverage === 'not_mapped' ? (
        <span className="text-caption text-ink-muted">記述式</span>
      ) : (
        <DataCoverageBadge
          coverage={gap.dataCoverage}
          missingNames={gap.missingMetrics.map((m) => m.name)}
          noneLabel="承認済みデータなし"
        />
      ),
  },
  {
    key: 'metrics',
    header: '対応する指標',
    importance: 'detail',
    cell: ({ gap }) => (
      <span className="text-small">{gap?.mappedMetrics.map((m) => m.name).join('、') || '—'}</span>
    ),
  },
  {
    key: 'current',
    header: '当年値',
    importance: 'detail',
    align: 'right',
    cell: ({ gap }) => (
      <span className="tnum">
        <CurrentValueCell gap={gap} />
      </span>
    ),
  },
  {
    key: 'response',
    header: '回答状況',
    importance: 'detail',
    cell: ({ view, gap }) => (
      <ResponseStatusBadge
        status={gap?.response?.status ?? view.response?.status ?? 'not_started'}
      />
    ),
  },
];

/** よく使う 2 群（チップ） */
const FILTERS: FilterGroup[] = [
  {
    key: 'applicability',
    label: '適用',
    options: [
      { value: 'always', label: 'ESRS 2（常に適用）' },
      { value: 'material', label: '適用（重要）' },
      { value: 'not_material', label: '対象外' },
      { value: 'undetermined', label: '未判定' },
    ],
  },
  {
    key: 'coverage',
    label: '総合',
    options: [
      { value: 'covered', label: '対応済み' },
      { value: 'mostly_covered', label: 'おおむね対応' },
      { value: 'partial', label: '一部対応' },
      { value: 'not_covered', label: '未対応' },
      { value: 'unconfirmed', label: '未確認' },
    ],
  },
];

/** 残りの絞り込み（「絞り込み ▾」） */
const OVERFLOW_FILTERS: FilterGroup[] = [
  {
    key: 'perspective',
    label: '観点',
    options: [
      { value: 'impact', label: 'インパクト' },
      { value: 'financial', label: '財務' },
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
    key: 'review',
    label: '確認',
    options: [{ value: 'awaiting', label: '確認待ち（AI 候補あり）' }],
  },
  {
    key: 'data',
    label: '承認済みデータ',
    options: [
      { value: 'full', label: 'データあり' },
      { value: 'partial', label: '一部データあり' },
      { value: 'none', label: '承認済みデータなし' },
      { value: 'not_mapped', label: '記述式（指標なし）' },
    ],
  },
  {
    key: 'answer',
    label: '回答',
    options: [
      { value: 'answered', label: '回答あり' },
      { value: 'not_answered', label: '回答なし' },
    ],
  },
  {
    key: 'required',
    label: '必須',
    multiple: false,
    options: [{ value: '1', label: '開示が求められる項目のみ' }],
  },
];

/**
 * CSRD 要求事項の評価（docs/disclosure-first.md §9.4・plan E25）。12 行。
 * 適用は DMA（人の判断）から導出し、どの観点（インパクト・財務）で適用になったかを示す。
 * DMA が未確定の間は「暫定（DMA 確定前）」を併記する。AI ギャップ分析は詳細で 1 件ずつ（候補）。
 *
 * 一覧は DataTable（plan §1.12）: 既定の列は 要求事項・適用・総合・優先度・担当者の確認。
 * 節・観点・3 観点・AI の候補と、対応状況の画面にあったギャップ分析表の列（必須・承認済みデータ・
 * 対応する指標・当年値・回答状況）は「列 ▾」で出す（同じ母集団の表を 2 つ置かない。plan T8）。
 * チップは 適用・総合 の 2 群、残りは「絞り込み ▾」。
 *
 * 文字量を減らす（§10.4）: 件数の流れは図（FunnelSteps）、画面の使い方は「この画面について」、
 * SSBJ との違いは 1 行（未発効の注記を含む）＋閉じた全文。DMA 未確定の注記・表・架空の縮小サンプルは常に見せる。
 */
export default async function CsrdRequirementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const actions = (
    <PageActions
      secondary={[
        {
          kind: 'link',
          id: 'settings',
          label: '設定（DMA）',
          href: `${BASE}/settings`,
          icon: <Settings2 aria-hidden="true" />,
        },
        {
          kind: 'link',
          id: 'back',
          label: '対応状況へ戻る',
          href: BASE,
          icon: <ArrowLeft aria-hidden="true" />,
        },
      ]}
    />
  );

  if (!can(ctx, 'enterprise.disclosure.read') && !can(ctx, 'enterprise.disclosure.write')) {
    return (
      <>
        <PageHeader title="CSRD 要求事項の評価" autoBreadcrumbs actions={actions} />
        <PermissionDeniedState
          description="CSRD の画面は、開示の閲覧権限を持つ利用者のみ閲覧できます。"
          permission="enterprise.disclosure.read"
        />
      </>
    );
  }

  const [loaded, workspace] = await Promise.all([
    loadCsrdRequirementViews(db, ctx, shell.currentPeriod),
    loadDisclosureWorkspace(db, ctx, 'csrd', shell.currentPeriod, shell.periods, shell.metrics),
  ]);
  if (!loaded) {
    return (
      <>
        <PageHeader title="CSRD 要求事項の評価" autoBreadcrumbs actions={actions} />
        <div className="p-4">
          <EmptyState
            kind="not-applicable"
            title="ESRS 項目マスターが登録されていません"
            description="CSRD の要求事項マスター（架空の縮小サンプル）が登録されると、ここに要求事項が並びます。マスターの登録は管理者が行います。"
          />
        </div>
      </>
    );
  }

  const gapByItem = new Map((workspace?.rows ?? []).map((row) => [row.item.id, row]));
  const factsOf = (view: CsrdRequirementView): RequirementDataFacts | undefined => {
    const gap = gapByItem.get(view.item.id);
    if (!gap) return undefined;
    return {
      dataCoverage: gap.dataCoverage,
      // 対応状況の「回答済み」と同じ数え方（未着手以外で回答本文がある）
      answered: Boolean(
        gap.response && gap.response.status !== 'not_started' && gap.response.answerText,
      ),
      required: gap.item.required,
    };
  };

  const { filters, q } = parseRequirementQuery(query);
  const dataFilters = parseRequirementDataQuery(query);
  const matched: RequirementRow[] = searchCsrdRequirements(
    filterCsrdRequirements(loaded.views, filters),
    q,
  )
    .map((view) => ({ view, gap: gapByItem.get(view.item.id), facts: factsOf(view) }))
    .filter((row) => matchesRequirementData(row.facts, dataFilters));
  const sorted = sortRows(
    matched,
    typeof query.sort === 'string' ? query.sort : undefined,
    typeof query.dir === 'string' ? query.dir : undefined,
  );
  const pageSize = parsePageSize(query.size);
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = Math.min(parsePage(query.page), totalPages);
  const rows = sorted.slice((page - 1) * pageSize, page * pageSize);

  const count = (kind: CsrdRequirementView['applicability']['kind']) =>
    loaded.views.filter((v) => v.applicability.kind === kind).length;
  const inScope = count('always') + count('material');
  const provisional = loaded.views.filter((v) => v.applicability.provisional).length;

  return (
    <>
      <PageHeader
        title="CSRD 要求事項の評価"
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {loaded.versionLabel} ／ {shell.currentPeriod.label} ／ DMA で決めた適用を 3
              観点で評価
            </span>
            {loaded.isFixture && <SampleMasterBadge />}
          </span>
        }
        help={
          <>
            <p>
              ダブル・マテリアリティ評価（DMA）で決めた適用に沿って、開示・データ・業務プロセスの 3
              観点で評価します。
            </p>
            <p>
              コードを選ぶと、適用の根拠・3 観点・AI
              の候補・対応計画・回答への導線を確認できます。優先度は評価対象（常に適用・重要）だけに付けます。
            </p>
            <p>
              データの揃い具合（承認済みデータ）・対応する指標・当年値・回答状況は「列」から表示できます。
            </p>
          </>
        }
        autoBreadcrumbs
        actions={actions}
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        {!loaded.dmaConfirmed && (
          <p
            role="note"
            className="flex flex-wrap items-center gap-1.5 rounded-t4d border border-warning/40 bg-warning-soft px-3 py-1.5 text-small text-ink"
          >
            <CircleAlert className="size-3.5 text-warning-ink" aria-hidden="true" />
            ダブル・マテリアリティ評価（DMA）が未確定のため、テーマ別の要求事項の適用は暫定です（
            {provisional} / {loaded.views.length} 件）。
            <Link href={`${BASE}/settings`} className="text-brand-800 underline">
              設定で事項を判断して確定する
            </Link>
          </p>
        )}

        <DoubleMaterialityNote compact />

        {/* 件数の流れ。「なぜこの件数なのか」を画面上で検算できるようにする（段ごとの内訳は閉じた説明に） */}
        <Card className="max-w-2xl space-y-1.5 p-3">
          <FunnelSteps
            label="評価対象の件数の流れ"
            steps={[
              { label: 'サンプル（架空）マスター', count: loaded.masterTotal, unit: '項目' },
              { label: '未判定を除く', count: loaded.views.length - count('undetermined') },
              {
                label: '対象外を除く（評価対象）',
                count: inScope,
                href: `${CSRD_REQUIREMENTS_PATH}?applicability=always&applicability=material`,
              },
            ]}
          />
          <MoreInfo label="件数の内訳">
            <p>
              評価対象 {inScope} / {loaded.views.length} 件 ＝ ESRS 2（常に適用）{count('always')}{' '}
              件＋重要と判断 {count('material')} 件。対象外 {count('not_material')} 件・未判定{' '}
              {count('undetermined')} 件は評価対象から除きます。
            </p>
          </MoreInfo>
        </Card>

        <Section
          id="csrd-requirements-list"
          title={`要求事項（${matched.length} / ${loaded.views.length} 件）`}
        >
          {/* コードの行き先の説明は「この画面について」に置く（§10.4） */}
          <DataTable<RequirementRow>
            id="csrd-requirements"
            caption="CSRD 要求事項の評価"
            columns={COLUMNS}
            rows={rows}
            getRowId={(row) => row.view.item.id}
            getRowLabel={(row) => row.view.item.code}
            searchParams={query}
            basePath={CSRD_REQUIREMENTS_PATH}
            filters={FILTERS}
            overflowFilters={OVERFLOW_FILTERS}
            search={{ placeholder: '要求事項コード・見出しで検索' }}
            userViews
            savedViews={[
              {
                label: '評価対象のみ',
                query: 'applicability=always&applicability=material',
                description: '常に適用・重要と判断した事項の要求事項',
              },
              {
                label: '確認待ち',
                query: 'review=awaiting',
                description: 'AI の候補を担当者が確認していない要求事項',
              },
              {
                label: '優先度「高」（評価対象・未対応）',
                query: CSRD_OPEN_HIGH_PRIORITY_QUERY,
                description: '初年度対応を優先する項目（対応済みを除く）',
              },
              {
                label: '財務の観点で適用',
                query: 'perspective=financial',
                description: '財務的重要性で重要と判断した事項の要求事項',
              },
            ]}
            page={{ page, pageSize, total: matched.length, sizes: DEFAULT_PAGE_SIZES }}
            empty={{
              noData: {
                title: 'ESRS の要求事項がまだありません',
                description:
                  '設定でダブル・マテリアリティ評価を進めると、要求事項の適用が決まります。',
                action: (
                  <Link href={`${BASE}/settings`} className="text-small text-brand-700 underline">
                    設定（報告範囲・DMA）を開く
                  </Link>
                ),
              },
              filtered: { title: '該当する要求事項がありません' },
            }}
          />
          {/* AI は候補・確定は人、架空の縮小サンプルであることは閉じずに見せる */}
          <p className="border-t border-line px-3 py-2 text-caption leading-relaxed text-ink-muted">
            3 観点・総合は担当者が確定した値です（AI の候補は「AI
            の候補」列に分け、確定値には入れません）。収録は ESRS の架空の縮小サンプル{' '}
            {loaded.masterTotal} 項目で、正式な ESRS の全量ではありません。
          </p>
        </Section>
      </div>
    </>
  );
}
