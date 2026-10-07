import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { permissionsFor } from '@/lib/authorization/can';
import { GETTING_STARTED_MAX, gettingStartedSteps } from '@/lib/ui/getting-started';
import {
  HOME_PROFILE_LABELS,
  homeProfileFor,
  type Can,
  type HomeProfile,
} from '@/lib/ui/home-profile';
import { LOCAL_KEYS } from '@/lib/ui/local-store';
import type { RoleKey } from '@/types/domain';

/**
 * ホームの「はじめに」（plan §1.11 Beginner・§4 localStorage）と、通知の既読の即時反映（§1.18 Optimistic UI）。
 * - 役割別の 3 手順。権限の無い手順は出さない
 * - 閉じたら利用者ごとに記憶し、閉じた人には一瞬も出さない（読み込むまで描かない）
 * - 既読は押した時点で未読の印が消え、失敗したらサーバーの状態に戻る
 * - コメントは送った本文を「送信中」として先に出し、保存に成功してから入力欄を空にする
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/enterprise/dashboard',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const addComment = vi.fn(async (_formData: FormData) => {});
vi.mock('@/app/enterprise/actions', () => ({
  addCommentAction: (formData: FormData) => addComment(formData),
}));

const { GettingStarted } = await import('@/components/shared/getting-started');
const { CommentBox } = await import('@/components/shared/comment-box');
const { ShellProvider } = await import('@/components/shared/viewer-context');
const { NotificationList } = await import('@/app/(common)/notifications/notification-list');

function canOf(...roles: RoleKey[]): Can {
  const set = permissionsFor(roles);
  return (permission) => set.has(permission);
}

const context = { unitScopeIds: [], demo: true, disclosureFirst: false };

describe('「はじめに」の手順（役割別）', () => {
  it.each([
    [['site_contributor'], ['データを入力する', '資料を登録する', '差戻しを直す（データ）']],
    [['sustainability_manager'], ['取込を始める', '原稿を書く', '開示の状況を見る']],
    [['reviewer'], ['データを確認する', '原稿をレビューする', '集計を見る']],
    [
      ['approver', 'reviewer'],
      ['データを承認する', '原稿をレビューする', 'レポートを作る'],
    ],
    [['enterprise_admin'], ['報告年度を追加する', '拠点を追加する', 'メンバーを招待する']],
    [['viewer'], ['集計を見る', '現状診断を見る', '開示の状況を見る']],
  ] as Array<[RoleKey[], string[]]>)('%j → %j', (roles, labels) => {
    const can = canOf(...roles);
    const steps = gettingStartedSteps(homeProfileFor(can), can, context);
    expect(steps.map((s) => s.label)).toEqual(labels);
    expect(steps.length).toBeLessThanOrEqual(GETTING_STARTED_MAX);
  });

  it('権限の無い手順は出さない（どの役割でも、手順の行き先はその役割が使える動詞だけ）', () => {
    const profiles: HomeProfile[] = [
      'contributor',
      'preparer',
      'reviewer',
      'approver',
      'admin',
      'viewer',
    ];
    const none: Can = () => false;
    for (const profile of profiles) {
      for (const step of gettingStartedSteps(profile, none, context)) {
        // 権限を要しない手順（開示の状況を見る）だけが残る
        expect(step.key).toBe('see-disclosure-status');
      }
    }
  });

  it('「原稿を書く」は現在のプロジェクトの自分の原稿へ（無ければプロジェクトの一覧）', () => {
    const can = canOf('sustainability_manager');
    const withProject = gettingStartedSteps('preparer', can, {
      ...context,
      currentProjectId: 'proj-a',
    });
    expect(withProject.find((s) => s.key === 'write-manuscript')?.href).toBe(
      '/enterprise/disclosure-projects/proj-a?tab=manuscripts&filter=mine',
    );
    expect(
      gettingStartedSteps('preparer', can, context).find((s) => s.key === 'write-manuscript')?.href,
    ).toBe('/enterprise/disclosure-projects');
  });
});

describe('GettingStarted（閉じた印は端末ごと）', () => {
  const shell = {
    viewerKey: 'u-1:org-1',
    variant: 'enterprise' as const,
    workspace: 'enterprise' as const,
    hiddenHrefs: [],
    hiddenPermissions: [],
    permissions: [],
    defaultCollapsedGroups: [],
    verbContext: context,
    homeHref: '/enterprise/dashboard',
  };
  const steps = [
    { key: 'a', label: 'データを入力する', note: '未入力の値を入れる', href: '/enterprise/data' },
    { key: 'b', label: '資料を登録する', note: '根拠を登録する', href: '/enterprise/evidence' },
  ];

  beforeEach(() => window.localStorage.clear());

  it('役割の名前と番号つきの手順を出し、閉じると利用者ごとに記憶する', async () => {
    const { unmount } = render(
      <ShellProvider value={shell}>
        <GettingStarted profileLabel={HOME_PROFILE_LABELS.contributor} steps={steps} />
      </ShellProvider>,
    );
    const region = await screen.findByRole('region', { name: /はじめに/ });
    expect(region).toHaveTextContent('データを入力する人');
    expect(
      within(region)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['1.データを入力する未入力の値を入れる', '2.資料を登録する根拠を登録する']);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '「はじめに」を閉じる' }));
    });
    expect(screen.queryByRole('region', { name: /はじめに/ })).toBeNull();
    expect(window.localStorage.getItem(LOCAL_KEYS.gettingStarted('u-1:org-1'))).toBe('true');
    unmount();

    // 閉じた利用者には出さない。別の利用者には出す
    render(
      <ShellProvider value={shell}>
        <GettingStarted profileLabel="x" steps={steps} />
      </ShellProvider>,
    );
    await waitFor(() => expect(screen.queryByRole('region', { name: /はじめに/ })).toBeNull());
  });

  it('別の利用者（viewerKey 違い）には、閉じた印を持ち越さない', async () => {
    window.localStorage.setItem(LOCAL_KEYS.gettingStarted('u-1:org-1'), 'true');
    render(
      <ShellProvider value={{ ...shell, viewerKey: 'u-2:org-1' }}>
        <GettingStarted profileLabel="x" steps={steps} />
      </ShellProvider>,
    );
    expect(await screen.findByRole('region', { name: /はじめに/ })).toBeInTheDocument();
  });
});

describe('通知の既読（即時反映）', () => {
  const rows = [
    {
      id: 'n1',
      categoryLabel: 'タスク',
      title: '入力の依頼',
      body: null,
      href: '/enterprise/data',
      createdAtText: '2026/10/01 09:00',
      read: false,
    },
    {
      id: 'n2',
      categoryLabel: 'レビュー',
      title: '差戻し',
      body: '理由: 単位',
      href: null,
      createdAtText: '2026/10/02 10:00',
      read: false,
    },
  ];

  it('「既読にする」を押すと、応答を待たずにその通知の未読の印が消える', async () => {
    let finish: () => void = () => {};
    const markReadAction = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <NotificationList
        rows={rows}
        markReadAction={markReadAction}
        markAllReadAction={vi.fn(async () => {})}
        empty={<p>通知はありません</p>}
      />,
    );
    expect(screen.getAllByText('未読', { exact: true })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: '既読にする' })[0]!);
    await waitFor(() => expect(screen.getAllByText('未読', { exact: true })).toHaveLength(1));
    expect(markReadAction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /すべて既読にする（1）/ })).toBeInTheDocument();
    // 保存に失敗した（サーバーの状態が未読のまま）なら、応答のあとで元に戻る
    await act(async () => finish());
    await waitFor(() => expect(screen.getAllByText('未読', { exact: true })).toHaveLength(2));
  });
});

describe('コメントの送信中の表示（即時反映）', () => {
  it('送った本文を「送信中」の行としてすぐに出し、保存に成功したら入力欄を空にする', async () => {
    let finish: () => void = () => {};
    addComment.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <CommentBox
        targetType="data_point"
        targetId="dp-1"
        href="/enterprise/data/dp-1"
        members={[]}
      />,
    );
    const box = screen.getByPlaceholderText(/コメントを入力/);
    fireEvent.change(box, { target: { value: '単位を確認してください' } });
    fireEvent.click(screen.getByRole('button', { name: 'コメントする' }));
    const sending = await screen.findByText('単位を確認してください', {
      selector: '[data-t4d-comment-sending] span',
    });
    expect(sending.closest('li')).toHaveTextContent('送信中');
    expect(box).toHaveValue('単位を確認してください');
    await act(async () => finish());
    await waitFor(() => expect(box).toHaveValue(''));
    expect(document.querySelector('[data-t4d-comment-sending]')).toBeNull();
  });
});
