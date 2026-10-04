import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import type { EnterpriseShell } from '@/lib/services/shell';
import type { AuthorizationContext, RoleKey, Uuid } from '@/types/domain';

/**
 * 財務影響分析のページ（docs/disclosure-first.md §10.3）。Server Component をそのまま呼ぶ。
 * 報告期間の状態は画面の表記（「クローズ」）で書き、DB の値（closed）をそのまま見せない。
 */

const shellState = vi.hoisted(() => ({ shell: null as unknown }));

vi.mock('@/lib/services/shell', () => ({
  loadEnterpriseShell: async () => shellState.shell,
}));

const { default: FinancialImpactPage } =
  await import('@/app/enterprise/analysis/financial-impact/page');

function useShell(organizationId: Uuid, email: string, roleKeys: RoleKey[], periodId: Uuid): void {
  const fixture = createFixtureDb();
  const ctx: AuthorizationContext = {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType: 'enterprise',
      organizationName: 'テスト',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
  shellState.shell = {
    db: new DemoDbClient(fixture),
    session: null as never,
    ctx,
    periods: fixture.periods.filter((p) => p.organizationId === organizationId),
    currentPeriod: fixture.periods.find((p) => p.id === periodId)!,
    units: fixture.units.filter((u) => u.organizationId === organizationId),
    metrics: fixture.metrics.filter((m) => m.organizationId === organizationId),
    unreadNotifications: 0,
  } satisfies EnterpriseShell;
}

const renderPage = async () =>
  render(await FinancialImpactPage({ searchParams: Promise.resolve({}) }));

describe('財務影響分析のページ', () => {
  it('締め済みの期間が無い組織: 空の状態は「締め済み（クローズ）」と書き、closed をそのまま出さない', async () => {
    useShell(
      ORG_IDS.soten,
      'other-enterprise-admin@demo.local',
      ['enterprise_admin'],
      PERIOD_IDS.sotenFy2026,
    );
    const { container } = await renderPage();
    expect(screen.getByText('基準年度がありません')).toBeTruthy();
    expect(
      screen.getByText(
        'ヘッダーの年度（FY2026）以前に、締め済み（クローズ）の報告期間がありません。起点の確定値を決められないため試算しません。',
      ),
    ).toBeTruthy();
    // 「この画面について」（閉じた説明）も同じ表記
    expect(container.textContent).toContain('以前で締め済み（クローズ）の最新の報告期間です。');
    expect(container.textContent).not.toMatch(/closed/i);
  });
});
