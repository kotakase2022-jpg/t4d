import Link from 'next/link';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { MetricStrip, MetricTile } from '@/components/shared/metric-strip';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { SemanticBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { requireAssuranceContext } from '@/lib/auth/session';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import { loadEngagementOr404, loadPopulation } from '@/lib/services/assurance';
import type { PopulationItem } from '@/types/domain';
import { EngagementHeader } from '../engagement-header';

export const metadata = { title: '母集団' };

type SearchParams = Record<string, string | string[] | undefined>;

type PopulationRow = PopulationItem & { metricName: string; unitName: string };

export default async function PopulationPage({
  params,
  searchParams,
}: {
  params: Promise<{ engagementId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { engagementId } = await params;
  const query = await searchParams;
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const context = await loadEngagementOr404(db, ctx, engagementId);
  const view = await loadPopulation(db, ctx, engagementId);
  const base = `/assurance/engagements/${engagementId}`;

  if (!view) {
    return (
      <>
        <EngagementHeader context={context} page="母集団" />
        <div className="p-4">
          <EmptyState
            kind="no-data"
            title="母集団が作成されていません"
            description="Snapshot を固定すると、保証対象 Data Point から母集団が構成されます。"
            action={
              <Button variant="secondary" size="sm" asChild>
                <Link href={`${base}/data-room`}>Data Room で Snapshot を固定する</Link>
              </Button>
            }
          />
        </div>
      </>
    );
  }

  const search = typeof query.q === 'string' ? query.q.trim().toLowerCase() : '';
  const excludedFilter = typeof query.excluded === 'string' ? query.excluded : null;
  const rows = view.items
    .filter((item) =>
      excludedFilter === 'yes' ? item.excluded : excludedFilter === 'no' ? !item.excluded : true,
    )
    .filter((item) =>
      search === '' ? true : `${item.metricName} ${item.unitName}`.toLowerCase().includes(search),
    );

  const columns: DataTableColumn<PopulationRow>[] = [
    {
      key: 'metric',
      header: '指標',
      importance: 'primary',
      lockVisible: true,
      cell: (item) => <span className="font-medium">{item.metricName}</span>,
    },
    { key: 'unit', header: '組織（層）', importance: 'primary', cell: (item) => item.unitName },
    {
      key: 'value',
      header: '固定値',
      importance: 'primary',
      align: 'right',
      cell: (item) => (
        <span className="tnum">
          {formatNumber(item.value)}
          <span className="ml-1 text-caption text-ink-muted">{item.unitOfMeasure}</span>
        </span>
      ),
    },
    {
      key: 'excluded',
      header: '除外',
      importance: 'primary',
      cell: (item) => (item.excluded ? <SemanticBadge semantic="excluded" label="除外" /> : '—'),
    },
    {
      key: 'reason',
      header: '除外理由',
      importance: 'secondary',
      cell: (item) => (
        <span className="text-caption text-ink-muted">{item.exclusionReason ?? '—'}</span>
      ),
    },
  ];

  return (
    <>
      <EngagementHeader
        context={context}
        page="母集団"
        actions={
          <Button variant="secondary" size="sm" asChild>
            <Link href={`${base}/sampling`}>サンプリングへ</Link>
          </Button>
        }
      />

      <div className="space-y-3 p-4">
        <MetricStrip label="母集団の要約">
          <MetricTile label="件数" value={view.population.itemCount} unit="件" />
          <MetricTile label="合計" value={formatNumber(view.population.totalValue)} />
          <MetricTile
            label="欠損"
            value={view.population.missingCount}
            unit="件"
            status={
              view.population.missingCount > 0
                ? { semantic: 'pending', label: '企業側で未承認' }
                : { semantic: 'done', label: 'なし' }
            }
          />
          <MetricTile label="重複" value={view.population.duplicateCount} unit="件" />
          <MetricTile label="除外" value={view.population.excludedCount} unit="件" />
          <MetricTile label="版" value={`v${view.population.versionNo}`} />
        </MetricStrip>

        <Section
          id="completeness"
          title="完全性の確認"
          collapsible
          summary={`スコープ上の対象 ${view.expectedInScope} 件 ／ 母集団 ${view.population.itemCount} 件（差 ${view.population.missingCount} 件）`}
        >
          <dl className="space-y-2 text-small">
            <div>
              <dt className="font-medium text-ink">スコープ上の対象件数</dt>
              <dd className="text-ink-muted">
                {view.expectedInScope} 件（対象範囲の一覧で「対象」とした 組織 × 指標）
              </dd>
            </div>
            <div>
              <dt className="font-medium text-ink">母集団に含まれた件数</dt>
              <dd className="text-ink-muted">
                {view.population.itemCount} 件（差 {view.population.missingCount}{' '}
                件は企業側で未承認のため）
              </dd>
            </div>
            <div>
              <dt className="font-medium text-ink">照合メモ</dt>
              <dd className="text-ink-muted">{view.population.reconciliationNote ?? '—'}</dd>
            </div>
            <div>
              <dt className="font-medium text-ink">完全性手続メモ</dt>
              <dd className="whitespace-pre-wrap text-ink-muted">
                {view.population.completenessProcedureNote ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-ink">作成</dt>
              <dd className="text-ink-muted">{formatJst(view.population.createdAt)}</dd>
            </div>
          </dl>
        </Section>

        <Section title={`母集団項目（${view.items.length}）`}>
          <DataTable<PopulationRow>
            id="assurance-population"
            caption="母集団項目"
            columns={columns}
            rows={rows}
            getRowId={(item) => item.id}
            getRowLabel={(item) => `${item.metricName} ${item.unitName}`}
            searchParams={query}
            basePath={`${base}/population`}
            search={{ placeholder: '指標名・組織名で検索' }}
            filters={[
              {
                key: 'excluded',
                label: '除外',
                options: [
                  { value: 'no', label: '対象' },
                  { value: 'yes', label: '除外' },
                ],
              },
            ]}
            empty={{
              noData: {
                title: '母集団項目がありません',
                description: 'Snapshot に固定したデータから母集団が構成されます。',
                action: (
                  <Link href={`${base}/data-room`} className="text-small text-brand-700">
                    Data Room を開く
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
