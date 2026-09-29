import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  ENTERPRISE_NAV,
  ENTERPRISE_NAV_DISCLOSURE_FIRST,
  navTreeFor,
  type NavItem,
} from '@/components/shared/nav-config';

/**
 * 左メニューの 2 つのツリー（従来／開示優先モード。docs/disclosure-first.md §2-1）。
 *
 * A01: 開示優先モードでは新しい導線が出て、既存の画面の URL はすべてメニューから開ける。
 * A39: 機能設定が無効の組織は従来のメニューのまま（ラベル・リンク先・入れ子を変えない）。
 * A37 周辺: 同じ画面で「現在地」（aria-current）が 2 つ並ばない。
 */

let pathname = '/enterprise/dashboard';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

// Sidebar は next/navigation を使うため、モックの後に読み込む
const { Sidebar } = await import('@/components/shared/sidebar');

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

function flatten(items: NavItem[]): NavItem[] {
  return items.flatMap((item) => [item, ...flatten(item.children ?? [])]);
}

describe('従来メニュー（機能設定が無効の組織: A39）', () => {
  it('enterprise の木は従来の ENTERPRISE_NAV そのもの', () => {
    expect(navTreeFor('enterprise', null)).toBe(ENTERPRISE_NAV);
  });

  it('ラベル・リンク先・入れ子・権限が従来のまま', () => {
    expect(shape(ENTERPRISE_NAV)).toEqual([
      { label: 'ホーム', href: '/enterprise/dashboard' },
      {
        label: '開示対応',
        href: '/enterprise/disclosures/ssbj',
        children: [
          {
            label: 'SSBJ',
            href: '/enterprise/disclosures/ssbj',
            children: [
              { label: '対応状況', href: '/enterprise/disclosures/ssbj' },
              { label: '要求事項', href: '/enterprise/disclosures/ssbj/requirements' },
              { label: '対応計画', href: '/enterprise/disclosures/ssbj/plans' },
              { label: 'データ収集', href: '/enterprise/disclosures/ssbj/collection' },
              { label: '開示ドラフト', href: '/enterprise/disclosures/ssbj/draft' },
            ],
          },
          { label: 'CDP', href: '/enterprise/disclosures/cdp' },
          { label: 'CSRD', href: '/enterprise/disclosures/csrd' },
          { label: 'MSCI', href: '/enterprise/disclosures/msci' },
          { label: 'FTSE', href: '/enterprise/disclosures/ftse' },
        ],
      },
      {
        label: 'ESG データ（GHG以外）',
        href: '/enterprise/data',
        children: [
          { label: 'データ取込', href: '/enterprise/imports' },
          { label: '非財務データ', href: '/enterprise/data' },
          { label: 'Evidence', href: '/enterprise/evidence' },
        ],
      },
      {
        label: 'GHG',
        href: '/enterprise/ghg',
        children: [
          { label: '算定サマリー', href: '/enterprise/ghg' },
          {
            label: 'Scope3データ取込',
            href: '/enterprise/ghg/suppliers',
            children: [{ label: 'Cat.1', href: '/enterprise/ghg/suppliers' }],
          },
        ],
      },
      {
        label: '業務管理',
        href: '/enterprise/workflows',
        children: [
          { label: 'ワークフロー', href: '/enterprise/workflows' },
          { label: 'アラート', href: '/enterprise/alerts' },
          { label: 'レポート', href: '/enterprise/reports' },
        ],
      },
      { label: 'AI Copilot', href: '/enterprise/ai' },
      {
        label: '管理',
        href: '/enterprise/organizations',
        children: [
          { label: '組織・拠点', href: '/enterprise/organizations' },
          { label: '設定', href: '/enterprise/settings', permission: 'enterprise.org.manage' },
        ],
      },
    ]);
  });
});

describe('開示優先モードのメニュー（A01）', () => {
  const tree = ENTERPRISE_NAV_DISCLOSURE_FIRST;

  it('enterprise-disclosure の木は開示優先モードのツリー', () => {
    expect(navTreeFor('enterprise-disclosure', null)).toBe(tree);
  });

  it('最上位は ホーム → 開示プロジェクト → 情報・根拠 → ESG経営 → タスク・承認 → 管理、AI Copilot は補助として最後', () => {
    expect(tree.map((item) => item.label)).toEqual([
      'ホーム',
      '開示プロジェクト',
      '情報・根拠',
      'ESG経営',
      'タスク・承認',
      '管理',
      'AI Copilot',
    ]);
  });

  it('新しい導線（プロジェクト・定性情報・標準 CSV・ESG経営）へのリンクを持つ', () => {
    const byLabel = new Map(flatten(tree).map((item) => [item.label, item.href]));
    expect(byLabel.get('開示プロジェクト')).toBe('/enterprise/disclosure-projects');
    expect(byLabel.get('定性情報')).toBe('/enterprise/narratives');
    expect(byLabel.get('数値を登録（標準CSV）')).toBe('/enterprise/imports/standard');
    expect(byLabel.get('ESG経営')).toBe('/enterprise/esg');
    expect(byLabel.get('定量データ')).toBe('/enterprise/data');
    expect(byLabel.get('資料・証跡')).toBe('/enterprise/evidence');
    expect(byLabel.get('GHG算定')).toBe('/enterprise/ghg');
    expect(byLabel.get('Cat.1')).toBe('/enterprise/ghg/suppliers');
  });

  it('CDP・MSCI・FTSE は「その他の開示」へ格納し、削除しない', () => {
    const projects = tree.find((item) => item.label === '開示プロジェクト');
    const other = projects?.children?.find((item) => item.label === 'その他の開示');
    expect(projects?.children?.map((c) => c.label)).toEqual([
      'SSBJ',
      'CSRD',
      'その他の開示',
      'レポート出力',
    ]);
    expect(other?.children?.map((c) => [c.label, c.href])).toEqual([
      ['CDP', '/enterprise/disclosures/cdp'],
      ['MSCI', '/enterprise/disclosures/msci'],
      ['FTSE', '/enterprise/disclosures/ftse'],
    ]);
  });

  it('従来メニューの画面はすべて新しいメニューからも開ける（既存 URL を維持）', () => {
    const newHrefs = new Set(flatten(tree).map((item) => item.href));
    const missing = flatten(ENTERPRISE_NAV)
      .map((item) => item.href)
      .filter((href) => !newHrefs.has(href));
    expect(missing).toEqual([]);
  });

  it('権限付きの項目（管理 > 設定）は同じ権限を保つ', () => {
    const settings = flatten(tree).find((item) => item.href === '/enterprise/settings');
    expect(settings?.permission).toBe('enterprise.org.manage');
  });

  it('兄弟の中でラベルが重複しない（Command Palette の経路ラベルが一意になる）', () => {
    const walk = (items: NavItem[]) => {
      const labels = items.map((item) => item.label);
      expect(new Set(labels).size).toBe(labels.length);
      for (const item of items) walk(item.children ?? []);
    };
    walk(tree);
  });
});

describe('Sidebar の現在地（aria-current）', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  function currentLinks(): string[] {
    const nav = screen.getByRole('navigation', { name: 'メインナビゲーション' });
    return within(nav)
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page')
      .map((link) => link.textContent ?? '');
  }

  it.each([
    ['/enterprise/data', ['定量データ']],
    ['/enterprise/data/some-data-point', ['定量データ']],
    ['/enterprise/imports/standard', ['数値を登録（標準CSV）']],
    ['/enterprise/ghg/suppliers', ['Cat.1']],
    ['/enterprise/workflows', ['自分の作業・レビュー']],
    ['/enterprise/organizations', ['組織・拠点']],
    ['/enterprise/disclosure-projects/abc/blocks/def', ['開示プロジェクト']],
    ['/enterprise/disclosures/ssbj', ['対応状況']],
    ['/enterprise/disclosures/msci', ['MSCI']],
  ])('開示優先モード %s では現在地が 1 つだけ（%j）', (path, expected) => {
    pathname = path;
    render(<Sidebar variant="enterprise-disclosure" hiddenHrefs={[]} />);
    expect(currentLinks()).toEqual(expected);
  });

  it('従来メニューの現在地の付け方は変えない（最上位 GHG と Cat.1。算定サマリーは付かない）', () => {
    // 従来メニューでは最上位の項目にも aria-current が付く（A39: 従来の DOM を変えない）。
    // 開示優先モードでは同じ href の子がある最上位項目は子に譲る（上の it.each）
    pathname = '/enterprise/ghg/suppliers';
    render(<Sidebar variant="enterprise" hiddenHrefs={[]} />);
    expect(currentLinks()).toEqual(['GHG', 'Cat.1']);
  });

  it('折りたたみ中（子を出さない）は最上位の項目に現在地を残す', async () => {
    window.localStorage.setItem('t4d.sidebar.collapsed', '1');
    pathname = '/enterprise/data';
    render(
      <TooltipProvider>
        <Sidebar variant="enterprise-disclosure" hiddenHrefs={[]} />
      </TooltipProvider>,
    );
    const nav = screen.getByRole('navigation', { name: 'メインナビゲーション' });
    await waitFor(() => expect(nav).toHaveAttribute('data-collapsed', 'true'));
    expect(within(nav).getByRole('link', { name: '情報・根拠' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('権限で隠した項目は開示優先モードのメニューからも消える', () => {
    pathname = '/enterprise/dashboard';
    render(<Sidebar variant="enterprise-disclosure" hiddenHrefs={['/enterprise/settings']} />);
    const nav = screen.getByRole('navigation', { name: 'メインナビゲーション' });
    expect(within(nav).queryByRole('link', { name: '設定' })).toBeNull();
    expect(within(nav).getByRole('link', { name: '組織・拠点' })).toBeInTheDocument();
  });
});
