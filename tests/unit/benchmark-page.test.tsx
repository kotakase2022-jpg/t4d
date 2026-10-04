import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import type { EnterpriseShell } from '@/lib/services/shell';
import type { AuthorizationContext } from '@/types/domain';

/**
 * 他社比較の表（docs/disclosure-first.md §9.5・§10.4）。Server Component をそのまま呼ぶ。
 * 行見出し（th scope=row）は指標名と単位だけにする。定義・注記の折りたたみを行見出しの中に置くと、
 * その文が行見出しの名前になり、表を読み上げで移動するたびに値より先に読まれるため、次の全幅の行に分ける。
 */

const shellState = vi.hoisted(() => ({ shell: null as unknown }));

vi.mock('@/lib/services/shell', () => ({
  loadEnterpriseShell: async () => shellState.shell,
}));

const { default: BenchmarkPage } = await import('@/app/enterprise/analysis/benchmark/page');

function useShell(): void {
  const fixture = createFixtureDb();
  const email = 'sustainability@demo.local';
  const ctx: AuthorizationContext = {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys: ['sustainability_manager'],
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
  shellState.shell = {
    db: new DemoDbClient(fixture),
    session: null as never,
    ctx,
    periods: fixture.periods.filter((p) => p.organizationId === ORG_IDS.aomi),
    currentPeriod: fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!,
    units: fixture.units.filter((u) => u.organizationId === ORG_IDS.aomi),
    metrics: fixture.metrics.filter((m) => m.organizationId === ORG_IDS.aomi),
    unreadNotifications: 0,
  } satisfies EnterpriseShell;
}

describe('他社比較の表', () => {
  it('行見出しは指標名と単位だけ。定義・注記は次の全幅の行に閉じて置き、どの指標のものかを名前に書く', async () => {
    useShell();
    render(await BenchmarkPage());
    const table = screen.getByRole('table', { name: /^架空の比較データ/ });
    const headers = within(table)
      .getAllByRole('rowheader')
      .filter((th) => th.getAttribute('scope') === 'row');
    expect(headers).toHaveLength(12);
    for (const header of headers) {
      expect(header.querySelector('details')).toBeNull();
    }
    const scope2 = headers.find((h) => h.textContent?.startsWith('Scope2（マーケット基準）'))!;
    expect(scope2.textContent).toBe('Scope2（マーケット基準）（t-CO2e）');

    const notesRow = scope2.closest('tr')!.nextElementSibling as HTMLElement;
    expect(notesRow.getAttribute('data-benchmark-notes')).toBe('scope2_market');
    const cell = notesRow.querySelector('td')!;
    // 全幅（指標・自社・比較先 5 社・比較できる社・中央値・範囲）
    expect(cell.getAttribute('colspan')).toBe('10');
    const details = cell.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toBe(
      'Scope2（マーケット基準） の定義・注記',
    );
    expect(details.textContent).toContain(
      'ロケーション基準とは別の指標です。読み替え・合算はしません。',
    );

    // 定義・注記の無い指標（Scope1）には注記の行を作らない
    const scope1 = headers.find((h) => h.textContent?.startsWith('Scope1'))!;
    expect(
      (scope1.closest('tr')!.nextElementSibling as HTMLElement | null)?.hasAttribute(
        'data-benchmark-notes',
      ),
    ).toBe(false);
  });
});
