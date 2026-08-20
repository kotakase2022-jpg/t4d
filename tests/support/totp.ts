import { createHmac } from 'node:crypto';

/**
 * RFC 6238 TOTP（HMAC-SHA1 / 30 秒 / 6 桁）。
 * MFA E2E で Authenticator アプリの代わりにコードを生成するためのヘルパー。
 * ライブラリを追加しない方針のため node:crypto で実装する。
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`base32 でない文字が含まれています: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function totpCode(secretBase32: string, at: number = Date.now()): string {
  const counter = Math.floor(at / 1000 / 30);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secretBase32)).update(counterBuf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code = ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}

/** 30 秒境界をまたいで失敗しないよう、残り時間が短ければ次の窓を待つ */
export async function freshTotpCode(secretBase32: string): Promise<string> {
  const msIntoWindow = Date.now() % 30_000;
  if (msIntoWindow > 25_000) {
    await new Promise((resolve) => setTimeout(resolve, 30_000 - msIntoWindow + 500));
  }
  return totpCode(secretBase32);
}
