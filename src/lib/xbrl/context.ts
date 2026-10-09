import type { FilingIdentifierScheme, IsoDate, XbrlProfile } from '@/types/domain';
import { SAMPLE_ENTITY_SCHEME_URI } from './sample-taxonomy';

/**
 * XBRL のコンテキスト（提出者・期間・軸）。plan §3.4・gap D-01・D-04・X-17。
 *
 * - 期間: 期間型（duration／instant）は概念が決める。duration は数値の版の期間（開始日〜終了日）、
 *   instant は期間の終了日。xBRL-JSON（OIM）は「終了日の翌日 0 時」で表す（2026-03-31 終了 →
 *   2026-04-01T00:00:00）。iXBRL の xbrli:period は日付のまま書く
 * - 提出者: パッケージのプロファイルごとに使う識別子を決める。SAMPLE の出力には sample の識別子だけを使い、
 *   実在の識別子（EDINET コード・LEI・法人番号）を架空のパッケージの出力に混ぜない
 * - 軸: 対応付けに明示した軸 → メンバーだけを使う（境界の文字列から推測しない）
 */

export const ENTITY_SCHEME_URIS: Record<FilingIdentifierScheme, string> = {
  edinet_code: 'http://disclosure.edinet-fsa.go.jp',
  lei: 'http://standards.iso.org/iso/17442',
  // 法人番号の公式の scheme は確認していない（T4D の仮の名前。Stage 2 で確かめる）
  corporate_number: 'urn:t4d:jp-corporate-number',
  sample: SAMPLE_ENTITY_SCHEME_URI,
};

export const FILING_IDENTIFIER_SCHEME_LABELS: Record<FilingIdentifierScheme, string> = {
  edinet_code: 'EDINET コード',
  lei: 'LEI',
  corporate_number: '法人番号',
  sample: 'サンプル（架空）',
};

/** プロファイルごとに使う識別子（先頭が優先） */
const PREFERRED_SCHEMES: Record<XbrlProfile, readonly FilingIdentifierScheme[]> = {
  sample: ['sample'],
  edinet_ssbj: ['edinet_code'],
  edinet_non_ssbj: ['edinet_code'],
  esrs: ['lei'],
  esrs_40a: ['lei'],
};

export interface XbrlEntity {
  scheme: FilingIdentifierScheme;
  schemeUri: string;
  value: string;
  isSample: boolean;
}

export function entityFor(
  profile: XbrlProfile,
  identifiers: ReadonlyArray<{ scheme: FilingIdentifierScheme; value: string }>,
): XbrlEntity | null {
  for (const scheme of PREFERRED_SCHEMES[profile]) {
    const found = identifiers.find((i) => i.scheme === scheme && i.value.trim() !== '');
    if (found) {
      return {
        scheme,
        schemeUri: ENTITY_SCHEME_URIS[scheme],
        value: found.value.trim(),
        isSample: scheme === 'sample',
      };
    }
  }
  return null;
}

/** 識別子が無いときの仮の提出者（出力は検査 V11 で止まる。画面のプレビューで構造だけ見せる） */
export const UNIDENTIFIED_ENTITY: XbrlEntity = {
  scheme: 'sample',
  schemeUri: SAMPLE_ENTITY_SCHEME_URI,
  value: 'UNIDENTIFIED',
  isSample: true,
};

// ----------------------------------------------------------------------
// 期間
// ----------------------------------------------------------------------

export interface PeriodWindow {
  start: IsoDate;
  end: IsoDate;
}

export type XbrlPeriod =
  { type: 'duration'; start: IsoDate; end: IsoDate } | { type: 'instant'; instant: IsoDate };

/** 暦日の翌日（UTC の暦で数える。タイムゾーンに依存しない） */
export function nextDay(date: IsoDate): IsoDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** 暦日を n 年ずらす（2 月 29 日は 2 月 28 日へ寄せる） */
export function shiftYears(date: IsoDate, years: number): IsoDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y + years, m - 1, d));
  if (target.getUTCMonth() !== m - 1)
    return new Date(Date.UTC(y + years, m, 0)).toISOString().slice(0, 10);
  return target.toISOString().slice(0, 10);
}

export function periodOf(type: 'duration' | 'instant', window: PeriodWindow): XbrlPeriod {
  return type === 'instant'
    ? { type: 'instant', instant: window.end }
    : { type: 'duration', start: window.start, end: window.end };
}

/** xBRL-JSON（OIM）の期間の表記。終了日・時点は翌日の 0 時 */
export function oimPeriod(period: XbrlPeriod): string {
  if (period.type === 'instant') return `${nextDay(period.instant)}T00:00:00`;
  return `${period.start}T00:00:00/${nextDay(period.end)}T00:00:00`;
}

/** 報告期間との関係（当年・前年・それ以外） */
export type PeriodRelation = 'current' | 'prior1' | 'earlier' | 'later';

export function periodRelation(period: PeriodWindow, report: PeriodWindow): PeriodRelation {
  if (period.end === report.end) return 'current';
  if (period.end === shiftYears(report.end, -1)) return 'prior1';
  return period.end < report.end ? 'earlier' : 'later';
}

// ----------------------------------------------------------------------
// コンテキストの ID
// ----------------------------------------------------------------------

/**
 * 決定的なコンテキストの ID（XML の NCName）。当年・前年は EDINET に似た名前（CurrentYear・Prior1Year）、
 * それ以外は期間の日付。軸のメンバーを末尾に足す（軸の名前の順）
 */
export function contextIdOf(
  period: XbrlPeriod,
  report: PeriodWindow,
  dimensions: Readonly<Record<string, string>>,
): string {
  const window: PeriodWindow =
    period.type === 'instant'
      ? { start: period.instant, end: period.instant }
      : { start: period.start, end: period.end };
  const relation = periodRelation(window, report);
  const base =
    relation === 'current'
      ? 'CurrentYear'
      : relation === 'prior1'
        ? 'Prior1Year'
        : `Period${window.start.replace(/-/g, '')}to${window.end.replace(/-/g, '')}`;
  const kind = period.type === 'instant' ? 'Instant' : 'Duration';
  const members = Object.keys(dimensions)
    .sort()
    .map((axis) => `_${(dimensions[axis] ?? '').replace(/[^A-Za-z0-9_.-]/g, '_')}`)
    .join('');
  return `${base}${kind}${members}`;
}
