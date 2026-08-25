/**
 * 異種データ 50 ファイルの生成器（機能追加要望 ①）。
 *
 * 「拠点・部門・カテゴリごとにフォーマット・言語が全く異なるデータ群」を再現する。
 * すべて架空データ（実顧客データ禁止）。決定論的（同じ入力から必ず同じファイル）。
 *
 * 用途:
 *  - `scripts/generate-heterogeneous-dataset.ts` が zip 化して納品物を作る
 *    （本ファイルは scripts/ 配下に置く。tests/ は Vercel へ上げないため）
 *  - `tests/integration/hetero-import.test.ts` が全件を実際に取り込んで検証する
 *  - E2E が実ブラウザのアップロードに使う
 *
 * 文字化けを起こさないための決めごと:
 *  - UTF-8 のテキストは **必ず BOM 付き**で書く。BOM が無いと Excel（日本語 Windows）が
 *    CP932 と誤認して日本語が化ける。アプリ側のパーサは BOM を除去して読む。
 *  - Shift_JIS のファイルは `TextDecoder('shift_jis')` から**逆引きテーブルを生成**して
 *    エンコードする。固定パレット方式だと表外の文字が「?」に落ちて化ける。
 *  - PDF は Latin 文字（英語・ドイツ語・フランス語）のみ。日本語を出すには CID フォントの
 *    埋め込みが必要で、埋め込み無しでは pdf.js がテキストを復元できない（検証済み）。
 *    日本語の Evidence は CSV / Excel 側で表現する。
 */

export interface DatasetFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  /** 表形式（AI 仕分けの対象）か、PDF（テキスト抽出）か */
  kind: 'table' | 'pdf';
}

const enc = (s: string) => new TextEncoder().encode(s);

/** UTF-8 + BOM。Excel で開いても日本語が化けない。 */
export const utf8Bom = (s: string) => enc('﻿' + s);

// ----------------------------------------------------------------------
// Shift_JIS（CP932）エンコード
// ----------------------------------------------------------------------

/**
 * `TextDecoder('shift_jis')` の全バイト列をデコードして逆引き表を作る。
 * Node 20+ は full-ICU 同梱なので追加依存なしに CP932 全域（約 9,400 文字）を扱える。
 */
let sjisTable: Map<string, number[]> | null = null;

function getSjisTable(): Map<string, number[]> {
  if (sjisTable) return sjisTable;
  const dec = new TextDecoder('shift_jis', { fatal: false });
  const map = new Map<string, number[]>();
  for (let b = 0x00; b < 0x80; b++) map.set(String.fromCharCode(b), [b]);
  for (let b = 0xa1; b <= 0xdf; b++) {
    const s = dec.decode(new Uint8Array([b]));
    if (s.length === 1 && s !== '�' && !map.has(s)) map.set(s, [b]);
  }
  for (let hi = 0x81; hi <= 0xfc; hi++) {
    for (let lo = 0x40; lo <= 0xfc; lo++) {
      if (lo === 0x7f) continue;
      const s = dec.decode(new Uint8Array([hi, lo]));
      if (s.length === 1 && s !== '�' && !map.has(s)) map.set(s, [hi, lo]);
    }
  }
  sjisTable = map;
  return map;
}

export function encodeSjis(text: string): Uint8Array {
  const table = getSjisTable();
  const bytes: number[] = [];
  for (const ch of text) {
    const mapped = table.get(ch);
    if (mapped) {
      bytes.push(...mapped);
    } else {
      // CP932 に存在しない文字（絵文字など）は使わない方針。
      // 混入した場合に黙って化けないよう、生成時点で気づけるようにする。
      throw new Error(`Shift_JIS で表現できない文字が含まれています: ${JSON.stringify(ch)}`);
    }
  }
  return new Uint8Array(bytes);
}

// ----------------------------------------------------------------------
// PDF（Latin 文字のみ・非圧縮テキスト）
// ----------------------------------------------------------------------

/** WinAnsiEncoding で表せない文字を Latin へ寄せる（ä→ae など） */
function toWinAnsi(s: string): string {
  return s
    .replace(/[〜～]/g, '-')
    .replace(/[”“]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/[–—]/g, '-');
}

/**
 * 1 ページの PDF を手組みする（依存を増やさないため）。
 * WinAnsiEncoding + Helvetica なので Latin-1 の範囲（独仏のウムラウト・アクセント含む）を出せる。
 */
export function buildSimplePdf(lines: string[]): Uint8Array {
  const escape = (s: string) =>
    toWinAnsi(s)
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      // Latin-1 の範囲外は PDF に載せない（載せると閲覧側で化ける）
      .replace(/[^\u0020-\u00FF]/g, '?');

  const octal = (s: string) =>
    [...s]
      .map((ch) => {
        const code = ch.charCodeAt(0);
        return code > 0x7f ? `\\${code.toString(8).padStart(3, '0')}` : ch;
      })
      .join('');

  const content =
    'BT /F1 10 Tf 40 800 Td 13 TL\n' +
    lines.map((l) => `(${octal(escape(l))}) Tj T*`).join('\n') +
    '\nET';

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    out += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  // PDF は 1 バイト = 1 文字として書く（latin1）
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

// ----------------------------------------------------------------------
// Excel
// ----------------------------------------------------------------------

export async function buildXlsx(
  sheets: Array<{ name: string; rows: (string | number)[][]; boldFirstRow?: boolean }>,
): Promise<Uint8Array> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'T4D サンプル生成器';
  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name);
    for (const row of sheet.rows) ws.addRow(row);
    if (sheet.boldFirstRow !== false && sheet.rows.length > 0) {
      ws.getRow(1).font = { bold: true };
    }
    ws.columns.forEach((col) => {
      col.width = 18;
    });
  }
  const buffer = await wb.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

// ----------------------------------------------------------------------
// CSV / TSV
// ----------------------------------------------------------------------

/**
 * RFC4180 準拠の CSV 組み立て。区切り文字・引用符・改行を含むフィールドは引用する。
 * 引用を怠ると「1,234.5」のような値が列をまたいで壊れる。
 */
export function csv(rows: (string | number)[][], sep = ','): string {
  const cell = (v: string | number) => {
    const s = String(v);
    return s.includes(sep) || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  return rows.map((r) => r.map(cell).join(sep)).join('\r\n') + '\r\n';
}

// ----------------------------------------------------------------------
// 値の生成（決定論的）
// ----------------------------------------------------------------------

const MONTHS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3] as const;

/** 月ラベル（2026 年度 = 2026-04 〜 2027-03） */
function monthLabel(m: number, style: 'jp' | 'iso' | 'en' | 'de' | 'fr' = 'jp'): string {
  const year = m >= 4 ? 2026 : 2027;
  const mm = String(m).padStart(2, '0');
  switch (style) {
    case 'iso':
      return `${year}-${mm}`;
    case 'en':
      return `${['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m]} ${year}`;
    case 'de':
      return `${mm}/${year}`;
    case 'fr':
      return `${mm}/${year}`;
    default:
      return `${year}年${m}月`;
  }
}

/** 季節変動を持つ決定論的な月次系列 */
function monthlySeries(base: number, seed: number, amplitude = 0.18): number[] {
  return MONTHS.map((m, i) => {
    const season = Math.sin(((m - 1) / 12) * Math.PI * 2) * amplitude;
    const jitter = (((seed * 37 + i * 101) % 23) / 23 - 0.5) * 0.08;
    return round(base * (1 + season + jitter));
  });
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function sum(values: number[]): number {
  return round(values.reduce((a, b) => a + b, 0));
}

/** 1,234.5 形式（日本・英語圏） */
function fmtEn(n: number, digits = 1): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** 1.234,5 形式（ドイツ語圏） */
function fmtDe(n: number, digits = 1): string {
  // 1,234.5 → 1.234,5。桁区切りと小数点を入れ替えるため、いったん区切りを外してから置く。
  const [intPart, decPart] = fmtEn(n, digits).split('.');
  const grouped = (intPart ?? '').split(',').join('.');
  return decPart === undefined ? grouped : `${grouped},${decPart}`;
}

/** 1 234,5 形式（フランス語圏。桁区切りは半角スペース） */
function fmtFr(n: number, digits = 1): string {
  return fmtEn(n, digits).replace(/,/g, ' ').replace(/\./g, ',');
}

/** 全角数字 */
function toZenkaku(s: string): string {
  return s.replace(/[0-9.,]/g, (c) => {
    if (c === '.') return '．';
    if (c === ',') return '，';
    return String.fromCharCode(c.charCodeAt(0) + 0xfee0);
  });
}

const APPROVERS = ['海野 みどり', '検見川 涼', '承 花子', '青海 太郎'] as const;

// ----------------------------------------------------------------------
// 本体
// ----------------------------------------------------------------------

export async function buildHeterogeneousDataset(): Promise<DatasetFile[]> {
  const files: DatasetFile[] = [];

  const table = (name: string, mimeType: string, bytes: Uint8Array) =>
    files.push({ name, mimeType, bytes, kind: 'table' });
  const csvFile = (name: string, rows: (string | number)[][], sep = ',') =>
    table(name, 'text/csv', utf8Bom(csv(rows, sep)));
  const sjisFile = (name: string, rows: (string | number)[][]) =>
    table(name, 'text/csv', encodeSjis(csv(rows)));
  const tsvFile = (name: string, rows: (string | number)[][]) =>
    table(name, 'text/tab-separated-values', utf8Bom(csv(rows, '\t')));

  // ====================================================================
  // 1〜5: 日本語の標準形（UTF-8 BOM）。月次明細 + 年度合計 + 備考列。
  // ====================================================================

  {
    const s = monthlySeries(42.7, 3);
    csvFile('01_本社_Scope1_標準形.csv', [
      ['拠点', '項目', '値', '単位', '期間', '算定方法', '備考'],
      ...MONTHS.map((m, i) => [
        '本社',
        'Scope1 直接排出',
        s[i]!,
        't-CO2e',
        monthLabel(m),
        '燃料使用量 × 排出係数',
        i === 7 ? '空調更新に伴い一時増加' : '',
      ]),
      ['本社', 'Scope1 直接排出', sum(s), 't-CO2e', 'FY2026', '月次合計', '年度確定値'],
    ]);
  }

  {
    const s = monthlySeries(268.4, 7);
    csvFile('02_東日本工場_電力使用量.csv', [
      ['拠点', '項目', '値', '単位', '期間', '検針日', '担当'],
      ...MONTHS.map((m, i) => [
        '東日本工場',
        '電力使用量',
        fmtEn(s[i]!),
        'MWh',
        monthLabel(m),
        `${monthLabel(m, 'iso')}-25`,
        '設備課',
      ]),
      ['東日本工場', '電力使用量', fmtEn(sum(s)), 'MWh', 'FY2026', '', '設備課'],
    ]);
  }

  {
    const s = monthlySeries(5683, 11, 0.22);
    csvFile('03_西日本工場_用水.csv', [
      ['拠点', '項目', '値', '単位', '期間', '水源', '備考'],
      ...MONTHS.map((m, i) => [
        '西日本工場',
        '用水使用量',
        Math.round(s[i]!),
        'm3',
        monthLabel(m),
        i % 3 === 0 ? '市水' : '地下水',
        '',
      ]),
      ['西日本工場', '用水使用量', Math.round(sum(s)), 'm3', 'FY2026', '', '年度合計'],
    ]);
  }

  {
    const kinds = [
      ['廃プラスチック', 38.2, 'リサイクル'],
      ['金属くず', 24.6, 'リサイクル'],
      ['汚泥', 12.4, '中間処理'],
      ['木くず', 8.9, 'リサイクル'],
      ['廃油', 4.1, '中間処理'],
      ['その他産業廃棄物', 6.3, '埋立'],
    ] as const;
    csvFile('04_本社_廃棄物.csv', [
      ['拠点', '項目', '種類', '値', '単位', '処理方法', '処理業者', '期間'],
      ...kinds.map(([k, v, way]) => [
        '本社',
        '廃棄物排出量',
        k,
        v,
        't',
        way,
        `${k.slice(0, 2)}処理センター`,
        'FY2026',
      ]),
      [
        '本社',
        '廃棄物排出量',
        '合計',
        round(kinds.reduce((a, [, v]) => a + v, 0)),
        't',
        '',
        '',
        'FY2026',
      ],
    ]);
  }

  csvFile('05_人事部_従業員数.csv', [
    ['拠点', '項目', '値', '単位', '期間', '雇用形態', '基準日'],
    ['本社', '従業員数', 412, '人', 'FY2026', '正社員', '2027-03-31'],
    ['本社', '従業員数', 68, '人', 'FY2026', '契約・嘱託', '2027-03-31'],
    ['東日本工場', '従業員数', 386, '人', 'FY2026', '正社員', '2027-03-31'],
    ['東日本工場', '従業員数', 94, '人', 'FY2026', '契約・嘱託', '2027-03-31'],
    ['西日本工場', '従業員数', 298, '人', 'FY2026', '正社員', '2027-03-31'],
    ['西日本工場', '従業員数', 72, '人', 'FY2026', '契約・嘱託', '2027-03-31'],
    ['全社', '従業員数', 1330, '人', 'FY2026', '合計', '2027-03-31'],
    ['全社', '管理職数', 187, '人', 'FY2026', '', '2027-03-31'],
    ['全社', '女性管理職数', 34, '人', 'FY2026', '', '2027-03-31'],
  ]);

  // ====================================================================
  // 6〜8: Shift_JIS（現場の古い基幹システム由来を想定）
  // ====================================================================

  {
    const s = monthlySeries(5683, 5, 0.2);
    sjisFile('06_東日本工場_用水_SJIS.csv', [
      ['拠点', '項目', '値', '単位', '期間', '備考'],
      ...MONTHS.map((m, i) => [
        '東日本工場',
        '用水使用量',
        Math.round(s[i]!),
        'm3',
        monthLabel(m),
        i === 4 ? '配管更新工事のため一時停止あり' : '',
      ]),
      ['東日本工場', '用水使用量', Math.round(sum(s)), 'm3', 'FY2026', '年度合計'],
    ]);
  }

  {
    const s = monthlySeries(214.8, 13);
    sjisFile('07_西日本工場_電力_SJIS.csv', [
      ['拠点', '項目', '値', '単位', '期間', '契約種別', '備考'],
      ...MONTHS.map((m, i) => [
        '西日本工場',
        '購入電力量',
        fmtEn(s[i]!),
        'MWh',
        monthLabel(m),
        '高圧電力',
        i === 9 ? '再生可能エネルギー由来を一部導入' : '',
      ]),
      ['西日本工場', '購入電力量', fmtEn(sum(s)), 'MWh', 'FY2026', '高圧電力', '年度合計'],
    ]);
  }

  sjisFile('08_本社_従業員数_SJIS.csv', [
    ['報告書名', '人員構成報告（年度末時点）'],
    ['作成部署', '人事部 人事企画課'],
    ['作成日', '2027-04-10'],
    [],
    ['拠点', '項目', '値', '単位', '期間', '区分'],
    ['本社', '従業員数', 480, '人', 'FY2026', '全雇用形態'],
    ['本社', '男性従業員数', 291, '人', 'FY2026', ''],
    ['本社', '女性従業員数', 189, '人', 'FY2026', ''],
    ['本社', '管理職数', 76, '人', 'FY2026', ''],
    ['本社', '女性管理職数', 14, '人', 'FY2026', ''],
    ['本社', '平均勤続年数', 12.4, '年', 'FY2026', ''],
  ]);

  // ====================================================================
  // 9〜10: 説明行つき（前文があり、表が途中から始まる）
  // ====================================================================

  csvFile('09_総務部_エネルギー報告.csv', [
    ['エネルギー使用実績報告'],
    ['作成: 総務部 環境課'],
    ['対象期間: 2026年4月1日 〜 2027年3月31日'],
    ['注: 数値は検針票および請求書に基づく確定値です'],
    [],
    ['拠点', '項目', '値', '単位', '期間', '出典'],
    ['本社', '電力使用量', fmtEn(3120.5), 'MWh', 'FY2026', '電力会社請求書'],
    ['本社', '用水使用量', fmtEn(12400, 0), 'm3', 'FY2026', '水道局検針票'],
    ['本社', '都市ガス使用量', fmtEn(84.6), '千m3', 'FY2026', 'ガス会社請求書'],
    ['本社', '重油使用量', fmtEn(21.3), 'kL', 'FY2026', '納品書'],
    ['東日本工場', '電力使用量', fmtEn(3218.4), 'MWh', 'FY2026', '電力会社請求書'],
    ['東日本工場', '都市ガス使用量', fmtEn(142.8), '千m3', 'FY2026', 'ガス会社請求書'],
    ['西日本工場', '電力使用量', fmtEn(2577.6), 'MWh', 'FY2026', '電力会社請求書'],
    ['西日本工場', '重油使用量', fmtEn(38.7), 'kL', 'FY2026', '納品書'],
  ]);

  csvFile('10_環境課_廃棄物月報.csv', [
    ['廃棄物管理月報（年度集計）'],
    ['環境管理部 環境課'],
    ['単位: t（トン）／マニフェスト集計値'],
    [],
    ['拠点', '項目', '値', '単位', '期間', 'マニフェスト番号'],
    ['東日本工場', '廃棄物排出量', fmtEn(1070.4), 't', 'FY2026', 'MF-2026-E-0412'],
    ['東日本工場', '廃棄物リサイクル量', fmtEn(842.1), 't', 'FY2026', 'MF-2026-E-0412'],
    ['西日本工場', '廃棄物排出量', fmtEn(864.2), 't', 'FY2026', 'MF-2026-W-0388'],
    ['西日本工場', '廃棄物リサイクル量', fmtEn(651.8), 't', 'FY2026', 'MF-2026-W-0388'],
    ['本社', '廃棄物排出量', fmtEn(94.5), 't', 'FY2026', 'MF-2026-H-0121'],
  ]);

  // ====================================================================
  // 11〜12: TSV（基幹システムの export を想定）
  // ====================================================================

  {
    const rows: (string | number)[][] = [
      ['SITE_CD', '拠点', 'METRIC_CD', '項目', '値', '単位', '期間', 'UPDATED_AT'],
    ];
    const defs = [
      ['HQ', '本社', 'ELEC', '電力使用量', 3120.5],
      ['EAST', '東日本工場', 'ELEC', '電力使用量', 3218.4],
      ['WEST', '西日本工場', 'ELEC', '電力使用量', 2577.6],
      ['HQ', '本社', 'GAS', '都市ガス使用量', 84.6],
      ['EAST', '東日本工場', 'GAS', '都市ガス使用量', 142.8],
    ] as const;
    for (const [cd, name, mcd, metric, value] of defs) {
      rows.push([
        cd,
        name,
        mcd,
        metric,
        value,
        mcd === 'ELEC' ? 'MWh' : '千m3',
        'FY2026',
        '2027-04-05T09:12:00',
      ]);
    }
    tsvFile('11_基幹システム_export_energy.tsv', rows);
  }

  tsvFile('12_基幹システム_export_water.tsv', [
    ['SITE_CD', '拠点', 'METRIC_CD', '項目', '値', '単位', '期間', 'SOURCE'],
    ['HQ', '本社', 'WATER', '用水使用量', 12400, 'm3', 'FY2026', 'WATER_METER'],
    ['EAST', '東日本工場', 'WATER', '用水使用量', 68200, 'm3', 'FY2026', 'WATER_METER'],
    ['WEST', '西日本工場', 'WATER', '用水使用量', 71850, 'm3', 'FY2026', 'WATER_METER'],
    ['HQ', '本社', 'WATER_REUSE', '再生水利用量', 1840, 'm3', 'FY2026', 'WATER_METER'],
    ['EAST', '東日本工場', 'WATER_REUSE', '再生水利用量', 9620, 'm3', 'FY2026', 'WATER_METER'],
  ]);

  // ====================================================================
  // 13〜16: 英語（EU オフィス）
  // ====================================================================

  {
    const s = monthlySeries(74.2, 17);
    csvFile('13_EU_office_energy_report.csv', [
      ['Site', 'Metric', 'Value', 'Unit', 'Period', 'Source', 'Verified'],
      ...MONTHS.map((m, i) => [
        'EU Sales Office',
        'Electricity consumption',
        fmtEn(s[i]!),
        'MWh',
        monthLabel(m, 'en'),
        'Utility invoice',
        'Yes',
      ]),
      [
        'EU Sales Office',
        'Electricity consumption',
        fmtEn(sum(s)),
        'MWh',
        'FY2026',
        'Annual total',
        'Yes',
      ],
    ]);
  }

  csvFile('14_EU_office_water.csv', [
    ['Location', 'Indicator', 'Amount', 'UoM', 'Reporting period', 'Comment'],
    ['EU Sales Office', 'Water withdrawal', fmtEn(4820, 0), 'm3', 'FY2026', 'Municipal supply'],
    ['EU Sales Office', 'Water discharge', fmtEn(4310, 0), 'm3', 'FY2026', 'To public sewer'],
    [
      'EU Sales Office',
      'Water consumption',
      fmtEn(510, 0),
      'm3',
      'FY2026',
      'Withdrawal - discharge',
    ],
    ['EU Warehouse', 'Water withdrawal', fmtEn(1260, 0), 'm3', 'FY2026', 'Municipal supply'],
  ]);

  csvFile('15_EU_office_waste.csv', [
    ['Site', 'Metric', 'Waste type', 'Value', 'Unit', 'Disposal route', 'Period'],
    ['EU Sales Office', 'Waste generated', 'Paper and cardboard', 12.4, 't', 'Recycling', 'FY2026'],
    ['EU Sales Office', 'Waste generated', 'Mixed municipal', 8.1, 't', 'Incineration', 'FY2026'],
    ['EU Sales Office', 'Waste generated', 'Electronic waste', 1.6, 't', 'Recycling', 'FY2026'],
    ['EU Sales Office', 'Waste generated', 'Total', 22.1, 't', '', 'FY2026'],
  ]);

  csvFile('16_EU_office_headcount.csv', [
    ['Site', 'Metric', 'Value', 'Unit', 'Period', 'Category'],
    ['EU Sales Office', 'Headcount', 88, 'FTE', 'FY2026', 'Permanent'],
    ['EU Sales Office', 'Headcount', 12, 'FTE', 'FY2026', 'Fixed-term'],
    ['EU Sales Office', 'Managers', 14, 'FTE', 'FY2026', ''],
    ['EU Sales Office', 'Female managers', 6, 'FTE', 'FY2026', ''],
    ['EU Warehouse', 'Headcount', 24, 'FTE', 'FY2026', 'Permanent'],
  ]);

  // ====================================================================
  // 17〜19: ドイツ語（セミコロン区切り・1.234,5 表記）
  // ====================================================================

  {
    const s = monthlySeries(102.9, 19);
    csvFile(
      '17_Muenchen_Stromverbrauch.csv',
      [
        ['Standort', 'Kennzahl', 'Wert', 'Einheit', 'Zeitraum', 'Quelle'],
        ['EU Sales Office', 'Stromverbrauch', fmtDe(1234.5), 'MWh', 'GJ2026', 'Stromrechnung'],
        ...MONTHS.slice(0, 6).map((m, i) => [
          'EU Sales Office',
          'Stromverbrauch',
          fmtDe(s[i]!),
          'MWh',
          monthLabel(m, 'de'),
          'Stromrechnung',
        ]),
        ['EU Lager', 'Stromverbrauch', fmtDe(318.6), 'MWh', 'GJ2026', 'Stromrechnung'],
      ],
      ';',
    );
  }

  csvFile(
    '18_Muenchen_Wasser.csv',
    [
      ['Standort', 'Kennzahl', 'Wert', 'Einheit', 'Zeitraum', 'Bemerkung'],
      ['EU Sales Office', 'Wasserverbrauch', fmtDe(4820, 0), 'm3', 'GJ2026', 'Stadtwerke'],
      ['EU Sales Office', 'Abwasser', fmtDe(4310, 0), 'm3', 'GJ2026', 'Kanalisation'],
      ['EU Lager', 'Wasserverbrauch', fmtDe(1260, 0), 'm3', 'GJ2026', 'Stadtwerke'],
      ['EU Lager', 'Abwasser', fmtDe(1140, 0), 'm3', 'GJ2026', 'Kanalisation'],
    ],
    ';',
  );

  csvFile(
    '19_Muenchen_Abfall.csv',
    [
      ['Standort', 'Kennzahl', 'Abfallart', 'Wert', 'Einheit', 'Entsorgungsweg', 'Zeitraum'],
      ['EU Sales Office', 'Abfallmenge', 'Papier', fmtDe(12.4), 't', 'Recycling', 'GJ2026'],
      ['EU Sales Office', 'Abfallmenge', 'Restmüll', fmtDe(8.1), 't', 'Verbrennung', 'GJ2026'],
      ['EU Sales Office', 'Abfallmenge', 'Elektroschrott', fmtDe(1.6), 't', 'Recycling', 'GJ2026'],
      ['EU Sales Office', 'Abfallmenge', 'Gesamt', fmtDe(22.1), 't', '', 'GJ2026'],
    ],
    ';',
  );

  // ====================================================================
  // 20〜21: フランス語（セミコロン区切り・1 234,5 表記）
  // ====================================================================

  csvFile(
    '20_Paris_energie.csv',
    [
      ['Site', 'Indicateur', 'Valeur', 'Unité', 'Période', 'Source'],
      ['Bureau Paris', "Consommation d'électricité", fmtFr(486.3), 'MWh', 'EX2026', 'Facture'],
      ['Bureau Paris', 'Consommation de gaz', fmtFr(38.2), '1000 m3', 'EX2026', 'Facture'],
      ['Bureau Paris', 'Émissions directes', fmtFr(112.7), 't-CO2e', 'EX2026', 'Calcul interne'],
      ['Entrepôt Lyon', "Consommation d'électricité", fmtFr(214.8), 'MWh', 'EX2026', 'Facture'],
    ],
    ';',
  );

  csvFile(
    '21_Paris_eau.csv',
    [
      ['Site', 'Indicateur', 'Valeur', 'Unité', 'Période', 'Commentaire'],
      ['Bureau Paris', "Prélèvement d'eau", fmtFr(2140, 0), 'm3', 'EX2026', 'Réseau municipal'],
      ['Bureau Paris', "Rejet d'eau", fmtFr(1980, 0), 'm3', 'EX2026', 'Égout public'],
      ['Entrepôt Lyon', "Prélèvement d'eau", fmtFr(860, 0), 'm3', 'EX2026', 'Réseau municipal'],
    ],
    ';',
  );

  // ====================================================================
  // 22〜23: 中国語（簡体字）
  // ====================================================================

  csvFile('22_供应商_能源数据.csv', [
    ['站点', '指标', '数值', '单位', '期间', '数据来源'],
    ['供应商工厂A', '用电量', fmtEn(1842.6), 'MWh', '2026财年', '电费账单'],
    ['供应商工厂A', '天然气用量', fmtEn(62.4), '千立方米', '2026财年', '燃气账单'],
    ['供应商工厂A', '直接排放', fmtEn(486.2), '吨CO2e', '2026财年', '内部计算'],
    ['供应商工厂B', '用电量', fmtEn(964.8), 'MWh', '2026财年', '电费账单'],
    ['供应商工厂B', '直接排放', fmtEn(241.6), '吨CO2e', '2026财年', '内部计算'],
  ]);

  csvFile('23_供应商_用水.csv', [
    ['站点', '指标', '数值', '单位', '期间', '备注'],
    ['供应商工厂A', '取水量', fmtEn(18400, 0), '立方米', '2026财年', '市政供水'],
    ['供应商工厂A', '排水量', fmtEn(16200, 0), '立方米', '2026财年', '市政污水'],
    ['供应商工厂A', '循环水量', fmtEn(4800, 0), '立方米', '2026财年', ''],
    ['供应商工厂B', '取水量', fmtEn(9600, 0), '立方米', '2026财年', '市政供水'],
  ]);

  // ====================================================================
  // 24: 多言語混在（1 ファイルに日英独中が同居する最悪ケース）
  // ====================================================================

  csvFile('24_連結_multi_language.csv', [
    ['拠点', '項目', '値', '単位', '期間'],
    ['本社', 'Scope1 直接排出', fmtEn(512.4), 't-CO2e', 'FY2026'],
    ['EU Sales Office', 'Scope 1 direct emissions', fmtEn(148.6), 't-CO2e', 'FY2026'],
    ['EU Lager', 'Direkte Emissionen', fmtDe(62.8), 't-CO2e', 'GJ2026'],
    ['Bureau Paris', 'Émissions directes', fmtFr(112.7), 't-CO2e', 'EX2026'],
    ['供应商工厂A', '直接排放', fmtEn(486.2), '吨CO2e', '2026财年'],
    ['東日本工場', 'Scope1 直接排出', fmtEn(1284.2), 't-CO2e', 'FY2026'],
    ['西日本工場', 'Scope1 直接排出', fmtEn(1042.8), 't-CO2e', 'FY2026'],
  ]);

  // ====================================================================
  // 25〜36: Excel（12 件）
  // ====================================================================

  table(
    '25_本社_Scope2.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    await buildXlsx([
      {
        name: 'Scope2',
        rows: [
          ['拠点', '項目', '値', '単位', '期間', '算定基準', '排出係数'],
          ['本社', 'Scope2 間接排出', 1354.2, 't-CO2e', 'FY2026', 'マーケット基準', 0.000434],
          ['本社', 'Scope2 間接排出', 1421.8, 't-CO2e', 'FY2026', 'ロケーション基準', 0.000456],
          ['東日本工場', 'Scope2 間接排出', 1396.8, 't-CO2e', 'FY2026', 'マーケット基準', 0.000434],
          ['西日本工場', 'Scope2 間接排出', 1118.4, 't-CO2e', 'FY2026', 'マーケット基準', 0.000434],
        ],
      },
    ]),
  );

  {
    const s = monthlySeries(268.2, 23);
    table(
      '26_東日本_energy.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      await buildXlsx([
        {
          name: '月次実績',
          rows: [
            ['拠点', '項目', '値', '単位', '期間', '検針日'],
            ...MONTHS.map((m, i) => [
              '東日本工場',
              '電力使用量',
              s[i]!,
              'MWh',
              monthLabel(m),
              `${monthLabel(m, 'iso')}-25`,
            ]),
            ['東日本工場', '電力使用量', sum(s), 'MWh', 'FY2026', ''],
          ],
        },
      ]),
    );
  }

  table(
    '27_西日本_water.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    await buildXlsx([
      {
        name: '用水',
        rows: [
          ['拠点', '項目', '値', '単位', '期間', '水源', '備考'],
          ['西日本工場', '用水使用量', 71850, 'm3', 'FY2026', '市水', ''],
          ['西日本工場', '地下水採取量', 24600, 'm3', 'FY2026', '地下水', '許可番号 W-1182'],
          ['西日本工場', '排水量', 62400, 'm3', 'FY2026', '', '公共下水道'],
          ['西日本工場', '再生水利用量', 8400, 'm3', 'FY2026', '', '構内循環'],
        ],
      },
    ]),
  );

  table(
    '28_EU_scope1.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    await buildXlsx([
      {
        name: 'Scope 1',
        rows: [
          ['Site', 'Metric', 'Value', 'Unit', 'Period', 'Calculation basis'],
          [
            'EU Sales Office',
            'Scope 1 direct emissions',
            148.6,
            't-CO2e',
            'FY2026',
            'Fuel x factor',
          ],
          ['EU Sales Office', 'Company vehicles', 42.1, 't-CO2e', 'FY2026', 'Mileage x factor'],
          ['EU Warehouse', 'Scope 1 direct emissions', 62.8, 't-CO2e', 'FY2026', 'Fuel x factor'],
        ],
      },
    ]),
  );

  table(
    '29_EU_waste.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    await buildXlsx([
      {
        name: 'Waste',
        rows: [
          ['Site', 'Metric', 'Waste type', 'Value', 'Unit', 'Period'],
          ['EU Sales Office', 'Waste generated', 'Paper', 12.4, 't', 'FY2026'],
          ['EU Sales Office', 'Waste generated', 'Mixed', 8.1, 't', 'FY2026'],
          ['EU Warehouse', 'Waste generated', 'Packaging', 18.6, 't', 'FY2026'],
          ['EU Warehouse', 'Waste generated', 'Mixed', 4.2, 't', 'FY2026'],
        ],
      },
    ]),
  );

  table(
    '30_供应商_summary.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    await buildXlsx([
      {
        name: '汇总',
        rows: [
          ['站点', '指标', '数值', '单位', '期间', '备注'],
          ['供应商工厂A', '用电量', 1842.6, 'MWh', '2026财年', '电费账单'],
          ['供应商工厂A', '取水量', 18400, '立方米', '2026财年', '市政供水'],
          ['供应商工厂A', '直接排放', 486.2, '吨CO2e', '2026财年', '内部计算'],
          ['供应商工厂B', '用电量', 964.8, 'MWh', '2026财年', '电费账单'],
        ],
      },
    ]),
  );

  table(
    '31_総務_タイトル行つき.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    await buildXlsx([
      {
        name: '報告',
        rows: [
          ['2026年度 環境データ報告書'],
          ['総務部 環境課'],
          ['提出日: 2027年4月20日'],
          [],
          ['拠点', '項目', '値', '単位', '期間', '確認者'],
          ['本社', '電力使用量', 3120.5, 'MWh', 'FY2026', APPROVERS[0]],
          ['本社', '都市ガス使用量', 84.6, '千m3', 'FY2026', APPROVERS[0]],
          ['本社', '用水使用量', 12400, 'm3', 'FY2026', APPROVERS[1]],
          ['本社', '廃棄物排出量', 94.5, 't', 'FY2026', APPROVERS[1]],
        ],
        boldFirstRow: false,
      },
    ]),
  );

  table(
    '32_人事_headcount.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    await buildXlsx([
      {
        name: '人員',
        rows: [
          ['拠点', '項目', '値', '単位', '期間', '基準日'],
          ['本社', '従業員数', 480, '人', 'FY2026', '2027-03-31'],
          ['東日本工場', '従業員数', 480, '人', 'FY2026', '2027-03-31'],
          ['西日本工場', '従業員数', 370, '人', 'FY2026', '2027-03-31'],
          ['EU Sales Office', '従業員数', 100, '人', 'FY2026', '2027-03-31'],
          ['全社', '管理職数', 187, '人', 'FY2026', '2027-03-31'],
          ['全社', '女性管理職数', 34, '人', 'FY2026', '2027-03-31'],
        ],
      },
    ]),
  );

  table(
    '33_環境_multi_sheet.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    await buildXlsx([
      {
        name: 'エネルギー',
        rows: [
          ['拠点', '項目', '値', '単位', '期間'],
          ['本社', '電力使用量', 3120.5, 'MWh', 'FY2026'],
          ['東日本工場', '電力使用量', 3218.4, 'MWh', 'FY2026'],
          ['西日本工場', '電力使用量', 2577.6, 'MWh', 'FY2026'],
        ],
      },
      {
        name: '用水',
        rows: [
          ['拠点', '項目', '値', '単位', '期間'],
          ['本社', '用水使用量', 12400, 'm3', 'FY2026'],
          ['東日本工場', '用水使用量', 68200, 'm3', 'FY2026'],
          ['西日本工場', '用水使用量', 71850, 'm3', 'FY2026'],
        ],
      },
      {
        name: '廃棄物',
        rows: [
          ['拠点', '項目', '値', '単位', '期間'],
          ['本社', '廃棄物排出量', 94.5, 't', 'FY2026'],
          ['東日本工場', '廃棄物排出量', 1070.4, 't', 'FY2026'],
          ['西日本工場', '廃棄物排出量', 864.2, 't', 'FY2026'],
        ],
      },
    ]),
  );

  {
    const s = monthlySeries(268.2, 29);
    table(
      '34_東日本_月別電力.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      await buildXlsx([
        {
          name: '月別',
          rows: [
            ['拠点', '項目', '単位', ...MONTHS.map((m) => monthLabel(m)), '年度計'],
            ['東日本工場', '電力使用量', 'MWh', ...s, sum(s)],
            [
              '東日本工場',
              'うち再エネ由来',
              'MWh',
              ...s.map((v) => round(v * 0.18)),
              round(sum(s) * 0.18),
            ],
          ],
        },
      ]),
    );
  }

  {
    const s = monthlySeries(5987, 31, 0.2).map((v) => Math.round(v));
    table(
      '35_西日本_月別用水.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      await buildXlsx([
        {
          name: '月別用水',
          rows: [
            ['拠点', '項目', '単位', ...MONTHS.map((m) => monthLabel(m, 'iso')), '年度計'],
            ['西日本工場', '用水使用量', 'm3', ...s, s.reduce((a, b) => a + b, 0)],
            [
              '西日本工場',
              '排水量',
              'm3',
              ...s.map((v) => Math.round(v * 0.87)),
              Math.round(s.reduce((a, b) => a + b, 0) * 0.87),
            ],
          ],
        },
      ]),
    );
  }

  table(
    '36_経営企画_転置レイアウト.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    await buildXlsx([
      {
        name: '転置',
        rows: [
          ['項目', '本社', '東日本工場', '西日本工場', 'EU Sales Office', '単位', '期間'],
          ['Scope1 直接排出', 512.4, 1284.2, 1042.8, 148.6, 't-CO2e', 'FY2026'],
          ['Scope2 間接排出', 1354.2, 1396.8, 1118.4, 32.2, 't-CO2e', 'FY2026'],
          ['電力使用量', 3120.5, 3218.4, 2577.6, 74.2, 'MWh', 'FY2026'],
          ['用水使用量', 12400, 68200, 71850, 4820, 'm3', 'FY2026'],
          ['廃棄物排出量', 94.5, 1070.4, 864.2, 22.1, 't', 'FY2026'],
        ],
      },
    ]),
  );

  // ====================================================================
  // 37〜45: 例外的なレイアウト・単位・表記
  // ====================================================================

  csvFile('37_transposed_summary.csv', [
    ['Metric', 'HQ', 'East Plant', 'West Plant', 'EU Office', 'Unit', 'Period'],
    ['Scope 1 emissions', 512.4, 1284.2, 1042.8, 148.6, 't-CO2e', 'FY2026'],
    ['Scope 2 emissions', 1354.2, 1396.8, 1118.4, 32.2, 't-CO2e', 'FY2026'],
    ['Electricity', 3120.5, 3218.4, 2577.6, 74.2, 'MWh', 'FY2026'],
    ['Water withdrawal', 12400, 68200, 71850, 4820, 'm3', 'FY2026'],
  ]);

  csvFile('38_サプライヤーA_kgCO2e.csv', [
    ['拠点', '項目', '値', '単位', '期間', '備考'],
    [
      'サプライヤーA',
      'Scope1 直接排出',
      fmtEn(486200, 0),
      'kg-CO2e',
      'FY2026',
      '単位に注意（kg 表記）',
    ],
    [
      'サプライヤーA',
      'Scope2 間接排出',
      fmtEn(1284000, 0),
      'kg-CO2e',
      'FY2026',
      '単位に注意（kg 表記）',
    ],
    [
      'サプライヤーB',
      'Scope1 直接排出',
      fmtEn(241600, 0),
      'kg-CO2e',
      'FY2026',
      '単位に注意（kg 表記）',
    ],
  ]);

  csvFile('39_設備課_kWh表記.csv', [
    ['拠点', '項目', '値', '単位', '期間', '備考'],
    ['本社', '電力使用量', fmtEn(3120500, 0), 'kWh', 'FY2026', 'MWh ではなく kWh'],
    ['東日本工場', '電力使用量', fmtEn(3218400, 0), 'kWh', 'FY2026', 'MWh ではなく kWh'],
    ['西日本工場', '電力使用量', fmtEn(2577600, 0), 'kWh', 'FY2026', 'MWh ではなく kWh'],
  ]);

  csvFile('40_全角数字.csv', [
    ['拠点', '項目', '値', '単位', '期間'],
    ['本社', '電力使用量', toZenkaku('3,120.5'), 'ＭＷｈ', 'ＦＹ２０２６'],
    ['本社', '用水使用量', toZenkaku('12,400'), 'ｍ３', 'ＦＹ２０２６'],
    ['東日本工場', '電力使用量', toZenkaku('3,218.4'), 'ＭＷｈ', 'ＦＹ２０２６'],
  ]);

  csvFile('41_列名が不明瞭.csv', [
    ['場所', 'データ種別', '数量', '備考', '登録者'],
    ['本社ビル', '電気', '3120.5', 'MWh 換算済み', '設備課'],
    ['本社ビル', '水', '12400', 'm3', '設備課'],
    ['東工場', '電気', '3218.4', 'MWh 換算済み', '工務課'],
    ['東工場', 'ごみ', '1070.4', 't（産廃のみ）', '環境課'],
    ['西工場', '電気', '2577.6', 'MWh 換算済み', '工務課'],
  ]);

  csvFile('42_混在_ゴミ行あり.csv', [
    ['拠点', '項目', '値', '単位', '備考'],
    ['※ この行はメモです', '', '', '', '前年度の集計方法を踏襲'],
    ['西日本工場', 'Scope1 直接排出', 2988.6, 't-CO2e', ''],
    ['', '', '', '', ''],
    ['西日本工場', 'Scope2 間接排出', 1118.4, 't-CO2e', ''],
    ['-----', '-----', '-----', '-----', '-----'],
    ['西日本工場', '電力使用量', 2577.6, 'MWh', ''],
    ['合計', '', 2988.6, '', '※ 合計行（取込対象外）'],
  ]);

  csvFile('43_調達部_supplier_report.csv', [
    ['Supplier Site', 'Category', 'Metric', 'Value', 'Unit', 'Period', 'Data quality'],
    [
      'Supplier A',
      'Purchased goods',
      'Scope 3 Cat.1',
      fmtEn(2845.6),
      't-CO2e',
      'FY2026',
      'Supplier-specific',
    ],
    [
      'Supplier B',
      'Purchased goods',
      'Scope 3 Cat.1',
      fmtEn(1284.2),
      't-CO2e',
      'FY2026',
      'Spend-based',
    ],
    [
      'Supplier C',
      'Purchased goods',
      'Scope 3 Cat.1',
      '2.845',
      't-CO2e',
      'FY2026',
      'Spend-based（区切り記号が不明瞭）',
    ],
    [
      'Supplier D',
      'Purchased goods',
      'Scope 3 Cat.1',
      fmtEn(642.8),
      't-CO2e',
      'FY2026',
      'Spend-based',
    ],
  ]);

  csvFile('44_IR部_governance.csv', [
    ['対象', '項目', '値', '単位', '期間', '出典'],
    ['取締役会', '取締役数', 11, '人', 'FY2026', '有価証券報告書'],
    ['取締役会', '社外取締役数', 5, '人', 'FY2026', '有価証券報告書'],
    ['取締役会', '女性取締役数', 3, '人', 'FY2026', '有価証券報告書'],
    ['取締役会', '取締役会開催回数', 14, '回', 'FY2026', '招集通知'],
    ['監査役会', '監査役数', 4, '人', 'FY2026', '有価証券報告書'],
  ]);

  csvFile('45_総務_gj蒸気.csv', [
    ['拠点', '項目', '値', '単位', '期間', '備考'],
    ['東日本工場', '蒸気使用量', fmtEn(18400, 0), 'GJ', 'FY2026', '外部購入蒸気'],
    ['西日本工場', '蒸気使用量', fmtEn(12600, 0), 'GJ', 'FY2026', '外部購入蒸気'],
    ['東日本工場', '熱使用量', fmtEn(4200, 0), 'GJ', 'FY2026', '地域熱供給'],
  ]);

  // ====================================================================
  // 46〜50: PDF（Evidence 用。Latin 文字のみ）
  // ====================================================================

  const pdf = (name: string, lines: string[]) =>
    files.push({
      name,
      mimeType: 'application/pdf',
      bytes: buildSimplePdf(lines),
      kind: 'pdf',
    });

  pdf('46_electricity_invoice_munich.pdf', [
    'Stadtwerke Muenchen - Stromrechnung',
    'Rechnungsnummer: SR-2026-004128',
    'Kunde: EU Sales Office GmbH, Musterstrasse 12, 80331 Muenchen',
    'Abrechnungszeitraum: 01.04.2026 - 31.03.2027',
    '',
    'Position                     Menge        Einheit     Preis      Betrag',
    'Arbeitspreis HT              48.120,0     kWh         0,2840     13.666,08',
    'Arbeitspreis NT              26.080,0     kWh         0,1960      5.111,68',
    'Grundpreis                       12,0     Monate     18,5000        222,00',
    'Netzentgelt                  74.200,0     kWh         0,0720      5.342,40',
    '',
    'Gesamtverbrauch:             74.200,0 kWh  (entspricht 74,2 MWh)',
    'Nettobetrag:                 24.342,16 EUR',
    'Umsatzsteuer 19%:             4.625,01 EUR',
    'Rechnungsbetrag:             28.967,17 EUR',
    '',
    'CO2-Faktor Strommix 2026: 0,380 kg CO2e/kWh',
    'Berechnete Emissionen: 28,20 t CO2e (Scope 2, market-based)',
  ]);

  pdf('47_water_invoice_eu.pdf', [
    'Municipal Water Services - Invoice',
    'Invoice No.: WTR-2026-11842',
    'Customer: EU Sales Office GmbH',
    'Billing period: 01 Apr 2026 - 31 Mar 2027',
    '',
    'Description                  Quantity     Unit        Rate       Amount',
    'Water withdrawal              4,820.0     m3          2.140      10,314.80',
    'Waste water discharge         4,310.0     m3          1.860       8,016.60',
    'Standing charge                  12.0     months     24.000         288.00',
    '',
    'Total withdrawal: 4,820.0 m3',
    'Total discharge:  4,310.0 m3',
    'Net consumption:    510.0 m3',
    '',
    'Net amount:      18,619.40 EUR',
    'VAT 19%:          3,537.69 EUR',
    'Total due:       22,157.09 EUR',
  ]);

  pdf('48_waste_manifest_east.pdf', [
    'Industrial Waste Manifest (English summary)',
    'Manifest No.: MF-2026-E-0412',
    'Generator: East Plant, Aomi Technology Co., Ltd.',
    'Reporting period: FY2026 (Apr 2026 - Mar 2027)',
    '',
    'Waste type                   Quantity     Unit        Treatment',
    'Waste plastics                  382.4     t           Recycling',
    'Metal scrap                     246.8     t           Recycling',
    'Sludge                          124.2     t           Intermediate treatment',
    'Wood waste                       89.6     t           Recycling',
    'Waste oil                        41.2     t           Intermediate treatment',
    'Other industrial waste          186.2     t           Landfill',
    '',
    'Total waste generated:        1,070.4 t',
    'Total recycled:                 842.1 t',
    'Recycling rate:                  78.7 %',
    '',
    'Licensed contractor: East Region Waste Management Inc. (License No. 1182-A)',
  ]);

  pdf('49_energy_report_supplier.pdf', [
    'Supplier Energy and Emissions Report',
    'Supplier: Supplier A Manufacturing Co., Ltd.',
    'Reporting period: FY2026',
    'Prepared for: Aomi Technology Co., Ltd. (Procurement Division)',
    '',
    'Indicator                    Value        Unit        Method',
    'Electricity consumption      1,842.6      MWh         Utility invoice',
    'Natural gas consumption         62.4      1000 m3     Utility invoice',
    'Scope 1 direct emissions       486.2      t-CO2e      Fuel x emission factor',
    'Scope 2 market-based           799.7      t-CO2e      Grid factor 0.434',
    'Water withdrawal            18,400.0      m3          Water meter',
    '',
    'Allocation to Aomi Technology: 24.8 % of total production volume',
    'Allocated Scope 1+2:           318.9 t-CO2e',
    '',
    'Verified by: internal audit, 2027-04-12',
  ]);

  pdf('50_ghg_summary_hq.pdf', [
    'GHG Inventory Summary (Headquarters)',
    'Organization: Aomi Technology Co., Ltd.',
    'Reporting period: FY2026 (1 Apr 2026 - 31 Mar 2027)',
    'Boundary: Operational control',
    '',
    'Scope                        Value        Unit        Notes',
    'Scope 1 (direct)               512.4      t-CO2e      Fuel combustion, company vehicles',
    'Scope 2 (market-based)       1,354.2      t-CO2e      Purchased electricity',
    'Scope 2 (location-based)     1,421.8      t-CO2e      For reference only',
    'Scope 3 Cat.1                2,845.6      t-CO2e      Purchased goods and services',
    'Scope 3 Cat.6                  128.4      t-CO2e      Business travel',
    '',
    'Total Scope 1+2 (market-based): 1,866.6 t-CO2e',
    'Intensity per revenue:            18.2 t-CO2e / 100M JPY',
    '',
    'Emission factors: national grid average 2026 (0.434 kg-CO2e/kWh)',
    'Prepared by: Sustainability Department',
    'Reviewed: 2027-04-18',
  ]);

  return files;
}
