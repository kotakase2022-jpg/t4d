import {
  formatMillionYen,
  fiscalYearLabel,
  type PathwayResult,
} from '@/lib/domain/financial-impact';

/** 円 → 百万円（図の値。丸めは表示だけ） */
export function toMillion(value: number | null): number | null {
  return value === null ? null : value / 1_000_000;
}

/** 図の数値（百万円の値に符号を付け、小数 1 桁） */
export function millionLabel(valueInMillion: number): string {
  return formatMillionYen(valueInMillion * 1_000_000);
}

/** 符号付きの割合（小数 1 桁。営業利益比などの参考表示） */
export function signedPercent(ratio: number): string {
  const text = Math.abs(ratio * 100).toFixed(1);
  if (Number(text) === 0) return '0.0%';
  return `${ratio > 0 ? '+' : '−'}${text}%`;
}

/** 経路の 1 年のセルの表示（制度開始前・時間差は 0 に注記、未定量は「未定量」） */
export function cellText(cell: PathwayResult['years'][number], preStartLabel: string): string {
  if (cell.value === null) return '未定量';
  const text = formatMillionYen(cell.value);
  if (cell.note === 'pre_start') return `${text}（${preStartLabel}）`;
  if (cell.note === 'lag') return `${text}（時間差）`;
  return text;
}

/** 経路の影響が始まる年の文言（「開始 FY2028」。分からなければ「開始年未定」） */
export function startText(result: PathwayResult): string {
  return result.firstEffectYear === null
    ? '開始年未定'
    : `開始 ${fiscalYearLabel(result.firstEffectYear)}`;
}
