import { relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ENTERPRISE_NAV,
  ENTERPRISE_NAV_DISCLOSURE_FIRST,
  assuranceNav,
  type NavItem,
} from '@/components/shared/nav-config';
import { ROUTE_CATALOG } from '@/components/shared/route-catalog';
import { importsOf, listFiles, parse, rel, ROOT, stringLiterals } from '../support/static-analysis';

/**
 * 全ルートに到達できる（静的。plan §5.2・IF §7.2）。
 *
 * 入口: メニューのツリー（従来・開示優先・監査法人）、Command Palette（ROUTE_CATALOG の固定の行き先）、
 * ヘッダーの固定の入口（通知・プロフィール・ワークスペース）。
 * 辺: 各ページから import でたどれるモジュールの中の、リンク・リダイレクトの文字列（`/enterprise/data/${id}`
 * は 1 セグメントの値として扱う）。メニュー・パレットの定義そのものは入口として数え、辺には数えない。
 * 到達しないルートは、ログイン前・招待・リダイレクト専用の入口（ENTRY_ONLY）以外は失敗にする。
 * 条件付きの描画（権限・モードでの出し分け）は静的には見えない → E2E の reachability.spec.ts で補う。
 */

const APP = 'src/app';

/** 入口専用（メニュー・パレット・リンクから辿らないことが正しい） */
const ENTRY_ONLY: Record<string, string> = {
  '/': '/workspace へのリダイレクト',
  '/login': 'ログイン前の入口',
  '/mfa': 'Supabase Mode の多要素認証（ログインの途中）',
  '/reset': 'パスワード再設定のメールのリンク',
  '/invite/[invitationId]': '招待のメールのリンク',
  '/enterprise/analysis': '現状診断へのリダイレクト専用',
};

/** 辺に数えないモジュール（メニュー・パレットの定義。入口として別に数える） */
const ENTRY_DEFINITIONS = new Set([
  'src/components/shared/nav-config.ts',
  'src/components/shared/route-catalog.ts',
  'src/lib/ui/task-verbs.ts',
  'src/lib/ui/palette.ts',
]);

function pageFiles(): Array<{ file: string; pattern: string }> {
  return listFiles(APP, /^page\.tsx$/).map((file) => {
    const dir = relative(`${ROOT}${sep}${APP.split('/').join(sep)}`, file)
      .split(sep)
      .slice(0, -1)
      .filter((s) => !/^\(.+\)$/.test(s));
    return { file, pattern: `/${dir.join('/')}` };
  });
}

function patternRegExp(pattern: string): RegExp {
  const body = pattern
    .split('/')
    .map((segment) =>
      /^\[[^\]]+\]$/.test(segment) ? '[^/]+' : segment.replace(/[.*+?^${}()|\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${body}$`);
}

const pages = pageFiles();
const compiled = pages.map((p) => ({ ...p, re: patternRegExp(p.pattern) }));

/** パス（テンプレートの値は [*]）→ ルートのパターン */
function matchRoute(path: string): string | null {
  const clean = path.split(/[?#]/)[0]!.replace(/\/+$/, '') || '/';
  if (!clean.startsWith('/')) return null;
  const concrete = clean.replace(/\[\*\]/g, 'x');
  if (concrete.includes('x/x/x/x/x')) return null;
  // 固定の段が多いパターンを優先（/ssbj/requirements/top-priority は [itemId] より強い）
  const hits = compiled.filter((p) => p.re.test(concrete));
  if (hits.length === 0) return null;
  const score = (pattern: string) =>
    pattern.split('/').filter((s) => s && !s.startsWith('[')).length;
  return [...hits].sort((a, b) => score(b.pattern) - score(a.pattern))[0]!.pattern;
}

/** モジュールから import でたどれる src のモジュール（自分を含む） */
function closure(file: string, memo = new Map<string, Set<string>>()): Set<string> {
  const seen = new Set<string>();
  const stack = [file];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const info of importsOf(parse(current))) {
      if (info.resolved && !info.typeOnly && !seen.has(info.resolved)) stack.push(info.resolved);
    }
  }
  void memo;
  return seen;
}

/** ページ → そのページから行けるルート（リンク・リダイレクトの文字列） */
const edges = new Map<string, Set<string>>();
for (const page of pages) {
  const targets = new Set<string>();
  for (const mod of closure(page.file)) {
    if (ENTRY_DEFINITIONS.has(rel(mod))) continue;
    for (const literal of stringLiterals(parse(mod))) {
      if (!literal.startsWith('/')) continue;
      const route = matchRoute(literal);
      if (route) targets.add(route);
    }
  }
  const existing = edges.get(page.pattern) ?? new Set<string>();
  for (const t of targets) existing.add(t);
  edges.set(page.pattern, existing);
}

function navHrefs(items: NavItem[]): string[] {
  return items.flatMap((item) => [item.href, ...navHrefs(item.children ?? [])]);
}

function reachableFrom(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = entries.map((href) => matchRoute(href)).filter((r): r is string => r !== null);
  while (queue.length > 0) {
    const route = queue.shift()!;
    if (seen.has(route)) continue;
    seen.add(route);
    for (const next of edges.get(route) ?? []) if (!seen.has(next)) queue.push(next);
  }
  return seen;
}

const HEADER = ['/notifications', '/profile', '/workspace'];
const PALETTE = ROUTE_CATALOG.filter((e) => e.href && !e.entryOnly).map((e) =>
  e.href!.replace('{engagementId}', '[*]'),
);

describe('ルートの到達性（静的）', () => {
  it('ページとリンクの辺を見つけられている（検査そのものが空回りしていない）', () => {
    expect(pages.length).toBeGreaterThanOrEqual(78);
    const total = [...edges.values()].reduce((sum, set) => sum + set.size, 0);
    expect(total).toBeGreaterThan(200);
  });

  it.each([
    ['従来メニューの組織', navHrefs(ENTERPRISE_NAV)],
    ['開示優先モードの組織', navHrefs(ENTERPRISE_NAV_DISCLOSURE_FIRST)],
  ])('%s: 企業の全ルートにメニュー・パレット・リンクから届く', (_label, nav) => {
    const reached = reachableFrom([...nav, ...HEADER, ...PALETTE]);
    const unreached = pages
      .map((p) => p.pattern)
      .filter((pattern) => pattern.startsWith('/enterprise') || HEADER.includes(pattern))
      .filter((pattern) => !reached.has(pattern) && !(pattern in ENTRY_ONLY));
    expect(unreached).toEqual([]);
  });

  it('監査法人: 案件の全画面にメニュー・パレット・リンクから届く', () => {
    const reached = reachableFrom([...navHrefs(assuranceNav('[*]')), ...HEADER, ...PALETTE]);
    const unreached = pages
      .map((p) => p.pattern)
      .filter((pattern) => pattern.startsWith('/assurance'))
      .filter((pattern) => !reached.has(pattern));
    expect(unreached).toEqual([]);
  });

  it('入口専用のルートは実在する（古い例外を残さない）', () => {
    const patterns = new Set(pages.map((p) => p.pattern));
    for (const pattern of Object.keys(ENTRY_ONLY))
      expect(patterns.has(pattern), pattern).toBe(true);
  });
});
