import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { permissionsFor } from '@/lib/authorization/can';
import { COMMENT_MAX_LENGTH } from '@/lib/domain/comment-limits';
import { addDismissedViewer, parseDismissedViewers } from '@/lib/ui/getting-started';
import { OPEN_CONFIRM_EVENT, sameScreenConfirmId, type MenuActionSpec } from '@/lib/ui/actions';
import { sanitizeRecentHref } from '@/lib/ui/recent';
import type { RoleKey } from '@/types/domain';

/**
 * UI シンプル化・UX 再設計（5cb0d11）の検証で確定した所見の回帰テスト（画面の部品）。
 * いずれも修正前の部品では失敗する（＝欠陥を捉えている）。
 */

const push = vi.fn();
let pathname = '/enterprise/dashboard';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/app/enterprise/evidence/actions', () => ({
  uploadEvidenceDocumentFormAction: vi.fn(async () => ({
    status: 'idle',
    message: null,
    values: null,
  })),
}));
vi.mock('@/app/enterprise/narratives/actions', () => ({
  confirmNarrativeAction: vi.fn(),
  createAnchorAction: vi.fn(),
  createNarrativeAction: vi.fn(),
  loadFragmentsAction: vi.fn(async () => []),
  saveNarrativeAction: vi.fn(),
}));

const { ConfirmDialog } = await import('@/components/shared/confirm-dialog');
const { MoreMenu } = await import('@/components/shared/more-menu');
const { CommandPalette, OPEN_PALETTE_EVENT } = await import('@/components/shared/command-palette');
const { ShellProvider } = await import('@/components/shared/viewer-context');
const { RecordShortcuts, goShortcutTargets } = await import('@/components/shared/record-shortcuts');
const { visibleShortcuts } = await import('@/components/shared/help-dialog');
const { GettingStarted } = await import('@/components/shared/getting-started');
const { SubmitButton } = await import('@/components/ui/submit-button');
const { MetricTile } = await import('@/components/shared/metric-strip');
const { DataTable } = await import('@/components/shared/data-table');
const { CreatePanelFocus } = await import('@/components/shared/create-panel-focus');
const { EvidenceUploadForm } = await import('@/app/enterprise/evidence/evidence-upload-form');
const { NarrativeEditor } =
  await import('@/app/enterprise/narratives/_components/narrative-editor');
const { homeProfileFor } = await import('@/lib/ui/home-profile');

function shellFor(roles: RoleKey[], viewerKey = `u-${roles.join('-')}:org-1`) {
  const permissions = [...permissionsFor(roles)];
  return {
    viewerKey,
    variant: 'enterprise' as const,
    workspace: 'enterprise' as const,
    hiddenHrefs: [],
    hiddenPermissions: [],
    permissions,
    profile: homeProfileFor((p) => permissions.includes(p)),
    defaultCollapsedGroups: [],
    verbContext: { unitScopeIds: [], demo: true, disclosureFirst: true },
    homeHref: '/enterprise/dashboard',
  };
}

beforeEach(() => {
  push.mockReset();
  pathname = '/enterprise/dashboard';
  window.localStorage.clear();
  document.cookie = 't4d_gs_dismissed=; max-age=0; path=/';
});

// ----------------------------------------------------------------------
// BIZ-1・BIZ-2 理由欄の上限
// ----------------------------------------------------------------------

describe('BIZ-1 確認ダイアログの理由欄は、サーバーと同じ上限で入力を止める', () => {
  it('reason.maxLength を textarea の maxlength に出す', () => {
    render(
      <ConfirmDialog
        tier="bulk"
        title="差し戻しますか"
        scope="範囲"
        reason={{
          name: 'comment',
          label: '差戻し理由',
          required: true,
          maxLength: COMMENT_MAX_LENGTH,
        }}
        confirmLabel="差し戻す"
        action={async () => {}}
        defaultOpen
      />,
    );
    expect(screen.getByLabelText(/差戻し理由/)).toHaveAttribute(
      'maxlength',
      String(COMMENT_MAX_LENGTH),
    );
  });
});

// ----------------------------------------------------------------------
// F2（UX・持ち回り） パレットから同じ画面の ?confirm= を開く
// ----------------------------------------------------------------------

describe('F2 「その他」の確認ダイアログは、同じ画面のまま ?confirm= が変わっても開く', () => {
  const items: MenuActionSpec[] = [
    {
      kind: 'confirm',
      id: 'reset-demo',
      label: 'デモを初期状態に戻す',
      action: async () => {},
      confirm: {
        tier: 'irreversible',
        title: 'デモを戻しますか',
        scope: '開示デモのデータ',
        confirmLabel: '戻す',
      },
    },
  ];

  it('openConfirmId が後から渡されたら開く（同じ部品のまま。Next は検索条件だけの遷移で作り直さない）', () => {
    const { rerender } = render(<MoreMenu items={items} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(<MoreMenu items={items} openConfirmId="reset-demo" />);
    expect(screen.getByRole('dialog', { name: /デモを戻しますか/ })).toBeInTheDocument();
  });

  it('閉じたあと、同じ URL のまま（props が変わらない）パレットから頼まれても開く', async () => {
    render(<MoreMenu items={items} openConfirmId="reset-demo" />);
    const dialog = screen.getByRole('dialog', { name: /デモを戻しますか/ });
    act(() => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_CONFIRM_EVENT, { detail: 'reset-demo' }));
    });
    expect(screen.getByRole('dialog', { name: /デモを戻しますか/ })).toBeInTheDocument();
  });

  it('知らない項目の依頼では開かない', () => {
    render(<MoreMenu items={items} />);
    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_CONFIRM_EVENT, { detail: 'other' }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('同じ画面の ?confirm= だけを「その場で開く」対象にする', () => {
    expect(
      sameScreenConfirmId('/enterprise/dashboard?confirm=reset-demo', '/enterprise/dashboard'),
    ).toBe('reset-demo');
    expect(
      sameScreenConfirmId('/enterprise/dashboard?confirm=reset-demo', '/enterprise/data'),
    ).toBe(null);
    expect(sameScreenConfirmId('/enterprise/dashboard?tab=esg', '/enterprise/dashboard')).toBe(
      null,
    );
  });

  it('パレットで同じ画面の ?confirm= を選ぶと、移ったうえでその画面へ開くよう頼む', async () => {
    const requested = vi.fn();
    const listener = (event: Event) => requested((event as CustomEvent<string>).detail);
    window.addEventListener(OPEN_CONFIRM_EVENT, listener);
    const searchAction = vi.fn(async () => ({
      entries: [
        {
          id: 'data:操作:reset',
          group: 'data' as const,
          label: 'zzqq デモを初期状態に戻す',
          href: '/enterprise/dashboard?confirm=reset-demo',
          hint: '操作',
        },
      ],
    }));
    render(
      <ShellProvider value={shellFor(['sustainability_manager'])}>
        <CommandPalette variant="enterprise" hiddenHrefs={[]} searchAction={searchAction} />
      </ShellProvider>,
    );
    act(() => {
      window.dispatchEvent(new Event(OPEN_PALETTE_EVENT));
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'コマンドパレット検索' }), {
      target: { value: 'zzqq' },
    });
    const option = await screen.findByRole('option', { name: /zzqq デモを初期状態に戻す/ });
    act(() => {
      fireEvent.click(option);
    });
    expect(push).toHaveBeenCalledWith('/enterprise/dashboard?confirm=reset-demo');
    await waitFor(() => expect(requested).toHaveBeenCalledWith('reset-demo'));
    window.removeEventListener(OPEN_CONFIRM_EVENT, listener);
  });
});

// ----------------------------------------------------------------------
// SEC-3 パレットを閉じたら入力と検索結果を捨てる
// ----------------------------------------------------------------------

describe('SEC-3 パレットは閉じたら入力とデータの検索結果を持ち越さない', () => {
  it('閉じて開き直すと、前の検索の行（管理者だけのメンバーなど）が残らない', async () => {
    const searchAction = vi.fn(async () => ({
      entries: [
        {
          id: 'data:メンバー:u1',
          group: 'data' as const,
          label: '海野 さくら（umino@demo.local）',
          href: '/enterprise/settings?tab=members',
          hint: 'メンバー',
        },
      ],
    }));
    render(
      <ShellProvider value={shellFor(['enterprise_admin'])}>
        <CommandPalette variant="enterprise" hiddenHrefs={[]} searchAction={searchAction} />
      </ShellProvider>,
    );
    act(() => {
      window.dispatchEvent(new Event(OPEN_PALETTE_EVENT));
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'コマンドパレット検索' }), {
      target: { value: '海野' },
    });
    await screen.findByRole('option', { name: /海野 さくら/ });

    // Esc で閉じる（選ばずに閉じる）
    act(() => {
      fireEvent.keyDown(screen.getByRole('combobox', { name: 'コマンドパレット検索' }), {
        key: 'Escape',
      });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    act(() => {
      window.dispatchEvent(new Event(OPEN_PALETTE_EVENT));
    });
    expect(screen.getByRole('combobox', { name: 'コマンドパレット検索' })).toHaveValue('');
    expect(screen.queryByRole('option', { name: /海野 さくら/ })).toBeNull();
  });
});

// ----------------------------------------------------------------------
// F6（回帰） g の近道は開ける画面だけ
// ----------------------------------------------------------------------

describe('F6 g の近道は、権限なしの画面へ移さない（ヘルプにも出さない）', () => {
  const can = (roles: RoleKey[]) => {
    const set = permissionsFor(roles);
    return (p: Parameters<typeof set.has>[0]) => set.has(p);
  };

  it('拠点担当（開示の閲覧権限なし）には g → c（CSRD）を出さない', () => {
    const site = goShortcutTargets('/enterprise/dashboard', can(['site_contributor']));
    expect(site.c).toBeUndefined();
    // 行き先の判定は ROUTE_CATALOG のページのゲートと同じ（SSBJ 対応状況は閲覧のゲートを持たない。plan Q3）
    expect(site.s).toBe('/enterprise/disclosures/ssbj');
    expect(site.d).toBe('/enterprise/data');
    expect(site.h).toBe('/enterprise/dashboard');
    const keys = visibleShortcuts(site).map((s) => s.keys);
    expect(keys).not.toContain('g → c');
    expect(keys).toContain('g → d');
    expect(keys).toContain('j / k');

    const manager = goShortcutTargets('/enterprise/dashboard', can(['sustainability_manager']));
    expect(manager.c).toBe('/enterprise/disclosures/csrd');
  });

  it('監査法人はホームだけ', () => {
    expect(goShortcutTargets('/assurance/dashboard', () => true)).toEqual({
      h: '/assurance/dashboard',
    });
  });

  it('拠点担当が g → c を押しても移らない。作成担当は CSRD 対応状況へ移る', () => {
    const press = () => {
      act(() => {
        fireEvent.keyDown(window, { key: 'g' });
        fireEvent.keyDown(window, { key: 'c' });
      });
    };
    const { unmount } = render(
      <ShellProvider value={shellFor(['site_contributor'])}>
        <RecordShortcuts />
      </ShellProvider>,
    );
    press();
    expect(push).not.toHaveBeenCalled();
    unmount();

    render(
      <ShellProvider value={shellFor(['sustainability_manager'])}>
        <RecordShortcuts />
      </ShellProvider>,
    );
    press();
    expect(push).toHaveBeenCalledWith('/enterprise/disclosures/csrd');
  });
});

// ----------------------------------------------------------------------
// F7（回帰）・F5（UX）・F7（持ち回り） 「はじめに」は読み込み後に差し込まない
// ----------------------------------------------------------------------

describe('「はじめに」は最初の描画から出し分ける（読み込み後に本文をずらさない）', () => {
  const steps = [
    { key: 'a', label: 'データを入力する', note: '未入力の値を入れる', href: '/enterprise/data' },
  ];
  const shell = shellFor(['site_contributor'], 'u-1:org-1');

  it('サーバーの描画に含まれる（閉じていない人）／含まれない（閉じた人）', () => {
    const open = renderToString(
      <ShellProvider value={shell}>
        <GettingStarted profileLabel="入力する人" steps={steps} />
      </ShellProvider>,
    );
    expect(open).toContain('data-getting-started');
    const dismissed = renderToString(
      <ShellProvider value={shell}>
        <GettingStarted profileLabel="入力する人" steps={steps} initiallyDismissed />
      </ShellProvider>,
    );
    expect(dismissed).not.toContain('data-getting-started');
  });

  it('閉じると、サーバーが読める Cookie にも利用者ごとに残す', () => {
    render(
      <ShellProvider value={shell}>
        <GettingStarted profileLabel="入力する人" steps={steps} />
      </ShellProvider>,
    );
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '「はじめに」を閉じる' }));
    });
    const cookie = document.cookie
      .split('; ')
      .find((c) => c.startsWith('t4d_gs_dismissed='))
      ?.slice('t4d_gs_dismissed='.length);
    expect(parseDismissedViewers(cookie)).toEqual(['u-1:org-1']);
  });

  it('Cookie の値は利用者の鍵だけを受け付け、重ねず、上限で古いものを捨てる', () => {
    let value = '';
    for (let i = 0; i < 25; i += 1) value = addDismissedViewer(value, `u-${i}:org-1`);
    value = addDismissedViewer(value, 'u-24:org-1');
    const keys = parseDismissedViewers(value);
    expect(keys).toHaveLength(20);
    expect(keys.at(-1)).toBe('u-24:org-1');
    expect(new Set(keys).size).toBe(keys.length);
    expect(parseDismissedViewers('u-1:org-1.<script>.;x')).toEqual(['u-1:org-1']);
  });
});

// ----------------------------------------------------------------------
// F9（UX） SubmitButton の aria-busy
// ----------------------------------------------------------------------

describe('F9 SubmitButton は呼び出し側の aria-busy を上書きしない', () => {
  it('onSubmit で自前に送るフォームの「検証中」を読み上げに伝える', () => {
    const { rerender } = render(
      <form onSubmit={(e) => e.preventDefault()}>
        <SubmitButton aria-busy={true}>検証</SubmitButton>
      </form>,
    );
    expect(screen.getByRole('button', { name: '検証' })).toHaveAttribute('aria-busy', 'true');
    rerender(
      <form onSubmit={(e) => e.preventDefault()}>
        <SubmitButton aria-busy={false}>検証</SubmitButton>
      </form>,
    );
    expect(screen.getByRole('button', { name: '検証' })).not.toHaveAttribute('aria-busy', 'true');
  });
});

// ----------------------------------------------------------------------
// F7（UX） タイルの補足は折り返して全文を出す
// ----------------------------------------------------------------------

describe('F7 MetricTile の補足（何を数えたか）は省略記号で切らない', () => {
  it('補足に truncate を付けない', () => {
    const hint = '本文・引用した定性情報の必須項目・要対応コメント・適用判断に不足がある原稿';
    render(<MetricTile label="不足がある原稿" value={3} hint={hint} />);
    const element = screen.getByText(hint);
    expect(element.className).not.toContain('truncate');
    expect(element.className).not.toContain('line-clamp');
  });
});

// ----------------------------------------------------------------------
// F6（UX） 左に固定した列の見出しは、横に流れる見出しの上
// ----------------------------------------------------------------------

describe('F6 DataTable の固定した列の見出しは、他の見出しより上に重ねる', () => {
  interface Row {
    id: string;
    name: string;
    status: string;
  }
  const columns = [
    {
      key: 'metric',
      header: '指標',
      importance: 'primary' as const,
      lockVisible: true,
      pinned: 'left' as const,
      cell: (r: Row) => r.name,
    },
    { key: 'status', header: '状態', importance: 'primary' as const, cell: (r: Row) => r.status },
  ];
  const rows: Row[] = [{ id: 'a', name: '電力使用量', status: '入力中' }];

  it.each([
    ['選択なし', undefined],
    ['選択あり', { formId: 'bulk-form' }],
  ])('%s', (_label, selection) => {
    const { container } = render(
      <DataTable
        id="pinned"
        caption="固定列"
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        getRowLabel={(r) => r.name}
        searchParams={{}}
        basePath="/enterprise/data"
        selection={selection}
        empty={{ noData: { title: '無し', action: null } }}
      />,
    );
    const pinned = container.querySelector('th[data-column-key="metric"]')!;
    const other = container.querySelector('th[data-column-key="status"]')!;
    expect(pinned.className).toContain('z-(--z-sticky-corner)');
    expect(other.className).not.toContain('z-(--z-sticky-corner)');
    if (selection) {
      expect(container.querySelector('th[data-select-column]')!.className).toContain(
        'z-(--z-sticky-corner)',
      );
    }
  });
});

// ----------------------------------------------------------------------
// F6（持ち回り） 一括バーの件数・内訳は、行が消えた・変わったら数え直す
// ----------------------------------------------------------------------

describe('F6 一括バーは、再検証で行が消えた・状態が変わったら数え直す', () => {
  interface Row {
    id: string;
    name: string;
    status: string;
  }
  const columns = [
    {
      key: 'metric',
      header: '指標',
      importance: 'primary' as const,
      cell: (r: Row) => r.name,
    },
  ];
  const table = (rows: Row[]) => (
    <DataTable
      id="bulk"
      caption="一括"
      columns={columns}
      rows={rows}
      getRowId={(r) => r.id}
      getRowLabel={(r) => r.name}
      getRowStatus={(r) => r.status}
      searchParams={{}}
      basePath="/enterprise/data"
      selection={{ formId: 'bulk-form' }}
      bulkActions={[{ id: 'review', label: 'レビューへ' }]}
      empty={{ noData: { title: '無し', action: null } }}
    />
  );

  it('選んだ行が絞り込みから外れて消えたら、バーを閉じる（古い件数のまま残さない）', async () => {
    const { rerender } = render(
      table([
        { id: 'a', name: '電力使用量', status: '提出済み' },
        { id: 'b', name: '水使用量', status: '提出済み' },
      ]),
    );
    act(() => {
      fireEvent.click(screen.getByRole('checkbox', { name: '電力使用量 を選択' }));
    });
    expect(screen.getByRole('region', { name: '一括操作' })).toHaveTextContent(
      '1 件を選択中（提出済み 1）',
    );
    rerender(table([{ id: 'b', name: '水使用量', status: '提出済み' }]));
    await waitFor(() => expect(screen.queryByRole('region', { name: '一括操作' })).toBeNull());
  });

  it('選んだ行の状態が変わったら、内訳を今の状態にする', async () => {
    const { rerender } = render(table([{ id: 'a', name: '電力使用量', status: '提出済み' }]));
    act(() => {
      fireEvent.click(screen.getByRole('checkbox', { name: '電力使用量 を選択' }));
    });
    rerender(table([{ id: 'a', name: '電力使用量', status: 'レビュー中' }]));
    await waitFor(() =>
      expect(screen.getByRole('region', { name: '一括操作' })).toHaveTextContent(
        '1 件を選択中（レビュー中 1）',
      ),
    );
  });
});

// ----------------------------------------------------------------------
// F4（UX） 作成パネルを開いたらフォーカスを移す
// ----------------------------------------------------------------------

describe('F4 作成パネルを開くリンクが消えても、フォーカスを本文の外へ落とさない', () => {
  function Page({ open }: { open: boolean }) {
    return (
      <main id="t4d-main">
        {!open && (
          <a href="?new=1" data-t4d-shortcut="new">
            資料を登録
          </a>
        )}
        {open && (
          <section>
            <h2 id="panel-title" tabIndex={-1}>
              資料を登録
            </h2>
            <CreatePanelFocus headingId="panel-title" />
          </section>
        )}
      </main>
    );
  }

  it('開いたらパネルの見出しへ、閉じたら作成の入口へ戻す', async () => {
    const { rerender } = render(<Page open={false} />);
    screen.getByRole('link', { name: '資料を登録' }).focus();
    rerender(<Page open />);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '資料を登録' }));

    rerender(<Page open={false} />);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('link', { name: '資料を登録' })),
    );
  });

  it('利用者が別の場所にフォーカスを置いていれば動かさない', () => {
    const { rerender } = render(
      <>
        <input aria-label="検索" />
        <Page open={false} />
      </>,
    );
    screen.getByRole('textbox', { name: '検索' }).focus();
    rerender(
      <>
        <input aria-label="検索" />
        <Page open />
      </>,
    );
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '検索' }));
  });
});

// ----------------------------------------------------------------------
// BIZ-4 ファイルを選び直したら、推定のままの属性を置き換える
// ----------------------------------------------------------------------

describe('BIZ-4 資料の登録で、前のファイルの推定を残さない', () => {
  function renderForm() {
    const { container } = render(
      <EvidenceUploadForm
        qualitative={false}
        disclosureFirst
        periods={[{ id: 'p1', code: 'FY2026' }]}
        currentPeriodId="p1"
        extensions={[]}
        confidentialityLabels={{
          public: '公開',
          internal: '社内',
          confidential: '機密',
          restricted: '極秘',
        }}
      />,
    );
    const file = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const choose = (name: string) =>
      act(() => {
        fireEvent.change(file, { target: { files: [new File(['x'], name)] } });
      });
    return {
      container,
      choose,
      type: container.querySelector<HTMLInputElement>('input[name="documentType"]')!,
      issued: container.querySelector<HTMLInputElement>('input[name="issuedOn"]')!,
    };
  }

  it('人が直していない欄は新しいファイルの推定に置き換え、推定が無ければ空に戻す', () => {
    const { choose, type, issued } = renderForm();
    choose('請求書_20260630.pdf');
    expect(type.value).toBe('請求書');
    expect(issued.value).toBe('2026-06-30');

    choose('取締役会議事録.pdf');
    expect(type.value).toBe('議事録');
    expect(issued.value).toBe('');
  });

  it('人が書き換えた欄は残す', () => {
    const { choose, type, issued } = renderForm();
    choose('請求書_20260630.pdf');
    fireEvent.change(type, { target: { value: '検針票' } });
    type.value = '検針票';
    choose('取締役会議事録_20260701.pdf');
    expect(type.value).toBe('検針票');
    expect(issued.value).toBe('2026-07-01');
  });

  it('推定を入れたら属性の節を開く（確かめずに登録させない）', () => {
    const { container, choose } = renderForm();
    const section = [...container.querySelectorAll('details')].find((d) =>
      d.textContent?.includes('② 資料の属性'),
    )!;
    expect(section.open).toBe(false);
    choose('請求書_20260630.pdf');
    expect(section.open).toBe(true);
  });
});

// ----------------------------------------------------------------------
// F3（UX） 定性情報の「詳細項目」は入力中に閉じない
// ----------------------------------------------------------------------

describe('F3 定性情報の「詳細項目」は、最後の値を消しても閉じない', () => {
  it('開いて入力 → 消す、で節が開いたまま（入力中の欄を隠さない）', () => {
    const { container } = render(
      <NarrativeEditor
        mode="create"
        baseVersionId={null}
        theme="governance"
        themes={[{ value: 'governance', label: 'ガバナンス' }]}
        templateFieldsByTheme={{ governance: [{ key: 'body1', label: '体制' }] }}
        detailFieldsByTheme={{ governance: [{ key: 'detail1', label: '詳細 1' }] }}
        initial={{
          title: '',
          ownerDepartment: '',
          tags: '',
          reportingPeriodId: 'p1',
          scopeNote: '',
          fields: {},
          body: '',
          anchors: [],
        }}
        periods={[{ id: 'p1', code: 'FY2026' }]}
        documents={[]}
        initialDocumentId={null}
        usage={[]}
        canWrite
        noAmountNote=""
        currentConfirmed={false}
        isCandidate={false}
      />,
    );
    const details = [...container.querySelectorAll('details')].find((d) =>
      d.textContent?.includes('詳細項目'),
    )!;
    expect(details.open).toBe(false);
    details.open = true;
    const field = container.querySelector<HTMLTextAreaElement>('#nv-d-detail1')!;
    act(() => {
      fireEvent.change(field, { target: { value: 'あ' } });
    });
    act(() => {
      fireEvent.change(field, { target: { value: '' } });
    });
    expect(details.open).toBe(true);
  });
});

// ----------------------------------------------------------------------
// F5（持ち回り） 最近の画面に一度きりの引数を残さない
// ----------------------------------------------------------------------

describe('F5 最近使った画面から開き直しても、確認ダイアログ・通知を出し直さない', () => {
  it('?confirm= ・作成欄・出力の通知・合言葉を外し、絞り込み・タブは残す', () => {
    expect(sanitizeRecentHref('/enterprise/dashboard', '?confirm=reset-demo&tab=esg')).toBe(
      '/enterprise/dashboard?tab=esg',
    );
    expect(
      sanitizeRecentHref(
        '/enterprise/disclosure-projects/p',
        '?tab=outputs&snapshotCreated=3&kind=approved',
      ),
    ).toBe('/enterprise/disclosure-projects/p?tab=outputs');
    expect(sanitizeRecentHref('/enterprise/evidence', '?new=1&status=draft')).toBe(
      '/enterprise/evidence?status=draft',
    );
    expect(sanitizeRecentHref('/login', '?error=x&et=abc')).toBe('/login');
  });

  it('通知に添えた引数は、通知と一緒のときだけ外す', () => {
    expect(
      sanitizeRecentHref('/enterprise/settings', '?tab=grants&flash=grantRevoked&grantId=g1'),
    ).toBe('/enterprise/settings?tab=grants');
    expect(sanitizeRecentHref('/enterprise/ssbj/draft', '?version=2')).toBe(
      '/enterprise/ssbj/draft?version=2',
    );
  });
});
