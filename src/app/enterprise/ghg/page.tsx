import Link from 'next/link';
import {
  ArrowRight,
  Calculator,
  CircleAlert,
  CircleCheck,
  Clock,
  Scale,
  Upload,
} from 'lucide-react';
import { FractionBar } from '@/components/charts/fraction-bar';
import {
  AggregationIncompleteBadge,
  AvailabilityBadge,
  ValueKindBadge,
} from '@/components/shared/badges';
import { AttentionStrip } from '@/components/shared/attention-strip';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { Badge } from '@/components/ui/badge';
import { Collapsible } from '@/components/ui/collapsible';
import { MoreInfo } from '@/components/ui/more-info';
import { StackedBar, StackedBarLegendChip } from '@/components/ui/stacked-bar';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { formatJst, formatNumber } from '@/lib/format/datetime';
import { loadPeriodDataset } from '@/lib/services/enterprise-data';
import {
  computeConsolidatedAggregation,
  consolidatedTrendSeries,
  loadConsolidatedTrend,
  SCOPE3_CATEGORY_CODES,
  SCOPE3_TOTAL_CODE,
  summarizeMetricTotals,
  summarizeScope3,
  type MetricTotals,
} from '@/lib/services/aggregation';
import {
  CALCULATION_DATA_CLASS_LABELS,
  loadScope3SupplierBreakdown,
  PRIMARY_DATA_RATIO_DEFINITION,
} from '@/lib/services/scope3-suppliers';
import { loadEnterpriseShell } from '@/lib/services/shell';
import type { AvailabilityStatus, CalculationDataClass } from '@/types/domain';
import { GhgTrendMetric } from './_components/ghg-trend';
import { Scope3CategoryGrid } from './_components/scope3-category-grid';

export const metadata = { title: 'GHG' };

/*
 * 並び（plan §1.14・§2.26 E14）: 注意（Scope3 の未登録カテゴリー・照合の要確認・未提出のサプライヤー）→
 * 連結集計と推移 → Scope 別 → Scope3 → Cat.1 の算定根拠。主操作「サプライヤーデータ取込」は見出しに 1 つ。
 * 排出係数マスターはサプライヤーデータ取込の画面を正とし、ここからはリンクで行く（同じ表を 2 か所に置かない。T8）。
 *
 * 文字を減らすため（docs/disclosure-first.md §10.4）: 脚注・照合の扱い・算定版の注記は既定で閉じる。
 * 連結集計表・推移（見出しと数値・前年比）・Cat.1 の見出しとサプライヤー表・一次データ比率の定義・
 * 架空値のバッジ・空状態は閉じない。推移は小さな折れ線、Scope3 は 15 カテゴリーの格子（表は閉じる）、
 * 内訳合計の区分は積み上げ帯で示す。
 */

/** 値の無い行の状態のうち、画面に出すもの（人が判断した状態を未入力より優先） */
function absentStateOf(totals: MetricTotals): AvailabilityStatus {
  const order: AvailabilityStatus[] = [
    'not_applicable',
    'not_calculated',
    'not_obtained',
    'not_entered',
  ];
  return order.find((state) => (totals.absentByStatus[state] ?? 0) > 0) ?? 'not_entered';
}

const DATA_CLASS_ORDER: CalculationDataClass[] = [
  'supplier_specific',
  'activity_based',
  'spend_based',
];

export default async function GhgPage() {
  const shell = await loadEnterpriseShell();
  const canImport = can(shell.ctx, 'enterprise.import.run');
  const dataset = await loadPeriodDataset(
    shell.db,
    shell.ctx,
    shell.currentPeriod,
    shell.metrics,
    shell.units,
    shell.periods,
  );

  const ghgMetrics = shell.metrics.filter((m) => m.category === 'ghg');

  // Scope3 Cat.1 のサプライヤー別内訳（区分: 固有排出量・活動量×係数・金額×係数）と提出状況
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
  // （加重平均の算定自体は aggregation サービスに残っている）。
  // Scope2 はロケーション基準とマーケット基準を別の行にし、決して足さない（§7.2 / A08）
  const GHG_CONSOLIDATION_CODES = ['scope1', 'scope2', 'scope2_location', 'scope3_cat1'];
  const consolidation = await computeConsolidatedAggregation(
    shell.db,
    shell.ctx,
    shell.currentPeriod,
    shell.periods,
    GHG_CONSOLIDATION_CODES,
  );

  // 直近3年の推移（FY2024 以降の過年度 Fixture を含む）。
  // 比較可能性のため推計込み連結値で揃える（推計を含む年はバッジで明示）。
  // 値の無い指標（未入力）は 0 のバーを描かず、推移から外す
  const trend = await loadConsolidatedTrend(
    shell.db,
    shell.ctx,
    shell.periods,
    GHG_CONSOLIDATION_CODES,
  );
  const trendMetricCodes = GHG_CONSOLIDATION_CODES.filter((code) =>
    trend.some((entry) =>
      entry.metrics.some(
        (m) => m.metric.code === code && (m.consolidatedValueCount > 0 || m.estimates.length > 0),
      ),
    ),
  );

  // Scope 別集計: 未入力・対象外の行を 0 として足さない（W0 O4）
  const totals = ghgMetrics.map((metric) => ({
    metric,
    ...summarizeMetricTotals(dataset.dataPoints.filter((dp) => dp.metricId === metric.id)),
  }));
  // Scope3 のカテゴリー 1〜15 と合計の状況（A09・A10）
  const scope3 = summarizeScope3(shell.metrics, dataset.dataPoints);
  const scope3CodeSet = new Set<string>([...SCOPE3_CATEGORY_CODES, SCOPE3_TOTAL_CODE]);
  const scope3PendingLabels = scope3.categories
    .filter((c) => c.state !== 'value_present' && c.state !== 'not_applicable')
    .map((c) => `Cat.${c.category}`);

  // 内訳合計の区分別（金額×係数＝推計を一次データと混ぜない。W0 O6）。区分不明は値があるときだけ
  const classSegments = [
    ...DATA_CLASS_ORDER.map((key) => ({
      label: CALCULATION_DATA_CLASS_LABELS[key],
      value: breakdown.totalsByClass[key],
    })),
    ...(breakdown.totalsByClass.unclassified > 0
      ? [{ label: '区分不明（旧形式）', value: breakdown.totalsByClass.unclassified }]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="GHG"
        description={`${shell.currentPeriod.label} ／ Scope1・2・3 の算定状況と算定根拠`}
        help={
          <>
            <p>
              Scope2 はロケーション基準とマーケット基準の 2
              方式を別の行で示し、両者を足した値は出しません。
            </p>
            <p>
              Scope3 はカテゴリー 1〜15 の登録状況を示します。カテゴリー 1 の値を Scope3
              全体として扱いません。
            </p>
          </>
        }
        autoBreadcrumbs
        actions={
          <PageActions
            primary={{
              kind: 'link',
              id: 'supplier-import',
              label: 'サプライヤーデータ取込',
              icon: <Upload aria-hidden="true" />,
              href: '/enterprise/ghg/suppliers',
              // 取込の権限が無い役割には主操作にしない（提出状況を見るリンクだけにする）
              hidden: !canImport,
            }}
            secondary={[
              {
                kind: 'link',
                id: 'supplier-status',
                label: 'サプライヤーの提出状況',
                href: '/enterprise/ghg/suppliers',
                hidden: canImport,
              },
            ]}
          />
        }
      />

      <div className="space-y-3 p-4">
        <AttentionStrip
          items={[
            {
              key: 'scope3-pending',
              label: 'Scope3 の未登録カテゴリー',
              count: scope3.pendingCount,
              href: '#ghg-scope3',
              semantic: 'pending',
            },
            {
              key: 'scope3-reconciliation',
              label: 'Scope3 合計とカテゴリー計の照合が要確認',
              count: scope3.reconciliation && !scope3.reconciliation.withinTolerance ? 1 : 0,
              href: '#ghg-scope3',
              semantic: 'blocked',
            },
            {
              key: 'missing-suppliers',
              label: '未提出のサプライヤー（Cat.1）',
              count: missingSuppliers.length,
              href: '/enterprise/ghg/suppliers',
              semantic: 'pending',
            },
          ]}
        />

        <Section title="連結集計（合計・持分調整・内部取引控除・推計）" divider="none">
          <div className="t4d-scroll-x rounded-t4d border border-line bg-surface">
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
                {consolidation.metrics.map((agg) => {
                  // 承認済みの値が 1 件も無い指標は 0 ではなく「未入力」と出す（W0 O4）
                  const noValue = agg.valueCount === 0;
                  // 持分法・連結対象外の拠点にしか値が無ければ、連結値は 0 ではなく「未入力」
                  const noConsolidated = agg.consolidatedValueCount === 0;
                  return (
                    <TR key={agg.metric.id}>
                      <TD className="font-medium">
                        {agg.metric.name}
                        <span className="ml-1 text-caption text-ink-muted">{agg.metric.unit}</span>
                      </TD>
                      <TD align="right" className="tnum">
                        {noValue ? '—' : formatNumber(agg.simpleSum)}
                      </TD>
                      <TD align="right" className="tnum">
                        {noConsolidated ? '—' : formatNumber(agg.ownershipAdjusted)}
                      </TD>
                      <TD align="right" className="tnum">
                        {agg.intercompanyEliminated > 0
                          ? `− ${formatNumber(agg.intercompanyEliminated)}`
                          : '—'}
                      </TD>
                      <TD align="right" className="tnum font-semibold">
                        {noConsolidated ? (
                          <AvailabilityBadge status="not_entered" />
                        ) : (
                          formatNumber(agg.consolidated)
                        )}
                      </TD>
                      <TD align="right" className="tnum">
                        {agg.estimates.length > 0 ? (
                          <span>
                            {formatNumber(agg.consolidatedWithEstimates)}{' '}
                            <Badge tone="warning">
                              <Calculator className="size-3" aria-hidden="true" />
                              推計 {agg.estimates.length} 件
                            </Badge>
                          </span>
                        ) : noConsolidated ? (
                          '—'
                        ) : (
                          formatNumber(agg.consolidatedWithEstimates)
                        )}
                      </TD>
                      <TD className="text-caption text-ink-muted">
                        {agg.estimates.map((e) => `${e.unitName}: ${e.basis}`).join(' / ') ||
                          (agg.intercompanyEliminated > 0
                            ? 'グループ内取引の二重計上を控除'
                            : noValue
                              ? '承認済みの値がありません（0 ではありません）'
                              : noConsolidated
                                ? '連結対象の拠点に承認済みの値がありません（持分法・連結対象外の拠点の値は連結値に含めません）'
                                : '—')}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>
          <div className="py-1.5">
            <MoreInfo label="連結集計の注記（Scope2 の 2 方式・推計・連結対象外）">
              <p>
                Scope2
                はロケーション基準とマーケット基準を別の行で示し、両者を足した値は出しません。
                推計は実績と分けて「推計込み」の列にだけ加えます。
              </p>
              {consolidation.metrics[0] && consolidation.metrics[0].excludedUnits.length > 0 && (
                <p>
                  連結対象外:{' '}
                  {consolidation.metrics[0].excludedUnits
                    .map(
                      (u) =>
                        `${u.unitName}（${u.method === 'equity' ? '持分法' : '除外'}・持分 ${u.ownershipPercent}%${u.reason ? `・${u.reason}` : ''}）`,
                    )
                    .join(' ／ ')}
                </p>
              )}
            </MoreInfo>
          </div>

          {/* 直近3年の変化。指標ごとの小さな折れ線（値の無い年は線を切る）に、数値と前年比を文字で添える
              （色だけで状態を表さない・増減の良し悪しを赤緑で示さない） */}
          <div className="space-y-2 pt-1">
            <h3 className="text-small font-semibold text-ink">直近3年の推移（連結値・推計込み）</h3>
            <div className="grid gap-4 md:grid-cols-2">
              {trendMetricCodes.map((code) => (
                <GhgTrendMetric key={code} series={consolidatedTrendSeries(trend, code)} />
              ))}
            </div>
            {/* 控除の有無が年度で違うことは見えている前年比の読み方を変えるため、1 行は閉じない */}
            <p className="text-caption text-ink-muted">
              内部取引控除は FY2026 から適用（過年度は控除前の値）。
            </p>
            <MoreInfo label="推移の見方">
              <p>
                値は連結値（推計込み）です。値の無い年度は線を切り「未入力」と書きます（0
                として描きません）。
              </p>
              <p>前年比は矢印と符号で示し、増減の良し悪しを色で示しません。</p>
            </MoreInfo>
          </div>
        </Section>

        <Section title="Scope 別集計">
          <div className="t4d-scroll-x rounded-t4d border border-line bg-surface">
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
                {totals
                  .filter((row) => !scope3CodeSet.has(row.metric.code))
                  .map((row) => (
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
                      <TD align="right">
                        {/* 値の行が無い指標は 0 ではなく状態を出す（実績ゼロと未入力を区別） */}
                        {row.metric.aggregationMethod !== 'sum' && row.total !== null ? (
                          <span className="text-caption text-ink-muted">合計しない指標</span>
                        ) : row.total === null ? (
                          <AvailabilityBadge status={absentStateOf(row)} />
                        ) : (
                          formatNumber(row.total)
                        )}
                        {row.estimateTotal !== null && (
                          <span className="ml-1 inline-flex items-center gap-1 text-caption">
                            <ValueKindBadge kind="estimate" />
                            {formatNumber(row.estimateTotal)}
                          </span>
                        )}
                      </TD>
                      <TD align="right">
                        {row.metric.aggregationMethod !== 'sum'
                          ? '—'
                          : formatNumber(row.approvedTotal)}
                      </TD>
                      <TD align="right">{row.count}</TD>
                      <TD align="right">{row.approvedCount}</TD>
                    </TR>
                  ))}
              </TBody>
            </Table>
          </div>
          <div className="py-1.5">
            <MoreInfo label="「未入力」と合算の扱い">
              <p>
                「未入力」は Data Point
                が無い（又は値が入っていない）指標で、排出ゼロではありません。 Scope2 の 2
                方式は別の指標として並べ、合算しません。Scope3 は下のカテゴリー別の状況で示します。
              </p>
            </MoreInfo>
          </div>
        </Section>

        {/* Scope3: カテゴリー 1〜15 の状況。Cat.1 だけが登録された状態を Scope3 全体として見せない（A09）。
            合計とカテゴリーが両方あるときは照合するだけで、足さない（A10） */}
        <Section
          id="ghg-scope3"
          title="Scope3 カテゴリー別の状況（1〜15）"
          summary={`値あり ${scope3.presentCount} ／ 対象外 ${scope3.notApplicableCount} ／ 未登録 ${scope3.pendingCount}（全 15 カテゴリー）`}
        >
          <div className="flex flex-wrap items-center gap-2 border-b border-line py-2 text-small">
            <span className="font-medium text-ink">Scope3 合計</span>
            {scope3.total.value !== null ? (
              <span className="tnum font-semibold text-ink">
                {formatNumber(scope3.total.value)}
                <span className="ml-1 text-caption font-normal text-ink-muted">t-CO2e</span>
              </span>
            ) : scope3.completeness === 'complete' ? (
              <AvailabilityBadge status="not_entered" />
            ) : (
              <AggregationIncompleteBadge
                detail={`未登録のカテゴリー: ${scope3PendingLabels.join('・')}`}
              />
            )}
            {scope3.completeness !== 'complete' && (
              <span className="text-caption text-ink-muted">
                未登録のカテゴリーがあるため、Scope3 全体は確定していません。カテゴリー 1 の値を
                Scope3 全体として扱いません。
              </span>
            )}
          </div>
          {scope3.reconciliation && (
            <div className="flex flex-wrap items-center gap-2 border-b border-line py-2 text-small">
              <Scale className="size-3.5 text-ink-muted" aria-hidden="true" />
              <span className="text-ink">
                照合: 合計 {formatNumber(scope3.total.value)} − カテゴリー計{' '}
                {formatNumber(scope3.reconciliation.categorySum)} = 差{' '}
                <span className="tnum font-semibold">
                  {formatNumber(scope3.reconciliation.difference)}
                </span>{' '}
                t-CO2e
              </span>
              {scope3.reconciliation.withinTolerance ? (
                <Badge tone="success">
                  <CircleCheck className="size-3" aria-hidden="true" />
                  丸め差の範囲内
                </Badge>
              ) : (
                <Badge tone="warning">
                  <CircleAlert className="size-3" aria-hidden="true" />
                  要確認（許容 ±{formatNumber(scope3.reconciliation.tolerance)}）
                </Badge>
              )}
              <MoreInfo label="照合の扱い">
                <p>合計とカテゴリーは照合用で、足し合わせません（二重計上の防止）。</p>
              </MoreInfo>
            </div>
          )}
          <div className="space-y-2 py-2.5">
            <Scope3CategoryGrid categories={scope3.categories} />
            <Collapsible
              variant="plain"
              summary={`カテゴリーごとの値と理由の表（${scope3.categories.length} 行）`}
            >
              <div className="t4d-scroll-x">
                <Table>
                  <THead>
                    <TR>
                      <TH>カテゴリー</TH>
                      <TH>状態</TH>
                      <TH align="right">
                        全体合計<span className="normal-case">(t-CO2e)</span>
                      </TH>
                      <TH>理由・備考</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {scope3.categories.map((category) => (
                      <TR key={category.code}>
                        <TD className="text-small">
                          {category.metric ? (
                            <Link
                              href={`/enterprise/data?q=${encodeURIComponent(category.metric.name)}`}
                              className="text-brand-700 hover:underline"
                            >
                              {category.metric.name}
                            </Link>
                          ) : (
                            `Category ${category.category}`
                          )}
                        </TD>
                        <TD>
                          <AvailabilityBadge status={category.state} />
                        </TD>
                        <TD align="right" className="tnum">
                          {category.total === null ? '—' : formatNumber(category.total)}
                          {category.estimateTotal !== null && (
                            <span className="ml-1 inline-flex items-center gap-1 text-caption">
                              <ValueKindBadge kind="estimate" />
                              {formatNumber(category.estimateTotal)}
                            </span>
                          )}
                        </TD>
                        <TD className="text-caption text-ink-muted">
                          {category.reasons.join(' ／ ') ||
                            (category.state === 'not_entered' ? 'Data Point がありません' : '—')}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            </Collapsible>
          </div>
        </Section>

        <Section
          title="Scope3 Category 1 サプライヤー内訳（算定根拠）"
          actions={
            breakdown.dataPoint ? (
              <Link
                href={`/enterprise/data/${breakdown.dataPoint.id}`}
                className="text-small text-brand-700 hover:underline"
              >
                Data Point を開く
              </Link>
            ) : undefined
          }
        >
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1.5 rounded-t4d border border-line bg-surface-muted p-2.5">
                <FractionBar
                  label="サプライヤー提出"
                  numerator={breakdown.submittedCount}
                  denominator={breakdown.suppliers.length}
                  unit="社"
                />
                <p className="flex flex-wrap items-center gap-x-2 text-caption text-ink">
                  <span>
                    未提出 <span className="tabular-nums">{missingSuppliers.length}</span> 社
                  </span>
                  {missingSuppliers.length > 0 && (
                    <Link
                      href="/enterprise/ghg/suppliers"
                      className="inline-flex items-center gap-0.5 text-brand-700 hover:underline"
                    >
                      取込画面で依頼データを取り込む
                      <ArrowRight className="size-3" aria-hidden="true" />
                    </Link>
                  )}
                </p>
              </div>
              <div className="space-y-1.5 rounded-t4d border border-line bg-surface-muted p-2.5">
                <p className="text-caption text-ink-muted">内訳合計（区分を問わない）</p>
                <p className="text-figure-sm font-semibold leading-none tabular-nums text-ink">
                  {formatNumber(breakdown.breakdownTotal)}
                  <span className="ml-1 text-caption font-normal text-ink-muted">t-CO2e</span>
                </p>
                {/* 金額×係数（推計）を一次データと混ぜない（W0 O6）。区分の帯は凡例と同じ内容 */}
                <StackedBar segments={classSegments} label="内訳合計の区分別" unit=" t-CO2e" />
                <ul
                  aria-label="内訳合計の区分別"
                  className="space-y-0.5 text-caption text-ink-muted"
                >
                  {classSegments.map((segment, index) => (
                    <li key={segment.label} className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1">
                        <StackedBarLegendChip index={index} />
                        {segment.label}
                      </span>
                      <span className="tabular-nums">{formatNumber(segment.value)}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="space-y-1 rounded-t4d border border-line bg-surface-muted p-2.5">
                <p className="text-caption text-ink-muted">
                  確定値に占める一次データ比率（固有＋活動量ベース）
                </p>
                <p className="text-figure-sm font-semibold leading-none tabular-nums text-ink">
                  {breakdown.primaryDataPercent === null ? '—' : `${breakdown.primaryDataPercent}%`}
                </p>
                <p className="text-caption text-ink-muted">{PRIMARY_DATA_RATIO_DEFINITION}</p>
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
                    <TH>区分・算定根拠</TH>
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
                          <span className="font-mono text-caption font-normal text-ink-muted">
                            {supplier.code}
                          </span>
                        </span>
                      </TD>
                      <TD>{supplier.inputs.map((input) => input.item).join(' ／ ')}</TD>
                      <TD align="right">{formatNumber(supplier.total)}</TD>
                      <TD align="right">
                        {supplier.sharePercent === null ? '—' : `${supplier.sharePercent}%`}
                      </TD>
                      <TD className="text-caption text-ink-muted">
                        {supplier.inputs
                          .map(
                            (input) =>
                              `${input.dataClass ? `［${CALCULATION_DATA_CLASS_LABELS[input.dataClass]}］` : ''}${input.note ?? ''}`,
                          )
                          .join(' ／ ')}
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
                      <TD className="text-caption text-ink-muted">サプライヤー未対応の内訳行</TD>
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
                          <span className="font-mono text-caption font-normal text-ink-muted">
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
                      <TD className="text-caption">
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
                      <TD className="font-medium">内訳合計</TD>
                      <TD />
                      <TD align="right" className="font-medium">
                        {formatNumber(breakdown.breakdownTotal)}
                      </TD>
                      <TD align="right" className="font-medium">
                        100%
                      </TD>
                      <TD className="font-mono text-caption text-ink-muted" colSpan={2}>
                        {breakdown.calculation.formula}
                      </TD>
                    </TR>
                  )}
                </TBody>
              </Table>
            </div>

            {breakdown.calculation ? (
              <MoreInfo label={`算定版（第 ${breakdown.calculationCount} 版）と確定値の関係`}>
                <p>
                  算定版: 第 {breakdown.calculationCount} 版（
                  {formatJst(breakdown.calculation.calculatedAt)}
                  ）／ 過去の版は Data Point の詳細で確認できます。
                </p>
                <p>
                  内訳は確定値（{formatNumber(breakdown.dataPoint?.value)} t-CO2e・算定方法:{' '}
                  {breakdown.dataPoint?.methodology ?? '—'}
                  ）を置き換えません。確定値の変更は承認フローで行います。
                </p>
              </MoreInfo>
            ) : (
              <p className="text-caption text-ink-muted">
                算定内訳がまだありません。サプライヤーデータ取込からサプライヤーのデータを取り込んでください。
              </p>
            )}
          </div>
        </Section>

        {/* 排出係数マスターはサプライヤーデータ取込の画面を正とする（同じ表を 2 か所に置かない。T8）。
            架空値の注記は閉じない（リンクの横に見せる） */}
        <Section
          id="ghg-emission-factors"
          title={`排出係数マスター（${breakdown.factors.length}）`}
          actions={
            <Badge tone="warning">
              <CircleAlert className="size-3" aria-hidden="true" />
              架空値（実係数ではありません）
            </Badge>
          }
        >
          <p className="text-small text-ink">
            係数 {breakdown.factors.length} 件（コード・係数・単位・係数年度・出典）は{' '}
            <Link
              href="/enterprise/ghg/suppliers#supplier-emission-factors"
              className="text-brand-700 underline underline-offset-2"
            >
              サプライヤーデータ取込の排出量原単位マスター
            </Link>{' '}
            で確かめられます。
          </p>
        </Section>
      </div>
    </>
  );
}
