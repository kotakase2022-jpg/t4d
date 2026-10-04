import { ArrowDown, ArrowUp, Calculator, Minus } from 'lucide-react';
import { LineChart } from '@/components/charts/line-chart';
import { Badge } from '@/components/ui/badge';
import { formatNumber } from '@/lib/format/datetime';
import type { TrendPoint } from '@/lib/services/aggregation';

/**
 * GHG 画面「直近3年の推移」の 1 指標（docs/disclosure-first.md §10.4）。
 *
 * - 小さな折れ線（LineChart）。値の無い年度（その指標だけ未入力）は null のまま渡し、線を切る（0 にしない）
 * - 数値は点の隣に書く（3 点なので全部）。図と同じ数値の表は出さない（数値が 12 個以下で aria-label に全部入る）
 * - 前年比は矢印＋符号＋数値。増減の良し悪しを赤緑で示さない（中立色）。両年に値があり前年が 0 でないときだけ
 * - 推計を含む年度は「推計込み」のバッジ（ラベル＋アイコン）で示す
 */

/** 前年比（%、小数 1 桁に丸める）。片方の年に値が無い・前年が 0 なら null（未入力の年と比べない） */
export function yoyPercent(prev: number | null, value: number | null): number | null {
  if (value === null || prev === null || prev === 0) return null;
  return Math.round(((value - prev) / prev) * 1000) / 10;
}

/** 前年比の文字（例 -8.3%・+2.1%・0%）。既存の表示（ASCII の符号）を変えない */
export function yoyText(yoy: number): string {
  return `${yoy > 0 ? '+' : ''}${yoy}%`;
}

function YoyIcon({ yoy }: { yoy: number }) {
  const Icon = yoy > 0 ? ArrowUp : yoy < 0 ? ArrowDown : Minus;
  return <Icon className="size-3 shrink-0" aria-hidden="true" />;
}

export function GhgTrendMetric({ series }: { series: readonly TrendPoint[] }) {
  const metric = [...series].reverse().find((row) => row.metric)?.metric;
  if (!metric) return null;
  const changes = series.slice(1).map((row, index) => ({
    period: row.period,
    yoy: yoyPercent(series[index]?.value ?? null, row.value),
  }));
  const estimated = series.filter((row) => row.estimated);
  return (
    <div className="min-w-0 space-y-1">
      <LineChart
        title={metric.name}
        xLabels={series.map((row) => row.period.code)}
        series={[{ label: metric.name, values: series.map((row) => row.value) }]}
        unit={metric.unit}
        valueFormat={formatNumber}
        valueLabels="all"
        table={false}
        width={460}
        height={150}
      />
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink">
        <span className="text-ink-muted">前年比</span>
        {changes.map(({ period, yoy }) => (
          <span key={period.id} className="inline-flex items-center gap-1">
            <span className="font-mono text-ink-muted">{period.code}</span>
            {yoy === null ? (
              <span className="text-ink-muted">
                —<span className="sr-only">（前年か当年の値が無いため比べません）</span>
              </span>
            ) : (
              <>
                <YoyIcon yoy={yoy} />
                <span className="tabular-nums">{yoyText(yoy)}</span>
              </>
            )}
          </span>
        ))}
        {estimated.map((row) => (
          <Badge key={row.period.id} tone="warning">
            <Calculator className="size-3" aria-hidden="true" />
            {row.period.code} 推計込み
          </Badge>
        ))}
      </p>
    </div>
  );
}
