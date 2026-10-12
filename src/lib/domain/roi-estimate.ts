/**
 * 費用対効果の試算（トライアル対応 NF-36）。DB にも画面にも依存しない純粋関数だけ。
 *
 *  - 試算であり、実測した効果ではない。創出した時間は「人件費の現金削減」を意味しない（画面と出力に固定の注記）
 *  - 入力は利用者が URL に載せるだけで保存しない（財務影響分析と同じ。共有は URL で行う）
 *  - 単価・比較する費用は利用者が入れる。製品に価格・単価の既定値を埋め込まない（例の値も初期値にしない）
 *  - 負の値・数値でない値は誤りとして返し、試算しない。0 は 0 として計算する（0 円・0 時間）
 */

/** URL の引数の名前 */
export const ROI_PARAM = {
  unitPriceYen: 'price',
  departments: 'depts',
  monthlyHours: 'hours',
  months: 'months',
  /** 月あたり削減時間の出所（manual＝手入力、timing＝作業時間の記録から換算） */
  source: 'src',
  /** 作業時間の記録から換算するときの、月あたりの対象作業の件数（1 部門あたり） */
  unitsPerMonth: 'volume',
  /** 作業時間の記録から換算する作業（1 つ。作業ごとに単位が違うため合計しない） */
  task: 'task',
  /** 記録からの推定（参考値）を含む作業も換算に使う（'1' のときだけ） */
  includeReference: 'ref',
} as const;

/** 比較する費用（利用者が入れる。製品に価格を持たない） */
export const ROI_COST_FIELDS = [
  { key: 'initial', param: 'cost_initial', label: '導入費用' },
  { key: 'annual', param: 'cost_annual', label: '年間の利用費用' },
  { key: 'training', param: 'cost_training', label: '教育費用' },
  { key: 'parallel', param: 'cost_parallel', label: '並行運用の費用' },
  { key: 'option', param: 'cost_option', label: 'オプションの費用' },
] as const;
export type RoiCostKey = (typeof ROI_COST_FIELDS)[number]['key'];

export type RoiHoursSource = 'manual' | 'timing';

/** 月数の上限（10 年） */
export const ROI_MAX_MONTHS = 120;

export interface RoiInput {
  /** 社内換算単価（円 / 時間） */
  unitPriceYen: number;
  /** 対象部門数 */
  departments: number;
  /** 1 部門の月あたり削減時間（時間） */
  monthlyHours: number;
  months: number;
  /** 比較する費用（円）。入れていない費用は含めない */
  costs: number[];
}

export interface RoiResult {
  /** 創出時間（期間の合計） */
  hours: number;
  /** 円換算 */
  yen: number;
  /** 比較する費用の合計。費用を 1 つも入れていなければ null */
  totalCost: number | null;
  /** 円換算 − 費用の合計 */
  difference: number | null;
  /** 円換算 ÷ 費用の合計（費用が 0 なら出さない） */
  ratio: number | null;
}

export function estimateRoi(input: RoiInput): RoiResult {
  const hours = input.monthlyHours * input.departments * input.months;
  const yen = hours * input.unitPriceYen;
  const totalCost = input.costs.length > 0 ? input.costs.reduce((sum, c) => sum + c, 0) : null;
  return {
    hours,
    yen,
    totalCost,
    difference: totalCost === null ? null : yen - totalCost,
    ratio: totalCost === null || totalCost <= 0 ? null : yen / totalCost,
  };
}

/**
 * 作業時間の記録から月あたりの削減時間（時間）を出す: 1 単位あたりの短縮分（分）× 月あたりの件数 ÷ 60。
 * 短縮分が負（T4D の方が長い）なら 0 を下限にしない（増えたことをそのまま試算に出す）
 */
export function monthlyHoursFromSavedMinutes(
  savedMinutesPerUnit: number,
  unitsPerMonth: number,
): number {
  return (savedMinutesPerUnit * unitsPerMonth) / 60;
}

/** 換算に使う作業の短縮の要約（trial-metrics.ts の TaskReduction と同じ形の一部） */
export interface RoiTimingTask {
  taskKey: string;
  savedMinutesPerUnit: number | null;
  baseline: { n: number; methods: readonly string[]; includesLogEstimate: boolean };
  t4d: { n: number; methods: readonly string[]; includesLogEstimate: boolean };
}

export interface RoiTimingBasis<T extends RoiTimingTask> {
  /** 換算に選べる作業（両方 n ≥ 3。参考値を含む作業は、含めると選んだときだけ） */
  candidates: T[];
  /** 記録からの推定（参考値）を含むため、既定では選べない作業 */
  referenceOnly: T[];
  /** 換算に使う作業（1 つ）。選べない・選んでいなければ null */
  selected: T | null;
  /** 換算できない理由（null は換算できる） */
  reason: string | null;
}

/** 記録からの推定（待ち時間を含む参考値）を含むか */
export function includesReferenceTiming(task: RoiTimingTask): boolean {
  return task.baseline.includesLogEstimate || task.t4d.includesLogEstimate;
}

/**
 * 作業時間の記録から月あたり削減時間を換算するときの作業を決める（K10: 率には n と測り方を添える）。
 *  - 両方 n ≥ 3 の作業だけ。記録からの推定（参考値）を含む作業は、利用者が含めると選んだときだけ
 *  - 作業ごとに単位（行・節など）が違うため、短縮分を足し合わせない。換算する作業を 1 つ選ぶ
 *    （選べる作業が 1 つだけならそれを使う）
 */
export function roiTimingBasis<T extends RoiTimingTask>(
  tasks: readonly T[],
  options: { task: string; includeReference: boolean },
): RoiTimingBasis<T> {
  const measurable = tasks.filter((t) => t.savedMinutesPerUnit !== null);
  const referenceOnly = measurable.filter(includesReferenceTiming);
  const candidates = options.includeReference
    ? measurable
    : measurable.filter((t) => !includesReferenceTiming(t));
  const chosen = candidates.find((t) => t.taskKey === options.task) ?? null;
  const selected = chosen ?? (candidates.length === 1 ? candidates[0]! : null);
  let reason: string | null = null;
  if (candidates.length === 0) {
    reason =
      referenceOnly.length > 0
        ? '換算できる作業は、記録からの推定（参考値）を含むものだけです。参考値を含めて換算するか、手入力で試算してください。'
        : '作業時間の記録から換算できる作業がありません（現行と T4D の両方が 3 件以上の作業が必要です）。手入力で試算してください。';
  } else if (!selected) {
    reason =
      '換算する作業を 1 つ選んでください（作業ごとに単位が違うため、短縮分を合計しません）。';
  }
  return { candidates, referenceOnly, selected, reason };
}

type Params = Record<string, string | string[] | undefined>;

function first(params: Params, key: string): string {
  const value = params[key];
  return (Array.isArray(value) ? (value[0] ?? '') : (value ?? '')).trim();
}

interface NumberRule {
  label: string;
  integer?: boolean;
  max?: number;
}

/** 数値の欄を読む。空は null、誤りは errors に足して null */
function parseNumber(raw: string, rule: NumberRule, errors: string[]): number | null {
  if (raw === '') return null;
  const normalized = raw
    .replace(/[,，\s]/g, '')
    .replace(/[０-９．－]/g, (c) =>
      c === '．' ? '.' : c === '－' ? '-' : String.fromCharCode(c.charCodeAt(0) - 0xfee0),
    );
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    errors.push(`${rule.label}は数値で入力してください。`);
    return null;
  }
  const value = Number(normalized);
  if (value < 0) {
    errors.push(`${rule.label}は 0 以上で入力してください。`);
    return null;
  }
  if (rule.integer && !Number.isInteger(value)) {
    errors.push(`${rule.label}は整数で入力してください。`);
    return null;
  }
  if (rule.max !== undefined && value > rule.max) {
    errors.push(`${rule.label}は ${rule.max} 以下で入力してください。`);
    return null;
  }
  return value;
}

export interface ParsedRoiParams {
  /** フォームへ戻す生の値 */
  raw: Record<string, string>;
  source: RoiHoursSource;
  unitPriceYen: number | null;
  departments: number | null;
  /** 手入力の月あたり削減時間 */
  monthlyHours: number | null;
  months: number | null;
  unitsPerMonth: number | null;
  costs: Array<{ key: RoiCostKey; label: string; yen: number }>;
  errors: string[];
  /** 何か入力があるか（未入力の初期表示では誤りも結果も出さない） */
  touched: boolean;
}

/** URL の引数から試算の入力を読む（保存しない） */
export function parseRoiParams(params: Params): ParsedRoiParams {
  const errors: string[] = [];
  const raw: Record<string, string> = {};
  for (const key of Object.values(ROI_PARAM)) raw[key] = first(params, key);
  for (const field of ROI_COST_FIELDS) raw[field.param] = first(params, field.param);
  const source: RoiHoursSource = raw[ROI_PARAM.source] === 'timing' ? 'timing' : 'manual';
  const unitPriceYen = parseNumber(
    raw[ROI_PARAM.unitPriceYen]!,
    { label: '社内換算単価', max: 1_000_000 },
    errors,
  );
  const departments = parseNumber(
    raw[ROI_PARAM.departments]!,
    { label: '対象部門数', integer: true, max: 10_000 },
    errors,
  );
  const monthlyHours =
    source === 'manual'
      ? parseNumber(
          raw[ROI_PARAM.monthlyHours]!,
          { label: '月あたり削減時間', max: 10_000 },
          errors,
        )
      : null;
  const months = parseNumber(
    raw[ROI_PARAM.months]!,
    { label: '月数', integer: true, max: ROI_MAX_MONTHS },
    errors,
  );
  const unitsPerMonth =
    source === 'timing'
      ? parseNumber(
          raw[ROI_PARAM.unitsPerMonth]!,
          { label: '月あたりの件数', max: 1_000_000 },
          errors,
        )
      : null;
  const costs: ParsedRoiParams['costs'] = [];
  for (const field of ROI_COST_FIELDS) {
    const yen = parseNumber(raw[field.param]!, { label: field.label, max: 1e12 }, errors);
    if (yen !== null) costs.push({ key: field.key, label: field.label, yen });
  }
  const touched = Object.entries(raw).some(([key, value]) => key !== ROI_PARAM.source && value);
  return {
    raw,
    source,
    unitPriceYen,
    departments,
    monthlyHours,
    months,
    unitsPerMonth,
    costs,
    errors,
    touched,
  };
}

/** 試算に足りない欄（誤りではなく未入力） */
export function missingRoiFields(parsed: ParsedRoiParams): string[] {
  const missing: string[] = [];
  if (parsed.unitPriceYen === null) missing.push('社内換算単価');
  if (parsed.departments === null) missing.push('対象部門数');
  if (parsed.source === 'manual' && parsed.monthlyHours === null) missing.push('月あたり削減時間');
  if (parsed.source === 'timing' && parsed.unitsPerMonth === null) missing.push('月あたりの件数');
  if (parsed.months === null) missing.push('月数');
  return missing;
}
