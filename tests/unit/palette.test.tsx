import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { permissionsFor } from '@/lib/authorization/can';
import { arrangePaletteEntries, matchesPaletteQuery, type PaletteEntry } from '@/lib/ui/palette';
import { addRecentItem, parseRecentItems, sanitizeRecentHref } from '@/lib/ui/recent';
import type { RoleKey } from '@/types/domain';

/**
 * Command Palette（plan §1.10・§1.9）。最近使った画面 → おすすめ → 操作 → 画面 → 設定の項目 → データ。
 * 選ぶと移るだけ（操作は実行しない）。権限で候補を絞る。メニュー外の画面も引ける。
 */

const push = vi.fn();
let pathname = '/enterprise/dashboard';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const { CommandPalette, OPEN_PALETTE_EVENT } = await import('@/components/shared/command-palette');
const { ShellProvider } = await import('@/components/shared/viewer-context');
const { homeProfileFor } = await import('@/lib/ui/home-profile');

function shellFor(
  roles: RoleKey[],
  variant: 'enterprise' | 'enterprise-disclosure' = 'enterprise',
) {
  const permissions = [...permissionsFor(roles)];
  return {
    viewerKey: `u-${roles.join('-')}:org-1`,
    variant,
    workspace: 'enterprise' as const,
    hiddenHrefs: [],
    hiddenPermissions: [],
    permissions,
    profile: homeProfileFor((p) => permissions.includes(p)),
    defaultCollapsedGroups: [],
    verbContext: {
      unitScopeIds: [],
      demo: true,
      disclosureFirst: variant === 'enterprise-disclosure',
    },
    homeHref: '/enterprise/dashboard',
  };
}

function openPalette() {
  act(() => {
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  });
  return screen.getByRole('combobox', { name: 'コマンドパレット検索' });
}

function groupLabels(): string[] {
  return within(screen.getByRole('listbox', { name: '検索結果' }))
    .getAllByRole('group')
    .map((g) => g.getAttribute('data-palette-group') ?? '');
}

beforeEach(() => {
  push.mockReset();
  window.localStorage.clear();
});

describe('候補の絞り込み（純関数）', () => {
  it('全角・半角・大文字小文字を区別せず、空白で区切った語をすべて含むものに当たる', () => {
    const entry = { label: '開示対応 / SSBJ / 対応計画', keywords: ['担当', '期限'] };
    expect(matchesPaletteQuery(entry, 'ｓｓｂｊ　計画')).toBe(true);
    expect(matchesPaletteQuery(entry, 'ssbj 期限')).toBe(true);
    expect(matchesPaletteQuery(entry, 'csrd')).toBe(false);
  });

  it('空のクエリではおすすめを出し、クエリがあればおすすめを出さない', () => {
    const e = (group: PaletteEntry['group'], label: string, href = `/${label}`): PaletteEntry => ({
      id: `${group}:${label}`,
      group,
      label,
      href,
    });
    const groups = {
      recommended: [e('recommended', 'データを入力する')],
      screens: [e('screens', '非財務データ')],
    };
    expect(arrangePaletteEntries(groups, '').map((x) => x.group)).toEqual([
      'recommended',
      'screens',
    ]);
    expect(arrangePaletteEntries(groups, 'データ').map((x) => x.group)).toEqual(['screens']);
  });
});

describe('最近使った画面（端末ごと）', () => {
  it('通知・エラーの引数を外し、同じ行き先は 1 つにまとめて新しい順', () => {
    expect(sanitizeRecentHref('/enterprise/data', '?status=draft&flash=imported')).toBe(
      '/enterprise/data?status=draft',
    );
    const list = addRecentItem(
      [
        { href: '/a', label: 'A', at: '2026-10-01T00:00:00Z' },
        { href: '/b', label: 'B', at: '2026-10-02T00:00:00Z' },
      ],
      { href: '/a', label: 'A', at: '2026-10-03T00:00:00Z' },
    );
    expect(list.map((i) => i.href)).toEqual(['/a', '/b']);
    expect(
      parseRecentItems([
        { href: '//evil', label: 'x', at: '' },
        { href: '/ok', label: 'OK', at: '' },
      ]),
    ).toEqual([{ href: '/ok', label: 'OK', at: '' }]);
  });
});

describe('CommandPalette', () => {
  it('空のクエリ: 最近使った画面 → おすすめ → 操作 → 画面 の順', () => {
    const shell = shellFor(['site_contributor']);
    window.localStorage.setItem(
      `t4d.recent.v1.${shell.viewerKey}`,
      JSON.stringify([
        { href: '/enterprise/ghg', label: 'GHG 算定サマリー', at: '2026-10-01T00:00:00Z' },
      ]),
    );
    render(
      <ShellProvider value={shell}>
        <CommandPalette variant="enterprise" hiddenHrefs={[]} />
      </ShellProvider>,
    );
    openPalette();
    expect(groupLabels()).toEqual(['recent', 'recommended', 'actions', 'screens']);
    expect(screen.getByRole('option', { name: /GHG 算定サマリー/ })).toBeInTheDocument();
    // 拠点担当のおすすめ（入力・差戻し・資料・取込）
    const recommended = within(screen.getByRole('group', { name: 'おすすめ' })).getAllByRole(
      'option',
    );
    expect(recommended.map((o) => o.getAttribute('data-palette-href'))).toEqual([
      '/enterprise/data?status=not_started&status=draft',
      '/enterprise/data?status=returned',
      '/enterprise/evidence?new=1',
      '/enterprise/imports',
    ]);
  });

  it('作成担当のおすすめは 4 件。「原稿を書く」は現在のプロジェクトの原稿（一覧と重ならない）', () => {
    const shell = shellFor(['sustainability_manager']);
    render(
      <ShellProvider
        value={{ ...shell, verbContext: { ...shell.verbContext, currentProjectId: 'proj-a' } }}
      >
        <CommandPalette variant="enterprise" hiddenHrefs={[]} />
      </ShellProvider>,
    );
    openPalette();
    const recommended = within(screen.getByRole('group', { name: 'おすすめ' })).getAllByRole(
      'option',
    );
    expect(recommended.map((o) => o.getAttribute('data-palette-href'))).toEqual([
      '/enterprise/disclosure-projects/proj-a?tab=manuscripts&filter=mine',
      '/enterprise/imports',
      '/enterprise/disclosures/ssbj/requirements',
      '/enterprise/disclosure-projects',
    ]);
  });

  it('プロジェクトの画面で開くと、そのプロジェクトの原稿へ向ける（ヘッダーと同じ決め方）', () => {
    pathname = '/enterprise/disclosure-projects/proj-b/manuscripts';
    try {
      const shell = shellFor(['sustainability_manager']);
      render(
        <ShellProvider
          value={{ ...shell, verbContext: { ...shell.verbContext, currentProjectId: 'proj-a' } }}
        >
          <CommandPalette variant="enterprise" hiddenHrefs={[]} />
        </ShellProvider>,
      );
      openPalette();
      const first = within(screen.getByRole('group', { name: 'おすすめ' })).getAllByRole(
        'option',
      )[0];
      expect(first).toHaveAttribute(
        'data-palette-href',
        '/enterprise/disclosure-projects/proj-b?tab=manuscripts&filter=mine',
      );
    } finally {
      pathname = '/enterprise/dashboard';
    }
  });

  it('従来メニューでも、メニュー外の画面（開示プロジェクト）を権限があれば「画面」に出す', () => {
    render(
      <ShellProvider value={shellFor(['sustainability_manager'])}>
        <CommandPalette variant="enterprise" hiddenHrefs={[]} />
      </ShellProvider>,
    );
    fireEvent.change(openPalette(), { target: { value: '開示プロジェクト' } });
    const screens = screen.getByRole('group', { name: '画面' });
    const option = within(screens)
      .getAllByRole('option')
      .find((o) => o.getAttribute('data-palette-href') === '/enterprise/disclosure-projects');
    expect(option).toBeDefined();
    expect(option).toHaveTextContent(/^開示プロジェクト/);
    expect(option).toHaveTextContent('メニュー外の画面');
  });

  it('権限の無い画面・操作は出さない（拠点担当に CSRD・承認・メンバー招待を出さない）', () => {
    render(
      <ShellProvider value={shellFor(['site_contributor'])}>
        <CommandPalette variant="enterprise" hiddenHrefs={['/enterprise/disclosures/csrd']} />
      </ShellProvider>,
    );
    const input = openPalette();
    fireEvent.change(input, { target: { value: 'CSRD' } });
    expect(screen.queryByRole('option', { name: /CSRD 対応状況|CSRD \/ 対応状況/ })).toBeNull();
    fireEvent.change(input, { target: { value: '承認する' } });
    expect(screen.queryByRole('option', { name: /データを承認する/ })).toBeNull();
    fireEvent.change(input, { target: { value: '招待' } });
    expect(screen.queryByRole('option', { name: /メンバーを招待する/ })).toBeNull();
  });

  it('操作を選ぶと、その画面へ移るだけ（実行しない）', () => {
    render(
      <ShellProvider value={shellFor(['approver', 'reviewer'])}>
        <CommandPalette variant="enterprise" hiddenHrefs={[]} />
      </ShellProvider>,
    );
    fireEvent.change(openPalette(), { target: { value: 'データを承認' } });
    const option = screen.getByRole('option', { name: /データを承認する/ });
    act(() => {
      fireEvent.click(option);
    });
    expect(push).toHaveBeenCalledWith('/enterprise/data?status=in_review');
  });

  it('既定ビューがある一覧へは、選んだ時点で条件を付けて移る', () => {
    const shell = shellFor(['sustainability_manager']);
    window.localStorage.setItem(
      `t4d.table-defaults.v1.${shell.viewerKey}`,
      JSON.stringify({ '/enterprise/data': 'status=returned' }),
    );
    render(
      <ShellProvider value={shell}>
        <CommandPalette variant="enterprise" hiddenHrefs={[]} />
      </ShellProvider>,
    );
    fireEvent.change(openPalette(), { target: { value: '非財務データ' } });
    act(() => {
      fireEvent.click(
        within(screen.getByRole('group', { name: '画面' })).getAllByRole('option')[0]!,
      );
    });
    expect(push).toHaveBeenCalledWith('/enterprise/data?status=returned');
  });

  it('データの検索は 2 文字以上で呼び、結果を「データ」に出す（固定の高さの領域）', async () => {
    const searchAction = vi.fn(async () => ({
      entries: [
        {
          id: 'data:指標:m1',
          group: 'data' as const,
          label: '電力使用量（energy）',
          href: '/enterprise/data?metric=m1',
          hint: '指標',
        },
      ],
    }));
    render(
      <ShellProvider value={shellFor(['sustainability_manager'])}>
        <CommandPalette variant="enterprise" hiddenHrefs={[]} searchAction={searchAction} />
      </ShellProvider>,
    );
    const input = openPalette();
    expect(screen.getByRole('listbox', { name: '検索結果' }).className).toContain('h-80');
    fireEvent.change(input, { target: { value: '電' } });
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(searchAction).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '電力' } });
    await waitFor(() => expect(searchAction).toHaveBeenCalledWith('電力'));
    await waitFor(() =>
      expect(
        within(screen.getByRole('group', { name: 'データ' })).getByRole('option'),
      ).toHaveTextContent('電力使用量（energy）'),
    );
  });

  it('ヘッダーの「検索」から開ける（パレットの外からのイベント）', () => {
    render(
      <ShellProvider value={shellFor(['viewer'])}>
        <CommandPalette variant="enterprise" hiddenHrefs={[]} />
      </ShellProvider>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => {
      window.dispatchEvent(new Event(OPEN_PALETTE_EVENT));
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    pathname = '/enterprise/dashboard';
  });
});
