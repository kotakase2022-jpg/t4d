import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAiProviderForTesting } from '@/lib/ai';
import { MockAIProvider } from '@/lib/ai/mock-provider';
import { FIXTURE_TODAY } from '@/lib/config';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { SSBJ_FRAMEWORK_INFO } from '@/lib/frameworks/ssbj-2026';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { loadDisclosureHome } from '@/lib/services/disclosure-home';
import type { EnterpriseShell } from '@/lib/services/shell';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * ホーム（従来・開示業務）と SSBJ の画面の文字量削減（docs/disclosure-first.md §10.4 B3）。
 * Server Component をそのまま呼び、Fixture の DB で描画する（Action は呼ばない）。
 *
 * - 説明・注記・補助表・履歴は既定で閉じる（閉じた中にあることを確かめる）
 * - 誠実さの注記（正式基準・転載許可・草案である）・主要数値・確認とその範囲は閉じない
 * - 件数の帯は重ならない区分だけで作り、区分の合計が分母と一致する（重なる件数は帯の外）
 */

const shellState = vi.hoisted(() => ({ shell: null as unknown }));

vi.mock('@/lib/services/shell', () => ({
  loadEnterpriseShell: async () => shellState.shell,
}));
vi.mock('@/app/enterprise/actions', () => ({
  runSsbjGapAnalysisBulkAction: vi.fn(),
  createSsbjDataCollectionAction: vi.fn(),
  updateSsbjActionPlanAction: vi.fn(),
  generateSsbjDraftAction: vi.fn(),
  saveSsbjDraftAction: vi.fn(),
  confirmSsbjDraftAction: vi.fn(),
}));
vi.mock('@/app/enterprise/dashboard/actions', () => ({ resetDisclosureDemoAction: vi.fn() }));
vi.mock('@/components/shared/filter-bar', () => ({
  FilterBar: ({ total }: { total: number }) => <p data-testid="filter-bar">{total} 件</p>,
}));

const { default: SsbjPage } = await import('@/app/enterprise/disclosures/ssbj/page');
const { default: SsbjRequirementsPage } =
  await import('@/app/enterprise/disclosures/ssbj/requirements/page');
const { default: SsbjPlansPage } = await import('@/app/enterprise/disclosures/ssbj/plans/page');
const { default: SsbjCollectionPage } =
  await import('@/app/enterprise/disclosures/ssbj/collection/page');
const { default: SsbjDraftPage } = await import('@/app/enterprise/disclosures/ssbj/draft/page');
const { LegacyHomeBody } = await import('@/app/enterprise/dashboard/legacy-home');
const { DemoResetCard, DisclosureHomeView } =
  await import('@/app/enterprise/dashboard/disclosure-home-view');

let fixture: FixtureDb;
let db: DemoDbClient;

function ctxFor(email: string, roleKeys: RoleKey[]): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);

/** 当期は FY2026。マテリアリティの課題（Fixture）は FY2025 にだけあるため、表を見るときは FY2025 を渡す */
function shellFor(
  ctx: AuthorizationContext,
  periodId: string = PERIOD_IDS.fy2026,
): EnterpriseShell {
  const organizationId = ctx.workspace.organizationId;
  return {
    db,
    session: null as never,
    ctx,
    periods: fixture.periods.filter((p) => p.organizationId === organizationId),
    currentPeriod: fixture.periods.find((p) => p.id === periodId)!,
    units: fixture.units
      .filter((u) => u.organizationId === organizationId && u.deletedAt === null)
      .sort((a, b) => a.sortOrder - b.sortOrder),
    metrics: fixture.metrics.filter((m) => m.organizationId === organizationId),
    unreadNotifications: 0,
  };
}

type Query = Record<string, string>;
const renderPage = async (
  Page: (props: { searchParams: Promise<Query> }) => Promise<React.ReactElement>,
  query: Query = {},
) => render(await Page({ searchParams: Promise.resolve(query) }));

/** 閉じていない（details の外にある）。誠実さの注記・主要数値・確認とその範囲に使う */
function expectOutsideDetails(element: Element): void {
  expect(element.closest('details')).toBeNull();
}

/** 既定で閉じた折りたたみの中にあり、その要点の 1 行が summary であること */
function expectInClosedDetails(element: Element, summary: string | RegExp): void {
  const details = element.closest('details');
  expect(details, '折りたたみの中にない').not.toBeNull();
  expect(details!.open).toBe(false);
  // 入れ子の内側の summary を拾わないよう、自分の直下の summary だけを見る
  const ownSummary = Array.from(details!.children).find((child) => child.tagName === 'SUMMARY');
  const label = ownSummary?.querySelector('[data-collapsible-summary]')?.textContent ?? '';
  if (typeof summary === 'string') expect(label).toBe(summary);
  else expect(label).toMatch(summary);
}

/** 状態の内訳の凡例（「ラベル n / N 単位」）を [ラベル, n, N] にする */
function breakdownOf(list: HTMLElement, unit = '件'): Array<[string, number, number]> {
  return within(list)
    .getAllByRole('listitem')
    .map((item) => {
      const text = item.textContent ?? '';
      const match = text.match(new RegExp(`^(.+?)(\\d+) / (\\d+) ${unit}$`));
      expect(match, text).not.toBeNull();
      return [match![1]!, Number(match![2]), Number(match![3])];
    });
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  shellState.shell = shellFor(manager());
  setAiProviderForTesting(new MockAIProvider());
});

afterEach(() => {
  setAiProviderForTesting(null);
});

describe('SSBJ 対応状況', () => {
  it('8 枚のカードを 1 本の帯（6 区分の合計 = 全要求事項）にし、確認待ちは帯の外に分母付きで残す', async () => {
    await renderPage(SsbjPage);
    const list = screen.getByRole('list', { name: '全要求事項の内訳' });
    const rows = breakdownOf(list);
    expect(rows.map(([label]) => label)).toEqual([
      '対応済み',
      'おおむね対応',
      '一部対応',
      '未対応',
      '重要性なし',
      '対象外',
    ]);
    const total = rows[0]![2];
    for (const [, , denominator] of rows) expect(denominator).toBe(total);
    expect(rows.reduce((sum, [, count]) => sum + count, 0)).toBe(total);

    // 全要求事項の件数と確認待ちは閉じない（主要数値）
    const totalLabel = screen.getByText('全要求事項', { exact: true });
    expectOutsideDetails(totalLabel);
    expect(totalLabel.parentElement?.textContent).toBe(`全要求事項${total}件`);
    expectOutsideDetails(screen.getByText('確認待ち', { exact: true }));
    expectOutsideDetails(list);
  });

  it('件数の数え方・工程の説明・整備度の説明・評価の理由は既定で閉じ、正式基準と転載許可の表示は閉じない', async () => {
    await renderPage(SsbjPage);
    expectInClosedDetails(
      screen.getByText(/評価対象（対象外・重要性なしを除く）で数えています/),
      '件数の数え方',
    );
    expectInClosedDetails(
      screen.getByText('適用する基準・報告の範囲・重要性のある課題を決めます。'),
      '各工程の説明',
    );
    expectInClosedDetails(
      screen.getByText('要求される情報が、現在の開示資料に記載されている度合い'),
      '何を測るか',
    );
    // 工程の題・3 つの整備度・見出しは見える
    for (const text of [
      'マテリアリティ・分析条件の設定',
      '開示対応度',
      'データ整備度',
      '業務プロセス・内部統制整備度',
      '領域別の対応状況',
      'マテリアリティ充足度',
    ]) {
      expectOutsideDetails(screen.getByText(text, { exact: true }));
    }
    // 正式基準（転載許可取得済み）のバッジと出所の表記は閉じない（誠実さの注記）
    expectOutsideDetails(screen.getByText('正式基準準拠（転載許可取得済み）'));
    expectOutsideDetails(screen.getByText(SSBJ_FRAMEWORK_INFO.attribution));
    // 収録範囲（ユニバーサル基準は未収録・全条項ではない）もバッジ・全要求事項と一緒に見せる。
    // 閉じた「件数の数え方」の中だけに置くと、基準の全量を収録しているように見えるため
    const coverage = screen.getByText(
      '収録範囲: 一般開示基準33・気候関連開示基準96・実務対応基準第1号4の計133項目。ユニバーサル基準（適用）は未収録。基準のすべての条項ではありません。',
    );
    expectOutsideDetails(coverage);
    expect(coverage.closest('div')?.textContent).toContain('全要求事項');
    // 指示された禁止語を新しい凡例・要約に持ち込まない（閉じた中も含めて数える）
    for (const banned of ['ダッシュボード', 'アセスメント', 'ステータス', 'コンプライアント']) {
      expect(document.body.textContent).not.toContain(banned);
    }
  });

  it('マテリアリティの表: 課題名・評価は見せ、評価の理由だけを行ごとに閉じる', async () => {
    const topic = fixture.materialityTopics.find(
      (t) => t.organizationId === ORG_IDS.aomi && t.reportingPeriodId === PERIOD_IDS.fy2025,
    )!;
    shellState.shell = shellFor(manager(), PERIOD_IDS.fy2025);
    await renderPage(SsbjPage);
    expectOutsideDetails(screen.getByText(topic.title, { exact: true }));
    expectInClosedDetails(screen.getByText(topic.rationale), '評価の理由');
  });
});

describe('SSBJ 要求事項の評価', () => {
  it('件数の流れは各段の件数を文字で書き、段階の説明とマテリアリティ × 基準の表は既定で閉じる', async () => {
    await renderPage(SsbjRequirementsPage);
    const funnel = screen.getByRole('list', { name: '要求事項の件数の流れ' });
    const steps = within(funnel)
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(steps).toHaveLength(4);
    expect(steps[0]).toMatch(/^正式基準マスター\d+ 項目$/);
    expect(steps[1]).toMatch(/^適用基準で\d+ 項目$/);
    expect(steps[2]).toMatch(/^対象外を除く\d+ 項目$/);
    expect(steps[3]).toMatch(/^評価対象（重要性なしも除く）\d+ 項目$/);
    expectOutsideDetails(funnel);
    expectOutsideDetails(screen.getByText(/^除外した件数: 対象外/));
    // 「正式基準マスター n 項目」が基準の全条項に見えないよう、収録範囲を件数の流れの下に見せる
    expectOutsideDetails(
      screen.getByText(
        /^収録範囲: .*ユニバーサル基準（適用）は未収録。基準のすべての条項ではありません。$/,
      ),
    );

    // 工程チップ（題と残件数）は見え、説明だけを閉じる
    for (const title of [
      '対象判定・重要性判断',
      '人工知能によるギャップ分析',
      '担当者による確認',
      'ギャップの優先順位付け',
    ]) {
      expectOutsideDetails(screen.getByText(title, { exact: true }));
    }
    expectInClosedDetails(screen.getByText('適用の有無と重要性を判断します。'), '各工程の説明');
    // 「AI は候補・確定は人」は誠実さの注記なので、工程の説明を閉じても 1 行は外に見せる
    expectOutsideDetails(
      screen.getByText('人工知能の判定は候補です。最終判定は担当者が確認して入れます。', {
        exact: true,
      }),
    );

    // FY2026 はマテリアリティが未登録。空状態と登録への導線は閉じずに見せる
    expectOutsideDetails(screen.getByText('マテリアリティが未登録です'));
    expect(screen.queryByRole('columnheader', { name: '気候関連開示基準' })).toBeNull();
  });

  it('マテリアリティ × 基準の表（登録済み）は凡例ごと既定で閉じ、要点に件数を書く', async () => {
    const topics = fixture.materialityTopics.filter(
      (t) => t.organizationId === ORG_IDS.aomi && t.reportingPeriodId === PERIOD_IDS.fy2025,
    );
    expect(topics.length).toBeGreaterThan(0);
    shellState.shell = shellFor(manager(), PERIOD_IDS.fy2025);
    await renderPage(SsbjRequirementsPage);
    const summary = `マテリアリティ × 基準の対応表（${topics.length} 件）`;
    expectInClosedDetails(screen.getByRole('columnheader', { name: '気候関連開示基準' }), summary);
    expectInClosedDetails(screen.getByText(/^● = 開示対象になりやすい基準/), summary);
    // 件数の流れと適用中の基準は閉じない
    expectOutsideDetails(screen.getByRole('list', { name: '要求事項の件数の流れ' }));
    expectOutsideDetails(screen.getByText('適用中の基準:'));
  });

  it('紐づけの 4 分類は重なりうるので、分類ごとに同じ分母の「n / N 件」で示し、選ぶと一覧を絞り込む', async () => {
    await renderPage(SsbjRequirementsPage);
    const labels = ['資料と紐づけ済み', 'データあり', '未分析', '紐づけできず'];
    const denominators = new Set<string>();
    for (const label of labels) {
      const bar = screen.getByRole('img', { name: new RegExp(`^${label}: \\d+ / \\d+ 件$`) });
      denominators.add(bar.getAttribute('aria-label')!.replace(/^.*\/ /, ''));
      const link = bar.closest('a')!;
      expect(link.getAttribute('aria-label')).toMatch(
        new RegExp(`^${label} \\d+ / \\d+ 件（一覧を絞り込む）$`),
      );
      expect(link.getAttribute('href')).toMatch(
        /^\/enterprise\/disclosures\/ssbj\/requirements\?linkage=/,
      );
      expectOutsideDetails(link);
    }
    expect(denominators.size).toBe(1);
    expectInClosedDetails(
      screen.getByText('資料とデータの両方に紐づく要求事項は、両方に数えています。'),
      '紐づけの数え方',
    );
  });
});

describe('SSBJ 対応計画・データ収集', () => {
  it('対応計画: 4 区分の合計 = 計画の件数。期限超過は状態と重なるので帯の外に書く', async () => {
    await renderPage(SsbjPlansPage);
    const rows = breakdownOf(screen.getByRole('list', { name: '対応状況の内訳' }));
    expect(rows.map(([label]) => label)).toEqual(['未着手', '対応中', '確認中', '完了']);
    const plans = fixture.ssbjActionPlans.filter(
      (p) => p.organizationId === ORG_IDS.aomi && p.reportingPeriodId === PERIOD_IDS.fy2026,
    );
    expect(plans.length).toBeGreaterThan(0);
    for (const [, , denominator] of rows) expect(denominator).toBe(plans.length);
    expect(rows.reduce((sum, [, count]) => sum + count, 0)).toBe(plans.length);
    expectOutsideDetails(screen.getByText('期限超過', { exact: true }));
  });

  it('データ収集: 収集状況の内訳の合計 = 収集対象。値の無いものは「未入力」（0 にしない）', async () => {
    await renderPage(SsbjCollectionPage);
    expect(screen.getByRole('heading', { name: '収集の進捗' })).toBeTruthy();
    const rows = breakdownOf(screen.getByRole('list', { name: '収集状況の内訳' }));
    expect(rows[0]![0]).toBe('承認済み');
    const target = rows[0]![2];
    expect(screen.getByText('収集対象', { exact: true }).parentElement?.textContent).toBe(
      `収集対象${target}件`,
    );
    expect(rows.reduce((sum, [, count]) => sum + count, 0)).toBe(target);
    for (const [, count] of rows.slice(1)) expect(count).toBeGreaterThan(0);
  });
});

describe('SSBJ 開示ドラフト', () => {
  it('「生成されるのは草案」は常に見せ、人工知能が書ける範囲の説明だけを閉じる', async () => {
    await renderPage(SsbjDraftPage);
    expectOutsideDetails(screen.getByText(/^生成されるのは草案です。そのまま開示せず/));
    expectInClosedDetails(
      screen.getByText('担当者が確認して「対応済み」または「おおむね対応」とした要求事項'),
      '人工知能が書ける範囲',
    );
  });
});

describe('ホーム（従来・ESG経営タブ）', () => {
  it('拠点別進捗は拠点ごとの状態の内訳（合計 = 対象）。直近のアクティビティは見出しを残して閉じる', async () => {
    const shell = shellFor(manager());
    render(await LegacyHomeBody({ shell, today: FIXTURE_TODAY }));
    expectOutsideDetails(screen.getByRole('heading', { name: '拠点別進捗' }));

    const units = shell.units.filter((u) => u.unitType !== 'supplier');
    expect(units.length).toBeGreaterThan(0);
    for (const unit of units) {
      const list = screen.getByRole('list', { name: `${unit.name} の状態の内訳` });
      // 検証エラーは状態と重なるので帯に入れず、拠点の行に件数を書く（0 件でも書く）
      expect(list.closest('li')?.textContent).toMatch(/エラー \d+ 件/);
      const rows = breakdownOf(list);
      expect(rows.slice(0, 3).map(([label]) => label)).toEqual([
        '承認済み',
        'レビュー中',
        '未提出',
      ]);
      const total = rows[0]![2];
      expect(rows.reduce((sum, [, count]) => sum + count, 0)).toBe(total);
    }

    const activity = screen.getByRole('region', { name: '直近のアクティビティ' });
    expectOutsideDetails(within(activity).getByRole('heading', { name: '直近のアクティビティ' }));
    const firstItem = activity.querySelector('details li');
    expect(firstItem).not.toBeNull();
    expectInClosedDetails(firstItem!, /^更新 \d+ 件（最新 .+）$/);
  });
});

describe('ホーム（開示業務）', () => {
  it('「適用確定済み n 項目中、承認済み n 項目」と分母付きの帯は見せ、分母の決め方と拠点の未提出は閉じる', async () => {
    const ctx = manager();
    const home = await loadDisclosureHome(db, ctx, {
      period: shellFor(ctx).currentPeriod,
      today: FIXTURE_TODAY,
    });
    expect(home.progress).not.toBeNull();
    render(<DisclosureHomeView home={home} showDemoReset />);

    // 数値は <strong> に分かれているので、要素全体の文字で探す
    const headline = screen.getByText(
      (_, element) =>
        element?.tagName === 'SPAN' &&
        /^適用確定済み \d+ 項目中、承認済み \d+ 項目$/.test(element.textContent ?? ''),
    );
    expectOutsideDetails(headline);
    const bar = screen.getByRole('img', {
      name: `承認済み（適用確定済みのうち）: ${home.progress!.approvedItemCount} / ${home.progress!.confirmedItemCount} 項目`,
    });
    expectOutsideDetails(bar);
    expectInClosedDetails(
      screen.getByText(/^分母は、適用すると判断を確定した基準/),
      /^分母の決め方/,
    );
    expectOutsideDetails(screen.getByText(/^適用未判定/));

    // 拠点の未提出は補助表示（既定で閉じる）
    const unitsSummary = screen.getByText('拠点の未提出（補助表示）');
    const unitsDetails = unitsSummary.closest('details')!;
    expect(unitsDetails.open).toBe(false);
    // details に overflow を付けない（枠いっぱいの summary のフォーカスリングが切れて見えなくなる）
    expect(unitsDetails.className).not.toMatch(/overflow-(hidden|clip)/);
  });

  it('リセット: 確認のチェックと、それが指す範囲の 1 行は閉じない。戻す表の一覧だけを閉じる', () => {
    render(<DemoResetCard />);
    expectOutsideDetails(screen.getByText(/^戻す範囲: /));
    expectOutsideDetails(screen.getByLabelText('上記の範囲だけを初期状態へ戻すことを確認しました'));
    expectOutsideDetails(screen.getByRole('button', { name: '開示デモを初期状態に戻す' }));
    expectInClosedDetails(
      screen.getByText(/ダブル・マテリアリティ評価（DMA）/),
      '戻す範囲・戻さないものの一覧',
    );
  });
});
