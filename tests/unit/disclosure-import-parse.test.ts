import { describe, expect, it } from 'vitest';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { parseDocx, parseUploadedFile, validateUpload } from '@/lib/imports/parsers';
import {
  detectAnswerColumns,
  extractFromLines,
  extractFromTable,
} from '@/lib/services/disclosure-import';

/**
 * 過去回答 Import の解析ロジック（CDP-P0-003）。
 * Word は実際に .docx を生成して往復させる（Mock ではなく実ファイルで検証する）。
 */

async function buildDocx(lines: string[]): Promise<Uint8Array> {
  const doc = new Document({
    sections: [
      {
        children: lines.map((text) => new Paragraph({ children: [new TextRun(text)] })),
      },
    ],
  });
  const buffer = await Packer.toBuffer(doc);
  return new Uint8Array(buffer);
}

describe('列の推定', () => {
  it('日本語・英語どちらの見出しでも質問コード列と回答列を見つける', () => {
    expect(detectAnswerColumns(['質問コード', '回答'])).toEqual({
      code: '質問コード',
      answer: '回答',
    });
    expect(detectAnswerColumns(['Item Code', 'Answer'])).toEqual({
      code: 'Item Code',
      answer: 'Answer',
    });
    expect(detectAnswerColumns(['設問コード', '記載内容'])).toEqual({
      code: '設問コード',
      answer: '記載内容',
    });
  });

  it('見つからなければ null を返す', () => {
    expect(detectAnswerColumns(['拠点', '値'])).toEqual({ code: null, answer: null });
  });
});

describe('表からの抽出', () => {
  it('質問コードと回答を行番号付きで取り出す', () => {
    const { answers, warnings } = extractFromTable(
      ['質問コード', '回答'],
      [
        { 質問コード: 'C0.1', 回答: '当社は精密電子部品を製造しています。' },
        { 質問コード: 'C1.1', 回答: 'はい' },
      ],
      [2, 3],
    );
    expect(warnings).toEqual([]);
    expect(answers).toHaveLength(2);
    expect(answers[0]).toEqual({
      itemCode: 'C0.1',
      answerText: '当社は精密電子部品を製造しています。',
      locator: '行 2',
    });
    expect(answers[1]?.locator).toBe('行 3');
  });

  it('列を特定できないときは警告を返し、勝手に推測しない', () => {
    const { answers, warnings } = extractFromTable(['拠点', '値'], [{ 拠点: 'HQ', 値: '1' }], [2]);
    expect(answers).toEqual([]);
    expect(warnings[0]).toContain('特定できませんでした');
  });

  it('質問コードが空の行は無視する', () => {
    const { answers } = extractFromTable(
      ['質問コード', '回答'],
      [
        { 質問コード: '', 回答: '見出し行など' },
        { 質問コード: 'C1.2', 回答: '16.7' },
      ],
      [2, 3],
    );
    expect(answers).toHaveLength(1);
    expect(answers[0]?.itemCode).toBe('C1.2');
  });
});

describe('連続テキストからの抽出', () => {
  it('行頭の質問コードで区切り、次の区切りまでを本文にする', () => {
    const { answers } = extractFromLines([
      { text: 'C0.1 当社の事業内容', locator: 'p.1' },
      { text: '精密電子部品の設計・製造を行っています。', locator: 'p.1' },
      { text: '国内 2 工場を有します。', locator: 'p.1' },
      { text: 'C1.1 はい', locator: 'p.2' },
    ]);

    expect(answers).toHaveLength(2);
    expect(answers[0]?.itemCode).toBe('C0.1');
    expect(answers[0]?.answerText).toBe(
      '当社の事業内容\n精密電子部品の設計・製造を行っています。\n国内 2 工場を有します。',
    );
    expect(answers[0]?.locator).toBe('p.1');
    expect(answers[1]?.itemCode).toBe('C1.1');
    expect(answers[1]?.answerText).toBe('はい');
  });

  it('本文中に出てくる質問コードでは区切らない', () => {
    const { answers } = extractFromLines([
      { text: 'C0.1 事業内容', locator: 'p.1' },
      { text: '詳細は C1.1 を参照してください。', locator: 'p.1' },
    ]);
    expect(answers).toHaveLength(1);
    expect(answers[0]?.answerText).toContain('C1.1 を参照');
  });

  it('区切りが 1 つも無ければ警告を返す（無理に成功扱いしない）', () => {
    const { answers, warnings } = extractFromLines([
      { text: 'これは自由記述のレポートです。', locator: 'p.1' },
    ]);
    expect(answers).toEqual([]);
    expect(warnings[0]).toContain('質問コードで始まる行が見つかりませんでした');
  });

  it('SSBJ 形式のコード（SSBJ-G1）も区切りとして扱う', () => {
    const { answers } = extractFromLines([
      { text: 'SSBJ-G1 統治機関は取締役会です。', locator: '段落 1' },
    ]);
    expect(answers[0]?.itemCode).toBe('SSBJ-G1');
  });

  it('SSBJ 正式マスターのコード（一般-9 / 気候-47(1) / 気候-56-2 / 実務-7）を区切りとして扱う', () => {
    const { answers } = extractFromLines([
      { text: '一般-9 監督機関はサステナビリティ委員会です。', locator: '段落 1' },
      { text: '気候-47(1) 9052.7 t-CO2e です。', locator: '段落 2' },
      { text: '気候-56-2 デリバティブは除外していません。', locator: '段落 3' },
      { text: '実務-7 SHK 制度の方法は選択していません。', locator: '段落 4' },
    ]);
    expect(answers.map((a) => a.itemCode)).toEqual(['一般-9', '気候-47(1)', '気候-56-2', '実務-7']);
    expect(answers[1]?.answerText).toContain('9052.7');
  });
});

describe('Word (.docx) の解析', () => {
  it('実際の .docx から段落テキストを取り出せる', async () => {
    const bytes = await buildDocx([
      'CDP 2025 回答書',
      'C0.1 当社は精密電子部品の設計・製造を行っています。',
      'C1.1 はい',
    ]);

    const parsed = await parseDocx(bytes);
    expect(parsed.status).toBe('parsed');
    expect(parsed.paragraphs).toContain('CDP 2025 回答書');
    expect(parsed.paragraphs).toContain('C1.1 はい');
  });

  it('XML エンティティを含むテキストを正しく復元する', async () => {
    const bytes = await buildDocx(['C0.1 A&B <試験> "引用"']);
    const parsed = await parseDocx(bytes);
    expect(parsed.paragraphs.join('\n')).toContain('A&B <試験> "引用"');
  });

  it('ZIP でないバイト列は空として扱い、例外を投げない', async () => {
    const parsed = await parseDocx(new TextEncoder().encode('これは Word ではありません'));
    expect(parsed.status).toBe('empty');
    expect(parsed.paragraphs).toEqual([]);
  });

  it('parseUploadedFile が .docx を docx として振り分ける', async () => {
    const bytes = await buildDocx(['C0.1 テスト']);
    const result = await parseUploadedFile(
      '回答書.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes,
    );
    expect(result.kind).toBe('docx');
  });

  it('validateUpload が .docx を許可する', () => {
    const v = validateUpload(
      'CDP2025_回答.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      1024,
    );
    expect(v.ok).toBe(true);
  });

  it('validateUpload は許可外の拡張子を拒否したままである', () => {
    expect(validateUpload('script.exe', 'application/octet-stream', 1024).ok).toBe(false);
    expect(validateUpload('../../etc/passwd.csv', 'text/csv', 10).safeName).not.toContain('..');
  });
});
