import { parseFlexibleNumber } from '@/lib/imports/number';

/**
 * 取込の数の表記（GHG の活動量・既存の算定結果。純関数）。
 *
 * 既定の parseFlexibleNumber は「3.741」を 3.741（日英式）とも 3741（独仏式）とも読めるため null を返す
 * （1/1000 の値を書き込む事故を防ぐ）。排出量（t・小数 3 桁）や活動量はこの形が多いので、取込の
 * 列の対応付けで利用者が小数点の記号を選べるようにする。選ばなければ既定の判定のまま（推測しない）。
 *  - dot: 小数点は「.」、桁区切りは「,」と空白（日本・英語圏。表計算の数値のセルもこの形で読める）
 *  - comma: 小数点は「,」、桁区切りは「.」と空白（独仏など）
 */
export const DECIMAL_SEPARATORS = ['dot', 'comma'] as const;
export type DecimalSeparator = (typeof DECIMAL_SEPARATORS)[number];

export const DECIMAL_SEPARATOR_LABELS: Record<DecimalSeparator, string> = {
  dot: '小数点は「.」（例 1,234.5）',
  comma: '小数点は「,」（例 1.234,5）',
};

export function parseNumberWithSeparator(
  raw: string,
  separator: DecimalSeparator | null | undefined,
): number | null {
  if (!separator) return parseFlexibleNumber(raw);
  let v = raw.normalize('NFKC').trim();
  if (v === '') return null;
  v = v.replace(/[%％]/g, '').replace(/[△▲]/g, '-').trim();
  const m = v.match(/^[-+]?[\d.,\s]+/);
  if (!m) return null;
  v = m[0].replace(/\s/g, '');
  if (separator === 'dot') {
    if ((v.match(/\./g) ?? []).length > 1) return null;
    v = v.replace(/,/g, '');
  } else {
    if ((v.match(/,/g) ?? []).length > 1) return null;
    v = v.replace(/\./g, '').replace(',', '.');
  }
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 読めなかったときの文（小数点の記号を選んでいなければ、選ぶよう促す） */
export function unreadableNumberMessage(
  label: string,
  text: string,
  separator: DecimalSeparator | null | undefined,
): string {
  return separator
    ? `${label}「${text}」を数として読めません`
    : `${label}「${text}」を数として読めません（小数点の記号を選ぶと読める場合があります）`;
}
