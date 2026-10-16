import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  CALC_DETAIL_HREF,
  CALC_TAB_KEYS,
  CalcNav,
  calcTabHref,
  calcTabItems,
} from '@/app/enterprise/ghg/calculation/_components/calc-nav';
import { routeForPath } from '@/components/shared/route-catalog';

/**
 * Scope1・2 の算定の作業領域のタブ（plan K2・A6）。メニューの葉は 1 つだけで、下位の 5 画面へはタブで届く。
 * 要対応の件数は文字で出し（「要対応 n」）、無ければ件数を出さない。行き先は ROUTE_CATALOG に載っている
 */
const ATTENTION = {
  unresolvedLines: 2,
  unresolvedReasons: ['タイ工場: 電力（ロケーション基準）（割当がありません）'],
  pendingRules: 1,
  draftBatches: 0,
  defaultLoadLines: 4,
  flooredLoadLines: 1,
  reconciliationNeedsReview: 3,
};

describe('CalcNav', () => {
  it('概要・排出係数・算定ルール・活動量・照合の 5 つで、行き先は画面の一覧に載っている', () => {
    const items = calcTabItems(null);
    expect(items.map((i) => i.label)).toEqual(['概要', '排出係数', '算定ルール', '活動量', '照合']);
    expect(items.map((i) => i.key)).toEqual([...CALC_TAB_KEYS]);
    for (const item of items) {
      expect(routeForPath(item.href)?.pattern, item.href).toBe(item.href);
      expect(item.count).toBeUndefined();
    }
  });

  it('期間を引き継ぐ（?period=）', () => {
    expect(calcTabHref('rules', 'p 1')).toBe('/enterprise/ghg/calculation/rules?period=p%201');
    expect(calcTabHref('overview')).toBe('/enterprise/ghg/calculation');
  });

  it('要対応の件数は status の数え方のまま、0 件のタブには出さない', () => {
    const byKey = new Map(calcTabItems(ATTENTION).map((i) => [i.key, i]));
    expect(byKey.get('factors')).toMatchObject({ count: 2, attention: true });
    expect(byKey.get('rules')).toMatchObject({ count: 1, attention: true });
    expect(byKey.get('activity')?.count).toBeUndefined();
    expect(byKey.get('reconciliation')).toMatchObject({ count: 3, attention: true });
    expect(byKey.get('overview')?.count).toBeUndefined();
  });

  it('現在のタブに aria-current、件数は「要対応 n」の文字で出す', () => {
    render(<CalcNav current="reconciliation" periodId="p1" attention={ATTENTION} />);
    const nav = screen.getByRole('navigation', { name: 'Scope1・2算定の画面' });
    expect(nav).toBeTruthy();
    const current = screen.getByRole('link', { name: /照合/ });
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(current.textContent).toContain('要対応 3');
    expect(screen.getByRole('link', { name: /排出係数/ }).textContent).toContain('要対応 2');
  });

  it('詳細画面の行き先は画面の一覧の動的なパターンに当たる', () => {
    expect(routeForPath(CALC_DETAIL_HREF.factorSet('s1'))?.pattern).toBe(
      '/enterprise/ghg/calculation/factors/[setId]',
    );
    expect(routeForPath(CALC_DETAIL_HREF.activityBatch('b1'))?.pattern).toBe(
      '/enterprise/ghg/calculation/activity/[batchId]',
    );
    expect(routeForPath(CALC_DETAIL_HREF.run('r1'))?.pattern).toBe(
      '/enterprise/ghg/calculation/runs/[runId]',
    );
    expect(routeForPath(CALC_DETAIL_HREF.reconciliation('x1'))?.pattern).toBe(
      '/enterprise/ghg/calculation/reconciliation/[id]',
    );
  });
});
