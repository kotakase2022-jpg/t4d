import 'server-only';

/**
 * ファイル解析（指示書 13 章）。
 *
 * CSV / Excel: 表データを解析し、ヘッダー推定・空行除外・文字コード判定を行う。
 * PDF: テキスト抽出を試み、**抽出できない場合は成功扱いにせず**
 *      「OCR／AI解析要確認」として返す。
 */

export interface ParsedTable {
  headers: string[];
  rows: Array<Record<string, string>>;
  /** 元ファイル上の行番号（1 始まり・ヘッダー行を含む） */
  rowNumbers: number[];
  sheetName: string | null;
  detectedEncoding: string | null;
  warnings: string[];
}

export interface ParsedPdf {
  status: 'parsed' | 'needs_ocr';
  message: string | null;
  pages: Array<{ page: number; text: string }>;
}

export type ParseResult =
  | { kind: 'table'; table: ParsedTable }
  | { kind: 'pdf'; pdf: ParsedPdf }
  | { kind: 'docx'; docx: ParsedDocx }
  | { kind: 'unsupported'; message: string };

// ----------------------------------------------------------------------
// 文字コード判定
// ----------------------------------------------------------------------

/**
 * BOM → UTF-8（厳密） → Shift_JIS の順に試す。
 * Node 20+ は full-ICU 同梱のため `shift_jis` デコードが利用できる。
 */
export function decodeText(buffer: Uint8Array): {
  text: string;
  encoding: string;
  warning?: string;
} {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buffer.subarray(3)), encoding: 'UTF-8 (BOM)' };
  }

  try {
    const strict = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { text: strict, encoding: 'UTF-8' };
  } catch {
    // UTF-8 として不正 → Shift_JIS を試す
  }

  try {
    const sjis = new TextDecoder('shift_jis').decode(buffer);
    const replacements = (sjis.match(/�/g) ?? []).length;
    if (replacements === 0) return { text: sjis, encoding: 'Shift_JIS' };
    const ratio = replacements / Math.max(1, sjis.length);
    if (ratio < 0.02) {
      return {
        text: sjis,
        encoding: 'Shift_JIS',
        warning: `文字化けの可能性がある文字が ${replacements} 個ありました。`,
      };
    }
  } catch {
    // shift_jis 非対応環境
  }

  const fallback = new TextDecoder('utf-8').decode(buffer);
  const broken = (fallback.match(/�/g) ?? []).length;
  return {
    text: fallback,
    encoding: 'UTF-8 (代替)',
    warning:
      broken > 0
        ? `文字コードを判定できず、${broken} 文字が置換されました。UTF-8 で保存し直してください。`
        : undefined,
  };
}

// ----------------------------------------------------------------------
// 数値の多表記対応
// ----------------------------------------------------------------------

/**
 * ロケール混在の数値表記を解釈する（機能追加要望 ①）。
 * 対応: "1,234.5"（日英）/ "1.234,5"・"1 234,5"（独仏）/ 全角数字 / % や単位の付随。
 * 解釈できなければ null（勝手に 0 にしない）。
 */
export function parseFlexibleNumber(raw: string): number | null {
  let v = raw.normalize('NFKC').trim();
  if (v === '') return null;
  v = v.replace(/[%％]/g, '').replace(/[△▲]/g, '-').trim();
  // 数値以外の後置語（単位など）を落とす: "1,234.5 t-CO2e" → "1,234.5"
  const m = v.match(/^[-+]?[\d.,\s]+/);
  if (!m) return null;
  v = m[0].replace(/\s/g, '');

  const lastComma = v.lastIndexOf(',');
  const lastDot = v.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      // 1.234,5 → ドイツ・フランス式（. = 桁区切り, , = 小数点）
      v = v.replace(/\./g, '').replace(',', '.');
    } else {
      // 1,234.5 → 日英式
      v = v.replace(/,/g, '');
    }
  } else if (lastDot >= 0 && /^\d{1,3}(\.\d{3})+$/.test(v)) {
    // "2.845" はドイツ式なら 2845、日英式なら 2.845 で判別不能。
    // 契約どおり「解釈できなければ null」を返し、要確認として人へ委ねる
    // （誤って 1/1000 の値を高確信度で書き込む事故を防ぐ）。
    return null;
  } else if (lastComma >= 0) {
    const frac = v.length - lastComma - 1;
    // "1,5" のようにカンマ後が 1〜2 桁だけなら小数点、それ以外（"1,234"）は桁区切り
    v =
      frac > 0 && frac < 3 && v.indexOf(',') === lastComma
        ? v.replace(',', '.')
        : v.replace(/,/g, '');
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ----------------------------------------------------------------------
// CSV
// ----------------------------------------------------------------------

/**
 * 区切り文字を推定する（機能追加要望 ①: 事前加工なしの取込）。
 * 欧州の CSV はセミコロン区切りが一般的（小数点にカンマを使うため）。
 * 引用符外の出現回数が最多の候補を採用する。
 */
export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const head = text.slice(0, 4000);
  const counts: Record<',' | ';' | '\t', number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of head) {
    if (ch === '"') inQuotes = !inQuotes;
    if (inQuotes) continue;
    if (ch === ',' || ch === ';' || ch === '\t') counts[ch] += 1;
  }
  if (counts[';'] > counts[','] && counts[';'] >= counts['\t']) return ';';
  if (counts['\t'] > counts[','] && counts['\t'] > counts[';']) return '\t';
  return ',';
}

/** RFC4180 準拠の最小 CSV パーサ（引用符・改行・エスケープ・区切り文字自動判定に対応）。 */
export function parseCsvText(text: string, delimiter?: ',' | ';' | '\t'): string[][] {
  const sep = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === sep) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // CRLF の CR は無視
    } else if (ch !== undefined) {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function isBlankRow(cells: string[]): boolean {
  return cells.every((c) => c.trim() === '');
}

/**
 * ヘッダー行を推定する。
 * 「空でないセルが最も多く、数値だけではない行」を先頭 5 行から選ぶ。
 */
/**
 * ヘッダー行の推定。
 *
 * 現場のファイルは「報告書名・作成部署・作成日・注記・空行」のように
 * 前文が数行続いてから表が始まることが多い。候補の走査幅が狭いと
 * 前文の 1 行目をヘッダーと誤認し、表全体を取り逃す。
 * 数値が少なく、埋まっているセルが多い行ほどヘッダーらしいと評価する。
 */
const HEADER_SEARCH_LIMIT = 15;

export function detectHeaderRow(rows: string[][]): number {
  let best = 0;
  let bestScore = -1;
  const limit = Math.min(HEADER_SEARCH_LIMIT, rows.length);
  for (let i = 0; i < limit; i += 1) {
    const cells = rows[i] ?? [];
    if (isBlankRow(cells)) continue;
    const filled = cells.filter((c) => c.trim() !== '').length;
    const numeric = cells.filter(
      (c) => c.trim() !== '' && Number.isFinite(Number(c.replace(/,/g, ''))),
    ).length;
    const score = filled - numeric * 2;
    // 同点なら先に見つかった（＝より上の）行を残す
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

export function parseCsv(buffer: Uint8Array): ParsedTable {
  const { text, encoding, warning } = decodeText(buffer);
  const raw = parseCsvText(text);
  const warnings: string[] = warning ? [warning] : [];

  if (raw.length === 0) {
    return {
      headers: [],
      rows: [],
      rowNumbers: [],
      sheetName: null,
      detectedEncoding: encoding,
      warnings: ['ファイルが空です。'],
    };
  }

  const headerIndex = detectHeaderRow(raw);
  const headerCells = raw[headerIndex] ?? [];
  const headers = headerCells.map((h, i) => (h.trim() === '' ? `列${i + 1}` : h.trim()));

  const rows: Array<Record<string, string>> = [];
  const rowNumbers: number[] = [];
  for (let i = headerIndex + 1; i < raw.length; i += 1) {
    const cells = raw[i] ?? [];
    if (isBlankRow(cells)) continue;
    const record: Record<string, string> = {};
    headers.forEach((h, index) => {
      record[h] = (cells[index] ?? '').trim();
    });
    rows.push(record);
    rowNumbers.push(i + 1);
  }

  if (headerIndex > 0) {
    warnings.push(`${headerIndex} 行目までをヘッダー前の説明行として読み飛ばしました。`);
  }

  return { headers, rows, rowNumbers, sheetName: null, detectedEncoding: encoding, warnings };
}

// ----------------------------------------------------------------------
// Excel
// ----------------------------------------------------------------------

export async function parseExcel(
  buffer: Uint8Array,
  preferredSheet?: string,
): Promise<ParsedTable & { availableSheets: string[] }> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const availableSheets = workbook.worksheets.map((ws) => ws.name);
  const sheet =
    (preferredSheet ? workbook.getWorksheet(preferredSheet) : undefined) ?? workbook.worksheets[0];

  if (!sheet) {
    return {
      headers: [],
      rows: [],
      rowNumbers: [],
      sheetName: null,
      detectedEncoding: null,
      warnings: ['シートが見つかりませんでした。'],
      availableSheets,
    };
  }

  const grid: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      const value = cell.value;
      if (value === null || value === undefined) {
        cells.push('');
      } else if (typeof value === 'object' && 'result' in value) {
        cells.push(String((value as { result?: unknown }).result ?? ''));
      } else if (value instanceof Date) {
        cells.push(value.toISOString().slice(0, 10));
      } else if (typeof value === 'object' && 'text' in value) {
        cells.push(String((value as { text?: unknown }).text ?? ''));
      } else {
        cells.push(String(value));
      }
    });
    grid.push(cells);
  });

  const headerIndex = detectHeaderRow(grid);
  const headerCells = grid[headerIndex] ?? [];
  const headers = headerCells.map((h, i) => (h.trim() === '' ? `列${i + 1}` : h.trim()));

  const rows: Array<Record<string, string>> = [];
  const rowNumbers: number[] = [];
  for (let i = headerIndex + 1; i < grid.length; i += 1) {
    const cells = grid[i] ?? [];
    if (isBlankRow(cells)) continue;
    const record: Record<string, string> = {};
    headers.forEach((h, index) => {
      record[h] = (cells[index] ?? '').trim();
    });
    rows.push(record);
    rowNumbers.push(i + 1);
  }

  return {
    headers,
    rows,
    rowNumbers,
    sheetName: sheet.name,
    detectedEncoding: null,
    warnings:
      availableSheets.length > 1
        ? [`シートが ${availableSheets.length} 件あります。「${sheet.name}」を解析しました。`]
        : [],
    availableSheets,
  };
}

// ----------------------------------------------------------------------
// PDF
// ----------------------------------------------------------------------

export async function parsePdf(buffer: Uint8Array): Promise<ParsedPdf> {
  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(buffer);
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = (Array.isArray(text) ? text : [String(text)]).map((t, index) => ({
      page: index + 1,
      text: String(t ?? '').trim(),
    }));
    const totalChars = pages.reduce((sum, p) => sum + p.text.length, 0);

    if (totalChars < 20) {
      return {
        status: 'needs_ocr',
        message:
          'テキストを抽出できませんでした（画像 PDF の可能性）。OCR／AI 解析要確認として登録します。',
        pages: [],
      };
    }
    return { status: 'parsed', message: null, pages: pages.filter((p) => p.text.length > 0) };
  } catch (error) {
    return {
      status: 'needs_ocr',
      message: `PDF 解析に失敗しました（OCR／AI 解析要確認）: ${
        error instanceof Error ? error.message.slice(0, 120) : '不明なエラー'
      }`,
      pages: [],
    };
  }
}

// ----------------------------------------------------------------------
// 入口
// ----------------------------------------------------------------------

const CSV_MIME = ['text/csv', 'application/csv', 'text/plain', 'text/tab-separated-values'];
const DOCX_MIME = ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

const EXCEL_MIME = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
];

export async function parseUploadedFile(
  fileName: string,
  mimeType: string,
  buffer: Uint8Array,
  preferredSheet?: string,
): Promise<ParseResult> {
  const lower = fileName.toLowerCase();

  if (lower.endsWith('.csv') || lower.endsWith('.tsv') || CSV_MIME.includes(mimeType)) {
    return { kind: 'table', table: parseCsv(buffer) };
  }
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm') || EXCEL_MIME.includes(mimeType)) {
    return { kind: 'table', table: await parseExcel(buffer, preferredSheet) };
  }
  if (lower.endsWith('.pdf') || mimeType === 'application/pdf') {
    return { kind: 'pdf', pdf: await parsePdf(buffer) };
  }
  if (lower.endsWith('.docx') || DOCX_MIME.includes(mimeType)) {
    return { kind: 'docx', docx: await parseDocx(buffer) };
  }
  return {
    kind: 'unsupported',
    message: `未対応の形式です（${mimeType || '不明'}）。CSV / Excel / PDF / Word をアップロードしてください。`,
  };
}

// ----------------------------------------------------------------------
// アップロード検証（指示書 21 章）
// ----------------------------------------------------------------------

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const ALLOWED_EXTENSIONS = ['.csv', '.tsv', '.xlsx', '.xlsm', '.pdf', '.docx'];

export interface UploadValidation {
  ok: boolean;
  message?: string;
  safeName: string;
}

/** ファイル名の Path Traversal を防止し、拡張子・サイズ・MIME を検証する。 */
export function validateUpload(fileName: string, mimeType: string, size: number): UploadValidation {
  // ディレクトリ成分を落とす
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\0/g, '');
  const safeName = base.replace(/[^\p{L}\p{N}._\- ()]/gu, '_').slice(0, 200);

  if (!safeName || safeName === '.' || safeName === '..') {
    return { ok: false, message: 'ファイル名が不正です。', safeName: 'invalid' };
  }
  if (size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      message: `ファイルサイズが上限（${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB）を超えています。`,
      safeName,
    };
  }
  if (size === 0) {
    return { ok: false, message: 'ファイルが空です。', safeName };
  }
  const ext = safeName.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return {
      ok: false,
      message: `拡張子 ${ext || '(なし)'} は許可されていません（${ALLOWED_EXTENSIONS.join(', ')}）。`,
      safeName,
    };
  }
  const mimeOk =
    CSV_MIME.includes(mimeType) ||
    EXCEL_MIME.includes(mimeType) ||
    DOCX_MIME.includes(mimeType) ||
    mimeType === 'application/pdf' ||
    mimeType === '' ||
    mimeType === 'application/octet-stream';
  if (!mimeOk) {
    return { ok: false, message: `MIME タイプ ${mimeType} は許可されていません。`, safeName };
  }
  return { ok: true, safeName };
}

// ----------------------------------------------------------------------
// Word (.docx) テキスト抽出（CDP-P0-003）
// ----------------------------------------------------------------------

export interface ParsedDocx {
  status: 'parsed' | 'empty';
  message: string | null;
  /** 段落単位のテキスト（表のセルも 1 段落として並ぶ） */
  paragraphs: string[];
}

/**
 * .docx から本文テキストを取り出す。
 *
 * .docx は ZIP なので、依存を増やさず Node 標準の zlib で `word/document.xml` を取り出す。
 * （`docx` パッケージは生成専用で解析はできない。解析のためだけに依存を増やしたくない）
 * 書式は捨て、段落（`<w:p>`）区切りのプレーンテキストだけを返す。
 */
export async function parseDocx(buffer: Uint8Array): Promise<ParsedDocx> {
  const xml = await extractZipEntry(buffer, 'word/document.xml');
  if (!xml) {
    return {
      status: 'empty',
      message:
        'Word ファイルから本文を取り出せませんでした（.doc 形式や暗号化ファイルの可能性があります）。',
      paragraphs: [],
    };
  }

  const text = new TextDecoder('utf-8').decode(xml);
  const paragraphs: string[] = [];

  // <w:p> ごとに、その中の <w:t> を連結する。<w:tab/> と <w:br/> は空白へ。
  for (const match of text.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const block = match[0];
    let line = '';
    for (const t of block.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(?:tab|br)\s*\/>/g)) {
      line += t[1] === undefined ? ' ' : decodeXmlEntities(t[1]);
    }
    const trimmed = line.trim();
    if (trimmed) paragraphs.push(trimmed);
  }

  if (paragraphs.length === 0) {
    return { status: 'empty', message: '本文が空でした。', paragraphs: [] };
  }
  return { status: 'parsed', message: null, paragraphs };
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/**
 * ZIP から 1 エントリを取り出す（Store / Deflate のみ対応）。
 * End of Central Directory → Central Directory → Local File Header の順に辿る。
 */
async function extractZipEntry(buffer: Uint8Array, entryName: string): Promise<Uint8Array | null> {
  const { inflateRawSync } = await import('node:zlib');
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // EOCD シグネチャ 0x06054b50 を末尾から探す（コメント最大 64KB）
  let eocd = -1;
  const start = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= start; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  for (let n = 0; n < entryCount; n++) {
    if (offset + 46 > buffer.length || view.getUint32(offset, true) !== 0x02014b50) return null;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder('utf-8').decode(
      buffer.subarray(offset + 46, offset + 46 + nameLen),
    );

    if (name === entryName) {
      // Local File Header は名前・extra の長さが Central Directory と異なりうる
      if (view.getUint32(localOffset, true) !== 0x04034b50) return null;
      const lNameLen = view.getUint16(localOffset + 26, true);
      const lExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const raw = buffer.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return raw;
      if (method === 8) return new Uint8Array(inflateRawSync(raw));
      return null; // 未対応の圧縮方式
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
