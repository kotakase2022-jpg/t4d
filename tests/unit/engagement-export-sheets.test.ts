import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 案件パッケージ Export の「案内」と「実物」を突き合わせる。
 *
 * 画面は 13 シートを列挙していたが、実際の出力は 12 シートで、
 * 「サンプル項目」「保証手続」は出ず、逆に「テスト」は案内に無かった。
 * 出力を増減したときに案内だけ取り残されるのを防ぐ。
 *
 * 表記のゆれ（「Sign-off」/「Signoff」、「PBC 依頼と回答」/「PBC」）は許し、
 * **並び順と件数の対応**を固定する。
 */

const ROUTE = 'src/app/api/exports/engagement/route.ts';
const PAGE = 'src/app/assurance/engagements/[engagementId]/exports/page.tsx';

/** 空白とハイフンを落として比べる */
function normalize(name: string): string {
  return name.replace(/[\s-－・]/g, '');
}

function actualSheetNames(): string[] {
  const src = readFileSync(ROUTE, 'utf8');
  return [...src.matchAll(/^\s+name: '([^']+)',$/gm)].map((m) => m[1]!);
}

function advertisedSheetNames(): string[] {
  const src = readFileSync(PAGE, 'utf8');
  const start = src.indexOf('const sheets = [');
  const block = src.slice(start, src.indexOf('];', start));
  // 「スコープ（組織 × 指標 …）」→「スコープ」
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]!.replace(/（.*$/, '').trim());
}

describe('案件パッケージ Export', () => {
  const actual = actualSheetNames();
  const advertised = advertisedSheetNames();

  it('案内しているシート数と、実際に出力するシート数が一致する', () => {
    expect(advertised.length, `案内 ${advertised.join(' / ')}`).toBe(actual.length);
  });

  it('並び順どうしで対応している（名前のゆれは許す）', () => {
    const mismatched = actual
      .map((name, index) => ({ actual: name, advertised: advertised[index] ?? '(無し)' }))
      .filter(({ actual: a, advertised: b }) => {
        const [x, y] = [normalize(a), normalize(b)];
        return !x.startsWith(y) && !y.startsWith(x);
      });
    expect(mismatched, '案内と出力が食い違うシート').toEqual([]);
  });
});
