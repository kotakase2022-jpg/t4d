import 'server-only';

/**
 * Export（CSV / XLSX / 簡易 DOCX）。
 *
 * すべて Server Side で生成し、Route Handler が Content-Disposition 付きで返す。
 * Export の実行は audit_events（export_created）へ記録する。
 */

export interface ExportColumn<T> {
  key: string;
  header: string;
  value: (row: T) => string | number | null;
  numeric?: boolean;
}

export interface ExportSheet<T> {
  name: string;
  columns: ExportColumn<T>[];
  rows: T[];
}

// ----------------------------------------------------------------------
// CSV
// ----------------------------------------------------------------------

/**
 * 表計算ソフトが数式として解釈する先頭文字。
 *
 * `=cmd|...` のような文字列をそのまま出すと、CSV を開いた相手の環境で
 * 数式として実行されうる（数式インジェクション）。企業が入力した文字列が
 * 監査法人の手元で開かれる経路があるため、出力側で無害化する。
 */
const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

function csvCell(value: string | number | null): string {
  if (value === null || value === undefined) return '';
  // 数値はそのまま出す（負数を壊さない）
  if (typeof value === 'number') return String(value);

  let text = String(value);
  if (text.length > 0 && FORMULA_TRIGGERS.includes(text[0]!)) {
    // 先頭に ' を付けると、値は読めるまま数式として評価されなくなる
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Excel で日本語が文字化けしないよう UTF-8 BOM を付ける。 */
const UTF8_BOM = '\uFEFF';

export function toCsv<T>(sheet: ExportSheet<T>): string {
  const header = sheet.columns.map((c) => csvCell(c.header)).join(',');
  const body = sheet.rows
    .map((row) => sheet.columns.map((c) => csvCell(c.value(row))).join(','))
    .join('\r\n');
  return `${UTF8_BOM}${header}\r\n${body}\r\n`;
}

// ----------------------------------------------------------------------
// XLSX
// ----------------------------------------------------------------------

export async function toXlsx<T>(sheets: ExportSheet<T>[], title: string): Promise<Uint8Array> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TERRAST for Disclosure (T4D)';
  workbook.created = new Date();
  workbook.title = title;

  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name.slice(0, 31));
    ws.columns = sheet.columns.map((c) => ({
      header: c.header,
      key: c.key,
      width: Math.max(12, Math.min(48, c.header.length * 2 + 6)),
    }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFEAF3FF' },
    };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    for (const row of sheet.rows) {
      const record: Record<string, string | number | null> = {};
      for (const column of sheet.columns) record[column.key] = column.value(row);
      ws.addRow(record);
    }

    sheet.columns.forEach((column, index) => {
      if (!column.numeric) return;
      ws.getColumn(index + 1).numFmt = '#,##0.###';
      ws.getColumn(index + 1).alignment = { horizontal: 'right' };
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

// ----------------------------------------------------------------------
// DOCX（簡易）
// ----------------------------------------------------------------------

export interface DocxSection {
  heading: string;
  paragraphs: string[];
  table?: { headers: string[]; rows: string[][] };
}

export async function toDocx(title: string, sections: DocxSection[]): Promise<Uint8Array> {
  const {
    Document,
    Packer,
    Paragraph,
    HeadingLevel,
    Table,
    TableRow,
    TableCell,
    TextRun,
    WidthType,
  } = await import('docx');

  // Paragraph と Table が混在するため要素型は union にする
  const children: Array<InstanceType<typeof Paragraph> | InstanceType<typeof Table>> = [
    new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
    new Paragraph({
      children: [
        new TextRun({
          text: '本文書は TERRAST for Disclosure (T4D) が生成した下書きです。開示前に内容を確認してください。',
          italics: true,
          size: 18,
        }),
      ],
    }),
  ];

  for (const section of sections) {
    children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }));
    for (const paragraph of section.paragraphs) {
      children.push(new Paragraph({ text: paragraph }));
    }
    if (section.table) {
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              children: section.table.headers.map(
                (h) =>
                  new TableCell({
                    children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })],
                  }),
              ),
            }),
            ...section.table.rows.map(
              (row) =>
                new TableRow({
                  children: row.map((cell) => new TableCell({ children: [new Paragraph(cell)] })),
                }),
            ),
          ],
        }),
      );
    }
  }

  const doc = new Document({ sections: [{ children: children as never[] }] });
  const buffer = await Packer.toBuffer(doc);
  return new Uint8Array(buffer);
}

// ----------------------------------------------------------------------
// レポート画面の出力カード
// ----------------------------------------------------------------------

/** 出力カード 1 枚。links は出力形式のボタンだけを持つ（カードを入れ子にしない） */
export interface ReportExportCard {
  title: string;
  description: string;
  links: Array<{ label: string; href: string }>;
}

/**
 * レポート画面（/enterprise/reports）に並べる出力の一覧。
 *
 * 以前は画面側で配列を書いており、CDP のカードが SSBJ カードの links に入れ子になって
 * 画面に出ていなかった。CSRD の DOCX は経路（/api/exports/cdp?framework=csrd&format=docx）が
 * あるのにリンクが無かった（W0 棚卸し）。構造を 1 か所にしてテストで確かめる。
 */
export function buildReportExportCards(periodId: string): ReportExportCard[] {
  const disclosure = (framework: 'ssbj' | 'cdp' | 'csrd', format: ExportFormat) =>
    framework === 'cdp'
      ? `/api/exports/cdp?period=${periodId}&format=${format}`
      : `/api/exports/cdp?framework=${framework}&period=${periodId}&format=${format}`;

  return [
    {
      title: '非財務データ台帳',
      description: '組織 × 期間 × 指標 × 値 × 単位 × 状態 × 検証結果 × Evidence 件数を出力します。',
      links: [
        { label: 'CSV', href: `/api/exports/data-points?period=${periodId}&format=csv` },
        { label: 'XLSX', href: `/api/exports/data-points?period=${periodId}&format=xlsx` },
      ],
    },
    {
      title: 'SSBJ 開示ドラフト',
      description:
        'CSV / XLSX は SSBJ の開示要求ごとの一覧（マッピング指標・当年値／前年値）。DOCX は開示ドラフト画面の節別の本文（確定／未確定を明記）と、定量指標の承認済みの値を出力します。',
      links: [
        { label: 'CSV', href: disclosure('ssbj', 'csv') },
        { label: 'XLSX', href: disclosure('ssbj', 'xlsx') },
        { label: 'DOCX（節別ドラフト）', href: disclosure('ssbj', 'docx') },
      ],
    },
    {
      title: 'CDP 回答一覧',
      description:
        '質問コード・質問文・前年差分区分・状態・回答本文・マッピング指標を出力します（一問一答転記用）。',
      links: [
        { label: 'CSV', href: disclosure('cdp', 'csv') },
        { label: 'XLSX', href: disclosure('cdp', 'xlsx') },
        { label: 'DOCX（開示ドラフト）', href: disclosure('cdp', 'docx') },
      ],
    },
    {
      title: 'CSRD 開示ドラフト',
      description:
        'CSRD（ESRS・架空の縮小マスター）の開示要求ごとに、回答本文とマッピング指標を出力します。',
      links: [
        { label: 'CSV', href: disclosure('csrd', 'csv') },
        { label: 'XLSX', href: disclosure('csrd', 'xlsx') },
        { label: 'DOCX（開示ドラフト）', href: disclosure('csrd', 'docx') },
      ],
    },
  ];
}

// ----------------------------------------------------------------------
// 共通
// ----------------------------------------------------------------------

export const EXPORT_CONTENT_TYPES = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const;

export type ExportFormat = keyof typeof EXPORT_CONTENT_TYPES;

/** RFC 5987 に沿った Content-Disposition（日本語ファイル名対応）。 */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
