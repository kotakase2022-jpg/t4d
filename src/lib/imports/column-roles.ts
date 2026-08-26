/**
 * 列の役割判定。
 *
 * 人事システムの帳票には、数字に見えるが値ではない列が並ぶ。
 *   - ゼロ埋めコード（部門コード 0012、社員番号 0001）
 *   - 日付（20260401、令和8年4月1日、R8.4.1）
 *   - 前年同期の実績（上年同期用工总数、Prior Year Headcount）
 * 行内で最初に見つかった数値を値として採ると、これらが台帳へ入ってしまう。
 *
 * 列名（機械的な名前も含む）と、列全体の値の形の両方から役割を決める。
 * どちらか一方だけでは足りない: 列名が `SWDF010` のような機械コードのこともあれば、
 * 値がたまたま数字に見えることもある。
 */

import { parseFlexibleNumber } from './number';

export type ColumnRole =
  /** 識別子。値として採らない */
  | 'code'
  /** 日付。値として採らない */
  | 'date'
  /** 前年・前期の実績。当年の値として採らない */
  | 'previous'
  /** 期間の表記（FY2026 / CY2026） */
  | 'period'
  /** 単位（人 / % / t-CO2e） */
  | 'unit'
  /** 数値の値。取込対象 */
  | 'value'
  /** 文字列のラベル */
  | 'label';

const CODE_HEADER =
  /コード|ｺｰﾄﾞ|番号|CD$|_CD|_NO|\bID\b|ID$|code|no\.?$|number|userid|position id|worker id|employee id|社員|会社番号|拠点番号|编码|编号/i;

const DATE_HEADER =
  /年月日|日付|基準日|締日|入社|退社|退職日|発令日|取得日|期間開始|期間終了|date|stichtag|p[ée]riode du|reporting date|snapshot|as of|時点|统计日期|日期/i;

const PREVIOUS_HEADER =
  /前年|前期|昨年|前回|上年|去年|prior[- ]?year|previous|last year|py\b|vorjahr|ann[ée]e pr[ée]c[ée]dente|同期比/i;

const PERIOD_HEADER = /対象期間|期間|年度|報告期間|period|zeitraum|p[ée]riode|期间|会計年度/i;

const UNIT_HEADER = /^(単位|unit|einheit|unit[ée]|计量单位)$/i;

/** ゼロ埋め（"0012"）に見える値 */
function isZeroPadded(value: string): boolean {
  const v = value.trim();
  return /^0\d+$/.test(v);
}

/** 日付に見える値（8 桁・区切りあり・和暦） */
function looksDate(value: string): boolean {
  const v = value.normalize('NFKC').trim();
  if (v === '') return false;
  if (/^(令和|平成|昭和|[RHS])\s?\d{1,2}[年.\-/]\s?\d{1,2}[月.\-/]\s?\d{1,2}日?$/.test(v))
    return true;
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(v)) return true;
  if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$/.test(v)) return true;
  if (/^\d{4}年\d{1,2}月\d{1,2}日$/.test(v)) return true;
  // 8 桁の数字は日付の可能性が高い（20260401）。年として妥当な範囲だけ
  if (/^(19|20)\d{6}$/.test(v)) return true;
  return false;
}

function looksNumeric(value: string): boolean {
  return parseFlexibleNumber(value) !== null;
}

/** 列ごとの値のうち、空でないものを集める */
function columnValues(rows: Array<Record<string, string>>, header: string): string[] {
  return rows.map((r) => (r[header] ?? '').trim()).filter((v) => v !== '');
}

/** 過半数が条件を満たすか（1 行だけ形が違うファイルに引きずられないため） */
function majority(values: string[], predicate: (v: string) => boolean): boolean {
  if (values.length === 0) return false;
  return values.filter(predicate).length / values.length > 0.5;
}

/**
 * 表の列に役割を割り当てる。
 * 列名の手掛かりを優先し、無ければ値の形で判定する。
 */
export function classifyColumns(
  headers: string[],
  rows: Array<Record<string, string>>,
): Record<string, ColumnRole> {
  const roles: Record<string, ColumnRole> = {};

  for (const header of headers) {
    const values = columnValues(rows, header);
    const name = header.normalize('NFKC');

    // 列名による判定（前年 → 単位 → 期間 → 日付 → コード の順。
    // 「前年同期在籍者数」のように複数に当たる名前は、より限定的な方を採る）
    if (PREVIOUS_HEADER.test(name)) {
      roles[header] = 'previous';
      continue;
    }
    if (UNIT_HEADER.test(name)) {
      roles[header] = 'unit';
      continue;
    }
    if (DATE_HEADER.test(name)) {
      roles[header] = 'date';
      continue;
    }
    if (PERIOD_HEADER.test(name)) {
      roles[header] = 'period';
      continue;
    }
    if (CODE_HEADER.test(name)) {
      roles[header] = 'code';
      continue;
    }

    // 値の形による判定
    if (majority(values, isZeroPadded)) {
      roles[header] = 'code';
      continue;
    }
    if (majority(values, looksDate)) {
      roles[header] = 'date';
      continue;
    }
    if (majority(values, looksNumeric)) {
      roles[header] = 'value';
      continue;
    }
    roles[header] = 'label';
  }

  return roles;
}

/**
 * 行から「取り込むべき値」を 1 つ選ぶ。
 *
 * 候補が 1 列に定まらないときは **null を返して人へ委ねる**。
 * 男女別の 2 列があるような表で、勝手にどちらかを選ぶと静かに誤った値が入る。
 */
export function pickValueCell(
  raw: Record<string, string>,
  roles: Record<string, ColumnRole>,
): { header: string; value: number } | null {
  const candidates = Object.entries(roles).filter(([, role]) => role === 'value');
  if (candidates.length !== 1) return null;
  const header = candidates[0]?.[0];
  if (header === undefined) return null;
  const value = parseFlexibleNumber(raw[header] ?? '');
  if (value === null) return null;
  return { header, value };
}
