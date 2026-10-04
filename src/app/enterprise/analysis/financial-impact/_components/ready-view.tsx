import Link from 'next/link';
import { ArrowRight, Ban, Check, CircleDashed } from 'lucide-react';
import { BarChart } from '@/components/charts/bar-chart';
import { LineChart } from '@/components/charts/line-chart';
import { Card } from '@/components/ui/card';
import { Collapsible } from '@/components/ui/collapsible';
import {
  SCENARIOS,
  SCENARIO_LABEL,
  SCENARIO_MEANING,
  DRIVERS,
  fiscalYearLabel,
  formatMillionYen,
  serializeImpactParams,
  type PathwayResult,
} from '@/lib/domain/financial-impact';
import { formatNumber } from '@/lib/format/datetime';
import type { FinancialImpactReady } from '@/lib/services/analysis/financial-impact';
import { cn } from '@/lib/utils';
import { AssumptionForm } from './assumption-form';
import { EstimateTable } from './estimate-table';
import { millionLabel, signedPercent, toMillion } from './format';
import { HiddenAreaNote, ImpactValue, QuantifiedCount } from './impact-badges';
import { QualitativeSection } from './iro-grid';
import { PathwayFlow } from './pathway-flow';
import { Tornado } from './tornado';

/**
 * 財務影響分析の本体（基準年度があるとき。docs/disclosure-first.md §10.3・§10.4）。
 *
 * 既定で見える: シナリオ切替・要約タイル 3 つ・未定量の経路と理由・経路図・年次の図・累計の線。
 * 既定で閉じる: 仮定を変える（URL に仮定があれば開く）・経路ごとの試算表・感度・定性情報と IRO・
 * 制度の前提と出典・方法と限界。権限が無く出さなかった領域の 1 行は閉じない。
 */

export const FINANCIAL_IMPACT_PATH = '/enterprise/analysis/financial-impact';

function hrefWith(query: string): string {
  return query === '' ? FINANCIAL_IMPACT_PATH : `${FINANCIAL_IMPACT_PATH}?${query}`;
}

function ScenarioSwitch({ view }: { view: FinancialImpactReady }) {
  return (
    <nav aria-label="シナリオ" className="flex flex-wrap items-center gap-1.5">
      <span className="text-[12px] text-ink-muted">シナリオ:</span>
      {SCENARIOS.map((scenario) => {
        const active = view.params.scenario === scenario;
        return (
          <Link
            key={scenario}
            href={hrefWith(serializeImpactParams({ ...view.params, scenario }, view.defaults))}
            aria-current={active ? 'true' : undefined}
            className={cn(
              'inline-flex items-center gap-1 rounded-t4d border px-2 py-1 text-[12px]',
              active
                ? 'border-brand-700 bg-brand-50 font-semibold text-ink'
                : 'border-line bg-surface text-ink hover:bg-brand-50',
            )}
          >
            {active && <Check className="size-3.5" aria-hidden="true" />}
            {SCENARIO_LABEL[scenario]}
          </Link>
        );
      })}
    </nav>
  );
}

/** 選んだシナリオの意味と、目標達成で使う目標・使わない目標（理由つき） */
function ScenarioDetail({ view }: { view: FinancialImpactReady }) {
  const scenario = view.params.scenario;
  const label = (driver: keyof typeof DRIVERS) => DRIVERS[driver].label;
  return (
    <div className="space-y-0.5 text-[12px] text-ink">
      <p>
        {SCENARIO_LABEL[scenario]}: {SCENARIO_MEANING[scenario]}。基準年度 {view.basePeriod.code}
        （確定値）・試算期間 {fiscalYearLabel(view.current.years[0] ?? 0)}〜
        {fiscalYearLabel(view.current.years.at(-1) ?? 0)}
      </p>
      {scenario === 'target' && (
        <ul className="list-disc space-y-0.5 pl-5 text-[11px] text-ink-muted">
          {view.targets
            .filter((t) => t.status !== 'no_target')
            .map((t) => (
              <li key={t.driver}>
                {t.status === 'applied'
                  ? `${label(t.driver)}: ${t.targetYear} 年 ${formatNumber(t.targetValue)} ${DRIVERS[t.driver].unit} へ直線、以後一定（比較可の目標）`
                  : `${label(t.driver)}: 目標を使わず一定（${t.reasons.join('')}）`}
              </li>
            ))}
          <li>
            目標の無い起点（
            {view.targets
              .filter((t) => t.status === 'no_target')
              .map((t) => label(t.driver))
              .join('・') || 'なし'}
            ）は一定です。
          </li>
        </ul>
      )}
      {scenario === 'custom' && (
        <p className="text-[11px] text-ink-muted">
          年率:{' '}
          {Object.entries(view.params.growthRates)
            .filter(([, rate]) => rate !== 0)
            .map(([driver, rate]) => `${label(driver as keyof typeof DRIVERS)} ${rate}%/年`)
            .join('・') || 'すべて 0%/年（現状維持と同じ）'}
          。「仮定を変える」で起点ごとに入力します。
        </p>
      )}
    </div>
  );
}

function SummaryTiles({ view }: { view: FinancialImpactReady }) {
  const { current, comparison, referenceYear } = view;
  const index = current.years.indexOf(referenceYear);
  const annual = index === -1 ? null : (current.totals[index] ?? null);
  const firstYear = fiscalYearLabel(current.years[0] ?? 0);
  const lastYear = fiscalYearLabel(current.years.at(-1) ?? 0);
  const compared = comparison.scenario === 'bau' ? 'target' : comparison.scenario;
  const tileClass = 'space-y-1 rounded-t4d-lg border border-line bg-surface px-3 py-2';
  return (
    <section aria-label="試算の要約" className="grid gap-2 md:grid-cols-3">
      <div role="group" aria-labelledby="fi-tile-annual" className={tileClass}>
        <h2 id="fi-tile-annual" className="text-[12px] font-semibold text-ink-muted">
          {fiscalYearLabel(referenceYear)} の年間影響
        </h2>
        <ImpactValue value={annual} size="lg" />
        <QuantifiedCount quantified={current.quantifiedCount} enabled={current.enabledCount} />
        {view.baseline && annual !== null && (
          <p className="text-[11px] text-ink-muted">
            営業利益（架空 {formatNumber(view.baseline.operatingProfit / 100_000_000)} 億円）比{' '}
            {signedPercent(annual / view.baseline.operatingProfit)}（参考）
          </p>
        )}
      </div>
      <div role="group" aria-labelledby="fi-tile-cumulative" className={tileClass}>
        <h2 id="fi-tile-cumulative" className="text-[12px] font-semibold text-ink-muted">
          10 年累計（{firstYear}〜{lastYear}）
        </h2>
        <ImpactValue value={current.cumulative} size="lg" />
        <QuantifiedCount quantified={current.quantifiedCount} enabled={current.enabledCount} />
        <p className="text-[11px] text-ink-muted">
          {current.presentValue === null
            ? '割引率が未入力のため、現在価値は出しません'
            : `参考の現在価値（割引率 ${formatNumber(view.params.assumptions.discountRate)}%）${formatMillionYen(current.presentValue)} 百万円`}
        </p>
      </div>
      <div role="group" aria-labelledby="fi-tile-avoided" className={tileClass}>
        <h2 id="fi-tile-avoided" className="text-[12px] font-semibold text-ink-muted">
          回避コスト対削減費用（{SCENARIO_LABEL[compared]} − 現状維持）
        </h2>
        <ImpactValue value={comparison.avoided} size="lg" />
        <QuantifiedCount
          quantified={comparison.quantifiedCount}
          enabled={comparison.enabledCount}
        />
        <p className="text-[11px] text-ink-muted">
          {comparison.abatement === null
            ? '削減費用: 未定量（Scope1 の確定値か削減単価がありません）'
            : `削減費用（別枠・営業利益に足さない）${formatMillionYen(comparison.abatement).replace(/^\+/, '')} 百万円`}
        </p>
      </div>
    </section>
  );
}

/** 未定量・無効の経路と理由（0 として数えていないことを見せる。折りたたまない） */
function UnquantifiedList({ view }: { view: FinancialImpactReady }) {
  const rows = view.current.pathways.filter((p) => p.status !== 'quantified');
  if (rows.length === 0) return null;
  return (
    <div className="rounded-t4d border border-line bg-surface px-3 py-2">
      <p className="text-[12px] font-semibold text-ink">
        未定量・無効の経路（合計に含めていません。0 ではありません）
      </p>
      <ul aria-label="未定量・無効の経路" className="mt-0.5 space-y-0.5 text-[12px] text-ink">
        {rows.map((p) => (
          <li key={p.pathway.id} className="flex items-start gap-1.5">
            {p.status === 'disabled' ? (
              <Ban className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
            ) : (
              <CircleDashed
                className="mt-0.5 size-3.5 shrink-0 text-ink-muted"
                aria-hidden="true"
              />
            )}
            <span>
              {p.pathway.id} {p.pathway.mechanism}: {p.reason}
              {p.pathway.id === 'P7' && (
                <span className="block text-[11px] text-ink-muted">{view.injuryDataNote}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AnnualChart({ view }: { view: FinancialImpactReady }) {
  const { current } = view;
  const categories = current.years.map(fiscalYearLabel);
  const quantified = current.pathways.filter((p) => p.status === 'quantified');
  const nonZero = quantified
    .filter((p) => p.years.some((y) => (y.value ?? 0) !== 0))
    .sort((a, b) => Math.abs(b.cumulative ?? 0) - Math.abs(a.cumulative ?? 0));
  const zero = quantified.filter((p) => !nonZero.includes(p));
  const top = nonZero.slice(0, 6);
  const rest = nonZero.slice(6);
  const seriesOf = (p: PathwayResult) => ({
    label: `${p.pathway.id} ${p.pathway.mechanism}`,
    values: p.years.map((y) => toMillion(y.value)),
  });
  const series = [
    ...top.map(seriesOf),
    ...(rest.length > 0
      ? [
          {
            label: `その他（${rest.map((p) => p.pathway.id).join('・')}）`,
            values: current.years.map(
              (_, i) => rest.reduce((acc, p) => acc + (p.years[i]?.value ?? 0), 0) / 1_000_000,
            ),
          },
        ]
      : []),
  ];
  const title = `年次の影響（${categories[0]}〜${categories.at(-1)}）`;
  if (series.length === 0) {
    return (
      <div className="space-y-0.5">
        <p className="text-[12px] font-semibold text-ink">{title}</p>
        <p className="text-[12px] text-ink-muted">
          {quantified.length === 0
            ? '定量化できた経路がありません（0 ではありません）。仮定を入力すると試算します。'
            : `定量化できた経路（${quantified.map((p) => p.pathway.id).join('・')}）は、どの年も 0 です（基準年度から変わらない）。`}
        </p>
      </div>
    );
  }
  return (
    <BarChart
      title={title}
      categories={categories}
      series={series}
      unit="百万円"
      stacked
      categoryLabel="年度"
      valueFormat={millionLabel}
      width={960}
      height={260}
      note={
        <>
          ＋増益・−減益（0 軸の下が減益）。定量化できた経路のみ（{current.quantifiedCount} /{' '}
          {current.enabledCount} 経路）
          {zero.length > 0 &&
            `。どの年も 0 の経路（${zero.map((p) => p.pathway.id).join('・')}）は省略`}
        </>
      }
    />
  );
}

function CumulativeChart({ view }: { view: FinancialImpactReady }) {
  const xLabels = view.current.years.map(fiscalYearLabel);
  const running = (totals: ReadonlyArray<number | null>) => {
    let sum = 0;
    return totals.map((t) => {
      if (t === null) return null;
      sum += t;
      return sum / 1_000_000;
    });
  };
  const series = view.scenarios.map(({ scenario, result }) => ({
    label: SCENARIO_LABEL[scenario],
    values: running(result.totals),
    dashed: scenario === 'target',
  }));
  return (
    <LineChart
      title="累計の推移（シナリオ別）"
      xLabels={xLabels}
      series={series}
      unit="百万円"
      valueFormat={millionLabel}
      valueLabels="last"
      width={960}
      height={240}
      note={`各年までの累計。定量化できた経路のみ（${view.current.quantifiedCount} / ${view.current.enabledCount} 経路）`}
    />
  );
}

const INSTITUTIONS: Array<{
  fact: string;
  handling: (view: FinancialImpactReady) => string;
  href: string;
}> = [
  {
    fact: '地球温暖化対策税（289 円/t-CO2）は既に燃料価格に含まれる',
    handling: () => '上乗せしません',
    href: 'https://www.env.go.jp/policy/tax/about.html',
  },
  {
    fact: 'GX-ETS: 直近 3 年度平均の直接 CO2 排出が 10 万 t 以上の事業者は FY2026 から参加義務',
    handling: (view) =>
      view.scope1Reference === null
        ? '参考: Scope1 の確定値が無いため、義務対象かの参考も示しません'
        : `参考: 直接の義務対象外（${view.basePeriod.code} の Scope1 は約 ${(view.scope1Reference / 10_000).toFixed(1)} 万 t-CO2e。CO2e であり、当年度は収集中のため 3 年平均も出しません）`,
    href: 'https://www.meti.go.jp/shingikai/sankoshin/sangyo_gijutsu/emissions_trading/pdf/001_03_00.pdf',
  },
  {
    fact: '化石燃料賦課金は FY2028 から（化石燃料の輸入事業者等）',
    handling: () => 'P1 の開始年。転嫁率は仮定',
    href: 'https://www.meti.go.jp/press/2022/02/20230210004/20230210004.html',
  },
  {
    fact: '特定事業者負担金（発電事業者）は FY2033 から',
    handling: () => 'P2 の開始年。転嫁率は仮定',
    href: 'https://www.cas.go.jp/jp/seisaku/gx_jikkou_kaigi/dai15/siryou1.pdf',
  },
];

function InstitutionTable({ view }: { view: FinancialImpactReady }) {
  return (
    <div className="t4d-scroll-x">
      <table className="w-full min-w-[720px] text-[12px]">
        <caption className="pb-1 text-left text-[11px] text-ink-muted">
          制度の前提（2026-10-02
          時点で政府資料により確認した参考情報。価格水準は法定でないため、炭素価格は常に仮定）
        </caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="border-b border-line px-2 py-1 text-left text-[11px] text-ink-muted"
            >
              事実
            </th>
            <th
              scope="col"
              className="border-b border-line px-2 py-1 text-left text-[11px] text-ink-muted"
            >
              この試算での扱い
            </th>
            <th
              scope="col"
              className="border-b border-line px-2 py-1 text-left text-[11px] text-ink-muted"
            >
              出典
            </th>
          </tr>
        </thead>
        <tbody>
          {INSTITUTIONS.map((row) => (
            <tr key={row.href} className="border-b border-line last:border-b-0 align-top">
              <th scope="row" className="px-2 py-1 text-left font-normal text-ink">
                {row.fact}
              </th>
              <td className="px-2 py-1 text-ink">{row.handling(view)}</td>
              <td className="px-2 py-1">
                <a
                  href={row.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all text-brand-700 hover:underline"
                >
                  {new URL(row.href).hostname}（政府資料・新しいタブ）
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TARGET_STATUS_TEXT: Record<FinancialImpactReady['targets'][number]['status'], string> = {
  applied: '目標達成シナリオで使う（比較可）',
  not_comparable: '使わない（比較できない）',
  expired: '使わない（目標年が基準年度以前）',
  no_origin: '使わない（基準年度の確定値なし）',
  no_target: '目標なし（一定）',
};

/** 目標達成シナリオで使う目標・使わない目標（理由つき）。出所は ESG経営の目標 */
function TargetList({ view }: { view: FinancialImpactReady }) {
  return (
    <div className="mt-3 space-y-1">
      <h3 className="text-[12px] font-semibold text-ink">起点ごとの目標（目標達成シナリオ）</h3>
      <ul aria-label="起点ごとの目標" className="space-y-0.5 text-[12px] text-ink">
        {view.targets.map((t) => (
          <li key={t.driver}>
            <span className="font-medium">{DRIVERS[t.driver].label}</span>:{' '}
            {TARGET_STATUS_TEXT[t.status]}
            {t.targetYear !== null && t.targetValue !== null && (
              <span className="text-ink-muted">
                {' '}
                （{t.targetYear} 年 {formatNumber(t.targetValue)} {DRIVERS[t.driver].unit}・範囲「
                {t.boundary ?? '—'}」）
              </span>
            )}
            {t.reasons.length > 0 && (
              <span className="block text-[11px] text-ink-muted">{t.reasons.join('')}</span>
            )}
          </li>
        ))}
      </ul>
      <Link
        href="/enterprise/esg"
        className="inline-flex items-center gap-1 text-[11px] text-brand-700 hover:underline"
      >
        ESG経営（目標と実績）
        <ArrowRight className="size-3" aria-hidden="true" />
      </Link>
    </div>
  );
}

function MethodNotes({ view }: { view: FinancialImpactReady }) {
  return (
    <ul className="list-disc space-y-0.5 pl-5">
      <li>
        承認済みの非財務データ（基準年度 {view.basePeriod.code}
        の確定連結値）と、画面に示した仮定による決定論的な試算です。確定データは最長{' '}
        {view.dataDepthYears} 年分のため、回帰・弾性値・因果推定などの統計的な推定は行いません。
      </li>
      <li>経路と係数は仮定です。相関から因果を推定していません。</li>
      <li>
        経路は起点ごとに独立に計算し、経路間の相互作用（省エネで Scope1・Scope2
        が減る等）はモデル化しません。P3（電力・燃料費）と P1・P2
        は同じ燃料・電力を別の経路で数えるため、足し合わせると二重計上になりうる点に注意してください。
      </li>
      <li>
        金額は「基準年度の費用構造からの営業利益の増減（円/年）」です。＋は増益、−は減益。表示は百万円・小数
        1 桁で、丸めは表示だけです。
      </li>
      <li>
        未定量（確定値が無い・仮定が未入力）は 0
        にせず、合計は定量化できた経路だけです。制度開始前の年は制度が無いため 0 です。
      </li>
      <li>
        定性情報・IRO
        は円に換算しません。資本コストは根拠データが無いため未定量です（図にだけ示します）。
      </li>
      <li>削減費用（Scope1 の削減量 × 削減単価）は別枠で、営業利益の増減に足しません。</li>
      <li>現在価値は割引率による参考値です。</li>
      {view.baseline && (
        <li>
          財務ベースライン（売上高・営業利益）は架空の値で、営業利益比の参考表示だけに使います。
        </li>
      )}
      <li>{view.injuryDataNote}</li>
      <li>仮定・シナリオは URL にだけ載せ、保存しません（Cookie・データベースに書きません）。</li>
    </ul>
  );
}

export function ReadyView({ view }: { view: FinancialImpactReady }) {
  const { current } = view;
  const unquantified = current.pathways.filter(
    (p) => p.status === 'no_origin' || p.status === 'missing_input',
  ).length;
  const disabled = current.pathways.filter((p) => p.status === 'disabled').length;
  const relatedNarratives =
    view.qualitative?.narratives.filter((n) => n.pathways.length > 0).length ?? 0;
  return (
    <>
      <div className="space-y-1.5 rounded-t4d-lg border border-line bg-surface px-3 py-2">
        <ScenarioSwitch view={view} />
        <ScenarioDetail view={view} />
      </div>

      <SummaryTiles view={view} />
      <UnquantifiedList view={view} />

      <Card className="space-y-4 p-3">
        <PathwayFlow
          pathways={current.pathways}
          origins={view.origins}
          relatedByPathway={view.relatedByPathway}
          referenceYear={view.referenceYear}
        />
        <AnnualChart view={view} />
        <CumulativeChart view={view} />
      </Card>

      <Collapsible
        id="fi-assumptions"
        summary={`仮定を変える（${view.source === 'demo' ? '仮定・デモ既定から変更' : '仮定は未入力'}・URL で共有）`}
        open={view.params.customized || view.source === 'none' || view.params.notices.length > 0}
      >
        <AssumptionForm
          action={FINANCIAL_IMPACT_PATH}
          params={view.params}
          defaults={view.defaults}
          source={view.source}
        />
      </Collapsible>

      <Collapsible
        id="fi-estimates"
        summary={`経路ごとの試算表（定量化 ${current.quantifiedCount} / ${current.enabledCount} 経路・未定量 ${unquantified}・無効 ${disabled}）`}
      >
        <EstimateTable
          result={current}
          input={view.currentInput}
          origins={view.origins}
          relatedByPathway={view.relatedByPathway}
          referenceYear={view.referenceYear}
        />
        <TargetList view={view} />
      </Collapsible>

      <Collapsible
        id="fi-sensitivity"
        summary={`感度（±${Math.round(view.sensitivity.ratio * 100)}%）: 10 年累計への効きの大きい仮定 上位 ${view.sensitivity.rows.length} 件`}
      >
        <Tornado result={view.sensitivity} />
      </Collapsible>

      {view.qualitative ? (
        <Collapsible
          id="fi-qualitative"
          summary={`定性情報と IRO（円にしない）: IRO ${view.qualitative.iros.length} 件・経路に関連する定性情報 ${relatedNarratives} 件`}
        >
          <QualitativeSection view={view.qualitative} />
        </Collapsible>
      ) : (
        view.hiddenNote && (
          <HiddenAreaNote note={view.hiddenNote} areas="定性情報・IRO・SSBJ マテリアリティ" />
        )
      )}

      <Collapsible id="fi-institutions" summary="制度の前提と出典（2026-10-02 時点の参考情報）">
        <InstitutionTable view={view} />
      </Collapsible>

      <Collapsible
        id="fi-method"
        summary="方法と限界（決定論的な試算・相互作用なし・統計推定なし）"
      >
        <MethodNotes view={view} />
      </Collapsible>
    </>
  );
}
