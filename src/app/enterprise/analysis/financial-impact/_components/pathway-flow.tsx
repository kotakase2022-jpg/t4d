import { ChartFrame, type ChartTable } from '@/components/charts/chart-frame';
import { layoutPathwayFlow, fitText, type FlowRowInput } from '@/lib/charts/flow-layout';
import { TIME_HORIZON_LABEL, TIME_HORIZON_MEANING } from '@/lib/domain/dma';
import {
  FINANCIAL_LINES,
  FINANCIAL_LINE_LABEL,
  fiscalYearLabel,
  pathwayOriginLabel,
  type PathwayId,
  type PathwayResult,
} from '@/lib/domain/financial-impact';
import { formatNumber } from '@/lib/format/datetime';
import type { ImpactOrigin, RelatedItem } from '@/lib/services/analysis/financial-impact';
import { directionWord } from './impact-badges';
import { cellText, startText } from './format';

/**
 * 経路図（docs/disclosure-first.md §10.3）。4 列: 起点（指標・定性・IRO）→ 仕組み → 財務項目 → 時間帯。
 * 帯の太さは |参照年（FY2030）の影響| に比例、未定量は細い破線＋「未定量」の文字（太さで 0 と読ませない）。
 * 帯の文字（「開始 FY2028・減益」）で向きと時期を示し、色で良し悪しを示さない。
 * 配置は純関数 layoutPathwayFlow（src/lib/charts/flow-layout.ts）。
 */

const UNKNOWN_BAND = 'unknown';

function bandSpecs() {
  return [
    ...(['short', 'medium', 'long'] as const).map((key) => ({
      key,
      label: TIME_HORIZON_LABEL[key],
      sub: TIME_HORIZON_MEANING[key],
    })),
    { key: UNKNOWN_BAND, label: '時期未定', sub: '開始年の入力待ち', dashed: true },
  ];
}

function relatedTags(related: readonly RelatedItem[]): string | null {
  const iros = [
    ...new Set(
      related
        .filter((r) => r.kind === 'iro')
        .map((r) => r.href.split('/').at(-1) ?? '')
        .filter(Boolean),
    ),
  ];
  const narratives = related.filter((r) => r.kind === 'narrative').length;
  const ssbj = related.filter((r) => r.kind === 'ssbj').length;
  const parts = [
    ...(iros.length > 0 ? [`IRO ${iros.join('・')}`] : []),
    ...(narratives > 0 ? [`定性 ${narratives}`] : []),
    ...(ssbj > 0 ? ['SSBJ'] : []),
  ];
  return parts.length === 0 ? null : parts.join('・');
}

function rowText(result: PathwayResult): string {
  if (result.status === 'no_origin') return '未算定（確定値なし）';
  if (result.status !== 'quantified') return '未定量（入力待ち）';
  return `${startText(result)}・${directionWord(result.cumulative ?? 0)}`;
}

export function PathwayFlow({
  pathways,
  origins,
  relatedByPathway,
  referenceYear,
}: {
  pathways: readonly PathwayResult[];
  origins: readonly ImpactOrigin[];
  relatedByPathway: Record<PathwayId, RelatedItem[]>;
  referenceYear: number;
}) {
  const shown = pathways.filter((p) => p.status !== 'disabled');
  const disabled = pathways.filter((p) => p.status === 'disabled');
  const valueAtReference = (result: PathwayResult) =>
    result.years.find((y) => y.year === referenceYear)?.value ?? null;

  const rows: FlowRowInput[] = shown.map((result) => {
    const pathway = result.pathway;
    const driver = pathway.origin.kind === 'metric' ? pathway.origin.driver : null;
    const origin = driver ? (origins.find((o) => o.driver === driver) ?? null) : null;
    const valueText =
      driver === null
        ? '入力値'
        : origin && origin.value !== null
          ? `${formatNumber(origin.value)} ${origin.spec.unit}`
          : '確定値なし';
    const tags = relatedTags(relatedByPathway[pathway.id]);
    return {
      id: pathway.id,
      origin: {
        label: origin?.spec.label ?? pathwayOriginLabel(pathway),
        sub: valueText,
        note: tags,
      },
      mechanism: { label: pathway.mechanism, sub: `${pathway.id}・時間差 ${result.lag} 年` },
      lineKey: pathway.line,
      bandKey: result.band ?? UNKNOWN_BAND,
      magnitude: result.status === 'quantified' ? Math.abs(valueAtReference(result) ?? 0) : null,
      text: rowText(result),
    };
  });

  const layout = layoutPathwayFlow({
    rows,
    lines: FINANCIAL_LINES.map((key) => ({ key, label: FINANCIAL_LINE_LABEL[key] })),
    bands: bandSpecs(),
    extraLineNodes: [
      {
        key: 'cost_of_capital',
        label: '資本コスト',
        sub: '未定量',
        note: '根拠データなし',
        dashed: true,
      },
    ],
    columnTitles: ['起点（指標・定性・IRO）', '仕組み', '財務項目', '時間帯'],
  });

  const lineLabel = (result: PathwayResult) => FINANCIAL_LINE_LABEL[result.pathway.line];
  const bandLabel = (result: PathwayResult) =>
    result.band
      ? `${TIME_HORIZON_LABEL[result.band]}（${TIME_HORIZON_MEANING[result.band]}）`
      : '時期未定';
  const referenceText = (result: PathwayResult) => {
    if (result.status !== 'quantified') return result.reason ?? '未定量';
    // 制度開始前・時間差の 0 は注記つき（未定量と混ぜない）
    const cell = result.years.find((y) => y.year === referenceYear);
    return cell ? `${cellText(cell, result.pathway.preStartLabel)} 百万円` : '未定量';
  };

  const summary = `経路図（起点 → 仕組み → 財務項目 → 時間帯。帯の太さは ${fiscalYearLabel(referenceYear)} の影響の大きさ）。${shown
    .map(
      (r) =>
        `${r.pathway.id} ${rows.find((row) => row.id === r.pathway.id)?.origin.label ?? ''} → ${r.pathway.mechanism} → ${lineLabel(r)} → ${bandLabel(r)}、${rowText(r)}、${fiscalYearLabel(referenceYear)} ${referenceText(r)}`,
    )
    .join('。')}。資本コストは未定量（根拠データなし）。`;

  const table: ChartTable = {
    caption: `経路ごとの起点・仕組み・財務項目・時間帯と ${fiscalYearLabel(referenceYear)} の影響（百万円、＋増益・−減益）`,
    columns: [
      { label: '経路', align: 'left' },
      { label: '起点', align: 'left' },
      { label: '仕組み', align: 'left' },
      { label: '財務項目', align: 'left' },
      { label: '時間帯', align: 'left' },
      { label: `${fiscalYearLabel(referenceYear)} の影響`, align: 'right' },
    ],
    rows: shown.map((r) => {
      const row = rows.find((x) => x.id === r.pathway.id);
      return {
        key: r.pathway.id,
        cells: [
          r.pathway.id,
          row
            ? `${row.origin.label}（${[row.origin.sub, row.origin.note].filter(Boolean).join('・')}）`
            : '',
          r.pathway.mechanism,
          lineLabel(r),
          `${bandLabel(r)}・${rowText(r)}`,
          referenceText(r),
        ],
      };
    }),
  };

  return (
    <ChartFrame
      title="経路図（どの経路で・いつ・財務のどこに効くか）"
      summary={summary}
      width={layout.width}
      height={layout.height}
      note={
        <>
          帯の太さは {fiscalYearLabel(referenceYear)} の影響の大きさ。破線は未定量（0
          ではありません）。
          {disabled.length > 0 &&
            ` 無効の経路（${disabled.map((d) => d.pathway.id).join('・')}）は図に含めません。`}
        </>
      }
      table={table}
    >
      {layout.columns.map((column) => (
        <text
          key={column.title}
          x={column.x}
          y={16}
          fontSize={11}
          fontWeight={600}
          className="fill-ink-muted"
        >
          {column.title}
        </text>
      ))}

      {layout.links.map((link) =>
        link.dashed ? (
          <path
            key={`${link.rowId}-${link.column}`}
            d={link.d}
            fill="none"
            strokeWidth={link.thickness}
            strokeDasharray="4 3"
            className="stroke-ink-muted"
          />
        ) : (
          <path
            key={`${link.rowId}-${link.column}`}
            d={link.d}
            strokeWidth={0.75}
            fillOpacity={0.85}
            className="fill-brand-200 stroke-brand-700"
          />
        ),
      )}

      {layout.nodes.map((node) => (
        <g key={node.key}>
          <rect
            x={node.x}
            y={node.y}
            width={node.width}
            height={node.height}
            rx={4}
            strokeWidth={1}
            strokeDasharray={node.dashed ? '4 3' : undefined}
            className={node.dashed ? 'fill-surface stroke-ink-muted' : 'fill-surface stroke-line'}
          />
          <text x={node.x + 6} y={node.y + 15} fontSize={11} className="fill-ink">
            {fitText(node.label, node.width - 12)}
          </text>
          {node.sub && (
            <text x={node.x + 6} y={node.y + 28} fontSize={11} className="fill-ink-muted">
              {fitText(node.sub, node.width - 12)}
            </text>
          )}
          {node.note && (
            <text x={node.x + 6} y={node.y + 41} fontSize={11} className="fill-ink-muted">
              {fitText(node.note, node.width - 12)}
            </text>
          )}
        </g>
      ))}

      {layout.labels.map((label) => (
        <text
          key={`label-${label.rowId}`}
          x={label.x}
          y={label.y}
          fontSize={11}
          // 交差する帯の上でも読めるよう、背景色の縁取りを文字の下に敷く
          strokeWidth={3}
          strokeLinejoin="round"
          paintOrder="stroke"
          className="fill-ink-muted stroke-surface"
        >
          {label.text}
        </text>
      ))}
    </ChartFrame>
  );
}
