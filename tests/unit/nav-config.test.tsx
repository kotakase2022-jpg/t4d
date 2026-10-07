import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FileText } from 'lucide-react';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  ENTERPRISE_NAV,
  ENTERPRISE_NAV_DISCLOSURE_FIRST,
  branchToRemember,
  hiddenNavHrefsFor,
  isNavAncestorOfCurrent,
  isNavSubtreeActive,
  missingNavPermissions,
  navBranchOf,
  navTreeFor,
  resolveNavCurrent,
  visibleNavTree,
  type NavItem,
} from '@/components/shared/nav-config';
import { NAV_BRANCH_STORAGE_KEY, rememberNavBranch } from '@/components/shared/nav-branch';
import { permissionsFor } from '@/lib/authorization/can';

/**
 * 左メニューの 2 つのツリー（従来／開示優先モード。docs/disclosure-first.md §2-1・§9.1・§10.1）。
 *
 * A01: 開示優先モードでは新しい導線が出て、既存の画面の URL はすべてメニューから開ける。
 * A39: 機能設定が無効の組織は従来のメニューのまま。ただし 2026-10-01 の追加要望（§9.1）で
 *      定性情報（SSBJ 配下）・CSRD の 5 画面・分析を、2026-10-02 の追加要望（§10.1）で CSRD 配下の定性情報・
 *      分析の 自社経年比較／財務影響分析 を意図して足した。形はこのテストで厳密に固定する。
 * A37 周辺: 同じ画面で「現在地」（aria-current）が 2 つ並ばない。同じ href が別の枝に 2 回出ても重複しない
 *      （従来ツリーの定性情報は SSBJ と CSRD の 2 か所。どちらに付けるかは「優先枝」で決める）。
 */

let pathname = '/enterprise/dashboard';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

// Sidebar・CommandPalette は next/navigation を使うため、モックの後に読み込む
const { Sidebar } = await import('@/components/shared/sidebar');
const { navCommandEntries } = await import('@/components/shared/command-palette');

/** CSRD の回答編集画面（既存の csrd/[questionId]）。項目 ID は UUID */
const CSRD_QUESTION_PATH = '/enterprise/disclosures/csrd/6f1c2a4e-1b2d-4c3e-9f00-0123456789ab';

interface Shape {
  label: string;
  href: string;
  permission?: string;
  secondary?: true;
  children?: Shape[];
}

function shape(items: NavItem[]): Shape[] {
  return items.map((item) => ({
    label: item.label,
    href: item.href,
    ...(item.permission ? { permission: item.permission } : {}),
    ...(item.secondary ? { secondary: true as const } : {}),
    ...(item.children ? { children: shape(item.children) } : {}),
  }));
}

function flatten(items: NavItem[]): NavItem[] {
  return items.flatMap((item) => [item, ...flatten(item.children ?? [])]);
}

function uniqueHrefs(items: NavItem[]): string[] {
  return [...new Set(flatten(items).map((item) => item.href))];
}

/** 位置（navItemKey）の項目のラベル */
function labelAt(items: NavItem[], key: string): string {
  let nodes = items;
  let item: NavItem | undefined;
  for (const index of key.split('.').map(Number)) {
    item = nodes[index];
    nodes = item?.children ?? [];
  }
  return item?.label ?? '（なし）';
}

/**
 * 定性情報・CSRD の画面は開示の閲覧権限を求める（拠点担当などが開くと「アクセス権限がありません」になる）
 * ため、メニューにも同じ権限を付けて出さない（規制対応度と同じ。自己監査 F5）
 */
const DISCLOSURE_READ = 'enterprise.disclosure.read';

const SSBJ_CHILDREN: Shape[] = [
  { label: '対応状況', href: '/enterprise/disclosures/ssbj' },
  { label: '要求事項', href: '/enterprise/disclosures/ssbj/requirements' },
  { label: '対応計画', href: '/enterprise/disclosures/ssbj/plans' },
  { label: 'データ収集', href: '/enterprise/disclosures/ssbj/collection' },
  { label: '定性情報', href: '/enterprise/narratives', permission: DISCLOSURE_READ },
  { label: '開示ドラフト', href: '/enterprise/disclosures/ssbj/draft' },
];

const CSRD_CHILDREN: Shape[] = [
  { label: '対応状況', href: '/enterprise/disclosures/csrd', permission: DISCLOSURE_READ },
  {
    label: '要求事項',
    href: '/enterprise/disclosures/csrd/requirements',
    permission: DISCLOSURE_READ,
  },
  { label: '対応計画', href: '/enterprise/disclosures/csrd/plans', permission: DISCLOSURE_READ },
  {
    label: 'データ収集',
    href: '/enterprise/disclosures/csrd/collection',
    permission: DISCLOSURE_READ,
  },
  // §10.1 ①: SSBJ と同じく データ収集 と 開示ドラフト の間（同じ項目を再利用する）
  { label: '定性情報', href: '/enterprise/narratives', permission: DISCLOSURE_READ },
  {
    label: '開示ドラフト',
    href: '/enterprise/disclosures/csrd/draft',
    permission: DISCLOSURE_READ,
  },
];

/** §10.1 ②③: 自社経年比較は 規制対応度 と 他社比較 の間、財務影響分析は 他社比較 の次の兄弟 */
const ANALYSIS_CHILDREN: Shape[] = [
  { label: '現状診断', href: '/enterprise/analysis/diagnosis' },
  {
    label: '規制対応度',
    href: '/enterprise/analysis/regulations',
    permission: 'enterprise.disclosure.read',
  },
  // 2 画面とも権限なし（enterprise.data.read は全 enterprise 役割が持つ）
  { label: '自社経年比較', href: '/enterprise/analysis/trends' },
  { label: '他社比較', href: '/enterprise/analysis/benchmark' },
  { label: '財務影響分析', href: '/enterprise/analysis/financial-impact' },
];

const ANALYSIS: Shape = {
  label: '分析',
  href: '/enterprise/analysis/diagnosis',
  children: ANALYSIS_CHILDREN,
};

const ANALYSIS_PATHS = ANALYSIS_CHILDREN.map((child) => child.href);

/** 従来ツリーの枝の識別子（祖先ラベルの経路） */
const SSBJ_BRANCH = '開示対応 / SSBJ';
const CSRD_BRANCH = '開示対応 / CSRD';

describe('従来メニュー（機能設定が無効の組織: A39 と §9.1 の追加）', () => {
  it('enterprise の木は従来の ENTERPRISE_NAV そのもの', () => {
    expect(navTreeFor('enterprise', null)).toBe(ENTERPRISE_NAV);
  });

  it('ラベル・リンク先・入れ子・権限（定性情報・CSRD 6 画面・分析 5 画面を足した形）', () => {
    expect(shape(ENTERPRISE_NAV)).toEqual([
      { label: 'ホーム', href: '/enterprise/dashboard' },
      {
        label: '開示対応',
        href: '/enterprise/disclosures/ssbj',
        children: [
          // ① 定性情報は データ収集 と 開示ドラフト の間。従来ツリーでは通常の葉（現在地が付く）
          { label: 'SSBJ', href: '/enterprise/disclosures/ssbj', children: SSBJ_CHILDREN },
          { label: 'CDP', href: '/enterprise/disclosures/cdp' },
          // ③ CSRD は SSBJ と同じ並びのグループ。§10.1 ① で定性情報も入れた（§9.1 ③ を置き換え）
          {
            label: 'CSRD',
            href: '/enterprise/disclosures/csrd',
            permission: DISCLOSURE_READ,
            children: CSRD_CHILDREN,
          },
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
      // ② 分析は AI Copilot と 管理 の間。子は 5 画面（§10.1 ②③）
      ANALYSIS,
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

  it('CSRD「要求事項」だけが回答編集画面（csrd/{UUID}）も現在地として持つ', () => {
    const aliased = flatten(ENTERPRISE_NAV).filter((item) => item.alsoCurrentFor);
    expect(aliased.map((item) => [item.label, item.href])).toEqual([
      ['要求事項', '/enterprise/disclosures/csrd/requirements'],
    ]);
    const [pattern] = aliased[0]?.alsoCurrentFor ?? [];
    expect(pattern?.test(CSRD_QUESTION_PATH)).toBe(true);
    // 静的なセグメント（設定・要求事項など）や SSBJ の画面は含めない
    for (const path of [
      '/enterprise/disclosures/csrd/settings',
      '/enterprise/disclosures/csrd/requirements',
      '/enterprise/disclosures/csrd/draft',
      `${CSRD_QUESTION_PATH}/edit`,
      '/enterprise/disclosures/ssbj/6f1c2a4e-1b2d-4c3e-9f00-0123456789ab',
    ]) {
      expect(pattern?.test(path), path).toBe(false);
    }
  });

  it('兄弟の中でラベルが重複しない（Command Palette の経路ラベルが一意になる）', () => {
    const walk = (items: NavItem[]) => {
      const labels = items.map((item) => item.label);
      expect(new Set(labels).size).toBe(labels.length);
      for (const item of items) walk(item.children ?? []);
    };
    walk(ENTERPRISE_NAV);
  });
});

describe('開示優先モードのメニュー（A01）', () => {
  const tree = ENTERPRISE_NAV_DISCLOSURE_FIRST;

  it('enterprise-disclosure の木は開示優先モードのツリー', () => {
    expect(navTreeFor('enterprise-disclosure', null)).toBe(tree);
  });

  it('最上位は ホーム → 開示プロジェクト → 情報・根拠 → ESG経営 → タスク・承認 → 分析 → 管理、AI Copilot は補助として最後', () => {
    expect(tree.map((item) => item.label)).toEqual([
      'ホーム',
      '開示プロジェクト',
      '情報・根拠',
      'ESG経営',
      'タスク・承認',
      '分析',
      '管理',
      'AI Copilot',
    ]);
  });

  it('分析は従来ツリーと同じ 5 子（規制対応度の権限も同じ）', () => {
    expect(shape(tree).find((item) => item.label === '分析')).toEqual(ANALYSIS);
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

  it('SSBJ・CSRD は従来と同じ 6 子で、どちらも定性情報だけが別導線（secondary）', () => {
    const asSecondary = (children: Shape[]) =>
      children.map((child) =>
        child.href === '/enterprise/narratives' ? { ...child, secondary: true as const } : child,
      );
    const projects = shape(tree).find((item) => item.label === '開示プロジェクト');
    expect(projects?.children?.find((item) => item.label === 'SSBJ')).toEqual({
      label: 'SSBJ',
      href: '/enterprise/disclosures/ssbj',
      children: asSecondary(SSBJ_CHILDREN),
    });
    expect(projects?.children?.find((item) => item.label === 'CSRD')).toEqual({
      label: 'CSRD',
      href: '/enterprise/disclosures/csrd',
      permission: DISCLOSURE_READ,
      children: asSecondary(CSRD_CHILDREN),
    });
    // 正規の位置（情報・根拠 → 定性情報）は secondary ではない
    const info = shape(tree).find((item) => item.label === '情報・根拠');
    expect(info?.children?.find((item) => item.label === '定性情報')).toEqual({
      label: '定性情報',
      href: '/enterprise/narratives',
      permission: DISCLOSURE_READ,
    });
  });

  it('secondary は開示優先ツリーの SSBJ・CSRD 配下の定性情報 2 つだけ（従来ツリーには 1 つも無い）', () => {
    expect(flatten(ENTERPRISE_NAV).filter((item) => item.secondary)).toEqual([]);
    const secondaryPaths: string[] = [];
    const walk = (items: NavItem[], trail: string[]) => {
      for (const item of items) {
        if (item.secondary) secondaryPaths.push([...trail, item.label].join(' / '));
        walk(item.children ?? [], [...trail, item.label]);
      }
    };
    walk(tree, []);
    expect(secondaryPaths).toEqual([
      '開示プロジェクト / SSBJ / 定性情報',
      '開示プロジェクト / CSRD / 定性情報',
    ]);
  });

  it('従来メニューの画面はすべて新しいメニューからも開ける（既存 URL を維持）', () => {
    const newHrefs = new Set(flatten(tree).map((item) => item.href));
    const missing = flatten(ENTERPRISE_NAV)
      .map((item) => item.href)
      .filter((href) => !newHrefs.has(href));
    expect(missing).toEqual([]);
  });

  it('権限付きの項目（管理 > 設定・分析 > 規制対応度）は同じ権限を保つ', () => {
    const settings = flatten(tree).find((item) => item.href === '/enterprise/settings');
    expect(settings?.permission).toBe('enterprise.org.manage');
    const regulations = flatten(tree).find(
      (item) => item.href === '/enterprise/analysis/regulations',
    );
    expect(regulations?.permission).toBe('enterprise.disclosure.read');
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

describe('権限の無い項目を出さない（hiddenNavHrefsFor）', () => {
  /** 役割の権限で隠す href（app-shell と同じ判定） */
  const hiddenFor = (tree: NavItem[], role: Parameters<typeof permissionsFor>[0][number]) => {
    const permissions = new Set(permissionsFor([role]));
    return hiddenNavHrefsFor(tree, (permission) => permissions.has(permission));
  };

  it.each([
    ['従来メニュー', ENTERPRISE_NAV],
    ['開示優先モード', ENTERPRISE_NAV_DISCLOSURE_FIRST],
  ] as const)(
    '%s: 拠点担当（開示の閲覧権限なし）には、定性情報・CSRD の 5 画面・規制対応度を出さない（開いても権限なしの画面になる）',
    (_label, tree) => {
      const hidden = new Set(hiddenFor(tree, 'site_contributor'));
      for (const href of [
        '/enterprise/narratives',
        '/enterprise/disclosures/csrd',
        '/enterprise/disclosures/csrd/requirements',
        '/enterprise/disclosures/csrd/plans',
        '/enterprise/disclosures/csrd/collection',
        '/enterprise/disclosures/csrd/draft',
        '/enterprise/analysis/regulations',
      ]) {
        expect(hidden.has(href), href).toBe(true);
      }
      // 開ける画面（数値・資料・現状診断・自社経年比較・他社比較・財務影響分析）は出す
      for (const href of [
        '/enterprise/data',
        '/enterprise/evidence',
        '/enterprise/analysis/diagnosis',
        '/enterprise/analysis/trends',
        '/enterprise/analysis/benchmark',
        '/enterprise/analysis/financial-impact',
      ]) {
        expect(hidden.has(href), href).toBe(false);
      }
    },
  );

  it('開示優先: 「数値を登録（標準CSV）」は取込の権限がある役割だけに出す（画面のゲートと同じ。開くと権限なしの項目を出さない）', () => {
    for (const role of ['reviewer', 'approver', 'viewer', 'supplier_contributor'] as const) {
      expect(
        new Set(hiddenFor(ENTERPRISE_NAV_DISCLOSURE_FIRST, role)).has(
          '/enterprise/imports/standard',
        ),
        role,
      ).toBe(true);
    }
    for (const role of [
      'enterprise_admin',
      'sustainability_manager',
      'site_contributor',
    ] as const) {
      expect(
        new Set(hiddenFor(ENTERPRISE_NAV_DISCLOSURE_FIRST, role)).has(
          '/enterprise/imports/standard',
        ),
        role,
      ).toBe(false);
    }
  });

  it('開示優先: 開示の閲覧権限が無い役割には「開示プロジェクト」の行を開ける最初の子（SSBJ）へのリンクにする（配下は残す）', () => {
    const missing = (role: Parameters<typeof permissionsFor>[0][number]) => {
      const permissions = new Set(permissionsFor([role]));
      return missingNavPermissions(ENTERPRISE_NAV_DISCLOSURE_FIRST, (p) => permissions.has(p));
    };
    const site = visibleNavTree(
      ENTERPRISE_NAV_DISCLOSURE_FIRST,
      hiddenFor(ENTERPRISE_NAV_DISCLOSURE_FIRST, 'site_contributor'),
      missing('site_contributor'),
    );
    const projects = site.find((item) => item.label === '開示プロジェクト');
    expect(projects?.href).toBe('/enterprise/disclosures/ssbj');
    expect(projects?.linkFallback).toBe(true);
    expect(projects?.children?.map((c) => c.label)).toEqual([
      'SSBJ',
      'その他の開示',
      'レポート出力',
    ]);
    // パレットの「画面」には、開けない入口（開示プロジェクトの一覧）を出さない。子は経路付きで出す
    const entries = navCommandEntries(site).map((e) => [e.label, e.href]);
    expect(entries).not.toContainEqual(['開示プロジェクト', '/enterprise/disclosures/ssbj']);
    expect(entries.map(([, href]) => href)).not.toContain('/enterprise/disclosure-projects');
    expect(entries).toContainEqual(['開示プロジェクト / SSBJ', '/enterprise/disclosures/ssbj']);

    // 閲覧権限のある役割は従来どおり一覧へのリンク
    const admin = visibleNavTree(
      ENTERPRISE_NAV_DISCLOSURE_FIRST,
      hiddenFor(ENTERPRISE_NAV_DISCLOSURE_FIRST, 'enterprise_admin'),
      missing('enterprise_admin'),
    );
    const adminProjects = admin.find((item) => item.label === '開示プロジェクト');
    expect(adminProjects?.href).toBe('/enterprise/disclosure-projects');
    expect(adminProjects?.linkFallback).toBeUndefined();
  });

  it('開示の閲覧権限を持つ役割（閲覧者）には、定性情報・CSRD を出す', () => {
    const hidden = new Set(hiddenFor(ENTERPRISE_NAV, 'viewer'));
    expect(hidden.has('/enterprise/narratives')).toBe(false);
    expect(hidden.has('/enterprise/disclosures/csrd')).toBe(false);
  });
});

describe('現在地の決定（resolveNavCurrent・isNavSubtreeActive）', () => {
  it('従来メニューを折りたたむと、分析の 5 画面のどれでも最上位「分析」が現在地になる', () => {
    const analysisIndex = String(ENTERPRISE_NAV.findIndex((item) => item.label === '分析'));
    expect(ANALYSIS_PATHS).toHaveLength(5);
    for (const path of ANALYSIS_PATHS) {
      expect(
        [...resolveNavCurrent(ENTERPRISE_NAV, path, { mode: 'top-and-leaf', collapsed: true })],
        path,
      ).toEqual([analysisIndex]);
    }
  });

  /** 2 階層目以下の現在地を「親の経路 / ラベル」で返す */
  const deepCurrentOf = (
    tree: NavItem[],
    path: string,
    preferredBranch: string | null,
    mode: 'top-and-leaf' | 'single' = 'top-and-leaf',
  ) =>
    [...resolveNavCurrent(tree, path, { mode, collapsed: false, preferredBranch })]
      .filter((key) => key.includes('.'))
      .map((key) => `${navBranchOf(tree, key)} / ${labelAt(tree, key)}`);

  it('従来ツリーの定性情報（SSBJ と CSRD の 2 か所）: 優先枝が無ければ SSBJ、CSRD なら CSRD、該当しない枝なら SSBJ', () => {
    for (const path of ['/enterprise/narratives', '/enterprise/narratives/abc']) {
      expect(deepCurrentOf(ENTERPRISE_NAV, path, null), path).toEqual([
        `${SSBJ_BRANCH} / 定性情報`,
      ]);
      expect(deepCurrentOf(ENTERPRISE_NAV, path, CSRD_BRANCH), path).toEqual([
        `${CSRD_BRANCH} / 定性情報`,
      ]);
      expect(deepCurrentOf(ENTERPRISE_NAV, path, SSBJ_BRANCH), path).toEqual([
        `${SSBJ_BRANCH} / 定性情報`,
      ]);
      for (const unrelated of ['分析', 'GHG / Scope3データ取込', '開示対応', '存在しない枝']) {
        expect(deepCurrentOf(ENTERPRISE_NAV, path, unrelated), `${path} ${unrelated}`).toEqual([
          `${SSBJ_BRANCH} / 定性情報`,
        ]);
      }
    }
  });

  it('優先枝は同点の解消にだけ効く（一致の強さ・深さが違えば優先枝に関わらず同じ）', () => {
    for (const [path, expected] of [
      ['/enterprise/disclosures/csrd/plans', `${CSRD_BRANCH} / 対応計画`],
      ['/enterprise/disclosures/ssbj/plans', `${SSBJ_BRANCH} / 対応計画`],
      ['/enterprise/disclosures/csrd', `${CSRD_BRANCH} / 対応状況`],
      ['/enterprise/ghg/suppliers', 'GHG / Scope3データ取込 / Cat.1'],
    ] as const) {
      for (const preferred of [null, SSBJ_BRANCH, CSRD_BRANCH, 'GHG']) {
        expect(deepCurrentOf(ENTERPRISE_NAV, path, preferred), `${path} ${preferred}`).toEqual([
          expected,
        ]);
      }
    }
  });

  it('開示優先ツリーの定性情報は、優先枝に関わらず「情報・根拠」だけが現在地', () => {
    for (const preferred of [null, SSBJ_BRANCH, CSRD_BRANCH, '開示プロジェクト / CSRD']) {
      expect(
        deepCurrentOf(
          ENTERPRISE_NAV_DISCLOSURE_FIRST,
          '/enterprise/narratives',
          preferred,
          'single',
        ),
        String(preferred),
      ).toEqual(['情報・根拠 / 定性情報']);
    }
  });

  it('枝の識別子は祖先ラベルの経路（navBranchOf）。最上位は枝を持たない', () => {
    const narratives = (tree: NavItem[]) =>
      [
        ...resolveNavCurrent(tree, '/enterprise/narratives', {
          mode: 'top-and-leaf',
          collapsed: false,
          preferredBranch: CSRD_BRANCH,
        }),
      ].find((key) => key.includes('.'))!;
    expect(navBranchOf(ENTERPRISE_NAV, narratives(ENTERPRISE_NAV))).toBe(CSRD_BRANCH);
    expect(navBranchOf(ENTERPRISE_NAV, '0')).toBeNull();
    expect(navBranchOf(ENTERPRISE_NAV, '99.1')).toBeNull();
  });

  it('isNavAncestorOfCurrent: 現在地キーの祖先だけが true（自分自身・兄弟・別の枝は false）', () => {
    const current = new Set(['1', '1.2.4']);
    expect(isNavAncestorOfCurrent('1', current)).toBe(true);
    expect(isNavAncestorOfCurrent('1.2', current)).toBe(true);
    expect(isNavAncestorOfCurrent('1.0', current)).toBe(false);
    expect(isNavAncestorOfCurrent('1.2.4', current)).toBe(false);
    // 添字が前方一致するだけの別の位置（1.2 と 1.20）を祖先と取り違えない
    expect(isNavAncestorOfCurrent('1.2', new Set(['1.20.0']))).toBe(false);
    expect(isNavAncestorOfCurrent('1', new Set())).toBe(false);
  });

  describe('branchToRemember（遷移後に優先枝を書き換えるか）', () => {
    const rememberAt = (path: string, preferredBranch: string | null = null) =>
      branchToRemember(
        ENTERPRISE_NAV,
        resolveNavCurrent(ENTERPRISE_NAV, path, {
          mode: 'top-and-leaf',
          collapsed: false,
          preferredBranch,
        }),
      );

    it('CSRD の開示ドラフト（木に 1 回しか出ない画面。親 CSRD に定性情報がある）→ CSRD の枝', () => {
      expect(rememberAt('/enterprise/disclosures/csrd/draft')).toBe(CSRD_BRANCH);
      expect(rememberAt('/enterprise/disclosures/csrd/draft', SSBJ_BRANCH)).toBe(CSRD_BRANCH);
      expect(rememberAt('/enterprise/disclosures/csrd/plans')).toBe(CSRD_BRANCH);
      expect(rememberAt('/enterprise/disclosures/ssbj/draft', CSRD_BRANCH)).toBe(SSBJ_BRANCH);
    });

    it('定性情報そのもの（2 か所に出る画面）では変えない（undefined）', () => {
      expect(rememberAt('/enterprise/narratives')).toBeUndefined();
      expect(rememberAt('/enterprise/narratives', CSRD_BRANCH)).toBeUndefined();
      expect(rememberAt('/enterprise/narratives/abc', CSRD_BRANCH)).toBeUndefined();
    });

    it('親に重複する画面の無い枝（GHG・分析）やメニュー外の画面では変えない（undefined）', () => {
      expect(rememberAt('/enterprise/ghg')).toBeUndefined();
      expect(rememberAt('/enterprise/ghg/suppliers')).toBeUndefined();
      expect(rememberAt('/enterprise/analysis/trends')).toBeUndefined();
      expect(rememberAt('/enterprise/dashboard')).toBeUndefined();
      expect(rememberAt('/enterprise/disclosures/csrd/settings')).toBeUndefined();
    });

    it('開示優先ツリー（定性情報の別導線は secondary）では書き換えない', () => {
      for (const path of [
        '/enterprise/disclosures/csrd/draft',
        '/enterprise/disclosures/ssbj/draft',
        '/enterprise/narratives',
      ]) {
        expect(
          branchToRemember(
            ENTERPRISE_NAV_DISCLOSURE_FIRST,
            resolveNavCurrent(ENTERPRISE_NAV_DISCLOSURE_FIRST, path, {
              mode: 'single',
              collapsed: false,
            }),
          ),
          path,
        ).toBeUndefined();
      }
    });
  });

  const leaf = (label: string, href: string, extra: Partial<NavItem> = {}): NavItem => ({
    label,
    href,
    icon: FileText,
    ...extra,
  });

  it('同じ href が別の枝に 2 回出ても、2 階層目以下の現在地は木の順で最初の 1 つだけ', () => {
    const items: NavItem[] = [
      { ...leaf('A', '/a'), children: [leaf('共通', '/shared'), leaf('A2', '/a/2')] },
      { ...leaf('B', '/b'), children: [leaf('共通', '/shared'), leaf('B2', '/b/2')] },
    ];
    for (const mode of ['top-and-leaf', 'single'] as const) {
      expect([...resolveNavCurrent(items, '/shared', { mode, collapsed: false })], mode).toEqual([
        '0.0',
      ]);
      // 何度呼んでも同じ（決定的）
      expect([...resolveNavCurrent(items, '/shared/x', { mode, collapsed: false })], mode).toEqual([
        '0.0',
      ]);
      // 優先枝（祖先ラベルの経路）が一致する候補を選ぶ。一致しなければ木の順
      expect(
        [...resolveNavCurrent(items, '/shared', { mode, collapsed: false, preferredBranch: 'B' })],
        mode,
      ).toEqual(['1.0']);
      expect(
        [...resolveNavCurrent(items, '/shared', { mode, collapsed: false, preferredBranch: 'C' })],
        mode,
      ).toEqual(['0.0']);
      // 折りたたみ中（single）は優先枝の候補を含む最上位
      if (mode === 'single') {
        expect([
          ...resolveNavCurrent(items, '/shared', { mode, collapsed: true, preferredBranch: 'B' }),
        ]).toEqual(['1']);
      }
    }
  });

  it('secondary の項目は現在地にならず、もう一方へ譲る（木の順に関わらない）', () => {
    const items: NavItem[] = [
      { ...leaf('A', '/a'), children: [leaf('共通', '/shared', { secondary: true })] },
      { ...leaf('B', '/b'), children: [leaf('共通', '/shared')] },
    ];
    expect([...resolveNavCurrent(items, '/shared', { mode: 'single', collapsed: false })]).toEqual([
      '1.0',
    ]);
    // 折りたたみ中は、現在地の葉を含む最上位に付ける
    expect([...resolveNavCurrent(items, '/shared', { mode: 'single', collapsed: true })]).toEqual([
      '1',
    ]);
  });

  it('前方一致より完全一致・別名（alsoCurrentFor）を優先し、前方一致どうしは長い href を優先する', () => {
    const items: NavItem[] = [
      {
        ...leaf('X', '/x'),
        children: [leaf('広い', '/p'), leaf('別名', '/q', { alsoCurrentFor: [/^\/p\/alias$/] })],
      },
      { ...leaf('Y', '/y'), children: [leaf('狭い', '/p/deep')] },
    ];
    const at = (path: string) => [
      ...resolveNavCurrent(items, path, { mode: 'single', collapsed: false }),
    ];
    expect(at('/p')).toEqual(['0.0']);
    expect(at('/p/other')).toEqual(['0.0']);
    // 別の枝の前方一致どうしは長い href（より狭い画面）が勝つ
    expect(at('/p/deep')).toEqual(['1.0']);
    expect(at('/p/deep/more')).toEqual(['1.0']);
    // 別名は前方一致（広い）より強い
    expect(at('/p/alias')).toEqual(['0.1']);
    expect(at('/z')).toEqual([]);
  });

  it('兄弟の親パスを持つ葉は完全一致のときだけ（兄弟の配下の画面では光らない）', () => {
    const items: NavItem[] = [
      { ...leaf('X', '/x'), children: [leaf('入口', '/p'), leaf('配下', '/p/sub')] },
    ];
    const at = (path: string) => [
      ...resolveNavCurrent(items, path, { mode: 'single', collapsed: false }),
    ];
    expect(at('/p')).toEqual(['0.0']);
    expect(at('/p/sub/1')).toEqual(['0.1']);
    expect(at('/p/other')).toEqual([]);
  });

  it('secondary の項目は親の「配下が現在地」にも数えない（強調表示しない）', () => {
    const ssbjOf = (tree: NavItem[]) =>
      flatten(tree).find(
        (item) => item.label === 'SSBJ' && item.href === '/enterprise/disclosures/ssbj',
      )!;
    expect(isNavSubtreeActive('/enterprise/narratives', ssbjOf(ENTERPRISE_NAV))).toBe(true);
    expect(
      isNavSubtreeActive('/enterprise/narratives', ssbjOf(ENTERPRISE_NAV_DISCLOSURE_FIRST)),
    ).toBe(false);
    const projects = ENTERPRISE_NAV_DISCLOSURE_FIRST.find(
      (item) => item.label === '開示プロジェクト',
    )!;
    expect(isNavSubtreeActive('/enterprise/narratives', projects)).toBe(false);
    const info = ENTERPRISE_NAV_DISCLOSURE_FIRST.find((item) => item.label === '情報・根拠')!;
    expect(isNavSubtreeActive('/enterprise/narratives/abc', info)).toBe(true);
  });
});

describe('Sidebar の現在地（aria-current）', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  function currentLinks(): string[] {
    const nav = screen.getByRole('navigation', { name: 'メインナビゲーション' });
    return within(nav)
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page')
      .map((link) => link.textContent ?? '');
  }

  /** 現在地のリンクを「親リストの名前 / ラベル」で返す（同名のリンクがどの枝のものか区別する） */
  function currentLinksWithList(): string[] {
    const nav = screen.getByRole('navigation', { name: 'メインナビゲーション' });
    return within(nav)
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page')
      .map((link) => {
        const list = link.closest('ul');
        return `${list?.getAttribute('aria-label') ?? '(最上位)'} / ${link.textContent ?? ''}`;
      });
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
    ['/enterprise/analysis/diagnosis', ['現状診断']],
    ['/enterprise/analysis/trends', ['自社経年比較']],
    ['/enterprise/analysis/benchmark', ['他社比較']],
    ['/enterprise/analysis/financial-impact', ['財務影響分析']],
  ])('開示優先モード %s では現在地が 1 つだけ（%j）', (path, expected) => {
    pathname = path;
    render(<Sidebar variant="enterprise-disclosure" hiddenHrefs={[]} />);
    expect(currentLinks()).toEqual(expected);
  });

  it.each(uniqueHrefs(ENTERPRISE_NAV_DISCLOSURE_FIRST))(
    '開示優先モード: メニューのどの href（%s）を開いても aria-current はちょうど 1 つ',
    (href) => {
      pathname = href;
      render(<Sidebar variant="enterprise-disclosure" hiddenHrefs={[]} />);
      expect(currentLinks()).toHaveLength(1);
    },
  );

  it('開示優先モード: 定性情報は「情報・根拠」側だけが現在地（SSBJ・CSRD 配下の別導線には付けない）', () => {
    for (const branch of [null, SSBJ_BRANCH, CSRD_BRANCH, '開示プロジェクト / CSRD']) {
      for (const path of ['/enterprise/narratives', '/enterprise/narratives/abc']) {
        rememberNavBranch(branch);
        pathname = path;
        const { unmount } = render(<Sidebar variant="enterprise-disclosure" hiddenHrefs={[]} />);
        expect(currentLinksWithList(), `${path} ${branch}`).toEqual(['情報・根拠 / 定性情報']);
        // SSBJ・CSRD 配下の定性情報もリンクとしては出ている（別導線）
        for (const list of ['SSBJ', 'CSRD']) {
          expect(
            within(screen.getByRole('list', { name: list })).getByRole('link', {
              name: '定性情報',
            }),
          ).toHaveAttribute('href', '/enterprise/narratives');
        }
        unmount();
      }
    }
  });

  it.each(['enterprise', 'enterprise-disclosure'] as const)(
    '%s: CSRD の回答編集画面（csrd/{UUID}）では CSRD の「要求事項」が現在地',
    (variant) => {
      pathname = CSRD_QUESTION_PATH;
      render(<Sidebar variant={variant} hiddenHrefs={[]} />);
      expect(currentLinksWithList()).toEqual(['CSRD / 要求事項']);
    },
  );

  it.each([
    ['/enterprise/narratives', ['SSBJ / 定性情報']],
    ['/enterprise/disclosures/csrd', ['CSRD / 対応状況']],
    ['/enterprise/disclosures/csrd/requirements/abc', ['CSRD / 要求事項']],
    ['/enterprise/disclosures/csrd/plans', ['CSRD / 対応計画']],
    ['/enterprise/disclosures/csrd/collection', ['CSRD / データ収集']],
    ['/enterprise/disclosures/csrd/draft', ['CSRD / 開示ドラフト']],
    // 最上位「開示対応」の href は SSBJ のため、SSBJ の画面では最上位にも付く（従来どおり）
    ['/enterprise/disclosures/ssbj/collection', ['(最上位) / 開示対応', 'SSBJ / データ収集']],
    // 最上位「分析」は分析の画面すべて（入口の現状診断以外も）で現在地になる（SSBJ の画面と同じ扱い）
    ['/enterprise/analysis/regulations', ['(最上位) / 分析', '分析 / 規制対応度']],
    ['/enterprise/analysis/trends', ['(最上位) / 分析', '分析 / 自社経年比較']],
    ['/enterprise/analysis/benchmark', ['(最上位) / 分析', '分析 / 他社比較']],
    ['/enterprise/analysis/financial-impact', ['(最上位) / 分析', '分析 / 財務影響分析']],
  ])('従来メニュー %s の現在地は %j', (path, expected) => {
    pathname = path;
    render(<Sidebar variant="enterprise" hiddenHrefs={[]} />);
    expect(currentLinksWithList()).toEqual(expected);
  });

  /** 子リストの中のリンクが強調表示（グループ行の太字・最上位の背景）されているか */
  const emphasized = (list: string, link: string) =>
    within(screen.getByRole('list', { name: list }))
      .getByRole('link', { name: link })
      .getAttribute('data-nav-emphasis');

  it('従来メニューの定性情報: 優先枝が無ければ SSBJ 側、CSRD を覚えていれば CSRD 側だけが現在地で、強調も片方だけ', () => {
    pathname = '/enterprise/narratives';
    const first = render(<Sidebar variant="enterprise" hiddenHrefs={[]} />);
    expect(currentLinksWithList()).toEqual(['SSBJ / 定性情報']);
    expect(emphasized('開示対応', 'SSBJ')).toBe('ancestor');
    expect(emphasized('開示対応', 'CSRD')).toBeNull();
    first.unmount();

    window.sessionStorage.setItem(NAV_BRANCH_STORAGE_KEY, CSRD_BRANCH);
    render(<Sidebar variant="enterprise" hiddenHrefs={[]} />);
    expect(currentLinksWithList()).toEqual(['CSRD / 定性情報']);
    expect(emphasized('開示対応', 'CSRD')).toBe('ancestor');
    expect(emphasized('開示対応', 'SSBJ')).toBeNull();
    // 最上位「開示対応」は現在地の祖先として背景を付ける（aria-current は付けない: href が SSBJ のため）
    const nav = screen.getByRole('navigation', { name: 'メインナビゲーション' });
    const top = within(nav).getByRole('link', { name: '開示対応' });
    expect(top).toHaveAttribute('data-nav-emphasis', 'ancestor');
    expect(top).not.toHaveAttribute('aria-current');
  });

  it('従来メニュー: 2 階層目以下のリンクを押すとその親の枝を覚え、最上位のリンクを押すと忘れる', () => {
    pathname = '/enterprise/narratives';
    render(<Sidebar variant="enterprise" hiddenHrefs={[]} />);
    expect(currentLinksWithList()).toEqual(['SSBJ / 定性情報']);

    const linkIn = (list: string, name: string) =>
      within(screen.getByRole('list', { name: list })).getByRole('link', { name });
    // 遷移はしない（next/navigation はモック）。押した時点で枝を書き、同じ画面の現在地が移る
    act(() => {
      fireEvent.click(linkIn('CSRD', '定性情報'));
    });
    expect(window.sessionStorage.getItem(NAV_BRANCH_STORAGE_KEY)).toBe(CSRD_BRANCH);
    expect(currentLinksWithList()).toEqual(['CSRD / 定性情報']);

    act(() => {
      fireEvent.click(linkIn('SSBJ', '定性情報'));
    });
    expect(window.sessionStorage.getItem(NAV_BRANCH_STORAGE_KEY)).toBe(SSBJ_BRANCH);
    expect(currentLinksWithList()).toEqual(['SSBJ / 定性情報']);

    act(() => {
      fireEvent.click(linkIn('CSRD', '定性情報'));
    });
    const nav = screen.getByRole('navigation', { name: 'メインナビゲーション' });
    act(() => {
      fireEvent.click(within(nav).getByRole('link', { name: 'ホーム' }));
    });
    expect(window.sessionStorage.getItem(NAV_BRANCH_STORAGE_KEY)).toBeNull();
    expect(currentLinksWithList()).toEqual(['SSBJ / 定性情報']);
  });

  it('従来メニュー: CSRD の画面（開示ドラフト）を開くと CSRD の枝を覚え、その後の定性情報は CSRD 側', () => {
    pathname = '/enterprise/disclosures/csrd/draft';
    const { rerender } = render(<Sidebar variant="enterprise" hiddenHrefs={[]} />);
    expect(window.sessionStorage.getItem(NAV_BRANCH_STORAGE_KEY)).toBe(CSRD_BRANCH);
    // 画面右上のリンク等（サイドバー以外）で定性情報へ移った
    pathname = '/enterprise/narratives';
    rerender(<Sidebar variant="enterprise" hiddenHrefs={[]} />);
    expect(currentLinksWithList()).toEqual(['CSRD / 定性情報']);
    // 定性情報そのものは覚えた枝を変えない
    expect(window.sessionStorage.getItem(NAV_BRANCH_STORAGE_KEY)).toBe(CSRD_BRANCH);
    // SSBJ の画面へ移ると SSBJ の枝に戻る
    pathname = '/enterprise/disclosures/ssbj/collection';
    rerender(<Sidebar variant="enterprise" hiddenHrefs={[]} />);
    expect(window.sessionStorage.getItem(NAV_BRANCH_STORAGE_KEY)).toBe(SSBJ_BRANCH);
  });

  it('sessionStorage が使えなくても描画でき、既定（SSBJ 側）に従う', () => {
    // happy-dom の Storage はメソッドを実体ごとに束ねるため、prototype ではなく実体を差し替える
    const denied = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    const storage = vi.spyOn(window, 'sessionStorage', 'get').mockReturnValue(denied);
    try {
      pathname = '/enterprise/narratives';
      render(<Sidebar variant="enterprise" hiddenHrefs={[]} />);
      expect(currentLinksWithList()).toEqual(['SSBJ / 定性情報']);
      act(() => {
        fireEvent.click(
          within(screen.getByRole('list', { name: 'CSRD' })).getByRole('link', {
            name: '定性情報',
          }),
        );
      });
      expect(currentLinksWithList()).toEqual(['SSBJ / 定性情報']);
      expect(storage).toHaveBeenCalled();
    } finally {
      storage.mockRestore();
    }
  });

  it.each(['enterprise', 'enterprise-disclosure'] as const)(
    '%s: 強調表示は現在地の祖先だけ（SSBJ と CSRD が同時に強調されない）',
    (variant) => {
      for (const path of uniqueHrefs(navTreeFor(variant, null))) {
        for (const branch of [null, SSBJ_BRANCH, CSRD_BRANCH]) {
          rememberNavBranch(branch);
          pathname = path;
          const { unmount } = render(<Sidebar variant={variant} hiddenHrefs={[]} />);
          const nav = screen.getByRole('navigation', { name: 'メインナビゲーション' });
          const groups = ['SSBJ', 'CSRD'].filter((name) =>
            within(nav)
              .getAllByRole('link', { name })
              .some((link) => link.hasAttribute('data-nav-emphasis')),
          );
          expect(groups.length, `${path} ${branch}`).toBeLessThanOrEqual(1);
          // 強調された 2 階層目以下のグループ行は、現在地のリンクを配下に持つ（別の枝を強調しない）
          for (const link of within(nav).getAllByRole('link')) {
            if (link.getAttribute('data-nav-emphasis') !== 'ancestor') continue;
            const subtree = link.closest('li');
            const hasCurrentInside =
              subtree?.querySelector('a[aria-current="page"]') !== null ||
              // 現在地が 2 階層目以下に無い画面では従来の判定（配下の画面か）に戻る
              within(nav)
                .getAllByRole('link')
                .every((a) => a.getAttribute('aria-current') !== 'page' || !a.closest('ul ul'));
            expect(hasCurrentInside, `${path} ${branch} ${link.textContent}`).toBe(true);
          }
          unmount();
        }
      }
    },
  );

  it('従来メニューの現在地の付け方は変えない（最上位 GHG と Cat.1。算定サマリーは付かない）', () => {
    // 従来メニューでは最上位の項目にも aria-current が付く（A39: 従来の DOM を変えない）。
    // 開示優先モードでは同じ href の子がある最上位項目は子に譲る（上の it.each）
    pathname = '/enterprise/ghg/suppliers';
    render(<Sidebar variant="enterprise" hiddenHrefs={[]} />);
    expect(currentLinks()).toEqual(['GHG', 'Cat.1']);
  });

  it('従来メニューの現在地（最上位＋葉）は分析にも同じ規則で付く', () => {
    pathname = '/enterprise/analysis/diagnosis';
    render(<Sidebar variant="enterprise" hiddenHrefs={[]} />);
    expect(currentLinksWithList()).toEqual(['(最上位) / 分析', '分析 / 現状診断']);
  });

  it.each(uniqueHrefs(ENTERPRISE_NAV))(
    '従来メニュー: %s を開いても 2 階層目以下の aria-current は 1 つ以下、最上位も 1 つ以下',
    (href) => {
      pathname = href;
      render(<Sidebar variant="enterprise" hiddenHrefs={[]} />);
      const current = currentLinksWithList();
      expect(current.filter((c) => !c.startsWith('(最上位) / ')).length).toBeLessThanOrEqual(1);
      expect(current.filter((c) => c.startsWith('(最上位) / ')).length).toBeLessThanOrEqual(1);
      expect(current.length).toBeGreaterThanOrEqual(1);
    },
  );

  it.each(['enterprise', 'enterprise-disclosure'] as const)(
    '%s: 設定画面（SSBJ・CSRD）はメニュー外なので 2 階層目以下に現在地を付けない',
    (variant) => {
      for (const path of [
        '/enterprise/disclosures/ssbj/settings',
        '/enterprise/disclosures/csrd/settings',
        '/enterprise/disclosures/csrd/settings/matters/E1',
      ]) {
        pathname = path;
        const { unmount } = render(<Sidebar variant={variant} hiddenHrefs={[]} />);
        expect(
          currentLinksWithList().filter((c) => !c.startsWith('(最上位) / ')),
          path,
        ).toEqual([]);
        unmount();
      }
    },
  );

  it('子リストは親のラベルで名前が付く（同名のリンクが並ぶ SSBJ と CSRD を区別できる）', () => {
    pathname = '/enterprise/dashboard';
    render(<Sidebar variant="enterprise" hiddenHrefs={[]} />);
    const names = (list: string) =>
      within(screen.getByRole('list', { name: list }))
        .getAllByRole('link')
        .map((link) => link.textContent);
    expect(names('SSBJ')).toEqual(SSBJ_CHILDREN.map((c) => c.label));
    expect(names('CSRD')).toEqual([
      '対応状況',
      '要求事項',
      '対応計画',
      'データ収集',
      '定性情報',
      '開示ドラフト',
    ]);
    expect(names('分析')).toEqual([
      '現状診断',
      '規制対応度',
      '自社経年比較',
      '他社比較',
      '財務影響分析',
    ]);
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

  it('開示優先モードで折りたたみ中も、現在地の画面を含む最上位にちょうど 1 つ付く', async () => {
    window.localStorage.setItem('t4d.sidebar.collapsed', '1');
    for (const [path, top] of [
      ['/enterprise/narratives', '情報・根拠'],
      ['/enterprise/disclosures/csrd/plans', '開示プロジェクト'],
      ...ANALYSIS_PATHS.map((analysisPath) => [analysisPath, '分析'] as const),
    ] as const) {
      pathname = path;
      const { unmount } = render(
        <TooltipProvider>
          <Sidebar variant="enterprise-disclosure" hiddenHrefs={[]} />
        </TooltipProvider>,
      );
      const nav = screen.getByRole('navigation', { name: 'メインナビゲーション' });
      await waitFor(() => expect(nav).toHaveAttribute('data-collapsed', 'true'));
      const current = within(nav)
        .getAllByRole('link')
        .filter((link) => link.getAttribute('aria-current') === 'page')
        .map((link) => link.getAttribute('aria-label'));
      expect(current, path).toEqual([top]);
      unmount();
    }
  });

  it('権限で隠した項目は開示優先モードのメニューからも消える', () => {
    pathname = '/enterprise/dashboard';
    render(
      <Sidebar
        variant="enterprise-disclosure"
        hiddenHrefs={['/enterprise/settings', '/enterprise/analysis/regulations']}
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'メインナビゲーション' });
    expect(within(nav).queryByRole('link', { name: '設定' })).toBeNull();
    expect(within(nav).getByRole('link', { name: '組織・拠点' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: '規制対応度' })).toBeNull();
    expect(within(nav).getByRole('link', { name: '現状診断' })).toBeInTheDocument();
  });
});

describe('Command Palette の候補（navCommandEntries）', () => {
  const labels = (tree: NavItem[]) => navCommandEntries(tree).map((entry) => entry.label);

  it('従来メニュー: 新しい画面が経路ラベル付きで出る', () => {
    const all = labels(ENTERPRISE_NAV);
    for (const label of [
      '開示対応 / SSBJ / 定性情報',
      '開示対応 / CSRD',
      '開示対応 / CSRD / 対応状況',
      '開示対応 / CSRD / 要求事項',
      '開示対応 / CSRD / 対応計画',
      '開示対応 / CSRD / データ収集',
      '開示対応 / CSRD / 定性情報',
      '開示対応 / CSRD / 開示ドラフト',
      '分析',
      '分析 / 現状診断',
      '分析 / 規制対応度',
      '分析 / 自社経年比較',
      '分析 / 他社比較',
      '分析 / 財務影響分析',
    ]) {
      expect(all, label).toContain(label);
    }
  });

  it('従来メニュー: 定性情報は SSBJ・CSRD の 2 件（どちらも同じ画面）', () => {
    const narratives = navCommandEntries(ENTERPRISE_NAV).filter(
      (entry) => entry.href === '/enterprise/narratives',
    );
    expect(narratives.map((entry) => entry.label)).toEqual([
      '開示対応 / SSBJ / 定性情報',
      '開示対応 / CSRD / 定性情報',
    ]);
  });

  it('開示優先モード: 定性情報は正規の位置（情報・根拠）だけを候補にし、別導線は重ねない', () => {
    const narratives = navCommandEntries(ENTERPRISE_NAV_DISCLOSURE_FIRST).filter(
      (entry) => entry.href === '/enterprise/narratives',
    );
    expect(narratives.map((entry) => entry.label)).toEqual(['情報・根拠 / 定性情報']);
  });

  it('新しい項目は検索語を持つ（画面名に無い語でも探せる）', () => {
    const keywordsOf = (label: string) =>
      navCommandEntries(ENTERPRISE_NAV).find((entry) => entry.label === label)?.keywords ?? [];
    expect(keywordsOf('開示対応 / CSRD')).toEqual(expect.arrayContaining(['ESRS']));
    expect(keywordsOf('開示対応 / CSRD / 対応状況')).toEqual(
      expect.arrayContaining(['ダブル・マテリアリティ']),
    );
    expect(keywordsOf('開示対応 / SSBJ / 定性情報')).toEqual(expect.arrayContaining(['定性']));
    expect(keywordsOf('分析 / 他社比較')).toEqual(expect.arrayContaining(['ベンチマーク']));
    expect(keywordsOf('分析 / 規制対応度')).toEqual(expect.arrayContaining(['規制']));
    expect(keywordsOf('分析 / 現状診断')).toEqual(expect.arrayContaining(['診断']));
    // §10.1 ③ の検索語
    expect(keywordsOf('分析 / 自社経年比較')).toEqual(['経年', '推移', '前年比', '年度比較']);
    expect(keywordsOf('分析 / 財務影響分析')).toEqual([
      '財務',
      '影響',
      'シミュレーション',
      '経路',
      '炭素価格',
      'シナリオ',
    ]);
  });
});
