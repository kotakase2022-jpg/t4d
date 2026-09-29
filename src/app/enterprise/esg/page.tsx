import Link from 'next/link';
import { GitCompare, Info, Target } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { cn } from '@/lib/utils';
import {
  KPI_KEYS,
  KPI_SPECS,
  loadEsgDashboard,
  loadKpiSnapshotComparison,
  type KpiSnapshotComparison,
} from '@/lib/services/kpi';
import { listOrganizationSnapshots, SNAPSHOT_KIND_DISPLAY } from '@/lib/services/report-snapshot';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { can, NotFoundError } from '@/lib/authorization/can';
import { KpiCard, signed } from './kpi-card';

export const metadata = { title: 'ESG 経営' };

/**
 * ESG 経営ダッシュボード（指示書 §6.11）。
 *
 * - 最新承認値モード: 開示業務で承認された値だけで KPI を示す（別のデータコピーを作らない）。
 * - スナップショット照合モード: 選んだレポートのスナップショットが引用した版の値と、
 *   最新承認値との差・更新理由を並べる。最新値が過去のレポートを変えたようには見せない。
 */

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function ModeTabs({
  mode,
  periodId,
  canCompareSnapshots,
}: {
  mode: 'latest' | 'snapshot';
  periodId: string;
  canCompareSnapshots: boolean;
}) {
  const tabs = [
    { key: 'latest', label: '最新承認値', href: `/enterprise/esg?period=${periodId}` },
    { key: 'snapshot', label: 'スナップショット照合', href: '/enterprise/esg?mode=snapshot' },
  ].filter((tab) => tab.key === 'latest' || canCompareSnapshots);
  return (
    <nav aria-label="表示モード" className="flex gap-1">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={mode === tab.key ? 'page' : undefined}
          className={cn(
            'rounded-t4d border px-2.5 py-1 text-[12px] font-medium',
            mode === tab.key
              ? 'border-brand-600 bg-brand-100 text-brand-900'
              : 'border-line bg-surface text-ink hover:bg-brand-50',
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

function SnapshotComparisonView({ comparison }: { comparison: KpiSnapshotComparison }) {
  const { snapshot } = comparison;
  return (
    <div className="space-y-3">
      <div
        role="note"
        className="rounded-t4d border border-brand-200 bg-brand-50 px-3 py-2 text-[12px] text-brand-900"
      >
        <p className="font-medium">
          照合中: {snapshot.projectName} ／ {snapshot.kindLabel} No.{snapshot.snapshotNo}（作成{' '}
          {formatJst(snapshot.createdAt)}・内容ハッシュ {snapshot.contentHash.slice(0, 12)}）
        </p>
        <p className="mt-0.5 text-[11px]">
          左はスナップショットに固定した版の値です。最新承認値と違う場合は、更新理由とともに並べます。最新の値が変わっても、このスナップショットと、そこから出力したレポートの値は変わりません。
        </p>
      </div>
      {KPI_KEYS.map((key) => {
        const rows = comparison.rows[key];
        return (
          <Card key={key} className="overflow-hidden">
            <CardHeader>
              <CardTitle>{KPI_SPECS[key].label}</CardTitle>
            </CardHeader>
            {rows.length === 0 ? (
              <p className="px-3 py-2 text-[12px] text-ink-muted">
                このスナップショットは、この KPI の指標を引用していません。
              </p>
            ) : (
              <div className="t4d-scroll-x">
                <Table>
                  <THead>
                    <TR>
                      <TH>指標・組織・期間</TH>
                      <TH align="right">スナップショットの値（版）</TH>
                      <TH align="right">最新承認値（版）</TH>
                      <TH align="right">差</TH>
                      <TH>更新理由</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {rows.map((row) => {
                      return (
                        <TR key={`${row.dataPointId}-${row.snapshotVersionNo}`}>
                          <TD className="text-[12px]">
                            {row.metricName}
                            <span className="block text-[11px] text-ink-muted">
                              {row.unitName}・{row.periodCode}
                            </span>
                          </TD>
                          <TD align="right" className="text-[12px]">
                            {formatNumber(row.snapshotValue)} {row.unitOfMeasure}
                            <span className="block text-[11px] text-ink-muted">
                              版 {row.snapshotVersionNo}
                            </span>
                          </TD>
                          <TD align="right" className="text-[12px]">
                            {row.latestApproved ? (
                              <>
                                {formatNumber(row.latestApproved.value)}{' '}
                                {row.latestApproved.unitOfMeasure}
                                <span className="block text-[11px] text-ink-muted">
                                  版 {row.latestApproved.versionNo}
                                </span>
                              </>
                            ) : (
                              <span className="text-ink-muted">承認済みの版なし</span>
                            )}
                          </TD>
                          <TD align="right" className="text-[12px]">
                            {!row.differs ? (
                              <span className="text-ink-muted">同じ版</span>
                            ) : row.unitMismatch ? (
                              <span className="text-ink-muted">単位が異なるため差を出しません</span>
                            ) : row.diff === null ? (
                              '—'
                            ) : row.diff === 0 ? (
                              '値は同じ（版が異なる）'
                            ) : (
                              `${signed(row.diff)} ${row.diffUnit ?? ''}`.trim()
                            )}
                          </TD>
                          <TD className="text-[12px]">
                            {row.reasons.length > 0 ? (
                              <ul className="list-disc pl-4">
                                {row.reasons.map((reason) => (
                                  <li key={reason}>{reason}</li>
                                ))}
                              </ul>
                            ) : (
                              <span className="text-ink-muted">—</span>
                            )}
                          </TD>
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

export default async function EsgPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  // スナップショット（開示プロジェクト名・版）は開示の情報。開示の閲覧権限が無い人には照合モードを出さない
  const canCompareSnapshots = can(ctx, 'enterprise.disclosure.read');
  const mode =
    one(query.mode) === 'snapshot' && canCompareSnapshots ? 'snapshot' : ('latest' as const);

  // 照合モードでは KPI の計算は要らない（スナップショットの値と最新承認値の比較だけ）
  const dashboard =
    mode === 'latest'
      ? await loadEsgDashboard(db, ctx, { periodId: one(query.period) ?? shell.currentPeriod.id })
      : null;
  const selectedPeriodId =
    dashboard?.selectedPeriod.id ?? one(query.period) ?? shell.currentPeriod.id;
  const snapshotOptions = mode === 'snapshot' ? await listOrganizationSnapshots(db, ctx) : [];
  const selectedSnapshotId = one(query.snapshot) ?? snapshotOptions[0]?.id ?? null;
  let comparison: KpiSnapshotComparison | null = null;
  let comparisonMissing = false;
  if (mode === 'snapshot' && selectedSnapshotId) {
    try {
      comparison = await loadKpiSnapshotComparison(db, ctx, selectedSnapshotId);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      comparisonMissing = true;
    }
  }

  return (
    <>
      <PageHeader
        title="ESG 経営"
        description="開示業務で承認した数値をそのまま使った KPI（KPI 用のデータの写しは作りません）"
        breadcrumbs={[{ label: '企業ワークスペース' }, { label: 'ESG 経営' }]}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/enterprise/esg/targets">
              <Target aria-hidden="true" />
              目標の登録・改訂
            </Link>
          </Button>
        }
      />

      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ModeTabs
            mode={mode}
            periodId={selectedPeriodId}
            canCompareSnapshots={canCompareSnapshots}
          />
          {dashboard ? (
            <nav aria-label="対象年度" className="flex flex-wrap items-center gap-1 text-[12px]">
              <span className="text-ink-muted">対象年度:</span>
              {[...dashboard.periods].reverse().map((period) => (
                <Link
                  key={period.id}
                  href={`/enterprise/esg?period=${period.id}`}
                  aria-current={period.id === dashboard.selectedPeriod.id ? 'page' : undefined}
                  className={cn(
                    'rounded-t4d border px-2 py-0.5',
                    period.id === dashboard.selectedPeriod.id
                      ? 'border-brand-600 bg-brand-100 text-brand-900'
                      : 'border-line bg-surface hover:bg-brand-50',
                  )}
                >
                  {period.code}
                </Link>
              ))}
            </nav>
          ) : (
            <form method="get" action="/enterprise/esg" className="flex items-center gap-1.5">
              <input type="hidden" name="mode" value="snapshot" />
              <label className="flex items-center gap-1 text-[12px] text-ink-muted">
                照合するスナップショット
                <select
                  name="snapshot"
                  defaultValue={selectedSnapshotId ?? ''}
                  className="h-7 max-w-[420px] rounded-t4d border border-line bg-surface px-2 text-[12px] text-ink"
                >
                  {snapshotOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {`${option.projectName} ／ ${SNAPSHOT_KIND_DISPLAY[option.snapshotKind]} No.${option.snapshotNo}（${formatJst(option.createdAt)}）`}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                type="submit"
                size="sm"
                variant="outline"
                disabled={snapshotOptions.length === 0}
              >
                <GitCompare aria-hidden="true" />
                照合する
              </Button>
            </form>
          )}
        </div>

        {dashboard ? (
          <>
            <p className="flex items-start gap-1.5 rounded-t4d border border-line bg-surface px-3 py-2 text-[12px] text-ink-muted">
              <Info className="mt-0.5 size-3.5 shrink-0 text-brand-600" aria-hidden="true" />
              実績は、対象の全拠点が承認済みの最新年度の値です（GHG
              画面と同じ連結値）。未承認の値・承認後の訂正で未承認の値は含めず、集計中の年度は承認済み分の途中集計として別に示します。進捗率・前年差は、目標・前年と範囲や算定方法が同じときだけ計算します。
            </p>
            <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
              {dashboard.cards.map((card) => (
                <KpiCard
                  key={card.spec.key}
                  card={card}
                  detailHref={`/enterprise/esg/${card.spec.key}?period=${dashboard.selectedPeriod.id}`}
                />
              ))}
            </div>
          </>
        ) : snapshotOptions.length === 0 ? (
          <p className="rounded-t4d border border-line bg-surface px-3 py-4 text-[12px] text-ink-muted">
            照合できるスナップショットがありません。開示プロジェクトの「出力」タブでレビュー用草稿または社内承認済み版を作成してください。
          </p>
        ) : comparisonMissing || !comparison ? (
          <p
            role="alert"
            className="rounded-t4d border border-warning/40 bg-warning-soft px-3 py-2 text-[12px] text-ink"
          >
            選んだスナップショットが見つかりません（デモではスナップショットがサーバーのメモリにだけ保持されるため、消えている場合があります）。
          </p>
        ) : (
          <SnapshotComparisonView comparison={comparison} />
        )}
      </div>
    </>
  );
}
