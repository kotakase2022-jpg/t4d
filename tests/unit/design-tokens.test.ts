import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BUTTON_VARIANT_RENAMES,
  TOKEN_REPLACEMENTS,
  replaceTokens,
  transformButtons,
} from '../../scripts/codemod-tokens.mjs';
import { cn, FONT_SIZE_TOKENS } from '@/lib/utils';

/**
 * デザイントークンと、見た目を変えない置き換え（plan §3.3・§3.4-2 (a)）。
 *
 * 置き換えの前後で計算後の CSS が同じであることを、次の 3 点で確かめる:
 *  1. 対応表の各トークンの値が、置き換え元の任意値と一致する（globals.css を読む）
 *  2. 文字サイズのトークンは line-height を持たない（text-[12px] と同じ font-size だけの宣言）
 *  3. cn（tailwind-merge）の結果が置き換え前と同じ（トークンを文字色とみなして消さない）
 */

const css = readFileSync('src/app/globals.css', 'utf8');

function tokenValue(name: string): string | null {
  const m = new RegExp(`${name.replace(/[-]/g, '\\-')}:\\s*([^;]+);`).exec(css);
  return m ? m[1]!.trim() : null;
}

describe('トークンの値', () => {
  it.each(TOKEN_REPLACEMENTS.map((r) => [r.from, r.to, r.token, r.value] as const))(
    '%s → %s（%s は %s）',
    (_from, _to, token, value) => {
      expect(tokenValue(token)).toBe(value);
    },
  );

  it('文字サイズのトークンは line-height を持たない（置き換えで行の高さを変えない）', () => {
    expect(css).not.toMatch(/--text-[a-z0-9-]+--line-height/);
    for (const name of FONT_SIZE_TOKENS) {
      expect(tokenValue(`--text-${name}`), name).toMatch(/^\d+px$/);
    }
  });

  it('重なりの順は役割の名前で並ぶ（小さい順）', () => {
    const order = [
      '--z-sticky-col',
      '--z-sticky',
      '--z-sticky-corner',
      '--z-pane',
      '--z-pane-overlay',
      '--z-header',
      '--z-overlay',
      '--z-modal',
      '--z-popover',
      '--z-progress',
      '--z-skiplink',
    ].map((name) => Number(tokenValue(name)));
    expect(order.every((value) => Number.isFinite(value))).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('スクロールバーの色は hex 直書きでなくトークンを使う', () => {
    expect(css).toContain('background: var(--color-scrollbar);');
    expect(css).toContain('background: var(--color-scrollbar-hover);');
  });
});

describe('cn（tailwind-merge）は置き換えの前後で同じ結果', () => {
  const sizes: Array<[string, string]> = [
    ['text-[11px]', 'text-caption'],
    ['text-[12px]', 'text-small'],
    ['text-[13px]', 'text-body'],
    ['text-[14px]', 'text-title-sm'],
    ['text-[15px]', 'text-title'],
    ['text-[16px]', 'text-title-lg'],
    ['text-[18px]', 'text-figure-sm'],
    ['text-[20px]', 'text-figure'],
    ['text-[22px]', 'text-figure-lg'],
  ];

  it.each(sizes)('%s と %s は文字色と共存し、後の文字サイズが勝つ', (before, after) => {
    const swap = (s: string) => s.replace(before, after);
    // 文字色と並べても消えない
    expect(cn(before, 'text-ink-muted')).toBe(`${before} text-ink-muted`);
    expect(cn(after, 'text-ink-muted')).toBe(swap(`${before} text-ink-muted`));
    // 文字サイズどうしは後が勝つ（任意値とトークンを混ぜても同じ）
    expect(cn(after, 'text-[13px]')).toBe('text-[13px]');
    expect(cn('text-[13px]', after)).toBe(after);
    expect(cn('text-caption', after)).toBe(after);
  });

  it('警告の文字色のトークンは任意値の色と同じく文字色として扱う', () => {
    expect(cn('text-[#8a5d00]', 'text-ink')).toBe('text-ink');
    expect(cn('text-warning-ink', 'text-ink')).toBe('text-ink');
    expect(cn('text-caption', 'text-warning-ink')).toBe('text-caption text-warning-ink');
  });
});

describe('codemod の置き換え（scripts/codemod-tokens.mjs）', () => {
  it('クラスの境界で完全一致したものだけを置き換える', () => {
    const { source } = replaceTokens(
      [
        `className="text-[11px] text-ink"`,
        `'hover:text-[12px] !text-[13px] [&_svg]:text-[11px]'`,
        `cn('text-[11px]/5', 'bg-[#0b1b34]/35', 'min-[1366px]:grid-cols-3')`,
        `'xtext-[11px] text-[11px]x text-[110px]'`,
      ].join('\n'),
      'src/x.tsx',
    );
    expect(source).toContain(`className="text-caption text-ink"`);
    expect(source).toContain(`'hover:text-small !text-body [&_svg]:text-caption'`);
    expect(source).toContain(`cn('text-caption/5', 'bg-overlay/35', 'wide:grid-cols-3')`);
    expect(source).toContain(`'xtext-[11px] text-[11px]x text-[110px]'`);
  });

  it('寸法の置き換えは対象のファイルだけ（同じ値の別の意味を巻き込まない）', () => {
    expect(replaceTokens(`'w-[64px]'`, 'src/app/x.tsx').source).toBe(`'w-[64px]'`);
    expect(replaceTokens(`'w-[64px]'`, 'src/components/shared/sidebar.tsx').source).toBe(
      `'w-sidebar-collapsed'`,
    );
  });

  it('variant の無いボタンに primary を明示し、outline→secondary・secondary→quiet に改名する', () => {
    expect(BUTTON_VARIANT_RENAMES).toEqual({ outline: 'secondary', secondary: 'quiet' });
    const input = [
      '<Button onClick={() => a > b}>保存</Button>',
      '<SubmitButton size="sm">送る</SubmitButton>',
      '<Button variant="outline" size="xs">CSV</Button>',
      '<Button\n  variant="secondary"\n>選択中</Button>',
      '<Button variant={on ? "primary" : "outline"}>切替</Button>',
      '<ButtonGroup>x</ButtonGroup>',
      '<Button asChild><Link href="/x">開く</Link></Button>',
    ].join('\n');
    const out = transformButtons(input);
    expect(out.source).toContain('<Button variant="primary" onClick={() => a > b}>保存</Button>');
    expect(out.source).toContain('<SubmitButton variant="primary" size="sm">送る</SubmitButton>');
    expect(out.source).toContain('<Button variant="secondary" size="xs">CSV</Button>');
    expect(out.source).toContain('<Button\n  variant="quiet"\n>選択中</Button>');
    // 動的な variant は触らず、行番号を返す（手で直す）
    expect(out.source).toContain('<Button variant={on ? "primary" : "outline"}>切替</Button>');
    expect(out.dynamic).toEqual([7]);
    expect(out.source).toContain('<ButtonGroup>x</ButtonGroup>');
    expect(out.source).toContain('<Button variant="primary" asChild><Link href="/x">開く</Link>');
    expect(out.added).toBe(3);
    expect(out.renamed).toBe(2);
  });
});
