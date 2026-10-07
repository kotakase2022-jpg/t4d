import { DMA_OUTCOME_LABEL, ESRS_TOPIC_LABEL } from '@/lib/domain/csrd';
import type { DmaThresholds } from '@/lib/domain/dma';
import {
  QUADRANT_LABEL,
  formatScore,
  gridX,
  gridY,
  layoutDmaMatrix,
  type DmaMatrixInput,
} from '../dma-view';

/**
 * ダブル・マテリアリティ・マトリクス（docs/disclosure-first.md §9.4）。
 * 縦＝インパクト重要性（インパクトのスコア）、横＝財務的重要性（リスク・機会のスコア）。
 *
 * - 位置は算定結果（自社の方法・閾値による提案）。人の判断は表と説明文（desc）に書く
 * - 図だけで意味を伝えない: 同じ内容の表を隣に置き、図には名前と説明を付ける（role="img"）
 * - 色だけに頼らない: 点には事項コード、人の判断が未評価の事項は破線の白抜きの印、凡例で説明する
 * - グラフ用のライブラリは使わない（素の SVG。依存を増やさない）
 *
 * Server Component から使う（フックを使わない）。1 画面に 1 つなので ID は固定の接頭辞で足りる。
 */
export function DmaMatrix({
  inputs,
  thresholds,
  idPrefix = 'csrd-dma-matrix',
}: {
  inputs: readonly DmaMatrixInput[];
  thresholds: DmaThresholds;
  idPrefix?: string;
}) {
  const layout = layoutDmaMatrix(inputs, thresholds);
  const { plot } = layout;
  const titleId = `${idPrefix}-title`;
  const descId = `${idPrefix}-desc`;
  const description = [
    `横軸は財務的重要性（リスク・機会のスコア）、縦軸はインパクト重要性（インパクトのスコア）。` +
      `閾値は インパクト ${formatScore(thresholds.impactThreshold)}・財務 ${formatScore(thresholds.financialThreshold)}。` +
      '位置は算定結果（提案）です。',
    ...inputs.map(
      (p) =>
        `${p.topic} ${ESRS_TOPIC_LABEL[p.topic]}: インパクト ${formatScore(p.impactScore)}・財務 ${formatScore(p.financialScore)}（人の判断: ${DMA_OUTCOME_LABEL[p.outcome]}）`,
    ),
  ].join(' ');

  return (
    <figure className="space-y-2">
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="h-auto w-full max-w-[440px]"
      >
        <title id={titleId}>
          ダブル・マテリアリティ・マトリクス（算定結果の位置。表と同じ内容）
        </title>
        <desc id={descId}>{description}</desc>

        {/* どちらかの観点で閾値以上の領域（重要を提案する領域）を薄く塗る。意味は凡例と象限の名前で示す */}
        <rect
          x={layout.thresholdX}
          y={plot.top}
          width={Math.max(0, plot.right - layout.thresholdX)}
          height={plot.bottom - plot.top}
          className="fill-brand-50"
        />
        <rect
          x={plot.left}
          y={plot.top}
          width={Math.max(0, layout.thresholdX - plot.left)}
          height={Math.max(0, layout.thresholdY - plot.top)}
          className="fill-brand-50"
        />

        {/* 5×5 の枠 */}
        {layout.gridLines.map((value) => (
          <g key={`grid-${value}`} className="stroke-line">
            <line x1={gridX(value)} x2={gridX(value)} y1={plot.top} y2={plot.bottom} />
            <line x1={plot.left} x2={plot.right} y1={gridY(value)} y2={gridY(value)} />
          </g>
        ))}

        {/* 目盛 */}
        {layout.ticks.map((tick) => (
          <g key={`tick-${tick.score}`} className="fill-ink-muted" fontSize={10}>
            <text x={tick.x} y={plot.bottom + 14} textAnchor="middle">
              {tick.score}
            </text>
            <text x={plot.left - 8} y={tick.y + 3} textAnchor="end">
              {tick.score}
            </text>
          </g>
        ))}

        {/* 軸の名前 */}
        <text
          x={(plot.left + plot.right) / 2}
          y={plot.bottom + 32}
          textAnchor="middle"
          fontSize={11}
          className="fill-ink"
        >
          財務的重要性（リスク・機会のスコア）→
        </text>
        <text
          x={16}
          y={(plot.top + plot.bottom) / 2}
          textAnchor="middle"
          fontSize={11}
          className="fill-ink"
          transform={`rotate(-90 16 ${(plot.top + plot.bottom) / 2})`}
        >
          インパクト重要性（インパクトのスコア）→
        </text>

        {/* 閾値（会社が決めた値。ESRS は数値の閾値を定めていない） */}
        <g className="stroke-brand-700" strokeDasharray="5 3" strokeWidth={1.5}>
          <line x1={layout.thresholdX} x2={layout.thresholdX} y1={plot.top} y2={plot.bottom} />
          <line x1={plot.left} x2={plot.right} y1={layout.thresholdY} y2={layout.thresholdY} />
        </g>
        <text
          x={layout.thresholdLabels.financial.x}
          y={layout.thresholdLabels.financial.y}
          fontSize={9}
          className="fill-brand-800"
        >
          財務閾値 {formatScore(thresholds.financialThreshold)}
        </text>
        <text
          x={layout.thresholdLabels.impact.x}
          y={layout.thresholdLabels.impact.y}
          fontSize={9}
          className="fill-brand-800"
        >
          インパクト閾値 {formatScore(thresholds.impactThreshold)}
        </text>

        {/* 象限の名前（提案） */}
        {layout.quadrants.map((q) => (
          <text
            key={q.outcome}
            x={q.x}
            y={q.y}
            textAnchor={q.anchor}
            fontSize={10}
            className="fill-ink-muted"
          >
            {QUADRANT_LABEL[q.outcome]}
          </text>
        ))}

        {/* 事項（算定結果の位置） */}
        {layout.points.map((p) => (
          <g key={p.topic} data-decided={p.decided ? 'true' : 'false'}>
            {p.decided ? (
              <circle cx={p.cx} cy={p.cy} r={4} className="fill-brand-700" />
            ) : (
              <circle
                cx={p.cx}
                cy={p.cy}
                r={4}
                strokeDasharray="2 1.5"
                strokeWidth={1.5}
                className="fill-surface stroke-ink"
              />
            )}
            <text
              x={p.labelX}
              y={p.labelY}
              textAnchor={p.anchor}
              fontSize={11}
              fontWeight={600}
              className="fill-ink"
            >
              {p.topic}
            </text>
          </g>
        ))}
      </svg>

      <figcaption className="space-y-1 text-caption leading-relaxed text-ink-muted">
        <ul aria-label="マトリクスの凡例" className="flex flex-wrap gap-x-3 gap-y-0.5">
          <li className="flex items-center gap-1">
            <svg viewBox="0 0 10 10" className="size-2.5" aria-hidden="true">
              <circle cx={5} cy={5} r={4} className="fill-brand-700" />
            </svg>
            人が判断済みの事項
          </li>
          <li className="flex items-center gap-1">
            <svg viewBox="0 0 10 10" className="size-2.5" aria-hidden="true">
              <circle
                cx={5}
                cy={5}
                r={3.5}
                strokeDasharray="2 1.5"
                strokeWidth={1.2}
                className="fill-surface stroke-ink"
              />
            </svg>
            人の判断が未評価の事項
          </li>
          <li>破線: 自社の閾値（ESRS は数値の閾値を定めていません）</li>
          <li>
            閾値の線より 右上: {QUADRANT_LABEL.both}・左上: {QUADRANT_LABEL.impact_only}・右下:{' '}
            {QUADRANT_LABEL.financial_only}・左下: {QUADRANT_LABEL.not_material}
          </li>
        </ul>
        {layout.unplaced.length > 0 && (
          <p>
            評価材料が無く配置できない事項:{' '}
            {layout.unplaced.map((p) => `${p.topic} ${ESRS_TOPIC_LABEL[p.topic]}`).join('、')}
            （インパクトかリスク・機会の IRO が無い側があります）
          </p>
        )}
      </figcaption>
    </figure>
  );
}
