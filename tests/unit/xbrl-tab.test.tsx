import { readFileSync } from 'node:fs';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { createFixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * 開示プロジェクトの「XBRL」タブ（トライアル対応 NF-42 の画面）。Fixture（架空）の FY2025 で描き、
 * 誠実さの注記・権限ごとの操作・空状態を確かめる（E2E の前に描画の誤りを見つける）。
 */

const shell: { db: DemoDbClient | null; ctx: AuthorizationContext | null } = {
  db: null,
  ctx: null,
};

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => `/enterprise/disclosure-projects/${IDS.projects.fy2025}`,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams('tab=xbrl'),
}));
vi.mock('@/lib/services/shell', () => ({
  loadEnterpriseShell: async () => ({ db: shell.db, ctx: shell.ctx }),
}));

function ctxFor(email: string, roleKeys: RoleKey[]): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: 'テスト',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

beforeEach(() => {
  shell.db = new DemoDbClient(createFixtureDb());
});

async function renderTab(
  ctx: AuthorizationContext,
  projectId: string = IDS.projects.fy2025,
  searchParams: Record<string, string> = { tab: 'xbrl' },
) {
  shell.ctx = ctx;
  const { XbrlTab } = await import('@/app/enterprise/disclosure-projects/[projectId]/_tabs/xbrl');
  return render(await XbrlTab({ projectId, searchParams }));
}

// Fixture 全体を作って描くため、並行の負荷が高いと既定の 5 秒を超えることがある
describe('XBRL タブ', { timeout: 30_000 }, () => {
  it('仮のタブの印（TRIAL-STUB）を消している', () => {
    const source = readFileSync(
      'src/app/enterprise/disclosure-projects/[projectId]/_tabs/xbrl.tsx',
      'utf8',
    );
    expect(source).not.toContain('TRIAL-STUB');
  });

  it('先頭に SAMPLE・提出用ではない注記（折りたたまない）、指標の帯・一覧・事実の一覧を出す', async () => {
    const { container } = await renderTab(
      ctxFor('sustainability@demo.local', ['sustainability_manager']),
    );
    const honesty = container.querySelector('[data-xbrl-honesty]')!;
    expect(honesty).not.toBeNull();
    expect(honesty.closest('details')).toBeNull();
    expect(honesty.textContent).toContain('提出用ではありません');
    expect(honesty.textContent).toContain('SAMPLE（架空）');
    expect(honesty.querySelector('[data-honesty="not-filing-ready"]')).not.toBeNull();
    expect(honesty.querySelector('[data-honesty="sample-master"]')).not.toBeNull();

    const strip = screen.getByRole('region', { name: 'XBRL の対応付けと検証' });
    expect(within(strip).getByText('事実の追跡')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: /XBRL の対応付け（4 件）/ })).toBeInTheDocument();
    expect(container.querySelectorAll('[data-status-domain="xbrlMapping"]').length).toBe(4);
    expect(screen.getByText('事実の一覧（3 件・追跡 3 / 3）')).toBeInTheDocument();
    // 出力の権限がある: プレビューのリンク（API・project 付き）
    const preview = screen.getByRole('link', { name: /インライン XBRL プレビュー（社内確認用）/ });
    expect(preview.getAttribute('href')).toMatch(
      new RegExp(
        `^/api/exports/xbrl/[^?]+\\?format=ixbrl_html&audience=internal&project=${IDS.projects.fy2025}`,
      ),
    );
    // 承認権限が無い人には一括の選択を出さない（主操作なし）
    expect(container.querySelector('[data-t4d-select]')).toBeNull();
    expect(container.querySelector('[data-variant="primary"]')).toBeNull();
  });

  it('出力の権限が無い人（レビュー担当）には出力のリンクを出さない', async () => {
    await renderTab(ctxFor('reviewer@demo.local', ['reviewer']));
    expect(screen.queryByRole('link', { name: /インライン XBRL プレビュー/ })).toBeNull();
    // 編集はできる（対応付けを追加）
    expect(screen.getByRole('link', { name: '対応付けを追加' })).toBeInTheDocument();
  });

  it('承認権限者は確定できる候補だけを選べる（選択 0 件では一括のバーを出さない）', async () => {
    const { container } = await renderTab(ctxFor('approver@demo.local', ['approver']));
    const boxes = [...container.querySelectorAll<HTMLInputElement>('input[data-t4d-select]')];
    expect(boxes.length).toBe(4);
    const enabled = boxes.filter((b) => !b.disabled);
    // 候補は Scope2 の 1 件（作成者は別の人・精度と軸あり）
    expect(enabled).toHaveLength(1);
    expect(enabled[0]!.getAttribute('data-row-status')).toBe('候補');
    expect(container.querySelector('[data-bulk-action-bar]')).toBeNull();
    // 承認権限だけの人は編集できない（対応付けを追加を出さない）
    expect(screen.queryByRole('link', { name: '対応付けを追加' })).toBeNull();
  });

  it('作成パネル（?new=1）は必須の節（対象・概念）を先に並べ、対象を選べる', async () => {
    await renderTab(
      ctxFor('sustainability@demo.local', ['sustainability_manager']),
      IDS.projects.fy2025,
      {
        tab: 'xbrl',
        new: '1',
      },
    );
    const panel = screen.getByRole('region', { name: 'XBRL の対応付けを追加（候補）' });
    const target = within(panel).getByLabelText(/T4D の対象/);
    expect(target).toBeRequired();
    expect(within(panel).getByLabelText(/概念（SAMPLE・架空）/)).toBeRequired();
    expect(
      within(target)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(expect.arrayContaining(['節: ガバナンス', '節: 指標及び目標']));
    expect(within(panel).getByRole('button', { name: '候補として保存' })).toBeInTheDocument();
  });

  it('スナップショットが無いプロジェクトは、出力タブへの空状態', async () => {
    const { container } = await renderTab(
      ctxFor('sustainability@demo.local', ['sustainability_manager']),
      IDS.projects.fy2026,
    );
    expect(screen.getByText('スナップショットがありません')).toBeInTheDocument();
    expect(container.querySelector('[data-empty-kind="no-data"]')).not.toBeNull();
    expect(screen.getByRole('link', { name: '出力タブを開く' })).toHaveAttribute(
      'href',
      `/enterprise/disclosure-projects/${IDS.projects.fy2026}?tab=outputs`,
    );
    // 注記はこの状態でも出す
    expect(container.querySelector('[data-xbrl-honesty]')).not.toBeNull();
  });

  it('出力 API から戻った理由（符号）と結果を、固定の文言で出す', async () => {
    await renderTab(
      ctxFor('sustainability@demo.local', ['sustainability_manager']),
      IDS.projects.fy2025,
      {
        tab: 'xbrl',
        xbrlError: 'blocked',
      },
    );
    expect(screen.getByRole('alert')).toHaveTextContent('検証（T4D の簡易検査）にエラーがある');
  });
});
