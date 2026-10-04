import { linearScale } from '@/lib/charts/scale';
import { BENCHMARK_MEDIAN_MIN_PEERS } from '@/lib/domain/benchmark';

/**
 * 他社比較の 1 行の範囲帯（docs/disclosure-first.md §10.4「中立色の範囲帯」）。
 * 比較できる社の最小〜最大を帯、各社の値を点、中央値を縦線、自社を菱形で描く。
 *
 * - 比較できる社だけを描く（比較対象外・未開示の社は単位・範囲・定義が違うので同じ軸に置かない）
 * - 並べ替えない・順位を付けない・良し悪しを色で示さない（色は中立。印の形で区別する）
 * - 数値は同じ行のセル（自社・各社・中央値・範囲）に文字で書いてあるので、図は装飾（aria-hidden）。
 *   印の意味は表の下の凡例（BenchmarkRangeLegend）に文字で書く
 */

const WIDTH = 120;
const HEIGHT = 18;
const PAD = 6;
const MID = HEIGHT / 2;

export interface BenchmarkRangeInput {
  /** 比較できる社の値（換算しない・そのまま） */
  peerValues: readonly number[];
  median: number | null;
  /** 自社の確定値（無ければ null。集計中の値は渡さない） */
  own: number | null;
}

/** 点の x 座標（純関数。帯の両端と自社が必ず枠の内側に入る） */
export function benchmarkRangeLayout({ peerValues, median, own }: BenchmarkRangeInput) {
  const values = [...peerValues, ...(own === null ? [] : [own])].filter(Number.isFinite);
  if (peerValues.length === 0 || values.length === 0) return null;
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (lo === hi) {
    // 値が 1 つ（または全社同じ）でも帯の中央に描く
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.1 : 1;
    lo -= pad;
    hi += pad;
  }
  const x = linearScale([lo, hi], [PAD, WIDTH - PAD]);
  const peerMin = Math.min(...peerValues);
  const peerMax = Math.max(...peerValues);
  return {
    bandStart: x(peerMin),
    bandEnd: x(peerMax),
    peers: peerValues.map(x),
    median: median === null ? null : x(median),
    own: own === null ? null : x(own),
  };
}

function Diamond({ cx, className }: { cx: number; className?: string }) {
  const r = 4.5;
  return (
    <polygon
      points={`${cx},${MID - r} ${cx + r},${MID} ${cx},${MID + r} ${cx - r},${MID}`}
      strokeWidth={1}
      className={className}
    />
  );
}

export function BenchmarkRange(props: BenchmarkRangeInput) {
  const layout = benchmarkRangeLayout(props);
  if (!layout) return null;
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      aria-hidden="true"
      focusable="false"
      data-benchmark-range=""
      className="ml-auto mt-1 block h-[18px] w-[120px]"
    >
      <line x1={PAD} x2={WIDTH - PAD} y1={MID} y2={MID} className="stroke-line" strokeWidth={1} />
      <rect
        x={layout.bandStart - 1}
        y={MID - 3}
        width={Math.max(2, layout.bandEnd - layout.bandStart + 2)}
        height={6}
        rx={3}
        strokeWidth={1}
        className="fill-brand-100 stroke-brand-700"
      />
      {layout.peers.map((cx, index) => (
        <circle key={index} cx={cx} cy={MID} r={2.5} className="fill-brand-700" />
      ))}
      {layout.median !== null && (
        <line
          x1={layout.median}
          x2={layout.median}
          y1={2}
          y2={HEIGHT - 2}
          strokeWidth={2}
          className="stroke-ink"
        />
      )}
      {layout.own !== null && <Diamond cx={layout.own} className="fill-ink stroke-surface" />}
    </svg>
  );
}

/** 範囲帯の凡例（印の意味を文字で書く。色だけで区別しない） */
export function BenchmarkRangeLegend() {
  return (
    <ul
      aria-label="範囲の図の見方"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-muted"
    >
      <li className="flex items-center gap-1">
        <svg viewBox="0 0 24 10" aria-hidden="true" focusable="false" className="h-2.5 w-6">
          <rect
            x={1}
            y={2}
            width={22}
            height={6}
            rx={3}
            strokeWidth={1}
            className="fill-brand-100 stroke-brand-700"
          />
          <circle cx={6} cy={5} r={2.5} className="fill-brand-700" />
          <circle cx={18} cy={5} r={2.5} className="fill-brand-700" />
        </svg>
        帯と点: 比較できる社の最小〜最大と各社の値
      </li>
      <li className="flex items-center gap-1">
        <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false" className="size-2.5">
          <line x1={5} x2={5} y1={0} y2={10} strokeWidth={2} className="stroke-ink" />
        </svg>
        縦線: 中央値（{BENCHMARK_MEDIAN_MIN_PEERS} 社以上のとき）
      </li>
      <li className="flex items-center gap-1">
        <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false" className="size-2.5">
          <polygon points="5,0 10,5 5,10 0,5" className="fill-ink" />
        </svg>
        菱形: 自社の確定値
      </li>
      <li>並べ替え・順位付けはしません</li>
    </ul>
  );
}
