import 'server-only';

import { decodeText, detectDelimiter, parseCsvText } from './parsers';
import type { AvailabilityStatus, ValueKind } from '@/types/domain';

/**
 * 数値の標準 CSV（指示書 §7.4・docs/disclosure-first.md §6「数値を登録」）。
 *
 * 既存の取込（AI／Mock が行ごとに列の意味を推定する）とは別の、**決定論的な**経路。
 * 列の意味を推定しないので、同じファイルは何度読んでも同じ結果になる。
 *
 * ここでは「文字列 → 型付きの値」までを行い、組織・指標・期間の照合（マスター参照）と
 * 既存値との差分は Service（services/quantitative-import.ts）が行う。
 *
 * 方針
 *  - 曖昧な数値（`1.234` / `1,234` など、国によって読み方が変わる表記）は**推定で確定しない**。
 *    利用者が数値の書式を明示したときだけ読み取る。
 *  - 空欄は「未入力」の候補。0 にも対象外にもしない。
 *  - 数式に見えるセル（`=SUM(...)` など）は計算しない。文字列のまま保持する。
 */

export const STANDARD_COLUMNS = [
  'metric_code',
  'period_start',
  'period_end',
  'entity_code',
  'boundary_code',
  'value',
  'unit',
  'value_kind',
  'availability_status',
  'absence_reason',
  'methodology_code',
  'breakdown_key',
  'source_reference',
] as const;
export type StandardColumn = (typeof STANDARD_COLUMNS)[number];

/**
 * 見出しから対応付ける項目。標準列に加えて、既存テンプレートの「期間」（FY コード）を受ける。
 * `period_code` は標準列ではない（互換の変換層だけが使う）。
 */
export type StandardField = StandardColumn | 'period_code';

export const STANDARD_FIELD_LABELS: Record<StandardField, string> = {
  metric_code: '指標コード',
  period_start: '期間開始日',
  period_end: '期間終了日',
  entity_code: '組織コード',
  boundary_code: '集計範囲',
  value: '値',
  unit: '単位',
  value_kind: '値の区分',
  availability_status: '値の有無',
  absence_reason: '値が無い理由',
  methodology_code: '算定方法',
  breakdown_key: '内訳',
  source_reference: '出所',
  period_code: '期間（年度コード）',
};

/** 上限（D0 の初期値。性能検証で決めた値ではない。docs/known-limitations.md に記載する） */
export const MAX_STANDARD_CSV_BYTES = 2 * 1024 * 1024;
export const MAX_STANDARD_CSV_ROWS = 2000;

// ----------------------------------------------------------------------
// 見出し
// ----------------------------------------------------------------------

function normalizeHeader(header: string): string {
  return header
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s\-‐－]+/g, '_');
}

/**
 * 標準列名と完全一致しない見出しの対応候補。
 * 自動で対応付けた列は「候補」として画面に出し、人が確認する（§6.4）。
 */
const HEADER_ALIASES: Record<string, StandardField> = {
  指標コード: 'metric_code',
  指標: 'metric_code',
  項目: 'metric_code',
  metric: 'metric_code',
  期間開始日: 'period_start',
  期間開始: 'period_start',
  開始日: 'period_start',
  start_date: 'period_start',
  期間終了日: 'period_end',
  期間終了: 'period_end',
  終了日: 'period_end',
  end_date: 'period_end',
  期間: 'period_code',
  年度: 'period_code',
  period: 'period_code',
  period_code: 'period_code',
  組織コード: 'entity_code',
  拠点コード: 'entity_code',
  拠点: 'entity_code',
  組織: 'entity_code',
  entity: 'entity_code',
  集計範囲: 'boundary_code',
  境界: 'boundary_code',
  boundary: 'boundary_code',
  値: 'value',
  数値: 'value',
  単位: 'unit',
  値の区分: 'value_kind',
  区分: 'value_kind',
  値の有無: 'availability_status',
  availability: 'availability_status',
  値が無い理由: 'absence_reason',
  値がない理由: 'absence_reason',
  理由: 'absence_reason',
  算定方法: 'methodology_code',
  methodology: 'methodology_code',
  内訳: 'breakdown_key',
  breakdown: 'breakdown_key',
  出所: 'source_reference',
  出典: 'source_reference',
  source: 'source_reference',
};

/** 既存テンプレート（データ取込の標準テンプレート: 拠点／項目／値／単位／期間）の見出し */
const LEGACY_TEMPLATE_HEADERS = ['拠点', '項目', '値', '単位', '期間'];

export interface StandardHeaderMapping {
  /** ファイル上の見出し（原文） */
  header: string;
  /** 対応付けた項目。null は使わない列（登録には使わない） */
  field: StandardField | null;
  /** 標準列名と完全一致せず、別名から対応付けた（人が確認する「候補」） */
  candidate: boolean;
}

export interface StandardCsvRow {
  /** ファイル上のレコード番号（見出し行を含めて 1 始まり） */
  rowNo: number;
  /** 見出し（原文）→ セル（原文）。画面の「原文セル」に使う */
  raw: Record<string, string>;
  /** 対応付けた項目 → セル（前後の空白だけ除いた文字列） */
  fields: Partial<Record<StandardField, string>>;
}

export type StandardCsvFormat = 'standard' | 'legacy_template' | 'mapped_candidates';

export interface StandardCsvParseResult {
  format: StandardCsvFormat;
  encoding: string;
  delimiter: ',' | ';' | '\t';
  headers: string[];
  mapping: StandardHeaderMapping[];
  /** ファイル全体の誤り（見出しが足りない等）。1 件でもあれば行は検証しない */
  fileErrors: string[];
  fileWarnings: string[];
  rows: StandardCsvRow[];
}

function mapHeaders(headers: string[]): {
  mapping: StandardHeaderMapping[];
  duplicates: string[];
} {
  const standard = new Set<string>(STANDARD_COLUMNS);
  const used = new Map<StandardField, string>();
  const duplicates: string[] = [];
  const mapping = headers.map((header): StandardHeaderMapping => {
    const normalized = normalizeHeader(header);
    let field: StandardField | null = null;
    let candidate = false;
    if (standard.has(normalized)) {
      field = normalized as StandardColumn;
    } else {
      const alias = HEADER_ALIASES[normalized] ?? HEADER_ALIASES[header.normalize('NFKC').trim()];
      if (alias) {
        field = alias;
        candidate = true;
      }
    }
    if (field) {
      const previous = used.get(field);
      if (previous !== undefined) {
        duplicates.push(
          `「${previous}」と「${header}」がどちらも${STANDARD_FIELD_LABELS[field]}の列です`,
        );
        return { header, field: null, candidate: false };
      }
      used.set(field, header);
    }
    return { header, field, candidate };
  });
  return { mapping, duplicates };
}

function requiredColumnErrors(fields: ReadonlySet<StandardField>): string[] {
  const errors: string[] = [];
  if (!fields.has('metric_code')) errors.push('指標コード（metric_code）の列がありません。');
  if (!fields.has('entity_code')) errors.push('組織コード（entity_code）の列がありません。');
  const hasRange = fields.has('period_start') && fields.has('period_end');
  if (!hasRange && !fields.has('period_code')) {
    errors.push('対象期間（period_start と period_end）の列がありません。');
  }
  if (!fields.has('value') && !fields.has('availability_status')) {
    errors.push('値（value）または値の有無（availability_status）の列が必要です。');
  }
  return errors;
}

function isBlankRecord(cells: string[]): boolean {
  return cells.every((cell) => cell.trim() === '');
}

/** 文字列（貼り付け・手入力を含む）を標準 CSV として読む */
export function parseStandardCsvText(
  text: string,
  encoding = 'UTF-8',
  extraWarnings: string[] = [],
): StandardCsvParseResult {
  // 貼り付けた文字列の先頭に BOM が残ることがある（decodeText を通らない経路）
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  const delimiter = detectDelimiter(body);
  const records = parseCsvText(body, delimiter);
  const fileWarnings = [...extraWarnings];

  const headerIndex = records.findIndex((cells) => !isBlankRecord(cells));
  if (headerIndex === -1) {
    return {
      format: 'standard',
      encoding,
      delimiter,
      headers: [],
      mapping: [],
      fileErrors: ['ファイルが空です。'],
      fileWarnings,
      rows: [],
    };
  }

  const headers = (records[headerIndex] ?? []).map((h) => h.trim());
  const { mapping, duplicates } = mapHeaders(headers);
  const fields = new Set(mapping.flatMap((m) => (m.field ? [m.field] : [])));
  const fileErrors = [...duplicates.map((d) => `${d}。どちらか一方にしてください。`)];
  fileErrors.push(...requiredColumnErrors(fields));

  const isLegacy = LEGACY_TEMPLATE_HEADERS.every((h) => headers.includes(h));
  const format: StandardCsvFormat = isLegacy
    ? 'legacy_template'
    : mapping.some((m) => m.candidate)
      ? 'mapped_candidates'
      : 'standard';

  const rows: StandardCsvRow[] = [];
  for (let i = headerIndex + 1; i < records.length; i += 1) {
    const cells = records[i] ?? [];
    if (isBlankRecord(cells)) continue;
    const raw: Record<string, string> = {};
    const rowFields: Partial<Record<StandardField, string>> = {};
    headers.forEach((header, index) => {
      const cell = cells[index] ?? '';
      raw[header === '' ? `列${index + 1}` : header] = cell;
      const field = mapping[index]?.field;
      if (field) rowFields[field] = cell.trim();
    });
    if (cells.length > headers.length && cells.slice(headers.length).some((c) => c.trim())) {
      fileWarnings.push(`${i + 1} 行目に見出しより多いセルがあります（余分なセルは使いません）。`);
    }
    rows.push({ rowNo: i + 1, raw, fields: rowFields });
  }

  if (rows.length === 0 && fileErrors.length === 0) {
    fileErrors.push('見出しの下にデータ行がありません。');
  }
  if (rows.length > MAX_STANDARD_CSV_ROWS) {
    fileErrors.push(
      `一度に登録できるのは ${MAX_STANDARD_CSV_ROWS} 行までです（${rows.length} 行あります）。ファイルを分けてください。`,
    );
  }

  return { format, encoding, delimiter, headers, mapping, fileErrors, fileWarnings, rows };
}

/** ファイルのバイト列を読む（BOM・UTF-8・CP932 は既存の decodeText で判定する） */
export function parseStandardCsvBytes(bytes: Uint8Array): StandardCsvParseResult {
  if (bytes.byteLength > MAX_STANDARD_CSV_BYTES) {
    return {
      format: 'standard',
      encoding: '—',
      delimiter: ',',
      headers: [],
      mapping: [],
      fileErrors: [
        `ファイルが大きすぎます（上限 ${Math.round(MAX_STANDARD_CSV_BYTES / 1024 / 1024)}MB）。ファイルを分けてください。`,
      ],
      fileWarnings: [],
      rows: [],
    };
  }
  const { text, encoding, warning } = decodeText(bytes);
  return parseStandardCsvText(text, encoding, warning ? [warning] : []);
}

// ----------------------------------------------------------------------
// 数値
// ----------------------------------------------------------------------

/**
 * 数値の書式。
 *  - auto: 書式を決めない。国によって読み方が変わる表記は「要確認」にする（既定）
 *  - dot_decimal: 小数点「.」・桁区切り「,」（日本・英語圏）と利用者が明示した
 *  - comma_decimal: 小数点「,」・桁区切り「.」または空白（欧州）と利用者が明示した
 */
export const NUMBER_NOTATIONS = ['auto', 'dot_decimal', 'comma_decimal'] as const;
export type NumberNotation = (typeof NUMBER_NOTATIONS)[number];

export const NUMBER_NOTATION_LABELS: Record<NumberNotation, string> = {
  auto: '書式を決めない（読み方が分かれる値は要確認）',
  dot_decimal: '小数点「.」・桁区切り「,」（日本・英語圏）',
  comma_decimal: '小数点「,」・桁区切り「.」（欧州）',
};

export type StandardNumberParse =
  | { kind: 'empty' }
  | { kind: 'number'; value: number; normalized: string }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'invalid'; reason: string };

/**
 * 数式・コマンドとして実行されうる文字列か（文字として保持し、計算しない）。
 * 先頭文字の集合は exports/index.ts の出力側の無害化（= + - @）と揃える。
 */
export function looksLikeFormula(text: string): boolean {
  const trimmed = text.trimStart();
  const first = trimmed[0];
  if (first === '=' || first === '@') return true;
  // 「-12.5」「+3」は数値。記号の直後が数字でない場合だけを数式扱いにする
  if (first === '+' || first === '-') return !/^[+-]\s*\d/.test(trimmed);
  return false;
}

function toNumber(text: string): number | null {
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * 値のセルを数値に変換する。**解釈が分かれる表記は数値にしない。**
 *
 * `1.234` はドイツ式なら 1234、日英式なら 1.234 で、1000 倍違う。
 * 高い確信度で片方に決めると、誤った値が「正しそうな顔で」台帳に入る。
 */
export function parseStandardNumber(
  rawCell: string,
  notation: NumberNotation = 'auto',
): StandardNumberParse {
  // 全角数字・全角記号・マイナス記号の異体字を揃える（値そのものは変えない）
  const text = rawCell.normalize('NFKC').replace(/[−‒–]/g, '-').trim();
  if (text === '') return { kind: 'empty' };

  // 表計算で「該当なし」の意味に使われがちな横棒は、0 とも空欄とも決めない
  if (/^[-‐―—ー]+$/.test(text)) {
    return {
      kind: 'invalid',
      reason: `「${text}」は値として読み取りません。対象外・未取得などは値の有無（availability_status）と理由で指定してください。`,
    };
  }
  if (looksLikeFormula(text)) {
    return {
      kind: 'invalid',
      reason: '数式のように見えるセルです。計算はせず、数値としても読み取りません。',
    };
  }
  if (/[%％]/.test(text)) {
    return {
      kind: 'invalid',
      reason: '値に「%」が含まれています。値は数字だけにし、単位は unit 列に書いてください。',
    };
  }
  if (/[eE]/.test(text) && /\d[eE][+-]?\d/.test(text)) {
    return {
      kind: 'invalid',
      reason: '指数表記（例: 1e3）は読み取りません。数字で書いてください。',
    };
  }

  const sign = text.startsWith('-') ? '-' : '';
  const body = text.replace(/^[+-]\s*/, '');

  if (!/^[\d.,\s]+$/.test(body)) {
    return {
      kind: 'invalid',
      reason:
        '値に数字以外の文字（単位・注記など）が含まれています。値は数字だけにし、単位は unit 列に書いてください。',
    };
  }

  const finish = (normalized: string): StandardNumberParse => {
    const value = toNumber(`${sign}${normalized}`);
    return value === null
      ? { kind: 'invalid', reason: '数値として読み取れません。' }
      : { kind: 'number', value, normalized: `${sign}${normalized}` };
  };

  if (notation === 'dot_decimal') {
    if (/^\d+(\.\d+)?$/.test(body)) return finish(body);
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(body)) return finish(body.replace(/,/g, ''));
    return {
      kind: 'invalid',
      reason: '指定した書式（小数点「.」・桁区切り「,」）として読み取れません。',
    };
  }

  if (notation === 'comma_decimal') {
    if (/^\d+(,\d+)?$/.test(body)) return finish(body.replace(',', '.'));
    if (/^\d{1,3}([.\s]\d{3})+(,\d+)?$/.test(body)) {
      return finish(body.replace(/[.\s]/g, '').replace(',', '.'));
    }
    return {
      kind: 'invalid',
      reason: '指定した書式（小数点「,」・桁区切り「.」）として読み取れません。',
    };
  }

  // auto: どの国の書き方でも同じ値になる表記だけを読む
  if (/^\d+$/.test(body)) return finish(body);
  if (/^[1-9]\d{0,2}[.,]\d{3}$/.test(body)) {
    return {
      kind: 'ambiguous',
      reason: `「${text}」は小数とも桁区切りとも読めます（例: 1.234 は日本では約 1、欧州では 1234）。推定では確定しません。数値の書式を指定して検証し直すか、桁区切りを付けずに書いてください。`,
    };
  }
  if (/^\d+\.\d+$/.test(body)) return finish(body);
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(body)) return finish(body.replace(/,/g, ''));
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(body) || /^\d+,\d+$/.test(body) || /\s/.test(body)) {
    return {
      kind: 'ambiguous',
      reason: `「${text}」は欧州式（小数点がカンマ）の表記に見えます。推定では確定しません。数値の書式で「欧州」を指定して検証し直してください。`,
    };
  }
  return { kind: 'invalid', reason: '数値として読み取れません。' };
}

// ----------------------------------------------------------------------
// 日付・区分
// ----------------------------------------------------------------------

export type StandardDateParse = { ok: true; date: string } | { ok: false; reason: string };

/** YYYY-MM-DD / YYYY/M/D / YYYY.M.D / YYYY年M月D日 を受ける。存在しない日付は誤り */
export function parseStandardDate(rawCell: string): StandardDateParse {
  const text = rawCell.normalize('NFKC').trim();
  if (text === '') return { ok: false, reason: '日付が空欄です。' };
  const m =
    text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/) ??
    text.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
  if (!m) {
    return {
      ok: false,
      reason: `日付「${text}」を読み取れません。YYYY-MM-DD で書いてください（表計算ソフトのシリアル値は読み取りません）。`,
    };
  }
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return { ok: false, reason: `日付「${text}」は存在しません。` };
  }
  return {
    ok: true,
    date: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

const VALUE_KIND_TOKENS: Record<string, ValueKind> = {
  actual: 'actual',
  実績: 'actual',
  estimate: 'estimate',
  推計: 'estimate',
  target: 'target',
  目標: 'target',
};

/** 空欄は null（未指定。既存の区分を引き継ぐか、実績とするかは Service が決める） */
export function parseValueKind(
  rawCell: string,
): { ok: true; value: ValueKind | null } | { ok: false; reason: string } {
  const text = rawCell.normalize('NFKC').trim();
  if (text === '') return { ok: true, value: null };
  const found = VALUE_KIND_TOKENS[text.toLowerCase()] ?? VALUE_KIND_TOKENS[text];
  return found
    ? { ok: true, value: found }
    : {
        ok: false,
        reason: `値の区分「${text}」は使えません（actual／estimate／target、または 実績／推計／目標）。`,
      };
}

const AVAILABILITY_TOKENS: Record<string, AvailabilityStatus> = {
  value_present: 'value_present',
  値あり: 'value_present',
  not_entered: 'not_entered',
  未入力: 'not_entered',
  not_obtained: 'not_obtained',
  未取得: 'not_obtained',
  // 「未提出」は拠点から届いていない＝取得できていない。未入力（まだ誰も書いていない）とは分ける
  未提出: 'not_obtained',
  not_applicable: 'not_applicable',
  対象外: 'not_applicable',
  not_calculated: 'not_calculated',
  未算定: 'not_calculated',
};

/** 空欄は null（未指定。値の有無は値のセルから決める） */
export function parseAvailabilityStatus(
  rawCell: string,
): { ok: true; value: AvailabilityStatus | null } | { ok: false; reason: string } {
  const text = rawCell.normalize('NFKC').trim();
  if (text === '') return { ok: true, value: null };
  const found = AVAILABILITY_TOKENS[text.toLowerCase()] ?? AVAILABILITY_TOKENS[text];
  return found
    ? { ok: true, value: found }
    : {
        ok: false,
        reason: `値の有無「${text}」は使えません（value_present／not_entered／not_obtained／not_applicable／not_calculated）。`,
      };
}

/** 理由の記入が必要な値の有無（未取得・対象外・未算定） */
export function requiresAbsenceReason(status: AvailabilityStatus): boolean {
  return status === 'not_obtained' || status === 'not_applicable' || status === 'not_calculated';
}

// ----------------------------------------------------------------------
// 行の解釈（マスター照合の前まで）
// ----------------------------------------------------------------------

export interface InterpretedStandardRow {
  metricKey: string;
  entityKey: string;
  periodStart: string | null;
  periodEnd: string | null;
  periodCode: string | null;
  boundaryCode: string | null;
  /** 値のセルの原文 */
  valueRaw: string;
  value: number | null;
  /** 変換後の表記（全角・桁区切りを外したもの）。空欄・読み取れない場合は null */
  valueNormalized: string | null;
  unitRaw: string;
  valueKind: ValueKind | null;
  /** 値の有無。空欄の値で状態も未指定なら 'not_entered'（blankCandidate=true） */
  availabilityStatus: AvailabilityStatus;
  /** 空欄で状態の指定も無い（未入力の「候補」） */
  blankCandidate: boolean;
  absenceReason: string | null;
  methodology: string | null;
  breakdownKey: string | null;
  sourceReference: string | null;
  errors: string[];
  warnings: string[];
}

/** 「内訳なし」を表す値（内訳の列があっても合計行として扱える） */
const TOTAL_BREAKDOWN_KEYS = new Set(['', 'total', '合計', '計', 'all']);

export function isTotalBreakdown(key: string | null): boolean {
  return key === null || TOTAL_BREAKDOWN_KEYS.has(key.normalize('NFKC').trim().toLowerCase());
}

function textCell(value: string | undefined): string | null {
  const text = (value ?? '').trim();
  return text === '' ? null : text;
}

export function interpretStandardRow(
  row: StandardCsvRow,
  notation: NumberNotation = 'auto',
): InterpretedStandardRow {
  const f = row.fields;
  const errors: string[] = [];
  const warnings: string[] = [];

  const metricKey = (f.metric_code ?? '').trim();
  if (!metricKey) errors.push('指標コードが空欄です。');
  const entityKey = (f.entity_code ?? '').trim();
  if (!entityKey) errors.push('組織コードが空欄です。');

  // 期間: 標準は開始日・終了日。既存テンプレートは年度コード（Service が期間マスターで引く）
  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  const periodCode = textCell(f.period_code);
  const hasRange = (f.period_start ?? '') !== '' || (f.period_end ?? '') !== '';
  if (hasRange || !periodCode) {
    const start = parseStandardDate(f.period_start ?? '');
    const end = parseStandardDate(f.period_end ?? '');
    if (start.ok) periodStart = start.date;
    else errors.push(`期間開始日: ${start.reason}`);
    if (end.ok) periodEnd = end.date;
    else errors.push(`期間終了日: ${end.reason}`);
    if (periodStart && periodEnd && periodStart > periodEnd) {
      errors.push('期間の開始日が終了日より後になっています。');
    }
  }

  const valueRaw = f.value ?? '';
  const parsed = parseStandardNumber(valueRaw, notation);
  let value: number | null = null;
  let valueNormalized: string | null = null;
  if (parsed.kind === 'number') {
    value = parsed.value;
    valueNormalized = parsed.normalized;
  } else if (parsed.kind === 'ambiguous' || parsed.kind === 'invalid') {
    errors.push(`値: ${parsed.reason}`);
  }
  const valueCellFilled = parsed.kind !== 'empty';

  const unitRaw = (f.unit ?? '').trim();
  if (value !== null && unitRaw === '') {
    errors.push('値があるのに単位（unit）が空欄です。');
  }

  const kind = parseValueKind(f.value_kind ?? '');
  const valueKind = kind.ok ? kind.value : null;
  if (!kind.ok) errors.push(kind.reason);

  const availability = parseAvailabilityStatus(f.availability_status ?? '');
  if (!availability.ok) errors.push(availability.reason);
  const explicitStatus = availability.ok ? availability.value : null;

  let availabilityStatus: AvailabilityStatus;
  let blankCandidate = false;
  if (explicitStatus === null) {
    if (valueCellFilled) {
      availabilityStatus = 'value_present';
    } else {
      availabilityStatus = 'not_entered';
      blankCandidate = true;
      warnings.push(
        '値が空欄のため「未入力」の候補として扱います（0 にも対象外にもしません）。対象外・未取得などの場合は値の有無と理由を書いてください。',
      );
    }
  } else {
    availabilityStatus = explicitStatus;
    if (explicitStatus === 'value_present' && !valueCellFilled) {
      errors.push('値の有無が「値あり」なのに値が空欄です。');
    }
    if (explicitStatus !== 'value_present' && valueCellFilled) {
      errors.push(
        `値の有無が「値あり」以外なのに値が入っています。値を消すか、値の有無を value_present にしてください。`,
      );
    }
  }

  const absenceReason = textCell(f.absence_reason);
  if (requiresAbsenceReason(availabilityStatus) && !absenceReason) {
    errors.push('未取得・対象外・未算定の行には、値が無い理由（absence_reason）が必要です。');
  }
  if (availabilityStatus === 'value_present' && absenceReason) {
    warnings.push('値があるため、値が無い理由は保存しません。');
  }

  const methodology = textCell(f.methodology_code);
  const breakdownKey = textCell(f.breakdown_key);
  if (!isTotalBreakdown(breakdownKey)) {
    errors.push(
      `内訳「${breakdownKey}」ごとの値は、現在の台帳では同じ指標・組織・期間の値と区別して保存できません。合算もしません。内訳の無い合計の行で登録してください。`,
    );
  }
  const sourceReference = textCell(f.source_reference);

  const formulaCells = (
    [
      ['値が無い理由', absenceReason],
      ['算定方法', methodology],
      ['出所', sourceReference],
    ] as const
  ).filter(([, text]) => text !== null && looksLikeFormula(text));
  if (formulaCells.length > 0) {
    warnings.push(
      `${formulaCells.map(([label]) => label).join('・')}が数式のように見えます。計算せず、文字としてそのまま保存します。`,
    );
  }

  return {
    metricKey,
    entityKey,
    periodStart,
    periodEnd,
    periodCode: hasRange ? null : periodCode,
    boundaryCode: textCell(f.boundary_code),
    valueRaw,
    value,
    valueNormalized,
    unitRaw,
    valueKind,
    availabilityStatus,
    blankCandidate,
    absenceReason: availabilityStatus === 'value_present' ? null : absenceReason,
    methodology,
    breakdownKey: isTotalBreakdown(breakdownKey) ? null : breakdownKey,
    sourceReference,
    errors,
    warnings,
  };
}

/** 単位の表記ゆれを比較用に揃える（t-CO2e / tCO₂e / t‐CO2e を同じとみなす）。換算はしない */
export function normalizeUnitForCompare(unit: string): string {
  return unit
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s\-‐－_]/g, '');
}
