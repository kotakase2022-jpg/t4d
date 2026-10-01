import Link from 'next/link';
import { ArrowRight, Info, Inbox } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { isDemoMode } from '@/lib/config';
import { BENCHMARK_MEDIAN_MIN_PEERS, DEMO_BENCHMARK_NOTICE } from '@/lib/domain/benchmark';
import { formatNumber } from '@/lib/format/datetime';
import {
  loadBenchmark,
  type BenchmarkPeerCell,
  type BenchmarkRow,
} from '@/lib/services/analysis/benchmark';
import { loadEnterpriseShell } from '@/lib/services/shell';
import {
  AssuranceNote,
  ComparabilityBadge,
  DemoBenchmarkBanner,
  UndisclosedBadge,
} from '../_components/analysis-badges';

export const metadata = { title: '他社比較' };

/**
 * 他社比較（docs/disclosure-first.md §9.5）。閲覧専用。
 *
 * 比較データは Demo Mode のときだけの架空データ。Supabase モードでは「比較データが登録されていません」
 * と示す（他テナントの値を比較データとして使わない）。順位・総合スコアは出さず、値の高低を色で示さない。
 *
 * 数値の列は右寄せ（桁をそろえる）にし、値・中央値・範囲には必ず単位を付ける（行の単位と同じでも省かない。
 * 横にスクロールした先で単位が分からなくならないように）。1 列目（指標）は横スクロールしても見えるよう固定する。
 */

/** 値と単位（常に単位を付ける） */
function ValueWithUnit({ value, unit }: { value: number; unit: string }) {
  return (
    <>
      {formatNumber(value)}
      <span className="ml-0.5 text-[11px] font-normal text-ink-muted">{unit}</span>
    </>
  );
}

/** 1 列目（指標）を横スクロールしても見えるように固定する（背景を塗って下の列を隠す） */
const STICKY_FIRST_COLUMN = 'sticky left-0 z-[1] bg-surface';

function PeerCell({ cell }: { cell: BenchmarkPeerCell }) {
  if (!cell.disclosed || !cell.value || cell.value.value === null) {
    return <UndisclosedBadge />;
  }
  const comparability = cell.comparability;
  return (
    <div className="space-y-0.5">
      <span className="tnum block text-[13px] font-semibold text-ink">
        <ValueWithUnit value={cell.value.value} unit={cell.value.unit} />
      </span>
      {cell.value.method && (
        <span className="block text-[11px] text-ink-muted">{cell.value.method}</span>
      )}
      {comparability && <ComparabilityBadge comparable={comparability.comparable} />}
      {comparability && !comparability.comparable && (
        <ul className="space-y-0.5 text-[11px] text-ink">
          {comparability.reasons.map((reason) => (
            <li key={reason.factor}>
              <span className="font-medium">{reason.label}</span>
              <span className="block text-ink-muted">{reason.text}</span>
            </li>
          ))}
        </ul>
      )}
      <AssuranceNote assured={cell.value.assured} />
    </div>
  );
}

function OwnCell({ row }: { row: BenchmarkRow }) {
  const own = row.own;
  return (
    <div className="space-y-0.5">
      {own.value !== null ? (
        <span className="tnum block text-[13px] font-semibold text-ink">
          <ValueWithUnit value={own.value} unit={own.conditions.unit} />
        </span>
      ) : (
        <span className="block text-[12px] font-semibold text-ink">{own.label}</span>
      )}
      {own.value !== null && <span className="block text-[11px] text-ink-muted">{own.label}</span>}
      {own.conditions.boundary && (
        <span className="block text-[11px] text-ink-muted">範囲: {own.conditions.boundary}</span>
      )}
      {own.reason && <span className="block text-[11px] text-ink-muted">{own.reason}</span>}
      {own.fix && (
        <Link
          href={own.fix.href}
          className="inline-flex items-center gap-1 text-[11px] text-brand-700 hover:underline"
        >
          {own.fix.label}
          <ArrowRight className="size-3" aria-hidden="true" />
        </Link>
      )}
    </div>
  );
}

function StatsCells({ row }: { row: BenchmarkRow }) {
  const { stats } = row;
  return (
    <>
      <TD align="right" className="py-2 align-top text-[12px]">
        <span className="tnum font-semibold">
          {stats.n} / {row.peerTotal} 社
        </span>
        <span className="block text-[11px] text-ink-muted">
          未開示 {row.undisclosedCount}・比較対象外 {row.notComparableCount}
        </span>
      </TD>
      <TD align="right" className="py-2 align-top text-[12px]">
        {stats.median !== null ? (
          <span className="tnum font-semibold">
            <ValueWithUnit value={stats.median} unit={row.metric.unit} />
          </span>
        ) : (
          <span className="block text-[11px] text-ink-muted">
            出しません（{BENCHMARK_MEDIAN_MIN_PEERS} 社未満）
          </span>
        )}
      </TD>
      <TD align="right" className="py-2 align-top text-[12px]">
        {stats.min !== null && stats.max !== null ? (
          <span className="tnum">
            {formatNumber(stats.min)}〜{formatNumber(stats.max)}
            <span className="ml-0.5 text-[11px] text-ink-muted">{row.metric.unit}</span>
          </span>
        ) : (
          <span className="text-[11px] text-ink-muted">—</span>
        )}
      </TD>
    </>
  );
}

export default async function BenchmarkPage() {
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const header = (
    <PageHeader
      title="他社比較"
      description="自社の確定値と、比較の条件が同じ会社の開示値を並べます（順位・総合スコアは出しません）"
      breadcrumbs={[{ label: '企業ワークスペース' }, { label: '分析' }, { label: '他社比較' }]}
    />
  );
  if (!can(ctx, 'enterprise.data.read')) {
    return (
      <>
        {header}
        <div className="p-4">
          <PermissionDeniedState description="他社比較は、データの閲覧権限を持つ利用者のみ閲覧できます。" />
        </div>
      </>
    );
  }

  // 比較データは Demo Mode のときだけ（Supabase モードでは比較データを持たない）
  const view = await loadBenchmark(db, ctx, { source: isDemoMode() ? 'demo' : 'none' });

  if (view.source === 'none') {
    return (
      <>
        {header}
        <div className="p-4">
          <Card>
            <EmptyState
              icon={<Inbox className="size-5" aria-hidden="true" />}
              title="比較データが登録されていません"
              description={`他社の開示値（比較データ）は登録されていません。デモ環境でのみ、${DEMO_BENCHMARK_NOTICE}を表示します。`}
            />
          </Card>
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="space-y-3 p-4">
        <DemoBenchmarkBanner />

        <section
          aria-labelledby="benchmark-rules"
          className="rounded-t4d border border-line bg-surface px-3 py-2 text-[12px] text-ink"
        >
          <h2 id="benchmark-rules" className="flex items-center gap-1.5 text-[13px] font-semibold">
            <Info className="size-3.5 text-brand-600" aria-hidden="true" />
            比較の決まり
          </h2>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            <li>
              比較の年度は {view.fiscalYear}（比較データの年度）です。自社の値は
              {view.ownPeriod
                ? ` ${view.ownPeriod.code}（${view.ownFiscalYearEndMonth ?? '—'} 月決算）`
                : ` ${view.fiscalYear}（自社に同じ年度の期間がありません）`}
              の確定値です（対象の全拠点が承認済み。合計は GHG
              画面と同じ連結値、比率は分子・分母の合計から計算）。集計途中の値は使いません。
            </li>
            <li>
              単位・範囲（境界）・算定方法や定義・年度・決算月がすべて同じ会社だけを比較します。1
              つでも違う会社は「比較対象外」とし、理由を示します。値の換算はしません。
            </li>
            <li>
              集計は比較できる会社だけで行い、社数を必ず示します。中央値は{' '}
              {BENCHMARK_MEDIAN_MIN_PEERS}{' '}
              社以上のときだけ示します。順位・総合スコアは出さず、値の高低を色で示しません。
            </li>
            <li>
              原単位（売上高当たり・従業員当たり）は出しません。売上高の指標が無く、従業員数の集計方法が比較先と揃っていることを確認できないためです。
            </li>
            <li>第三者保証の有無は注記です（比較の可否には使いません）。</li>
          </ul>
        </section>

        <div className="t4d-scroll-x rounded-t4d-lg border border-line bg-surface">
          <Table className="min-w-[1280px]">
            <caption className="px-3 py-2 text-left text-[13px] font-semibold text-ink">
              {DEMO_BENCHMARK_NOTICE}（{view.fiscalYear}・比較先 {view.peers.length} 社）
            </caption>
            <THead>
              <TR>
                <TH className={STICKY_FIRST_COLUMN}>指標（単位）</TH>
                <TH align="right">自社（{view.fiscalYear}）</TH>
                {view.peers.map((peer) => (
                  <TH key={peer.id} align="right">
                    {peer.name}
                  </TH>
                ))}
                <TH align="right">比較できる社</TH>
                <TH align="right">中央値</TH>
                <TH align="right">範囲（最小〜最大）</TH>
              </TR>
            </THead>
            <TBody>
              {view.rows.map((row) => (
                <TR key={row.metric.key} className="align-top">
                  <th
                    scope="row"
                    className={`max-w-[200px] px-2 py-2 text-left align-top text-[12px] ${STICKY_FIRST_COLUMN}`}
                  >
                    <span className="font-semibold text-ink">{row.metric.label}</span>
                    <span className="block font-normal text-ink-muted">（{row.metric.unit}）</span>
                    {row.metric.ownMethod && (
                      <span className="block text-[11px] font-normal text-ink-muted">
                        自社の定義: {row.metric.ownMethod}
                      </span>
                    )}
                    {row.metric.note && (
                      <span className="block text-[11px] font-normal text-ink-muted">
                        {row.metric.note}
                      </span>
                    )}
                  </th>
                  <TD align="right" className="max-w-[200px] py-2 align-top">
                    <OwnCell row={row} />
                  </TD>
                  {row.peers.map((cell) => (
                    <TD key={cell.peer.id} align="right" className="max-w-[170px] py-2 align-top">
                      <PeerCell cell={cell} />
                    </TD>
                  ))}
                  <StatsCells row={row} />
                </TR>
              ))}
            </TBody>
          </Table>
        </div>

        <div className="t4d-scroll-x rounded-t4d-lg border border-line bg-surface">
          <Table>
            <caption className="px-3 py-2 text-left text-[13px] font-semibold text-ink">
              比較先の会社（{DEMO_BENCHMARK_NOTICE}）
            </caption>
            <THead>
              <TR>
                <TH>会社</TH>
                <TH>業種</TH>
                <TH>規模</TH>
              </TR>
            </THead>
            <TBody>
              {view.peers.map((peer) => (
                <TR key={peer.id}>
                  <th scope="row" className="px-2 text-left text-[12px] font-medium">
                    {peer.name}
                  </th>
                  <TD className="text-[12px]">{peer.industry}</TD>
                  <TD className="text-[12px]">{peer.sizeBand}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      </div>
    </>
  );
}
