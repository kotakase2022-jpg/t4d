import Link from 'next/link';
import { CircleCheck, Clock, Upload } from 'lucide-react';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { StackedBar, StackedBarLegendChip } from '@/components/ui/stacked-bar';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { loadPeriodDataset } from '@/lib/services/enterprise-data';
import {
  computeConsolidatedAggregation,
  isCountedInTotals,
  loadConsolidatedTrend,
} from '@/lib/services/aggregation';
import { loadScope3SupplierBreakdown } from '@/lib/services/scope3-suppliers';
import { loadEnterpriseShell } from '@/lib/services/shell';

export const metadata = { title: 'GHG' };

export default async function GhgPage() {
  const shell = await loadEnterpriseShell();
  const dataset = await loadPeriodDataset(
    shell.db,
    shell.ctx,
    shell.currentPeriod,
    shell.metrics,
    shell.units,
    shell.periods,
  );

  const ghgMetrics = shell.metrics.filter((m) => m.category === 'ghg');
  const factors = await shell.db.select('emissionFactors', {
    where: { organizationId: shell.ctx.workspace.organizationId },
    orderBy: { column: 'code' },
  });

  // Scope3 Cat.1 のサプライヤー別内訳（一次データ）と提出状況
  const breakdown = await loadScope3SupplierBreakdown(shell.db, shell.ctx, shell.currentPeriod.id);
  const submittedSuppliers = breakdown.suppliers.filter((s) => s.submitted);
  const missingSuppliers = breakdown.suppliers.filter((s) => !s.submitted);
  const barSegments = [
    ...submittedSuppliers.map((s) => ({ label: s.name, value: s.total })),
    ...(breakdown.otherInputs.length > 0
      ? [
          {
            label: 'その他',
            value:
              Math.round(breakdown.otherInputs.reduce((sum, input) => sum + input.value, 0) * 10) /
              10,
          },
        ]
      : []),
  ];

  // 連結集計（DATA-P0-006）: 合計・持分調整・内部取引控除・推計。
  // 女性管理職比率は GHG と無関係なため 2026-09 の依頼でこの画面から外した
  // （加重平均の算定自体は aggregation サービスに残っている）
  const GHG_CONSOLIDATION_CODES = ['scope1', 'scope2', 'scope3_cat1'];
  const consolidation = await computeConsolidatedAggregation(
    shell.db,
    shell.ctx,
    shell.currentPeriod,
    shell.periods,
    GHG_CONSOLIDATION_CODES,
  );

  // 直近3年の推移（FY2024 以降の過年度 Fixture を含む）。
  // 比較可能性のため推計込み連結値で揃える（推計を含む年はバッジで明示）
  const trend = await loadConsolidatedTrend(
    shell.db,
    shell.ctx,
    shell.periods,
    GHG_CONSOLIDATION_CODES,
  );
  const trendMetricCodes = GHG_CONSOLIDATION_CODES.filter((code) =>
    trend.some((entry) => entry.metrics.some((m) => m.metric.code === code)),
  );

  const totals = ghgMetrics.map((metric) => {
    const rows = dataset.dataPoints.filter((dp) => dp.metricId === metric.id);
    const approved = rows.filter((dp) => dp.status === 'approved');
    return {
      metric,
      total: rows.filter(isCountedInTotals).reduce((sum, dp) => sum + (dp.value ?? 0), 0),
      approvedTotal: approved
        .filter(isCountedInTotals)
        .reduce((sum, dp) => sum + (dp.value ?? 0), 0),
      count: rows.length,
      approvedCount: approved.length,
    };
  });

  return (
    <>
      <PageHeader
        title="GHG"
        description={`${shell.currentPeriod.label} ／ Scope1・2・3 Category 1 の算定状況と算定根拠`}
        breadcrumbs={[{ label: '企業ワークスペース' }, { label: 'GHG' }]}
      />

      <div className="space-y-3 p-4">
        <Card className="overflow-hidden">
          <SectionTitle title="連結集計（合計・持分調整・内部取引控除・推計）" />
          <div className="t4d-scroll-x">
            <Table>
              <THead>
                <TR>
                  <TH>指標</TH>
                  <TH align="right">単純合計</TH>
                  <TH align="right">持分調整後</TH>
                  <TH align="right">内部取引控除</TH>
                  <TH align="right">連結値</TH>
                  <TH align="right">推計込み</TH>
                  <TH>備考</TH>
                </TR>
              </THead>
              <TBody>
                {consolidation.metrics.map((agg) => (
                  <TR key={agg.metric.id}>
                    <TD className="font-medium">
                      {agg.metric.name}
                      <span className="ml-1 text-[11px] text-ink-muted">{agg.metric.unit}</span>
                    </TD>
                    <TD align="right" className="tnum">
                      {formatNumber(agg.simpleSum)}
                    </TD>
                    <TD align="right" className="tnum">
                      {formatNumber(agg.ownershipAdjusted)}
                    </TD>
                    <TD align="right" className="tnum">
                      {agg.intercompanyEliminated > 0
                        ? `− ${formatNumber(agg.intercompanyEliminated)}`
                        : '—'}
                    </TD>
                    <TD align="right" className="tnum font-semibold">
                      {formatNumber(agg.consolidated)}
                    </TD>
                    <TD align="right" className="tnum">
                      {agg.estimates.length > 0 ? (
                        <span>
                          {formatNumber(agg.consolidatedWithEstimates)}{' '}
                          <Badge tone="warning">推計 {agg.estimates.length} 件</Badge>
                        </span>
                      ) : (
                        formatNumber(agg.consolidatedWithEstimates)
                      )}
                    </TD>
                    <TD className="text-[11px] text-ink-muted">
                      {agg.estimates.map((e) => `${e.unitName}: ${e.basis}`).join(' / ') ||
                        (agg.intercompanyEliminated > 0 ? 'グループ内取引の二重計上を控除' : '—')}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
          {consolidation.metrics[0] && consolidation.metrics[0].excludedUnits.length > 0 && (
            <p className="border-t border-line px-3 py-1.5 text-[11px] text-ink-muted">
              連結対象外:{' '}
              {consolidation.metrics[0].excludedUnits
                .map(
                  (u) =>
                    `${u.unitName}（${u.method === 'equity' ? '持分法' : '除外'}・持分 ${u.ownershipPercent}%${u.reason ? `・${u.reason}` : ''}）`,
                )
                .join(' ／ ')}
            </p>
          )}

          {/* 直近3年の変化。年度は同一色相の明→暗（古い→新しい）で塗り、
              値と前年比は必ず数値で併記する（色だけで状態を表さない） */}
          <div className="border-t border-line px-3 py-3">
            <h3 className="mb-2 text-[12px] font-semibold text-ink">
              直近3年の推移（連結値・推計込み）
            </h3>
            <div className="grid grid-cols-3 gap-4">
              {trendMetricCodes.map((code) => {
                const series = trend.flatMap((entry) => {
                  const agg = entry.metrics.find((m) => m.metric.code === code);
                  return agg ? [{ period: entry.period, agg }] : [];
                });
                const metric = series[series.length - 1]?.agg.metric;
                if (!metric) return null;
                const max = Math.max(...series.map((row) => row.agg.consolidatedWithEstimates), 1);
                const YEAR_BAR_CLASSES = ['bg-brand-300', 'bg-brand-500', 'bg-brand-700'];
                return (
                  <div key={code}>
                    <p className="mb-1 text-[12px] font-medium text-ink">
                      {metric.name}
                      <span className="ml-1 text-[11px] font-normal text-ink-muted">
                        {metric.unit}
                      </span>
                    </p>
                    <ul className="space-y-1">
                      {series.map((row, index) => {
                        const value = row.agg.consolidatedWithEstimates;
                        const prev =
                          index > 0 ? series[index - 1]?.agg.consolidatedWithEstimates : null;
                        const yoy =
                          prev && prev !== 0
                            ? Math.round(((value - prev) / prev) * 1000) / 10
                            : null;
                        return (
                          <li key={row.period.id} className="flex items-center gap-2">
                            <span className="w-14 shrink-0 font-mono text-[11px] text-ink-muted">
                              {row.period.code}
                            </span>
                            <span className="h-2.5 w-full overflow-hidden rounded-full bg-surface-muted">
                              <span
                                aria-hidden="true"
                                className={`block h-full rounded-full ${YEAR_BAR_CLASSES[index] ?? 'bg-brand-700'}`}
                                style={{ width: `${Math.max((value / max) * 100, 2)}%` }}
                              />
                            </span>
                            <span className="w-20 shrink-0 text-right text-[12px] tabular-nums text-ink">
                              {formatNumber(value)}
                            </span>
                            <span
                              className={`w-14 shrink-0 text-right text-[11px] tabular-nums ${
                                yoy === null
                                  ? 'text-ink-muted'
                                  : yoy > 0
                                    ? 'text-danger'
                                    : 'text-success'
                              }`}
                            >
                              {yoy === null ? '—' : `${yoy > 0 ? '+' : ''}${yoy}%`}
                            </span>
                            {/* バーの軌道幅を全行で揃えるため、バッジ枠は常に確保する */}
                            <span className="w-16 shrink-0">
                              {row.agg.estimates.length > 0 && (
                                <Badge tone="warning">推計込み</Badge>
                              )}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] text-ink-muted">
              バーは指標ごとの 3 年間の最大値を 100% とした相対値。前年比は排出量の増加を赤、
              減少を緑で表示（数値併記）。内部取引控除は FY2026 から適用（過年度は控除前の値）。
            </p>
          </div>
        </Card>

        <Card className="overflow-hidden">
          <SectionTitle title="Scope 別集計" />
          <Table>
            <THead>
              <TR>
                <TH>指標</TH>
                <TH>単位</TH>
                <TH align="right">全体合計</TH>
                <TH align="right">承認済み合計</TH>
                <TH align="right">対象件数</TH>
                <TH align="right">承認済み件数</TH>
              </TR>
            </THead>
            <TBody>
              {totals.map((row) => (
                <TR key={row.metric.id}>
                  <TD>
                    <Link
                      href={`/enterprise/data?q=${encodeURIComponent(row.metric.name)}`}
                      className="text-brand-700 hover:underline"
                    >
                      {row.metric.name}
                    </Link>
                  </TD>
                  <TD>{row.metric.unit}</TD>
                  <TD align="right">{formatNumber(row.total)}</TD>
                  <TD align="right">{formatNumber(row.approvedTotal)}</TD>
                  <TD align="right">{row.count}</TD>
                  <TD align="right">{row.approvedCount}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>

        <Card className="overflow-hidden">
          <SectionTitle
            title="Scope3 Category 1 サプライヤー内訳（一次データ）"
            action={
              <div className="flex items-center gap-2">
                {breakdown.dataPoint && (
                  <Link
                    href={`/enterprise/data/${breakdown.dataPoint.id}`}
                    className="text-[12px] text-brand-700 hover:underline"
                  >
                    Data Point を開く
                  </Link>
                )}
                <Button size="sm" asChild>
                  <Link href="/enterprise/ghg/suppliers">
                    <Upload aria-hidden="true" />
                    サプライヤーデータ取込
                  </Link>
                </Button>
              </div>
            }
          />

          <div className="space-y-3 px-3 pb-3">
            <div className="grid grid-cols-4 gap-2">
              <div className="space-y-1.5 rounded-t4d border border-line bg-surface-muted p-2.5">
                <p className="text-[11px] text-ink-muted">サプライヤー提出</p>
                <div className="flex items-center gap-1.5">
                  <Progress
                    value={
                      breakdown.suppliers.length === 0
                        ? 0
                        : (breakdown.submittedCount / breakdown.suppliers.length) * 100
                    }
                    tone={missingSuppliers.length === 0 ? 'success' : 'warning'}
                    label={`サプライヤー提出 ${breakdown.submittedCount} / ${breakdown.suppliers.length} 社`}
                  />
                  <span className="shrink-0 text-[13px] font-semibold tabular-nums text-ink">
                    {breakdown.submittedCount} / {breakdown.suppliers.length} 社
                  </span>
                </div>
              </div>
              <div className="space-y-1 rounded-t4d border border-line bg-surface-muted p-2.5">
                <p className="text-[11px] text-ink-muted">一次データ排出量</p>
                <p className="text-[18px] font-semibold leading-none tabular-nums text-ink">
                  {formatNumber(breakdown.primaryTotal)}
                  <span className="ml-1 text-[11px] font-normal text-ink-muted">t-CO2e</span>
                </p>
              </div>
              <div className="space-y-1 rounded-t4d border border-line bg-surface-muted p-2.5">
                <p className="text-[11px] text-ink-muted">確定値に占める一次データ比率</p>
                <p className="text-[18px] font-semibold leading-none tabular-nums text-ink">
                  {breakdown.coveragePercent === null ? '—' : `${breakdown.coveragePercent}%`}
                </p>
                <p className="text-[10px] text-ink-muted">残りは購買金額ベースの推計</p>
              </div>
              <div className="space-y-1 rounded-t4d border border-line bg-surface-muted p-2.5">
                <p className="text-[11px] text-ink-muted">未提出</p>
                <p
                  className={`text-[18px] font-semibold leading-none tabular-nums ${
                    missingSuppliers.length > 0 ? 'text-danger' : 'text-ink'
                  }`}
                >
                  {missingSuppliers.length} 社
                </p>
                {missingSuppliers.length > 0 && (
                  <Link
                    href="/enterprise/ghg/suppliers"
                    className="text-[10px] text-brand-700 hover:underline"
                  >
                    取込画面で依頼データを取り込む
                  </Link>
                )}
              </div>
            </div>

            {barSegments.length > 0 && (
              <StackedBar
                segments={barSegments}
                label="Scope3 Category 1 サプライヤー別内訳"
                unit=" t-CO2e"
              />
            )}

            <div className="t4d-scroll-x">
              <Table>
                <THead>
                  <TR>
                    <TH>サプライヤー</TH>
                    <TH>品目</TH>
                    {/* TH は uppercase が掛かるため、大小文字に意味がある単位は normal-case で守る */}
                    <TH align="right">
                      排出量<span className="normal-case">(t-CO2e)</span>
                    </TH>
                    <TH align="right">構成比</TH>
                    <TH>算定根拠（活動量 × 係数）</TH>
                    <TH>提出状況</TH>
                  </TR>
                </THead>
                <TBody>
                  {submittedSuppliers.map((supplier, index) => (
                    <TR key={supplier.unitId}>
                      <TD className="font-medium text-ink">
                        <span className="flex items-center gap-1.5">
                          <StackedBarLegendChip index={index} />
                          {supplier.name}
                          <span className="font-mono text-[11px] font-normal text-ink-muted">
                            {supplier.code}
                          </span>
                        </span>
                      </TD>
                      <TD>{supplier.inputs.map((input) => input.item).join(' ／ ')}</TD>
                      <TD align="right">{formatNumber(supplier.total)}</TD>
                      <TD align="right">
                        {supplier.sharePercent === null ? '—' : `${supplier.sharePercent}%`}
                      </TD>
                      <TD className="text-[11px] text-ink-muted">
                        {supplier.inputs.map((input) => input.note).join(' ／ ')}
                      </TD>
                      <TD>
                        <Badge tone="success">
                          <CircleCheck className="size-3" aria-hidden="true" />
                          提出済み
                        </Badge>
                      </TD>
                    </TR>
                  ))}
                  {breakdown.otherInputs.length > 0 && (
                    <TR>
                      <TD className="font-medium text-ink">
                        <span className="flex items-center gap-1.5">
                          <StackedBarLegendChip index={submittedSuppliers.length} />
                          その他
                        </span>
                      </TD>
                      <TD>{breakdown.otherInputs.map((input) => input.label).join(' ／ ')}</TD>
                      <TD align="right">
                        {formatNumber(
                          Math.round(
                            breakdown.otherInputs.reduce((sum, input) => sum + input.value, 0) * 10,
                          ) / 10,
                        )}
                      </TD>
                      <TD align="right">—</TD>
                      <TD className="text-[11px] text-ink-muted">サプライヤー未対応の内訳行</TD>
                      <TD>—</TD>
                    </TR>
                  )}
                  {missingSuppliers.map((supplier) => (
                    <TR key={supplier.unitId}>
                      <TD className="font-medium text-ink">
                        <span className="flex items-center gap-1.5">
                          {/* 未提出はバーに出ないため色チップも付けない */}
                          <span aria-hidden="true" className="inline-block size-2.5 shrink-0" />
                          {supplier.name}
                          <span className="font-mono text-[11px] font-normal text-ink-muted">
                            {supplier.code}
                          </span>
                        </span>
                      </TD>
                      <TD className="text-ink-muted">—</TD>
                      <TD align="right" className="text-ink-muted">
                        —
                      </TD>
                      <TD align="right" className="text-ink-muted">
                        —
                      </TD>
                      <TD className="text-[11px]">
                        <Link
                          href="/enterprise/ghg/suppliers"
                          className="text-brand-700 hover:underline"
                        >
                          サプライヤーデータ取込へ
                        </Link>
                      </TD>
                      <TD>
                        <Badge tone="warning">
                          <Clock className="size-3" aria-hidden="true" />
                          未提出
                        </Badge>
                      </TD>
                    </TR>
                  ))}
                  {breakdown.calculation && (
                    <TR>
                      <TD className="font-medium">一次データ合計</TD>
                      <TD />
                      <TD align="right" className="font-medium">
                        {formatNumber(breakdown.primaryTotal)}
                      </TD>
                      <TD align="right" className="font-medium">
                        100%
                      </TD>
                      <TD className="font-mono text-[11px] text-ink-muted" colSpan={2}>
                        {breakdown.calculation.formula}
                      </TD>
                    </TR>
                  )}
                </TBody>
              </Table>
            </div>

            {breakdown.calculation ? (
              <p className="text-[11px] text-ink-muted">
                算定版: 第 {breakdown.calculationCount} 版（
                {formatJst(breakdown.calculation.calculatedAt)}
                ）／ 過去の版は Data Point の詳細で確認できます。 一次データは確定値（
                {formatNumber(breakdown.dataPoint?.value ?? 0)} t-CO2e）を
                置き換えません。確定値の変更は承認フローで行います。
              </p>
            ) : (
              <p className="text-[11px] text-ink-muted">
                算定内訳がまだありません。サプライヤーデータ取込から一次データを取り込んでください。
              </p>
            )}
          </div>
        </Card>

        <Card className="overflow-hidden">
          <SectionTitle
            title={`排出係数マスター（${factors.length}）`}
            action={<Badge tone="warning">架空値（実係数ではありません）</Badge>}
          />
          <Table>
            <THead>
              <TR>
                <TH>コード</TH>
                <TH>名称</TH>
                <TH>区分</TH>
                <TH align="right">係数</TH>
                <TH>単位</TH>
                <TH align="right">係数年度</TH>
                <TH>出典</TH>
              </TR>
            </THead>
            <TBody>
              {factors.map((factor) => (
                <TR key={factor.id}>
                  <TD className="font-mono text-[11px]">{factor.code}</TD>
                  <TD>{factor.name}</TD>
                  <TD>{factor.category}</TD>
                  <TD align="right">{factor.factorValue}</TD>
                  <TD>{factor.factorUnit}</TD>
                  <TD align="right">{factor.factorYear}</TD>
                  <TD className="text-[11px] text-ink-muted">{factor.factorSource}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      </div>
    </>
  );
}
