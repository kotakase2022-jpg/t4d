import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ENTERPRISE_NAV,
  ENTERPRISE_NAV_DISCLOSURE_FIRST,
  assuranceNav,
  type NavItem,
} from '@/components/shared/nav-config';
import {
  ROUTE_CATALOG,
  canOpenRoute,
  isDynamicPattern,
  resolveRouteHref,
  routeForPath,
} from '@/components/shared/route-catalog';
import { matchesPaletteQuery } from '@/lib/ui/palette';

/**
 * 全画面の一覧（plan §3.1 ROUTE_CATALOG・§3.5 route-catalog）。
 * src/app の全ページが載っている（新しいページを足し忘れると失敗する）。パレットで日本語の画面名から引ける。
 */

const APP_DIR = 'src/app';

/** src/app 配下の page.tsx をパターン（route group を除く。[x] はそのまま）にする */
function pagePatterns(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name === 'page.tsx') {
        const rel = relative(APP_DIR, dir).split(sep).join('/');
        const segments = rel === '' ? [] : rel.split('/').filter((s) => !/^\(.+\)$/.test(s));
        out.push(`/${segments.join('/')}`);
      }
    }
  };
  walk(APP_DIR);
  return out.sort();
}

function hrefsOf(items: NavItem[]): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: NavItem[]) => {
    for (const node of nodes) {
      out.add(node.href);
      walk(node.children ?? []);
    }
  };
  walk(items);
  return out;
}

describe('ROUTE_CATALOG', () => {
  it('src/app の全ページ（78 以上）が載っていて、載っているパターンにはページがある', () => {
    const pages = pagePatterns();
    expect(pages.length).toBeGreaterThanOrEqual(78);
    const catalog = [...new Set(ROUTE_CATALOG.map((entry) => entry.pattern))].sort();
    expect(catalog).toEqual(pages);
  });

  it('固定の行き先は自分のパターンに当たる（取り違えた href が無い）', () => {
    for (const entry of ROUTE_CATALOG) {
      if (!entry.href) continue;
      const href = entry.engagement ? entry.href.replace('{engagementId}', 'eng-1') : entry.href;
      expect(routeForPath(href)?.pattern, entry.label).toBe(entry.pattern);
    }
  });

  it('詳細画面（動的なパターン）は固定の行き先を持たない（案件の画面を除く）', () => {
    for (const entry of ROUTE_CATALOG) {
      if (isDynamicPattern(entry.pattern) && !entry.engagement) {
        // MSCI・FTSE は同じ [framework] のパターンを固定の行き先で持つ
        if (entry.pattern.endsWith('/disclosures/[framework]')) continue;
        expect(entry.href, entry.pattern).toBeUndefined();
      }
    }
  });

  it('メニューの区分はメニューのツリーと一致する', () => {
    const classic = hrefsOf(ENTERPRISE_NAV);
    const disclosure = hrefsOf(ENTERPRISE_NAV_DISCLOSURE_FIRST);
    const assurance = hrefsOf(assuranceNav('eng-1'));
    for (const entry of ROUTE_CATALOG) {
      const href = entry.href ? resolveRouteHref(entry, 'eng-1') : null;
      if (!href) continue;
      const inClassic = classic.has(href);
      const inDisclosure = disclosure.has(href);
      switch (entry.menu) {
        case 'both':
          expect([entry.label, inClassic && inDisclosure]).toEqual([entry.label, true]);
          break;
        case 'classic':
          expect([entry.label, inClassic, inDisclosure]).toEqual([entry.label, true, false]);
          break;
        case 'disclosure':
          expect([entry.label, inClassic, inDisclosure]).toEqual([entry.label, false, true]);
          break;
        case 'assurance':
          expect([entry.label, assurance.has(href)]).toEqual([entry.label, true]);
          break;
        case 'none':
          expect([entry.label, inClassic || inDisclosure || assurance.has(href)]).toEqual([
            entry.label,
            false,
          ]);
          break;
        default:
          break;
      }
    }
  });

  it('パレットで画面名（日本語）から引ける', () => {
    for (const entry of ROUTE_CATALOG) {
      if (entry.entryOnly || !entry.href) continue;
      const candidate = {
        label: entry.path.join(' / '),
        keywords: [entry.label, ...(entry.keywords ?? [])],
      };
      expect(matchesPaletteQuery(candidate, entry.label), entry.label).toBe(true);
    }
  });

  it('権限の条件は「どれか 1 つ」（資料はサプライヤー担当の登録だけでも開ける）', () => {
    const evidence = ROUTE_CATALOG.find((e) => e.pattern === '/enterprise/evidence')!;
    expect(canOpenRoute(evidence, (p) => p === 'enterprise.evidence.write')).toBe(true);
    expect(canOpenRoute(evidence, () => false)).toBe(false);
  });

  it('pathname から画面を引ける（固定の段が多いものを優先）', () => {
    expect(routeForPath('/enterprise/disclosures/ssbj/requirements/top-priority')?.label).toBe(
      '最優先のギャップを開く',
    );
    expect(routeForPath('/enterprise/disclosures/ssbj/requirements/abc')?.label).toBe(
      'SSBJ 要求事項の詳細',
    );
    expect(routeForPath('/enterprise/disclosures/ftse')?.label).toBe('FTSE');
    expect(routeForPath('/enterprise/data?status=draft')?.label).toBe('非財務データ');
    expect(routeForPath('/nowhere')).toBeNull();
  });
});
