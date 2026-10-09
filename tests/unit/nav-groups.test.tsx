import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import {
  ENTERPRISE_NAV,
  ENTERPRISE_NAV_DISCLOSURE_FIRST,
  assuranceNav,
  missingNavPermissions,
  navTreeFor,
  type NavItem,
} from '@/components/shared/nav-config';
import { permissionsFor } from '@/lib/authorization/can';
import type { PermissionKey, RoleKey } from '@/types/domain';

/**
 * ナビゲーションの変更（docs/ui-redesign/plan.md §1.4）:
 *  ① グループの開閉（既定は開。役割で閉じるグループあり。利用者ごとに覚える。現在地の祖先は開いて描く）
 *  ② 監査法人ツリーの再編（案件ホーム／保証契約／〔案件選択時〕計画・実施・結論・記録／設定）
 *  ③ パンくず（描画中のツリーから経路を作る。aria-current は末尾だけ）
 * 従来・開示優先のツリーの形は nav-config.test.tsx が固定している（ここでは変えていないことだけ確かめる）
 */

let pathname = '/enterprise/dashboard';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const { Sidebar } = await import('@/components/shared/sidebar');
const { navBreadcrumbsFor } = await import('@/components/shared/nav-breadcrumbs');
const { ShellProvider } = await import('@/components/shared/viewer-context');

interface Shape {
  label: string;
  href: string;
  permission?: string;
  children?: Shape[];
}

function shape(items: NavItem[]): Shape[] {
  return items.map((item) => ({
    label: item.label,
    href: item.href,
    ...(item.permission ? { permission: item.permission } : {}),
    ...(item.children ? { children: shape(item.children) } : {}),
  }));
}

const ENG = 'eng-1';
const base = `/assurance/engagements/${ENG}`;
const READ = 'assurance.engagement.read';

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('監査法人ツリー（plan §1.4。形をここで厳密に固定する）', () => {
  it('案件を選んでいないときは 案件ホーム・保証契約・設定 だけ', () => {
    expect(shape(assuranceNav(null))).toEqual([
      { label: '案件ホーム', href: '/assurance/dashboard' },
      { label: '保証契約', href: '/assurance/engagements' },
      { label: '設定', href: '/assurance/settings', permission: 'assurance.firm.manage' },
    ]);
  });

  it('案件を選ぶと 計画・実施・結論・記録 のグループに手続の 13 画面が並ぶ（案件の閲覧権限付き。実施に開示レポート）', () => {
    expect(shape(assuranceNav(ENG))).toEqual([
      { label: '案件ホーム', href: '/assurance/dashboard' },
      { label: '保証契約', href: '/assurance/engagements' },
      {
        label: '計画',
        href: `${base}/overview`,
        permission: READ,
        children: [
          { label: '概要', href: `${base}/overview`, permission: READ },
          { label: 'スコープ', href: `${base}/scope`, permission: READ },
        ],
      },
      {
        label: '実施',
        href: `${base}/data-room`,
        permission: READ,
        children: [
          { label: 'Data Room', href: `${base}/data-room`, permission: READ },
          // トライアル対応（plan K2 の例外）: 企業が共有した承認済みレポートの写し
          { label: '開示レポート', href: `${base}/reports`, permission: READ },
          { label: '母集団', href: `${base}/population`, permission: READ },
          { label: 'サンプリング', href: `${base}/sampling`, permission: READ },
          { label: '保証手続・調書', href: `${base}/testing`, permission: READ },
          { label: 'PBC／資料依頼', href: `${base}/requests`, permission: READ },
          { label: '指摘・例外', href: `${base}/issues`, permission: READ },
        ],
      },
      {
        label: '結論',
        href: `${base}/review-notes`,
        permission: READ,
        children: [
          { label: 'レビューNote', href: `${base}/review-notes`, permission: READ },
          { label: 'Sign-off', href: `${base}/signoffs`, permission: READ },
        ],
      },
      {
        label: '記録',
        href: `${base}/audit-trail`,
        permission: READ,
        children: [
          { label: '監査ログ', href: `${base}/audit-trail`, permission: READ },
          // 出力は出力の権限（担当者・専門家には出さない。開くと権限なしになるため）
          { label: '出力', href: `${base}/exports`, permission: 'assurance.export.run' },
        ],
      },
      { label: '設定', href: '/assurance/settings', permission: 'assurance.firm.manage' },
    ]);
  });

  it('法人管理者（案件の閲覧なし）には案件の画面の権限が足りない（項目を隠す）', () => {
    const has = (roles: RoleKey[]) => {
      const set = permissionsFor(roles);
      return (permission: PermissionKey) => set.has(permission);
    };
    expect(missingNavPermissions(assuranceNav(ENG), has(['assurance_admin']))).toEqual([
      READ,
      'assurance.export.run',
    ]);
    expect(missingNavPermissions(assuranceNav(ENG), has(['assurance_staff']))).toEqual([
      'assurance.export.run',
      'assurance.firm.manage',
    ]);
    expect(missingNavPermissions(assuranceNav(ENG), has(['assurance_manager']))).toEqual([
      'assurance.firm.manage',
    ]);
  });

  it('従来・開示優先のツリーは変えていない（同じ配列を返す）', () => {
    expect(navTreeFor('enterprise', null)).toBe(ENTERPRISE_NAV);
    expect(navTreeFor('enterprise-disclosure', null)).toBe(ENTERPRISE_NAV_DISCLOSURE_FIRST);
  });
});

describe('Sidebar のグループの開閉', () => {
  const nav = () => screen.getByRole('navigation', { name: 'メインナビゲーション' });

  it('子を持つ行に開閉ボタン（文字の名前・aria-expanded・aria-controls）。既定は開', () => {
    pathname = '/enterprise/dashboard';
    render(<Sidebar variant="enterprise" hiddenHrefs={[]} />);
    const toggle = within(nav()).getByRole('button', { name: '開示対応 を折りたたむ' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const list = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(list.getAttribute('aria-label')).toBe('開示対応');
    expect(list.hidden).toBe(false);
    // 3 階層目（SSBJ・CSRD・Scope3データ取込）にも開閉ボタン
    expect(within(nav()).getByRole('button', { name: 'SSBJ を折りたたむ' })).toBeInTheDocument();
    expect(
      within(nav()).getByRole('button', { name: 'Scope3データ取込 を折りたたむ' }),
    ).toBeInTheDocument();
  });

  it('役割で既定を閉じるグループは閉じて描き、開けると覚える（利用者ごと）', () => {
    pathname = '/enterprise/dashboard';
    const view = render(
      <ShellProvider
        value={{
          viewerKey: 'u-site:org-1',
          variant: 'enterprise',
          workspace: 'enterprise',
          hiddenHrefs: [],
          hiddenPermissions: [],
          permissions: [],
          defaultCollapsedGroups: ['開示対応'],
          verbContext: { unitScopeIds: [] },
          homeHref: '/enterprise/dashboard',
        }}
      >
        <Sidebar variant="enterprise" hiddenHrefs={[]} />
      </ShellProvider>,
    );
    const expand = within(nav()).getByRole('button', { name: '開示対応 を展開する' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(within(nav()).queryByRole('list', { name: '開示対応' })).toBeNull();
    // 閉じたグループの中のリンクは支援技術にも出さない
    expect(within(nav()).queryByRole('link', { name: 'SSBJ' })).toBeNull();
    act(() => {
      fireEvent.click(expand);
    });
    expect(within(nav()).getByRole('list', { name: '開示対応' })).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem('t4d.nav.v1.u-site:org-1')!)).toEqual({
      開示対応: true,
    });
    view.unmount();
  });

  it('現在地の祖先は保存が「閉」でも開いて描く', () => {
    window.localStorage.setItem('t4d.nav.v1.anonymous', JSON.stringify({ GHG: false }));
    pathname = '/enterprise/ghg/suppliers';
    render(<Sidebar variant="enterprise" hiddenHrefs={[]} />);
    expect(within(nav()).getByRole('link', { name: 'Cat.1' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav()).getByRole('button', { name: 'GHG を折りたたむ' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('保存できない値・壊れた値は既定（すべて開）に戻る', () => {
    window.localStorage.setItem('t4d.nav.v1.anonymous', '{not json');
    pathname = '/enterprise/dashboard';
    render(<Sidebar variant="enterprise" hiddenHrefs={[]} />);
    expect(within(nav()).getByRole('button', { name: 'GHG を折りたたむ' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('監査法人で案件を選んでいないときは、手続の画面の代わりに 1 行の案内', () => {
    pathname = '/assurance/dashboard';
    render(<Sidebar variant="assurance" hiddenHrefs={[]} />);
    expect(within(nav()).getByText('案件を選ぶと手続の画面が並びます')).toBeInTheDocument();
    expect(within(nav()).queryByRole('link', { name: 'Data Room' })).toBeNull();
  });

  it('監査法人の現在地はちょうど 1 つ（グループ行と同じ画面でも子だけ）', () => {
    pathname = `${base}/overview`;
    render(<Sidebar variant="assurance" hiddenHrefs={[]} />);
    const current = within(nav())
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page')
      .map((link) => link.textContent);
    expect(current).toEqual(['概要']);
  });

  it('権限キーで隠す項目（案件の画面）はどの案件でも隠れる', () => {
    pathname = `${base}/sampling`;
    render(<Sidebar variant="assurance" hiddenHrefs={[]} hiddenPermissions={[READ]} />);
    expect(within(nav()).queryByRole('link', { name: 'サンプリング' })).toBeNull();
    expect(within(nav()).getByRole('link', { name: '案件ホーム' })).toBeInTheDocument();
  });
});

describe('パンくず（navBreadcrumbsFor）', () => {
  const home = { homeHref: '/enterprise/dashboard' };

  it('メニューにある画面: ホーム › 祖先 › 画面（現在の画面はリンクにしない）', () => {
    expect(navBreadcrumbsFor(ENTERPRISE_NAV, '/enterprise/disclosures/ssbj/plans', home)).toEqual([
      { label: 'ホーム', href: '/enterprise/dashboard' },
      { label: '開示対応', href: '/enterprise/disclosures/ssbj' },
      { label: 'SSBJ', href: '/enterprise/disclosures/ssbj' },
      { label: '対応計画' },
    ]);
  });

  it('メニュー外の詳細画面: いちばん近いメニューの項目までリンクにし、末尾に対象名（tail）', () => {
    expect(
      navBreadcrumbsFor(ENTERPRISE_NAV, '/enterprise/data/dp-1', {
        ...home,
        tail: [{ label: '電力使用量 — 東日本工場' }],
      }),
    ).toEqual([
      { label: 'ホーム', href: '/enterprise/dashboard' },
      { label: 'ESG データ（GHG以外）', href: '/enterprise/data' },
      { label: '非財務データ', href: '/enterprise/data' },
      { label: '電力使用量 — 東日本工場' },
    ]);
  });

  it('tail が無いメニュー外の画面は、画面一覧（ROUTE_CATALOG）の名前で終える', () => {
    const crumbs = navBreadcrumbsFor(ENTERPRISE_NAV, '/enterprise/disclosures/ssbj/settings', home);
    expect(crumbs[crumbs.length - 1]).toEqual({ label: 'SSBJ マテリアリティ・分析条件の設定' });
    expect(crumbs[0]).toEqual({ label: 'ホーム', href: '/enterprise/dashboard' });
  });

  it('ホームそのものでは 1 つだけ', () => {
    expect(navBreadcrumbsFor(ENTERPRISE_NAV, '/enterprise/dashboard', home)).toEqual([
      { label: 'ホーム' },
    ]);
  });
});
