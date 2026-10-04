import Link from 'next/link';
import { Info } from 'lucide-react';
import { MiniBars } from '@/components/charts/mini-bars';
import { FilterBar, type FilterGroup } from '@/components/shared/filter-bar';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Card } from '@/components/ui/card';
import { Collapsible } from '@/components/ui/collapsible';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import {
  filterMetricTrendRows,
  parseTrendFilters,
  TREND_CHANGE_FILTER_LABEL,
  TREND_CHANGE_FILTERS,
  TREND_GROUP_LABEL,
  TREND_GROUPS,
  trendEmptyReason,
  trendFilterQuery,
  type TrendEmptyReason,
  type TrendFilters,
} from '@/lib/domain/metric-trend';
import { loadMetricTrends, type MetricTrendRow } from '@/lib/services/analysis/trends';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { cn } from '@/lib/utils';
import { TrendCellView, TrendChangeCell } from './_components/trend-badges';
import { TrendDetail } from './_components/trend-detail';
import { TrendSummaryChips } from './_components/trend-summary';

export const metadata = { title: '自社経年比較' };

/**
 * 自社経年比較（docs/disclosure-first.md §10.2）。閲覧専用（書かない）。
 *
 * ヘッダーの年度（Cookie）を終点に、直近 3 年度の確定値を指標ごとに 1 つの表へ並べる。値の源は
 * ESG経営・他社比較と同じ（kpi.ts の loadMetricYearStates）。確定していない年度は数値にせず状態で示し
 * （未入力を 0 と書かない）、前年比は同じ前提で比べられるときだけ出す。増減は色で良し悪しを示さない。
 *
 * 文字を減らすため（§10.4）: 画面の説明は「この画面について」、比較の決まりと行ごとの内訳は既定で閉じる。
 * 窓が 3 年度に満たない注記・要約の件数・表は閉じない。絞込（group・change・q・empty）は URL に持ち、
 * 「比較条件の確認が必要」で絞ったときは理由のある内訳を開いて描く。
 */

const BASE_PATH = '/enterprise/analysis/trends';

/** 1 列目（指標）を横スクロールしても見えるように固定する（背景を塗って下の列を隠す） */
const STICKY_FIRST_COLUMN = 'sticky left-0 z-[1] bg-surface';

const FILTER_GROUPS: FilterGroup[] = [
  {
    key: 'group',
    label: '区分',
    multiple: false,
    options: TREND_GROUPS.map((group) => ({ value: group, label: TREND_GROUP_LABEL[group] })),
  },
  {
    key: 'change',
    label: '前年比',
    multiple: false,
    options: TREND_CHANGE_FILTERS.map((change) => ({
      value: change,
      label: TREND_CHANGE_FILTER_LABEL[change],
    })),
  },
];

function hrefWith(filters: TrendFilters, patch: Partial<TrendFilters>): string {
  const query = trendFilterQuery({ ...filters, ...patch });
  return query ? `${BASE_PATH}?${query}` : BASE_PATH;
}

/** 内訳の 1 行要約（年度ごとの承認済み n/N 拠点。未入力の年度は —） */
function detailMeta(row: MetricTrendRow): string {
  const counts = row.cells.map((cell) =>
    cell.kind === 'not_entered' || cell.expectedCount === 0
      ? '—'
      : `${cell.approvedCount}/${cell.expectedCount}`,
  );
  return `承認済み ${counts.join('・')} 拠点`;
}

/**
 * 指標の行と、その下の「内訳」の行。
 *
 * 行見出し（th scope=row）には指標名と単位だけを置く。内訳（年度ごとの承認の状況・理由・リンク）を
 * 行見出しの中に置くと、その文が行見出しの名前になり、表を読み上げで移動するたびに内訳の全文
 * （開いていれば定義・理由・リンクまで）が値より先に読まれるため、表の幅いっぱいの次の行に分ける
 */
function TrendRow({
  row,
  periodCodes,
  columnCount,
  openDetail,
}: {
  row: MetricTrendRow;
  periodCodes: string[];
  columnCount: number;
  openDetail: boolean;
}) {
  const { metric } = row;
  return (
    <>
      <TR className="border-b-0 align-top" data-metric-code={metric.code}>
        <th
          scope="row"
          className={cn(
            'min-w-[240px] max-w-[320px] px-2 pt-2 pb-0.5 text-left align-top text-[12px]',
            STICKY_FIRST_COLUMN,
          )}
        >
          <span className="font-semibold text-ink">{metric.name}</span>
          <span className="ml-1 font-normal text-ink-muted">（{metric.unit}）</span>
        </th>
        {row.cells.map((cell, index) => (
          <TD key={periodCodes[index] ?? index} align="right" className="pt-2 pb-0.5 align-top">
            <TrendCellView cell={cell} unit={metric.unit} />
          </TD>
        ))}
        <TD align="center" className="pt-2 pb-0.5 align-top">
          <MiniBars values={row.cells.map((cell) => cell.value)} labels={periodCodes} decorative />
        </TD>
        {row.changes.map((change, index) => (
          <TD
            key={row.changeLabels[index] ?? index}
            align="right"
            className="pt-2 pb-0.5 align-top"
          >
            <TrendChangeCell change={change} />
          </TD>
        ))}
      </TR>
      <tr className="border-b border-line last:border-b-0" data-trend-detail={metric.code}>
        <td colSpan={columnCount} className="px-0 pb-1.5 pt-0 text-[12px]">
          {/* 横にスクロールしても内訳の開閉が左端に見えるように固定する */}
          <div className="sticky left-0 w-fit max-w-[340px] px-2">
            <Collapsible
              variant="plain"
              // 行見出しから離れるため、読み上げではどの指標の内訳かを名前に含める
              summary={
                <>
                  <span className="sr-only">{metric.name}の</span>内訳
                </>
              }
              meta={detailMeta(row)}
              open={openDetail || undefined}
            >
              <TrendDetail row={row} />
            </Collapsible>
          </div>
        </td>
      </tr>
    </>
  );
}

/** 表が空のときの状態（理由ごとに文言を分ける。絞り込んでいないのに「絞り込み解除」を案内しない） */
function TrendEmptyState({
  reason,
  windowLabel,
}: {
  reason: TrendEmptyReason;
  windowLabel: string;
}) {
  if (reason === 'no_metrics') {
    return (
      <EmptyState
        title="数値の指標が登録されていません"
        description="指標マスターに数値の指標を登録すると、年度ごとの確定値を並べます。"
        action={
          <Link
            href="/enterprise/organizations"
            className="text-[12px] text-brand-700 underline underline-offset-2"
          >
            組織・拠点（指標マスター）
          </Link>
        }
      />
    );
  }
  if (reason === 'no_data') {
    return (
      <EmptyState
        title="比較できるデータがまだありません"
        description={`${windowLabel} のどの年度にも、指標のデータが登録されていません（0 ではありません）。データを登録すると、確定値を年度ごとに並べます。`}
        action={
          <Link
            href="/enterprise/imports"
            className="text-[12px] text-brand-700 underline underline-offset-2"
          >
            データ取込
          </Link>
        }
      />
    );
  }
  return (
    <EmptyState
      title="該当する指標がありません"
      description="絞り込みの条件を変えるか、「絞り込み解除」を押してください。"
    />
  );
}

export default async function TrendsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const header = (
    <PageHeader
      title="自社経年比較"
      description="直近 3 年度の確定値を指標ごとに並べます"
      help={
        <>
          <p>
            画面上部で選んだ報告期間（{shell.currentPeriod.code}
            ）を終点に、開始日がそれ以前の報告期間を新しい順に最大 3
            つ並べます。データの無い年度も列に出します。
          </p>
          <p>年度は画面上部の「報告期間」で切り替えます（この画面の URL では選べません）。</p>
          <p>
            各指標の「内訳」に、年度ごとの承認の状況・参考値・前年比を出さなかった理由と、関連する画面へのリンクがあります。
          </p>
        </>
      }
      breadcrumbs={[{ label: '企業ワークスペース' }, { label: '分析' }, { label: '自社経年比較' }]}
    />
  );
  if (!can(ctx, 'enterprise.data.read')) {
    return (
      <>
        {header}
        <div className="p-4">
          <PermissionDeniedState description="自社経年比較は、データの閲覧権限を持つ利用者のみ閲覧できます。" />
        </div>
      </>
    );
  }

  const view = await loadMetricTrends(db, ctx, {
    period: shell.currentPeriod,
    periods: shell.periods,
  });
  const filters = parseTrendFilters(query);
  const filtered = filterMetricTrendRows(view.rows, filters);
  const periodCodes = view.periods.map((p) => p.code);
  const firstCode = periodCodes[0] ?? view.period.code;
  const lastCode = periodCodes[periodCodes.length - 1] ?? view.period.code;
  // 行の changeLabels と同じ並び（隣り合う年度。古 → 新）
  const changeLabels = periodCodes.slice(1).map((code, index) => `${periodCodes[index]}→${code}`);
  const columnCount = 1 + periodCodes.length + 1 + changeLabels.length;
  const openDetail = filters.change === 'needs_check';

  return (
    <>
      {header}
      <div className="space-y-3 p-4">
        {view.windowNote && (
          <p
            role="note"
            className="flex items-start gap-1.5 rounded-t4d border border-line bg-surface-muted px-3 py-2 text-[12px] text-ink"
          >
            <Info className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
            {view.windowNote}
          </p>
        )}

        <TrendSummaryChips summary={view.summary} filters={filters} latestPeriodCode={lastCode} />

        <Collapsible
          id="trend-rules"
          summary="比較の決まり: 確定値だけ・合計は連結値・比率は加重平均・推計と目標は比べない"
        >
          <ul className="list-disc space-y-0.5 pl-5">
            <li>
              値の欄は確定値（対象の全拠点が承認済み）だけです。集計中・推計を含む・未入力の年度は数値にせず状態で示します（未入力を
              0 と書きません）。
            </li>
            <li>
              合計の指標は GHG
              画面と同じ連結値です（持分調整・内部取引の控除後。持分法の拠点は含めません）。
            </li>
            <li>
              比率は分子・分母の合計から計算する加重平均です（拠点の比率の単純平均は使いません）。単位が
              % の指標の前年比は % ポイントの差です。
            </li>
            <li>
              推計・前年値での補完・目標値・承認済み分のみの途中合計は、値の欄と前年比に使いません（内訳に参考として示します）。
            </li>
            <li>
              前年比は隣り合う 2
              年度がともに確定し、対象拠点・境界・算定方法・内部取引の控除・単位・期間が同じときだけ示します。違うときは「比較条件の確認が必要」とし、理由を内訳に示します。
            </li>
            <li>
              増減の良し悪しは指標によって逆になるため、色で示しません（矢印と符号）。「大きな変化」は指標マスターの前年比の許容幅を超えた変化です。
            </li>
            <li>Scope2 のマーケット基準とロケーション基準は別の指標で、合算しません。</li>
            <li>
              Scope3 Cat.1（購入した製品・サービス）は Scope3 の 1 カテゴリで、Scope3
              全体ではありません。
            </li>
            <li>単一の総合点・順位は出しません。</li>
          </ul>
        </Collapsible>

        <FilterBar
          groups={FILTER_GROUPS}
          searchPlaceholder="指標名・コードで検索"
          total={filtered.length}
        />

        {view.summary.emptyCount > 0 && (
          <p className="text-[12px] text-ink-muted">
            データが 1 年もない指標 {view.summary.emptyCount} 件（0 ではありません）
            {filters.empty ? '。表に含めています' : '。表では隠しています'}{' '}
            <Link
              href={hrefWith(filters, { empty: !filters.empty })}
              // 文中のリンクは色だけで区別しない（axe link-in-text-block）
              className="text-brand-700 underline underline-offset-2"
            >
              {filters.empty ? '隠す' : '表示'}
            </Link>
          </p>
        )}

        {filtered.length === 0 ? (
          <Card>
            <TrendEmptyState
              reason={trendEmptyReason(filters, {
                rowCount: view.rows.length,
                dataMetricCount: view.summary.dataMetricCount,
              })}
              windowLabel={firstCode === lastCode ? firstCode : `${firstCode}〜${lastCode}`}
            />
          </Card>
        ) : (
          <div className="t4d-scroll-x rounded-t4d-lg border border-line bg-surface">
            <Table className="min-w-[960px]">
              <caption className="px-3 py-2 text-left text-[13px] font-semibold text-ink">
                指標ごとの確定値（{firstCode === lastCode ? firstCode : `${firstCode}〜${lastCode}`}
                ・{filtered.length} 指標）
              </caption>
              <THead>
                <TR>
                  <TH className={STICKY_FIRST_COLUMN}>指標（単位）</TH>
                  {periodCodes.map((code) => (
                    <TH key={code} align="right">
                      {code}
                    </TH>
                  ))}
                  <TH align="center">推移</TH>
                  {changeLabels.map((label) => (
                    <TH key={label} align="right">
                      前年比 {label}
                    </TH>
                  ))}
                </TR>
              </THead>
              {TREND_GROUPS.map((group) => {
                const rows = filtered.filter((row) => row.group === group);
                if (rows.length === 0) return null;
                return (
                  <TBody key={group}>
                    <tr className="border-b border-line bg-surface-muted">
                      <th
                        scope="rowgroup"
                        colSpan={columnCount}
                        className="px-2 py-1 text-left text-[12px] font-semibold text-ink"
                      >
                        <span className="sticky left-2">
                          {TREND_GROUP_LABEL[group]}（{rows.length} 指標）
                        </span>
                      </th>
                    </tr>
                    {rows.map((row) => (
                      <TrendRow
                        key={row.metric.id}
                        row={row}
                        periodCodes={periodCodes}
                        columnCount={columnCount}
                        openDetail={openDetail && row.changes.some((c) => c.kind === 'needs_check')}
                      />
                    ))}
                  </TBody>
                );
              })}
            </Table>
          </div>
        )}
      </div>
    </>
  );
}
