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

function csvCell(value: string | number | null): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
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
