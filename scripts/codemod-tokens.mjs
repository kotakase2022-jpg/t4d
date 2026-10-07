#!/usr/bin/env node
/**
 * 見た目を変えない置き換えの codemod（docs/ui-redesign/plan.md §3.4-1）。
 *
 *   node scripts/codemod-tokens.mjs --dry     # 置換件数と、対応表に無い任意値・動的な variant の一覧
 *   node scripts/codemod-tokens.mjs           # 置き換えを書き込む
 *
 * 置き換えるのは「計算後の CSS が同じになるもの」だけ:
 *  - 任意値のクラス → トークンのクラス（例 text-[11px] → text-caption。--text-caption: 11px。
 *    文字サイズのトークンは line-height を持たせないので、text-[11px] と同じ font-size だけが出る）
 *  - Button・SubmitButton の variant の改名（outline → secondary、secondary → quiet）と、
 *    variant を書いていないボタンへの variant="primary" の明示（既定が secondary に変わるため。
 *    見た目は変えずに、primary の箇所を grep できるようにする）
 * 文字列リテラル・テンプレートの静的部分の中で、クラスの境界で完全一致したものだけを置き換える。
 * 動的な variant（variant={cond ? 'a' : 'b'}）は自動では触らず、一覧に出す（手で直す）。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 対応表。token は globals.css で定義する名前と値（tests/unit/design-tokens.test.ts が一致を検査する）。
 * prefix: true は variant の接頭辞（`min-[1366px]:`）。files があればそのファイルだけ（意味の違う同値を
 * 誤って置き換えないため。例: w-[64px] はサイドバーの折りたたみ幅だけ）
 */
export const TOKEN_REPLACEMENTS = [
  { from: 'text-[11px]', to: 'text-caption', token: '--text-caption', value: '11px' },
  { from: 'text-[12px]', to: 'text-small', token: '--text-small', value: '12px' },
  { from: 'text-[13px]', to: 'text-body', token: '--text-body', value: '13px' },
  { from: 'text-[14px]', to: 'text-title-sm', token: '--text-title-sm', value: '14px' },
  { from: 'text-[15px]', to: 'text-title', token: '--text-title', value: '15px' },
  { from: 'text-[16px]', to: 'text-title-lg', token: '--text-title-lg', value: '16px' },
  { from: 'text-[18px]', to: 'text-figure-sm', token: '--text-figure-sm', value: '18px' },
  { from: 'text-[20px]', to: 'text-figure', token: '--text-figure', value: '20px' },
  { from: 'text-[22px]', to: 'text-figure-lg', token: '--text-figure-lg', value: '22px' },
  {
    from: 'text-[#8a5d00]',
    to: 'text-warning-ink',
    token: '--color-warning-ink',
    value: '#8a5d00',
  },
  {
    from: 'accent-[#0b57a4]',
    to: 'accent-brand-700',
    token: '--color-brand-700',
    value: '#0b57a4',
  },
  { from: 'bg-[#0b1b34]', to: 'bg-overlay', token: '--color-overlay', value: '#0b1b34' },
  {
    from: 'h-[48px]',
    to: 'h-topbar',
    token: '--spacing-topbar',
    value: '48px',
    files: ['src/components/shared/app-shell.tsx'],
  },
  {
    from: 'w-[224px]',
    to: 'w-sidebar',
    token: '--spacing-sidebar',
    value: '224px',
    files: ['src/components/shared/sidebar.tsx'],
  },
  {
    from: 'w-[64px]',
    to: 'w-sidebar-collapsed',
    token: '--spacing-sidebar-collapsed',
    value: '64px',
    files: ['src/components/shared/sidebar.tsx'],
  },
  {
    from: 'min-[1366px]:',
    to: 'wide:',
    token: '--breakpoint-wide',
    value: '1366px',
    prefix: true,
  },
  {
    from: 'min-[1600px]:',
    to: 'xwide:',
    token: '--breakpoint-xwide',
    value: '1600px',
    prefix: true,
  },
];

/** Button の variant の改名（旧 → 新） */
export const BUTTON_VARIANT_RENAMES = { outline: 'secondary', secondary: 'quiet' };

/** variant を明示しないボタンに足す値（既定が secondary に変わるため、旧既定の primary を書く） */
const IMPLICIT_PRIMARY = 'primary';

/** ボタンの定義そのもの（既定の変更を受ける側）は書き換えない */
const BUTTON_DEFINITION_FILES = new Set([
  'src/components/ui/button.tsx',
  'src/components/ui/submit-button.tsx',
  'src/components/ui/icon-button.tsx',
]);

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** クラスの前に来うる文字（行頭・空白・引用符・variant の区切り・重要度の !・cva の配列） */
const BEFORE = '(?<=^|[\\s"\'`:!(,{])';
/** 単独のクラスの後に来うる文字（不透明度の /NN も許す） */
const AFTER = '(?=$|[\\s"\'`/)\\],}])';

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}

function toPosix(path) {
  return path.split(sep).join('/');
}

export function replaceTokens(source, file) {
  let next = source;
  const counts = {};
  for (const rule of TOKEN_REPLACEMENTS) {
    if (rule.files && !rule.files.includes(file)) continue;
    const re = rule.prefix
      ? new RegExp(`${BEFORE}${escapeRegExp(rule.from)}`, 'g')
      : new RegExp(`${BEFORE}${escapeRegExp(rule.from)}${AFTER}`, 'g');
    let n = 0;
    next = next.replace(re, () => {
      n += 1;
      return rule.to;
    });
    if (n > 0) counts[rule.from] = n;
  }
  return { source: next, counts };
}

/** 開始タグの終わり（深さ 0 の >）を探す。属性の文字列・{} の式の中の > は飛ばす */
function openingTagEnd(src, from) {
  let depth = 0;
  let quote = null;
  for (let j = from; j < src.length; j += 1) {
    const ch = src[j];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (depth === 0 && (ch === '"' || ch === "'")) {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0) return j;
  }
  return -1;
}

/** 深さ 0 の属性の範囲だけを見て variant= を探す（式の中の variant は数えない） */
function topLevelVariant(attrs) {
  let depth = 0;
  let quote = null;
  for (let j = 0; j < attrs.length; j += 1) {
    const ch = attrs[j];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (depth === 0 && (ch === '"' || ch === "'")) {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (depth === 0 && /\s/.test(attrs[j - 1] ?? ' ') && attrs.startsWith('variant=', j)) {
      return j;
    }
  }
  return -1;
}

export function transformButtons(source) {
  const tagRe = /<(Button|SubmitButton)(?=[\s>/])/g;
  let out = '';
  let last = 0;
  let added = 0;
  let renamed = 0;
  const dynamic = [];
  let match;
  while ((match = tagRe.exec(source))) {
    const nameEnd = match.index + match[0].length;
    const end = openingTagEnd(source, nameEnd);
    if (end < 0) continue;
    const attrs = source.slice(nameEnd, end);
    const at = topLevelVariant(attrs);
    let nextAttrs = attrs;
    if (at < 0) {
      nextAttrs = ` variant="${IMPLICIT_PRIMARY}"${attrs}`;
      added += 1;
    } else {
      const literal = /^variant=(["'])([a-z]+)\1/.exec(attrs.slice(at));
      if (literal) {
        const to = BUTTON_VARIANT_RENAMES[literal[2]];
        if (to) {
          nextAttrs = `${attrs.slice(0, at)}variant="${to}"${attrs.slice(at + literal[0].length)}`;
          renamed += 1;
        }
      } else {
        const line = source.slice(0, match.index).split('\n').length;
        dynamic.push(line);
      }
    }
    out += source.slice(last, nameEnd) + nextAttrs;
    last = end;
    tagRe.lastIndex = end;
  }
  out += source.slice(last);
  return { source: out, added, renamed, dynamic };
}

/** 対応表に無い任意値（C で目視して扱う）。種類 → 件数 */
function unhandledArbitrary(source) {
  const found = {};
  for (const m of source.matchAll(
    /(?<=[\s"'`:!])((?:text|bg|border|w|h|min-w|max-w|min-h|max-h|z|rounded|shadow|gap|p[xytrbl]?|m[xytrbl]?)-\[[^\]\s]+\])/g,
  )) {
    found[m[1]] = (found[m[1]] ?? 0) + 1;
  }
  return found;
}

function main() {
  // スクリプトの場所から求める（テストから関数だけを読み込むときは評価しない）
  const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const SRC = join(ROOT, 'src');
  const dry = process.argv.includes('--dry');
  const totals = {};
  let buttonsAdded = 0;
  let buttonsRenamed = 0;
  const dynamicVariants = [];
  const unhandled = {};
  const changedFiles = [];

  for (const abs of listFiles(SRC)) {
    const file = toPosix(relative(ROOT, abs));
    const original = readFileSync(abs, 'utf8');
    const tokens = replaceTokens(original, file);
    for (const [from, n] of Object.entries(tokens.counts)) totals[from] = (totals[from] ?? 0) + n;
    let next = tokens.source;
    if (file.endsWith('.tsx') && !BUTTON_DEFINITION_FILES.has(file)) {
      const buttons = transformButtons(next);
      buttonsAdded += buttons.added;
      buttonsRenamed += buttons.renamed;
      for (const line of buttons.dynamic) dynamicVariants.push(`${file}:${line}`);
      next = buttons.source;
    }
    for (const [cls, n] of Object.entries(unhandledArbitrary(next))) {
      unhandled[cls] = (unhandled[cls] ?? 0) + n;
    }
    if (next !== original) {
      changedFiles.push(file);
      if (!dry) writeFileSync(abs, next);
    }
  }

  console.log(dry ? '[dry] 置き換えの件数（書き込まない）' : '置き換えました');
  for (const [from, n] of Object.entries(totals)) console.log(`  ${from} → ${n}`);
  console.log(`  Button・SubmitButton に variant="primary" を明示: ${buttonsAdded}`);
  console.log(
    `  Button・SubmitButton の variant の改名（outline→secondary・secondary→quiet）: ${buttonsRenamed}`,
  );
  console.log(`  変更したファイル: ${changedFiles.length}`);
  if (dynamicVariants.length > 0) {
    console.log('動的な variant（手で確認する）:');
    for (const where of dynamicVariants) console.log(`  ${where}`);
  }
  const rest = Object.entries(unhandled).sort((a, b) => b[1] - a[1]);
  console.log(`対応表に無い任意値（Stage C で扱う）: ${rest.length} 種類`);
  for (const [cls, n] of rest.slice(0, dry ? 200 : 30)) console.log(`  ${cls} ${n}`);
}

function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
