import Link from 'next/link';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { formatNumber } from '@/lib/format/datetime';
import { loadPeriodDataset } from '@/lib/services/enterprise-data';
import { computeConsolidatedAggregation, isCountedInTotals } from '@/lib/services/aggregation';
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

  const scope3 = shell.metrics.find((m) => m.code === 'scope3_cat1');
  const scope3DataPoint = scope3
    ? dataset.dataPoints.find((dp) => dp.metricId === scope3.id)
    : undefined;
  const calculations = scope3DataPoint
    ? await shell.db.select('calculations', { where: { dataPointId: scope3DataPoint.id } })
    : [];

  // 連結集計（DATA-P0-006）: 合計・持分調整・内部取引控除・推計・加重平均
  const consolidation = await computeConsolidatedAggregation(
    shell.db,
    shell.ctx,
    shell.currentPeriod,
    shell.periods,
    ['scope1', 'scope2', 'scope3_cat1', 'female_manager_ratio'],
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
          <SectionTitle title="連結集計（合計・持分調整・内部取引控除・推計・加重平均）" />
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
                    {agg.metric.dataType === 'ratio' ? (
                      <>
                        <TD align="right" className="tnum">
                          {agg.simpleAverage === null ? '—' : `${agg.simpleAverage}%（単純平均）`}
                        </TD>
                        <TD align="right" className="tnum" colSpan={3}>
                          {agg.weightedAverage === null
                            ? '—'
                            : `${agg.weightedAverage}%（加重平均 = 分子合計 ÷ 分母合計）`}
                        </TD>
                        <TD align="right">—</TD>
                        <TD className="text-[11px] text-ink-muted">
                          分子: 女性管理職数 ／ 分母: 管理職数
                        </TD>
                      </>
                    ) : (
                      <>
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
                            (agg.intercompanyEliminated > 0
                              ? 'グループ内取引の二重計上を控除'
                              : '—')}
                        </TD>
                      </>
                    )}
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
            title="Scope3 Category 1 算定根拠"
            action={
              scope3DataPoint && (
                <Link
                  href={`/enterprise/data/${scope3DataPoint.id}`}
                  className="text-[12px] text-brand-700 hover:underline"
                >
                  Data Point を開く
                </Link>
              )
            }
          />
          {calculations.length === 0 ? (
            <EmptyState title="算定内訳がありません" />
          ) : (
            calculations.map((calc) => (
              <div key={calc.id} className="px-3 pb-3">
                <p className="mb-1 font-mono text-[12px] text-ink-muted">{calc.formula}</p>
                <Table>
                  <THead>
                    <TR>
                      <TH>仕入先 / 品目</TH>
                      <TH align="right">排出量</TH>
                      <TH>単位</TH>
                      <TH>算定根拠（活動量 × 係数）</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {calc.inputs.map((input, i) => (
                      <TR key={i}>
                        <TD>{input.label}</TD>
                        <TD align="right">{formatNumber(input.value)}</TD>
                        <TD>{input.unit}</TD>
                        <TD className="text-[11px] text-ink-muted">{input.note}</TD>
                      </TR>
                    ))}
                    <TR>
                      <TD className="font-medium">合計</TD>
                      <TD align="right" className="font-medium">
                        {formatNumber(calc.result)}
                      </TD>
                      <TD>{calc.resultUnit}</TD>
                      <TD />
                    </TR>
                  </TBody>
                </Table>
              </div>
            ))
          )}
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
