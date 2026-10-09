import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { ORG_IDS, PERIOD_IDS, at, userId } from '@/lib/fixtures/dataset';
import { fid } from '@/lib/fixtures/ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { addMaterialityTopic, assessMaterialityTopic } from '@/lib/services/materiality';
import { buildSsbjDocxSections } from '@/lib/services/disclosure';
import {
  loadSsbjOverview,
  loadSsbjRequirementViews,
  resolveSsbjVersion,
  ssbjVersionStamp,
} from '@/lib/services/ssbj-gap';
import {
  confirmSsbjSettings,
  loadSsbjSettings,
  pinSsbjFrameworkVersion,
  saveSsbjSettings,
} from '@/lib/services/ssbj-settings';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * SSBJ の基準の版を年度ごとに固定する（トライアル対応 NF-12・X-13。int:ssbj-version-pin）。
 *
 *  - 設定を確定した年度は、その時点の版に固定される。新しい版を足しても、その年度の画面は変わらない
 *  - 固定していない年度は公開中の版（新しい版）を読む
 *  - 版の切り替えは人の明示の操作で、設定の確定は外れる
 *  - 「対象年度×基準版」を画面・出力に出す
 */

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
const contributor = () => ctxFor('site-user@demo.local', ['site_contributor']);
const metrics = () => fixture.metrics.filter((m) => m.organizationId === ORG_IDS.aomi);
const period = (id: string) => fixture.periods.find((p) => p.id === id)!;

const SSBJ_2026 = fid('framework_version', 'ssbj/2026');
const SSBJ_2027 = fid('framework_version', 'ssbj/2027-test');
const NEW_CODE = '気候-100（テスト）';

/** 新しい SSBJ の版（架空のテスト用）。2026 の要求事項に 1 件足した版を公開中にする */
function publishNewSsbjVersion(): void {
  const base = fixture.frameworkVersions.find((v) => v.id === SSBJ_2026)!;
  fixture.frameworkVersions.push({
    ...base,
    id: SSBJ_2027,
    year: 2027,
    label: 'SSBJ 2027 テスト版（架空）',
    versionCode: 'ssbj-2027-test',
    createdAt: at(1),
  });
  const items = fixture.disclosureItems.filter((i) => i.frameworkVersionId === SSBJ_2026);
  for (const item of items) {
    fixture.disclosureItems.push({
      ...item,
      id: fid('disclosure_item', `ssbj/2027-test/${item.code}`),
      frameworkVersionId: SSBJ_2027,
    });
  }
  const first = items[0]!;
  fixture.disclosureItems.push({
    ...first,
    id: fid('disclosure_item', `ssbj/2027-test/${NEW_CODE}`),
    frameworkVersionId: SSBJ_2027,
    code: NEW_CODE,
    section: '気候：指標及び目標',
    questionText: '（テスト）新しい要求事項',
    sortOrder: 999,
    changeType: 'new',
  });
}

async function confirmFy2026(): Promise<void> {
  await saveSsbjSettings(db, manager(), {
    reportingPeriodId: PERIOD_IDS.fy2026,
    applyGeneral: true,
    applyClimate: true,
    applyPractical: false,
    firstTimeAdoption: true,
    consolidationScope: 'same_as_financial',
    consolidationNote: '',
    includedUnitIds: [],
    valueChainScope: 'both',
    valueChainNote: '',
  });
  const topic = await addMaterialityTopic(db, manager(), metrics(), {
    reportingPeriodId: PERIOD_IDS.fy2026,
    title: '気候変動に伴う炭素価格の上昇',
    description: '',
    category: 'environment',
    metricCodes: [],
  });
  await assessMaterialityTopic(db, manager(), {
    topicId: topic.id,
    materiality: 'high',
    rationale: '当年度の事業内容を踏まえて評価した（テスト）。',
  });
  // 既存の未評価の課題があれば評価する（③を満たす）
  for (const t of fixture.materialityTopics.filter(
    (x) =>
      x.organizationId === ORG_IDS.aomi &&
      x.reportingPeriodId === PERIOD_IDS.fy2026 &&
      x.materiality === 'not_assessed' &&
      !x.deletedAt,
  )) {
    await assessMaterialityTopic(db, manager(), {
      topicId: t.id,
      materiality: 'medium',
      rationale: 'テスト',
    });
  }
  await confirmSsbjSettings(db, manager(), PERIOD_IDS.fy2026, metrics());
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('SSBJ の基準の版の固定', () => {
  it('確定した年度は確定時の版に固定され、新しい版を足しても画面が変わらない', async () => {
    await confirmFy2026();
    const settings = fixture.ssbjAnalysisSettings.find(
      (s) => s.reportingPeriodId === PERIOD_IDS.fy2026,
    )!;
    expect(settings.frameworkVersionId).toBe(SSBJ_2026);
    const before = (await loadSsbjRequirementViews(db, manager(), period(PERIOD_IDS.fy2026)))!;

    publishNewSsbjVersion();
    const after = (await loadSsbjRequirementViews(db, manager(), period(PERIOD_IDS.fy2026)))!;
    expect(after.versionLabel).toBe(before.versionLabel);
    expect(after.versionPinned).toBe(true);
    expect(after.views.map((v) => v.item.id)).toEqual(before.views.map((v) => v.item.id));
    expect(after.views.some((v) => v.item.code === NEW_CODE)).toBe(false);

    // 固定していない年度（FY2025）は公開中の新しい版を読む
    const fy2025 = (await loadSsbjOverview(db, manager(), period(PERIOD_IDS.fy2025), '出所'))!;
    expect(fy2025.versionLabel).toBe('SSBJ 2027 テスト版（架空）');
    expect(fy2025.versionPinned).toBe(false);
  });

  it('設定の画面は固定した版と新しい版を示し、切り替えは人の明示の操作（確定は外れる）', async () => {
    await confirmFy2026();
    publishNewSsbjVersion();
    const view = await loadSsbjSettings(db, manager(), period(PERIOD_IDS.fy2026), metrics());
    expect(view.frameworkVersion?.id).toBe(SSBJ_2026);
    expect(view.frameworkVersion?.pinned).toBe(true);
    expect(view.frameworkVersion?.newerVersions.map((v) => v.id)).toEqual([SSBJ_2027]);

    await expect(
      pinSsbjFrameworkVersion(db, contributor(), {
        reportingPeriodId: PERIOD_IDS.fy2026,
        frameworkVersionId: SSBJ_2027,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    // SSBJ 以外の版には切り替えられない
    await expect(
      pinSsbjFrameworkVersion(db, manager(), {
        reportingPeriodId: PERIOD_IDS.fy2026,
        frameworkVersionId: fid('framework_version', 'csrd/2026'),
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await pinSsbjFrameworkVersion(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      frameworkVersionId: SSBJ_2027,
    });
    const switched = await loadSsbjSettings(db, manager(), period(PERIOD_IDS.fy2026), metrics());
    expect(switched.frameworkVersion?.id).toBe(SSBJ_2027);
    expect(switched.confirmed).toBe(false);
    const views = (await loadSsbjRequirementViews(db, manager(), period(PERIOD_IDS.fy2026)))!;
    expect(views.views.some((v) => v.item.code === NEW_CODE)).toBe(true);
  });

  it('対象年度×基準版の表示', async () => {
    const resolved = (await resolveSsbjVersion(db, ORG_IDS.aomi, PERIOD_IDS.fy2026))!;
    expect(resolved.pinned).toBe(false);
    expect(ssbjVersionStamp('2026年度', resolved)).toBe(
      `2026年度 × ${resolved.version.label}（公開中の版・未固定）`,
    );
    await confirmFy2026();
    const pinned = (await resolveSsbjVersion(db, ORG_IDS.aomi, PERIOD_IDS.fy2026))!;
    expect(ssbjVersionStamp('2026年度', pinned)).toContain('（設定で固定）');
  });

  it('SSBJ の開示ドラフトの Word（概要）にも対象年度×基準版を出す（T8 の依頼）', async () => {
    const fy2026 = period(PERIOD_IDS.fy2026);
    const periods = fixture.periods.filter((p) => p.organizationId === ORG_IDS.aomi);
    const built = (await buildSsbjDocxSections(db, manager(), fy2026, periods, metrics()))!;
    const overview = built.sections.find((s) => s.heading === '概要')!;
    const resolved = (await resolveSsbjVersion(db, ORG_IDS.aomi, PERIOD_IDS.fy2026))!;
    expect(overview.paragraphs).toContain(
      `対象年度×基準版: ${ssbjVersionStamp(fy2026.label, resolved)}`,
    );
  });
});
