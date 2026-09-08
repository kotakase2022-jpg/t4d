import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Demo Mode の Cookie 持ち回し（demo-persistence）。
 *
 * 確かめたいこと:
 *  - 通常サイズの編集は Cookie に書かれ、読み戻せる
 *  - **単体で 1 チャンクに入らない巨大編集は追記を諦め、既存の編集を消さない**
 *    （以前は縮小ループが空になるまで回り、全チャンクを空で上書きしていた）
 */

const jar = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string, options?: { maxAge?: number }) => {
      if (!value || options?.maxAge === 0) jar.delete(name);
      else jar.set(name, value);
    },
  }),
}));

// vi.mock の後で import する（モックを効かせるため）
const { appendDemoEdit, readDemoEdits } = await import('@/lib/repositories/demo-persistence');

/** deflate で縮まない（= 確実に上限超過する）値を決定論的に作る */
function incompressible(length: number): string {
  let x = 123456789;
  let out = '';
  while (out.length < length) {
    // xorshift32。乱数 API は使わない（決定論を守る）
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out += (x >>> 0).toString(36);
  }
  return out.slice(0, length);
}

beforeEach(() => {
  jar.clear();
});

describe('Demo 編集の Cookie 持ち回し', () => {
  it('通常サイズの編集は書き込まれ、読み戻せる', async () => {
    await appendDemoEdit('comments', 'c-1', { body: 'こんにちは' });
    const edits = await readDemoEdits();
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ t: 'comments', id: 'c-1' });
  });

  it('単体で入らない巨大編集は追記を諦め、既存の編集を守る', async () => {
    await appendDemoEdit('comments', 'c-1', { body: '守られるべき既存の編集' });

    // 圧縮後も 1 チャンク（3800 文字）に収まらないサイズ
    await appendDemoEdit('calculations', 'big-1', { inputs: incompressible(40_000) });

    const edits = await readDemoEdits();
    expect(edits.map((e) => e.id)).toEqual(['c-1']);
  });
});
