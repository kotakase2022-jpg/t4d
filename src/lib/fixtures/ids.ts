/**
 * 決定論的 ID / ハッシュ生成。
 *
 * Fixture は毎回同一の UUID を生成する必要がある（Seed SQL・E2E・Snapshot Hash が
 * 実行ごとに変わると再現テストが成立しないため）。
 * `crypto.randomUUID()` は使わず、文字列から安定生成する。
 */

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

function fnv1a64(input: string, seed: bigint = FNV_OFFSET): bigint {
  let hash = seed;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff);
    hash = (hash * FNV_PRIME) & MASK64;
    // マルチバイト文字も取りこぼさない
    const high = input.charCodeAt(i) >> 8;
    if (high) {
      hash ^= BigInt(high);
      hash = (hash * FNV_PRIME) & MASK64;
    }
  }
  return hash;
}

function toHex(value: bigint, length: number): string {
  return value.toString(16).padStart(length, '0').slice(-length);
}

/** 任意の文字列から安定した 64bit 16 進ハッシュを作る。 */
export function stableHash(input: string): string {
  return toHex(fnv1a64(input), 16);
}

/** Snapshot / Version の内容ハッシュ（表示用に 32 文字）。 */
export function contentHash(input: string): string {
  const a = fnv1a64(input);
  const b = fnv1a64(`${input}#salt`, a);
  return `${toHex(a, 16)}${toHex(b, 16)}`;
}

/**
 * 名前空間 + キー から決定論的な UUID（v4 形式に整形）を作る。
 * 例: `fid('data_point', 'AOMI/FY2026/HQ/scope1')`
 */
export function fid(namespace: string, key: string): string {
  const a = fnv1a64(`${namespace}::${key}`);
  const b = fnv1a64(`${key}::${namespace}`, a);
  const hex = `${toHex(a, 16)}${toHex(b, 16)}`;
  const v = `4${hex.slice(13, 16)}`;
  const variantNibble = ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const y = `${variantNibble}${hex.slice(17, 20)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${v}-${y}-${hex.slice(20, 32)}`;
}

/**
 * Seed 付き決定論的乱数（xorshift128）。
 * サンプリングの再現性テストでも同じ実装を使う。
 */
export function createRng(seed: string): () => number {
  let s0 = Number(fnv1a64(seed) & 0xffffffffn) >>> 0;
  let s1 = Number((fnv1a64(seed, FNV_PRIME) >> 16n) & 0xffffffffn) >>> 0;
  if (s0 === 0) s0 = 0x9e3779b9;
  if (s1 === 0) s1 = 0x85ebca6b;
  return () => {
    let x = s0;
    const y = s1;
    s0 = y;
    x ^= x << 23;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= y ^ (y >>> 26);
    x >>>= 0;
    s1 = x;
    return ((s0 + s1) >>> 0) / 0x100000000;
  };
}
