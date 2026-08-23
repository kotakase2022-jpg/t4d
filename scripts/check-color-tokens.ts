import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tailwind のクラス名で参照している色が、実際に定義済みのトークンかを検査する。
 *
 * Tailwind v4 は `@theme` の CSS 変数からユーティリティを生成する。
 * 定義されていない名前（例: `bg-warn-surface`）を書いても**エラーにならず、
 * 単に何も適用されない**。結果として「充足度バーが無色」「警告枠が出ない」といった
 * 見た目だけの欠落が静かに残る。ビルドで気づけないので、ここで検査する。
 */

const TOKEN_SOURCE = 'src/app/globals.css';
const SCAN_DIR = 'src';

/** Tailwind の組み込みパレット・キーワード。トークン定義は不要 */
const BUILTIN =
  /^(white|black|transparent|current|inherit|none|auto|left|right|center|start|end|top|bottom|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(-|$)/;

const UTILITIES =
  'bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|divide|accent|caret|placeholder';
const VARIANTS = '(?:[a-z-]+:|data-\\[[^\\]]+\\]:)*';
const CLASS_RE = new RegExp(
  `(?:^|["'\\s\`])${VARIANTS}(${UTILITIES})-([a-z][a-z0-9-]*)(?:/\\d+)?(?=["'\\s\`]|$)`,
  'g',
);

/** text-sm / border-2 など、色ではないユーティリティの語 */
const NON_COLOR = new Set([
  'xs',
  'sm',
  'base',
  'lg',
  'xl',
  'left',
  'right',
  'center',
  'justify',
  'start',
  'end',
  'top',
  'bottom',
  'balance',
  'pretty',
  'wrap',
  'nowrap',
  'clip',
  'ellipsis',
  'solid',
  'dashed',
  'dotted',
  'double',
  'hidden',
  'collapse',
  'separate',
  'fixed',
  'sr',
  // border-b / border-x / divide-y など、辺や向きを指すユーティリティ
  'b',
  't',
  'l',
  'r',
  'x',
  'y',
  's',
  'e',
]);

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p));
    else if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

export function findUndefinedColorClasses(): Map<string, string[]> {
  const css = readFileSync(TOKEN_SOURCE, 'utf8');
  const tokens = new Set([...css.matchAll(/--color-([a-z0-9-]+):/g)].map((m) => m[1]!));
  const bad = new Map<string, string[]>();

  for (const file of listFiles(SCAN_DIR)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(CLASS_RE)) {
      const utility = m[1]!;
      const name = m[2]!;
      const head = name.split('-')[0]!;
      if (BUILTIN.test(name) || NON_COLOR.has(name) || NON_COLOR.has(head) || tokens.has(name))
        continue;
      const key = `${utility}-${name}`;
      const files = bad.get(key) ?? [];
      if (!files.includes(file)) files.push(file);
      bad.set(key, files);
    }
  }
  return bad;
}

function main(): void {
  const bad = findUndefinedColorClasses();
  if (bad.size === 0) {
    console.log('✓ 未定義の色クラスはありません。');
    return;
  }
  console.error(`✗ 未定義の色クラスが ${bad.size} 種類あります（何も適用されません）:`);
  for (const [cls, files] of [...bad.entries()].sort()) {
    console.error(`  ${cls}`);
    for (const f of files) console.error(`    - ${f}`);
  }
  process.exit(1);
}

if (process.argv[1]?.endsWith('check-color-tokens.ts')) main();
