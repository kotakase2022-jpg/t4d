/**
 * 最小の ZIP 書き出し（依存を増やさないため自前実装）。
 *
 * 目的は 1 点だけ: **ファイル名を UTF-8 で書き、UTF-8 フラグを立てる**こと。
 * Windows 標準の圧縮（Compress-Archive）は日本語のファイル名を CP932 で書き、
 * フラグも立てないため、別環境（macOS・Google Drive のプレビュー等）で展開すると
 * 名前が化ける。ここでは general purpose bit 11 を必ず立てる。
 *
 * 圧縮は Node 標準の zlib（deflate raw）を使う。
 */
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS 形式の日時（再生成のたびに変わらないよう固定値を渡す） */
function dosDateTime(date: Date): { time: number; date: number } {
  const time =
    (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const d =
    ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, date: d };
}

interface Chunk {
  bytes: Uint8Array;
}

function u16(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
}

function u32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

/**
 * ZIP を組み立てる。`modifiedAt` を固定すると、同じ入力から常に同じバイト列になる。
 */
export function buildZip(
  entries: ZipEntry[],
  modifiedAt = new Date('2026-08-19T00:00:00Z'),
): Uint8Array {
  const { time, date } = dosDateTime(modifiedAt);
  const UTF8_FLAG = 0x0800; // general purpose bit 11: ファイル名は UTF-8

  const localParts: Chunk[] = [];
  const centralParts: Chunk[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.bytes);
    const deflated = new Uint8Array(deflateRawSync(entry.bytes, { level: 6 }));
    // 圧縮で膨らむ場合は無圧縮（method 0）で格納する
    const useDeflate = deflated.length < entry.bytes.length;
    const body = useDeflate ? deflated : entry.bytes;
    const method = useDeflate ? 8 : 0;

    const local = concat([
      u32(0x04034b50),
      u16(20), // version needed
      u16(UTF8_FLAG),
      u16(method),
      u16(time),
      u16(date),
      u32(crc),
      u32(body.length),
      u32(entry.bytes.length),
      u16(nameBytes.length),
      u16(0), // extra field length
      nameBytes,
      body,
    ]);
    localParts.push({ bytes: local });

    const central = concat([
      u32(0x02014b50),
      u16(20), // version made by
      u16(20), // version needed
      u16(UTF8_FLAG),
      u16(method),
      u16(time),
      u16(date),
      u32(crc),
      u32(body.length),
      u32(entry.bytes.length),
      u16(nameBytes.length),
      u16(0), // extra
      u16(0), // comment
      u16(0), // disk number start
      u16(0), // internal attributes
      u32(0), // external attributes
      u32(offset),
      nameBytes,
    ]);
    centralParts.push({ bytes: central });

    offset += local.length;
  }

  const centralBytes = concat(centralParts.map((c) => c.bytes));
  const eocd = concat([
    u32(0x06054b50),
    u16(0), // disk number
    u16(0), // disk with central directory
    u16(entries.length),
    u16(entries.length),
    u32(centralBytes.length),
    u32(offset),
    u16(0), // comment length
  ]);

  return concat([...localParts.map((c) => c.bytes), centralBytes, eocd]);
}
