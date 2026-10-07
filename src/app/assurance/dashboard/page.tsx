import Link from 'next/link';
import { BadgeCheck } from 'lucide-react';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { MetricStrip, MetricTile } from '@/components/shared/metric-strip';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { SemanticBadge, StatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { can } from '@/lib/authorization/can';
import { formatJstDate } from '@/lib/format/datetime';
import { loadAssuranceShell } from '@/lib/services/shell';
import { assuranceHomeProfileOf } from '@/lib/ui/home-profile';
import {
  ASSURANCE_FOCUS,
  ASSURANCE_FOCUS_LABEL,
  assuranceAttention,
  assuranceWorkItems,
  engagementBase,
  matchesAssuranceFocus,
  parseAssuranceFocus,
  type AssuranceFocus,
} from '@/lib/ui/assurance-work';
import { assuranceLevelLabel } from '../_components/labels';
import { loadEngagementWorkRows, type EngagementWorkRow } from '../_components/load-work-counts';
import { AssuranceNextWork } from '@/components/shared/assurance-next-work';

export const metadata = { title: '案件ホーム' };

type SearchParams = Record<string, string | string[] | undefined>;

/** 1 案件だけが該当するときに開く画面（KPI・要対応から一覧を経ずに直行する） */
const FOCUS_PAGE: Record<AssuranceFocus, string> = {
  active: 'overview',
  pbc: 'requests?filter=open',
  tests: 'testing',
  review: 'testing',
  high_issues: 'issues?filter=high',
  changes: 'data-room',
  deadline: 'overview',
};

export default async function AssuranceDashboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const shell = await loadAssuranceShell();
  const { ctx } = shell;
  const rows = await loadEngagementWorkRows(shell.db, ctx, shell.engagements);
  const profile = assuranceHomeProfileOf(ctx);

  const focusRows = (focus: AssuranceFocus) => rows.filter((r) => matchesAssuranceFocus(focus, r));
  const focusHref = (focus: AssuranceFocus): string => {
    const hits = focusRows(focus);
    return hits.length === 1
      ? `${engagementBase(hits[0]!.engagementId)}/${FOCUS_PAGE[focus]}`
      : `/assurance/dashboard?focus=${focus}#engagements`;
  };

  const sum = (pick: (row: EngagementWorkRow) => number) =>
    rows.reduce((total, row) => total + pick(row), 0);

  // 表の絞り込み（KPI・要対応から来たとき）と検索
  const focus = parseAssuranceFocus(params.focus);
  const query = typeof params.q === 'string' ? params.q.trim().toLowerCase() : '';
  const tableRows = rows
    .filter((row) => (focus ? matchesAssuranceFocus(focus, row) : true))
    .filter((row) =>
      query === ''
        ? true
        : `${row.code} ${row.clientName} ${row.dashboard.engagement.name}`
            .toLowerCase()
            .includes(query),
    );

  const header = (
    <PageHeader
      title="案件ホーム"
      description={`${ctx.workspace.organizationName} ／ アサインされている案件のみ表示しています`}
      autoBreadcrumbs
    />
  );

  if (rows.length === 0) {
    const canManage = can(ctx, 'assurance.engagement.manage');
    return (
      <>
        {header}
        <div className="p-4">
          {canManage ? (
            <EmptyState
              kind="no-data"
              title="アサインされている案件がありません"
              description="案件を起票すると、起票した本人がチームに入り、ここに表示されます。"
              icon={<BadgeCheck className="size-5" aria-hidden="true" />}
              action={
                <Button variant="primary" size="sm" asChild>
                  <Link href="/assurance/engagements?new=1">保証契約を起票</Link>
                </Button>
              }
            />
          ) : (
            <EmptyState
              kind="not-applicable"
              title="アサインされている案件がありません"
              description="案件は契約責任者・マネージャーが起票し、チームに担当者を加えます。監査法人管理者であっても、チームに入っていない案件のクライアントデータは閲覧できません。"
              icon={<BadgeCheck className="size-5" aria-hidden="true" />}
              action={
                can(ctx, 'assurance.firm.manage') ? (
                  <Button variant="secondary" size="sm" asChild>
                    <Link href="/assurance/settings">法人メンバーを確認する</Link>
                  </Button>
                ) : undefined
              }
            />
          )}
        </div>
      </>
    );
  }

  const columns: DataTableColumn<EngagementWorkRow>[] = [
    {
      key: 'client',
      header: 'クライアント',
      importance: 'primary',
      lockVisible: true,
      pinned: 'left',
      cell: (row) => (
        <>
          <Link
            href={`${engagementBase(row.engagementId)}/overview`}
            className="font-medium text-brand-800 hover:underline"
          >
            {row.clientName}
          </Link>
          <div className="font-mono text-caption text-ink-muted">{row.code}</div>
        </>
      ),
    },
    {
      key: 'progress',
      header: '手続の進捗',
      importance: 'primary',
      width: 'sm',
      cell: (row) => (
        <div className="flex items-center gap-1.5">
          <Progress value={row.dashboard.progressPercent} label={`${row.clientName} の進捗`} />
          <span className="tnum w-8 text-right text-caption text-ink-muted">
            {row.dashboard.progressPercent}%
          </span>
        </div>
      ),
    },
    {
      key: 'issues',
      header: '重要度「高」の指摘',
      importance: 'primary',
      align: 'right',
      cell: (row) =>
        row.openHighIssues > 0 ? (
          <SemanticBadge semantic="error" label={`未解決 ${row.openHighIssues} 件`} />
        ) : (
          <span className="tnum text-ink-muted">0</span>
        ),
    },
    {
      key: 'deadline',
      header: '期限',
      importance: 'primary',
      cell: (row) => (
        <span className="whitespace-nowrap">
          {formatJstDate(row.deadlineDate)}
          {row.daysUntilDeadline !== null && (
            <span className="ml-1 text-caption text-ink-muted">
              {row.daysUntilDeadline < 0
                ? `（${-row.daysUntilDeadline} 日超過）`
                : `（あと ${row.daysUntilDeadline} 日）`}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'signoff',
      header: 'Sign-off',
      importance: 'primary',
      cell: (row) =>
        row.signoffStages.length === 0 ? (
          <span className="text-caption text-ink-muted">未着手</span>
        ) : (
          <span className="flex flex-wrap gap-0.5">
            {row.signoffStages.map((stage) => (
              <StatusBadge key={stage} domain="signoff" value={stage} />
            ))}
          </span>
        ),
    },
    {
      key: 'period',
      header: '対象期間',
      importance: 'detail',
      cell: (row) => row.dashboard.periodCode,
    },
    {
      key: 'level',
      header: '保証水準',
      importance: 'detail',
      cell: (row) => assuranceLevelLabel(row.dashboard.engagement.assuranceLevel),
    },
    {
      key: 'pbc',
      header: '未完了の資料依頼',
      importance: 'detail',
      align: 'right',
      cell: (row) => <span className="tnum">{row.pbcOpen}</span>,
    },
    {
      key: 'tests',
      header: '手続が未完了',
      importance: 'detail',
      align: 'right',
      cell: (row) => <span className="tnum">{row.testsPending}</span>,
    },
    {
      key: 'review',
      header: 'レビュー待ち',
      importance: 'detail',
      align: 'right',
      cell: (row) => <span className="tnum">{row.reviewPending}</span>,
    },
    {
      key: 'changes',
      header: 'Snapshot 後の変更',
      importance: 'detail',
      align: 'right',
      cell: (row) => <span className="tnum">{row.changesSinceSnapshot}</span>,
    },
  ];

  const pbcTotal = sum((r) => r.pbcOpen);
  const testsTotal = sum((r) => r.testsPending);
  const reviewTotal = sum((r) => r.reviewPending);
  const issuesTotal = sum((r) => r.openHighIssues);
  const changesTotal = sum((r) => r.changesSinceSnapshot);
  const upcoming = focusRows('deadline').length;

  return (
    <>
      {header}

      <div className="space-y-3 p-4">
        {/* Attention → Action（役割ごとの作業） */}
        <AssuranceNextWork
          attention={assuranceAttention(rows, (f) => `/assurance/dashboard?focus=${f}#engagements`)}
          items={assuranceWorkItems(profile, rows)}
          showWork={profile !== 'firm_admin' && profile !== 'viewer'}
        />

        {/* Status: 押すと案件と状態で絞った行き先へ（N-13） */}
        <MetricStrip label="案件の状況">
          <MetricTile
            label="進行中の案件"
            value={focusRows('active').length}
            unit="件"
            href={focusHref('active')}
          />
          <MetricTile
            label="未完了の資料依頼"
            value={pbcTotal}
            unit="件"
            status={pbcTotal > 0 ? { semantic: 'pending', label: '回答・確認待ち' } : undefined}
            href={focusHref('pbc')}
          />
          <MetricTile
            label="手続が未完了"
            value={testsTotal}
            unit="件"
            status={testsTotal > 0 ? { semantic: 'pending', label: '未着手・実施中' } : undefined}
            href={focusHref('tests')}
          />
          <MetricTile
            label="レビュー待ちの調書"
            value={reviewTotal}
            unit="件"
            href={focusHref('review')}
          />
          <MetricTile
            label="重要度「高」の指摘"
            value={issuesTotal}
            unit="件"
            status={
              issuesTotal > 0
                ? { semantic: 'error', label: '未解決（Sign-off を止めます）' }
                : { semantic: 'done', label: 'なし' }
            }
            href={focusHref('high_issues')}
          />
          <MetricTile
            label="Snapshot 後の変更"
            value={changesTotal}
            unit="件"
            status={
              changesTotal > 0
                ? { semantic: 'blocked', label: '影響の評価が必要' }
                : { semantic: 'done', label: 'なし' }
            }
            href={focusHref('changes')}
          />
          <MetricTile
            label="期限接近（60 日以内）"
            value={upcoming}
            unit="件"
            href={focusHref('deadline')}
          />
        </MetricStrip>

        <Section
          id="engagements"
          title={`案件（${rows.length}）`}
          summary={focus ? `絞り込み: ${ASSURANCE_FOCUS_LABEL[focus]}` : undefined}
        >
          <DataTable<EngagementWorkRow>
            id="assurance-engagements"
            caption="アサインされている案件"
            columns={columns}
            rows={tableRows}
            getRowId={(row) => row.engagementId}
            getRowLabel={(row) => `${row.code} ${row.clientName}`}
            searchParams={params}
            basePath="/assurance/dashboard"
            search={{ placeholder: '案件コード・クライアントで検索' }}
            filters={[
              {
                key: 'focus',
                label: '絞り込み',
                options: ASSURANCE_FOCUS.map((value) => ({
                  value,
                  label: ASSURANCE_FOCUS_LABEL[value],
                })),
              },
            ]}
            empty={{
              noData: {
                title: 'アサインされている案件がありません',
                action: (
                  <Link href="/assurance/engagements" className="text-small text-brand-700">
                    保証契約の一覧へ
                  </Link>
                ),
              },
            }}
          />
        </Section>
      </div>
    </>
  );
}
