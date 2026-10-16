import type { ParsedTable } from '@/lib/imports/parsers';
import { parseActivity, parseMonth, parseRoundingNote, parseScope } from './labels';
import {
  parseNumberWithSeparator,
  unreadableNumberMessage,
  type DecimalSeparator,
} from './number-format';
import { parseUnit } from './units';
import type { BaselineGranularity, BaselineRow } from '@/types/domain';

/**
 * 既存の算定結果の表から行を取り出す（plan §2.2 baseline-parse.ts・CR-11）。純関数。
 *
 * 表の解析（前置き行の検出・Excel）は既存の parsers.ts（detectHeaderRow・parseExcel）が済ませた ParsedTable を
 * 受け取り、ここでは列の対応に従って値を読む。数値は parseFlexibleNumber（読めなければ null・0 にしない）。
 * 粒度は列の有無から決める（拠点×区分の合計だけ／拠点×活動／行）。丸めの記述は構造化し、読めなければ「不明」
 * （照合で丸めの原因を適用しない）。拠点コードから拠点への対応付けは利用者が選んだ unitMapping だけを使う
 * （推測で決めない）。
 */

/** 列の対応（既存結果の列名）。必須は拠点・区分・排出量 */
export interface BaselineColumnMapping {
  siteCode: string;
  scope: string;
  emissions: string;
  emissionsUnit?: string;
  activity?: string;
  month?: string;
  shipmentRef?: string;
  activityAmount?: string;
  activityUnit?: string;
  convertedAmount?: string;
  convertedUnit?: string;
  factorValue?: string;
  factorUnit?: string;
  factorYear?: string;
  method?: string;
  rounding?: string;
  /** 小数点の記号（利用者が選ぶ。無ければ曖昧な「3.741」は読めないまま返す） */
  decimalSeparator?: DecimalSeparator;
}

export interface BaselineParseError {
  rowNo: number;
  message: string;
}

export interface BaselineParseResult {
  rows: BaselineRow[];
  granularity: BaselineGranularity;
  errors: BaselineParseError[];
  /** 対応付けの無い拠点コード（利用者に選んでもらう） */
  unmappedSiteCodes: string[];
}

/** 取り込める行の上限（Supabase Mode。Demo Mode は Cookie の都合でさらに小さい） */
export const BASELINE_MAX_ROWS = 5000;

function cell(row: Record<string, string>, column: string | undefined): string {
  return column ? (row[column] ?? '').trim() : '';
}

function numberOrNull(raw: string, separator: DecimalSeparator | undefined): number | null {
  return raw === '' ? null : parseNumberWithSeparator(raw, separator);
}

export function extractBaselineRows(
  table: Pick<ParsedTable, 'headers' | 'rows' | 'rowNumbers'>,
  mapping: BaselineColumnMapping,
  unitMapping: Readonly<Record<string, string>>,
  options: { defaultEmissionsUnit?: string } = {},
): BaselineParseResult {
  const errors: BaselineParseError[] = [];
  const rows: BaselineRow[] = [];
  const unmapped = new Set<string>();
  for (const required of [mapping.siteCode, mapping.scope, mapping.emissions]) {
    if (!table.headers.includes(required)) {
      return {
        rows: [],
        granularity: 'site_scope',
        errors: [{ rowNo: 0, message: `列「${required}」が見つかりません。` }],
        unmappedSiteCodes: [],
      };
    }
  }
  if (table.rows.length > BASELINE_MAX_ROWS) {
    return {
      rows: [],
      granularity: 'site_scope',
      errors: [{ rowNo: 0, message: `行が多すぎます（上限 ${BASELINE_MAX_ROWS} 行）。` }],
      unmappedSiteCodes: [],
    };
  }
  table.rows.forEach((raw, index) => {
    const rowNo = table.rowNumbers[index] ?? index + 1;
    const siteCode = cell(raw, mapping.siteCode);
    const scope = parseScope(cell(raw, mapping.scope));
    const emissions = numberOrNull(cell(raw, mapping.emissions), mapping.decimalSeparator);
    const problems: string[] = [];
    // 排出量の単位は推測しない: 単位の列を選んだら、その行の欄の値だけを使う（空の欄を既定の単位で埋めると、
    // kg の結果の 1 行が t として読まれ 1,000 倍になる）。列が無いときだけ、利用者が選んだファイル全体の単位を使う
    const unitText = cell(raw, mapping.emissionsUnit);
    const emissionsUnit = mapping.emissionsUnit
      ? unitText
      : (options.defaultEmissionsUnit ?? '').trim();
    if (emissionsUnit === '') {
      problems.push(
        mapping.emissionsUnit
          ? '排出量の単位が空です（推測しません。単位を入れてください）'
          : '排出量の単位がありません（単位の列か、ファイル全体の単位を選んでください。推測しません）',
      );
    }
    if (siteCode === '') problems.push('拠点が空です');
    if (!scope) problems.push(`区分「${cell(raw, mapping.scope)}」を読めません`);
    if (emissions === null) {
      problems.push(
        unreadableNumberMessage('排出量', cell(raw, mapping.emissions), mapping.decimalSeparator),
      );
    }
    if (emissionsUnit !== '' && parseUnit(emissionsUnit)?.dimension !== 'emission') {
      problems.push(`排出量の単位「${emissionsUnit}」を読めません`);
    }
    const activityText = cell(raw, mapping.activity);
    const activity = activityText === '' ? null : parseActivity(activityText);
    if (activityText !== '' && !activity) problems.push(`活動「${activityText}」を読めません`);
    const monthText = cell(raw, mapping.month);
    const month = monthText === '' ? null : parseMonth(monthText);
    if (monthText !== '' && !month) problems.push(`月「${monthText}」を読めません`);
    const optionalNumber = (column: string | undefined, label: string) => {
      const text = cell(raw, column);
      if (text === '') return null;
      const n = parseNumberWithSeparator(text, mapping.decimalSeparator);
      if (n === null) problems.push(unreadableNumberMessage(label, text, mapping.decimalSeparator));
      return n;
    };
    const activityAmount = optionalNumber(mapping.activityAmount, '活動量');
    const convertedAmount = optionalNumber(mapping.convertedAmount, '換算後の量');
    const factorValue = optionalNumber(mapping.factorValue, '排出係数');
    const factorYear = optionalNumber(mapping.factorYear, '係数の年度');
    if (problems.length > 0) {
      errors.push({ rowNo, message: problems.join('。') });
      return;
    }
    const unitId = unitMapping[siteCode] ?? null;
    if (!unitId) unmapped.add(siteCode);
    const roundingNote = cell(raw, mapping.rounding);
    rows.push({
      rowNo,
      siteCode,
      unitId,
      scope: scope!,
      activityKind: activity?.kind ?? null,
      activityCode: activity?.code ?? null,
      month,
      shipmentRef: cell(raw, mapping.shipmentRef) || null,
      activityAmount,
      activityUnit: cell(raw, mapping.activityUnit) || null,
      convertedAmount,
      convertedUnit: cell(raw, mapping.convertedUnit) || null,
      factorValue,
      factorUnit: cell(raw, mapping.factorUnit) || null,
      factorYear: factorYear === null ? null : Math.trunc(factorYear),
      method: cell(raw, mapping.method) || null,
      emissions: emissions!,
      emissionsUnit,
      rounding: parseRoundingNote(roundingNote),
      roundingNote,
    });
  });
  return {
    rows,
    granularity: granularityOf(rows),
    errors,
    unmappedSiteCodes: [...unmapped].sort(),
  };
}

/** 粒度（いちばん細かい行で決める） */
export function granularityOf(rows: readonly BaselineRow[]): BaselineGranularity {
  if (rows.some((r) => r.activityKind && (r.month || r.shipmentRef))) return 'line';
  if (rows.some((r) => r.activityKind)) return 'site_activity';
  return 'site_scope';
}
