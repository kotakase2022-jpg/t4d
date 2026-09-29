/**
 * Word (.docx) テキスト抽出（CDP-P0-003）。
 *
 * `server-only` を付けない純粋モジュール。parsers.ts（取込・資料の断片化）から再輸出し、
 * E2E（Playwright の Node プロセス）も同じ実装で出力した DOCX を読み戻せるようにする
 * （server-only を import すると Next.js の外では読み込めないため）。
 */

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
