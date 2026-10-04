import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { importHistoryBreakdown, type ImportHistoryBatch } from '@/lib/imports/history-breakdown';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import type { QuantitativeImportHistoryItem } from '@/lib/services/quantitative-import';
import type { EnterpriseShell } from '@/lib/services/shell';
import type { AuthorizationContext } from '@/types/domain';

/**
 * 数値を登録の「取込の履歴」の帯（docs/disclosure-first.md §10.4 B6）。
 *  - 帯は重ならない区分だけ: 区分の合計 = 確定した取込の行数（除外した行はエラーの行の内数で、別の区分にしない）
 *  - 検証しただけ（未確定）の取込は台帳に書いていないため合計しない（検証し直すたびに新規が増えて見えない）
 */

const state = vi.hoisted(() => ({
  shell: null as unknown,
  history: [] as unknown[],
}));

vi.mock('@/lib/services/shell', () => ({
  loadEnterpriseShell: async () => state.shell,
}));
vi.mock('@/lib/services/quantitative-import', () => ({
  listQuantitativeImportBatches: async () => state.history,
}));
// 入力の部品は Client Component（Server Action・ブラウザの API を使う）。ここでは履歴だけを見る
vi.mock('@/app/enterprise/imports/standard/standard-import', () => ({
  StandardImport: () => null,
}));

const { default: StandardImportPage } = await import('@/app/enterprise/imports/standard/page');

function batch(
  status: ImportHistoryBatch['status'],
  counts: ImportHistoryBatch['counts'],
  excludedCount = 0,
): ImportHistoryBatch {
  return { status, counts, excludedCount };
}

/** 3 行（新規 2・エラー 1）を「正常行のみ登録」で確定し、同じファイルを検証し直して確定しなかった履歴 */
const VALID_ONLY_THEN_REVALIDATED = [
  batch('validated', { new: 0, changed: 0, unchanged: 2, error: 1 }),
  batch('committed', { new: 2, changed: 0, unchanged: 0, error: 1 }, 1),
];

describe('importHistoryBreakdown', () => {
  it('確定した取込だけを合計し、区分の合計が確定した行数と一致する（エラー＝除外を 2 回数えない）', () => {
    const result = importHistoryBreakdown(VALID_ONLY_THEN_REVALIDATED);
    expect(result.items.map((i) => [i.label, i.count])).toEqual([
      ['新規', 2],
      ['変更', 0],
      ['変更なし', 0],
      ['エラー（除外・未登録）', 1],
    ]);
    // 3 行のファイルは 3 行（7 行にならない）
    expect(result.totalRows).toBe(3);
    expect(result.items.reduce((sum, i) => sum + i.count, 0)).toBe(result.totalRows);
    expect(result.excludedRows).toBe(1);
    expect(result.committedBatches).toBe(1);
    expect(result.otherBatches).toBe(1);
  });

  it('同じファイルを 2 回検証して 1 回確定しても、新規は 1 回分', () => {
    const counts = { new: 10, changed: 0, unchanged: 0, error: 0 };
    const result = importHistoryBreakdown([
      batch('committed', counts),
      batch('validated', counts),
      batch('rejected', counts),
    ]);
    expect(result.items.find((i) => i.key === 'new')?.count).toBe(10);
    expect(result.otherBatches).toBe(2);
  });

  it('確定が無ければ行数は 0（検証のみの行を数えない）', () => {
    const result = importHistoryBreakdown([
      batch('validated', { new: 4, changed: 1, unchanged: 0, error: 2 }),
    ]);
    expect(result.committedBatches).toBe(0);
    expect(result.totalRows).toBe(0);
  });
});

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
  state.shell = {
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

function historyItem(
  id: string,
  b: ImportHistoryBatch,
  fileName = 'standard-metrics-sample-with-errors.csv',
): QuantitativeImportHistoryItem {
  return {
    id,
    fileName,
    status: b.status,
    statusLabel: b.status === 'committed' ? '確定済み' : '検証済み（未確定）',
    counts: { ...b.counts },
    excludedCount: b.excludedCount,
    createdAt: '2026-10-01T00:00:00.000Z',
    committedAt: b.status === 'committed' ? '2026-10-01T00:05:00.000Z' : null,
  };
}

/** 凡例（「ラベル」と「n 行」）を [ラベル, n] にする */
function legendOf(list: HTMLElement): Array<[string, number]> {
  return within(list)
    .getAllByRole('listitem')
    .map((item) => {
      const texts = [...item.children]
        .map((child) => child.textContent?.trim() ?? '')
        .filter((text) => text !== '');
      const count = texts.map((t) => /^(\d+) 行$/.exec(t)?.[1]).find(Boolean);
      const label = texts.find((t) => !/^\d+ 行$/.test(t)) ?? '';
      return [label, Number(count)] as [string, number];
    });
}

describe('数値を登録: 取込の履歴の帯', () => {
  it('確定した取込の行だけを重ならない区分で示し、凡例の合計 = 確定した行数', async () => {
    useShell();
    state.history = VALID_ONLY_THEN_REVALIDATED.map((b, i) => historyItem(`b${i}`, b));
    render(await StandardImportPage());
    const list = screen.getByRole('list', {
      name: '直近 2 件のうち確定した 1 件の取込の行の内訳',
    });
    const legend = legendOf(list);
    expect(legend).toEqual([
      ['新規', 2],
      ['変更', 0],
      ['変更なし', 0],
      ['エラー（除外・未登録）', 1],
    ]);
    expect(legend.reduce((sum, [, n]) => sum + n, 0)).toBe(3);
    // 「除外（未登録）」を別の区分として帯に重ねない
    expect(legend.map(([label]) => label)).not.toContain('除外（未登録）');
    expect(
      screen.getByText(/^確定した取込の 3 行の内訳です。エラーの 1 行は登録せずに除外しました。/)
        .textContent,
    ).toContain('検証のみ・未確定の 1 件は台帳に書いていないため数えていません。');
  });

  it('確定した取込が無ければ帯を出さず、検証のみの件数を数えない旨を書く', async () => {
    useShell();
    state.history = [
      historyItem('v1', batch('validated', { new: 10, changed: 0, unchanged: 0, error: 0 })),
    ];
    render(await StandardImportPage());
    expect(screen.queryByRole('list', { name: /取込の行の内訳$/ })).toBeNull();
    expect(
      screen.getByText(
        /^確定した取込はまだありません（検証のみ・未確定の 1 件は行数を合計しません）/,
      ),
    ).toBeTruthy();
  });
});
