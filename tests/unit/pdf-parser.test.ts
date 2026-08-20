import { describe, expect, it } from 'vitest';
import { parsePdf, parseUploadedFile } from '@/lib/imports/parsers';

/**
 * PDF 解析（指示書 13 章）。
 *
 * 重要な要件は「抽出できない PDF を成功扱いにしない」こと。
 * `canvas`（pdf.js のネイティブ任意依存）は依存ツリーから除外しているため、
 * テキスト抽出がそれなしで動作することもここで確認する。
 */

/** テキストを 1 つ含む最小の PDF を組み立てる。 */
function buildTextPdf(text: string): Uint8Array {
  const stream = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`;
  const bodies = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    null,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  bodies.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf +=
      index === 3
        ? `4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream\nendobj\n`
        : `${index + 1} 0 obj${body}endobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer<</Size ${bodies.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return new TextEncoder().encode(pdf);
}

describe('PDF テキスト抽出', () => {
  it('テキストを含む PDF からページ単位で抽出できる', async () => {
    const result = await parsePdf(buildTextPdf('Scope1 total 1234.5 t-CO2e'));

    expect(result.status).toBe('parsed');
    expect(result.message).toBeNull();
    expect(result.pages.length).toBeGreaterThan(0);
    expect(result.pages[0]?.page).toBe(1);
    expect(result.pages[0]?.text).toContain('1234.5');
  }, 30_000);

  it('テキストを持たない PDF は成功扱いにせず「OCR／AI解析要確認」を返す', async () => {
    // 本文ストリームが空の PDF
    const result = await parsePdf(buildTextPdf(''));

    expect(result.status).toBe('needs_ocr');
    expect(result.message).toContain('OCR');
    expect(result.pages).toEqual([]);
  }, 30_000);

  it('壊れたバイト列でも例外を投げず needs_ocr を返す', async () => {
    const result = await parsePdf(new TextEncoder().encode('this is not a pdf'));
    expect(result.status).toBe('needs_ocr');
    expect(result.message).toContain('OCR');
  }, 30_000);

  it('parseUploadedFile が拡張子から PDF を判別する', async () => {
    // 抽出文字数が 20 未満だと needs_ocr 扱いになるため、十分な長さの本文にする
    const result = await parseUploadedFile(
      '燃料使用記録.pdf',
      'application/pdf',
      buildTextPdf('Fuel consumption total 1000 L for FY2026'),
    );
    expect(result.kind).toBe('pdf');
    if (result.kind !== 'pdf') return;
    expect(result.pdf.status).toBe('parsed');
  }, 30_000);

  it('未対応形式は明示的に unsupported を返す', async () => {
    const result = await parseUploadedFile('image.png', 'image/png', new Uint8Array([1, 2, 3]));
    expect(result.kind).toBe('unsupported');
    if (result.kind !== 'unsupported') return;
    expect(result.message).toContain('未対応の形式');
  });
});
