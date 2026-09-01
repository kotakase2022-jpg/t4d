import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import {
  addMaterialityTopic,
  assessMaterialityTopic,
  loadMateriality,
} from '@/lib/services/materiality';
import { loadSsbjHeadline, loadSsbjRequirementViews } from '@/lib/services/ssbj-gap';
import {
  confirmSsbjSettings,
  includedSectionPrefixes,
  loadSsbjSettings,
  saveSsbjSettings,
} from '@/lib/services/ssbj-settings';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * SSBJ 対応の「①マテリアリティ・分析条件の設定」。
 *
 * この工程は長らく画面上で常に「完了」と表示されていたが、実際には何も
 * 決めていなかった。決めるまでは未完了であること、決めた内容を変えたら
 * 確定が外れること、確定は人の操作でのみ起きることを検査する。
 */

let db: DemoDbClient;
let fixture: FixtureDb;

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
const viewer = () => ctxFor('site-user@demo.local', ['site_contributor']);

const period = () => fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
const metrics = () => fixture.metrics.filter((m) => m.organizationId === ORG_IDS.aomi);

/**
 * 課題を登録して評価済みにする（③を満たすため）。
 * 課題は固定一覧ではなく利用者が自由記述で登録する仕様になったので、
 * まず追加してから評価する。
 */
async function assessAllTopics() {
  const names = ['気候変動に伴う炭素価格の上昇', '熟練技術者の確保と定着'];
  for (const name of names) {
    const topic = await addMaterialityTopic(db, manager(), metrics(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      title: name,
      category: name.includes('気候') ? 'environment' : 'social',
      metricCodes: [],
    });
    await assessMaterialityTopic(db, manager(), {
      topicId: topic.id,
      materiality: 'medium',
      rationale: '当年度の事業内容を踏まえて評価した。',
    });
  }
  // 登録した全課題が評価済みになっていること（途中で増えていれば検知する）
  const { topics } = await loadMateriality(db, manager(), period(), metrics());
  if (topics.some((t) => t.materiality === 'not_assessed')) {
    throw new Error('未評価の課題が残っている');
  }
}

async function saveValidSettings() {
  return saveSsbjSettings(db, manager(), {
    reportingPeriodId: PERIOD_IDS.fy2026,
    applyGeneral: true,
    applyClimate: true,
    applyPractical: false,
    firstTimeAdoption: true,
    consolidationScope: 'same_as_financial',
    consolidationNote: '',
    includedUnitIds: [],
    valueChainScope: 'both',
    valueChainNote: '一次サプライヤーまでを対象とする。',
  });
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('初期状態', () => {
  it('デモの初期状態は未完了（ダミーで完了にしない）', async () => {
    const view = await loadSsbjSettings(db, manager(), period(), metrics());

    expect(view.settings).toBeNull();
    expect(view.confirmed).toBe(false);
    expect(view.ready).toBe(false);
    // 3 項目すべてが未完了から始まる
    expect(view.steps.map((s) => s.done)).toEqual([false, false, false]);
  });

  it('当年度のマテリアリティは未評価から始まる', async () => {
    // 課題は固定一覧ではなく利用者が登録する。当年度は 0 件・未評価から始まる
    const view = await loadSsbjSettings(db, manager(), period(), metrics());
    expect(view.assessedTopicCount).toBe(0);
    expect(view.totalTopicCount).toBe(0);
    expect(view.materialTopicCount).toBe(0);
  });

  it('未完了の項目には、次に何をすればよいかが書いてある', async () => {
    const view = await loadSsbjSettings(db, manager(), period(), metrics());
    for (const step of view.steps.filter((s) => !s.done)) {
      expect(step.todo.length).toBeGreaterThan(10);
    }
  });
});

describe('分析条件の保存', () => {
  it('保存すると「適用する基準」と「報告の範囲」が完了になる', async () => {
    await saveValidSettings();
    const view = await loadSsbjSettings(db, manager(), period(), metrics());

    expect(view.steps[0]?.done).toBe(true);
    expect(view.steps[1]?.done).toBe(true);
    // マテリアリティはまだ未評価なので、全体としては未完了のまま
    expect(view.steps[2]?.done).toBe(false);
    expect(view.ready).toBe(false);
  });

  it('基準を 1 つも選ばないと保存できない', async () => {
    await expect(
      saveSsbjSettings(db, manager(), {
        reportingPeriodId: PERIOD_IDS.fy2026,
        applyGeneral: false,
        applyClimate: false,
        applyPractical: false,
        firstTimeAdoption: false,
        consolidationScope: 'same_as_financial',
        consolidationNote: '',
        includedUnitIds: [],
        valueChainScope: 'both',
        valueChainNote: '',
      }),
    ).rejects.toThrow(/1 つ以上/);
  });

  it('財務諸表と異なる連結範囲にするなら理由が要る', async () => {
    await expect(
      saveSsbjSettings(db, manager(), {
        reportingPeriodId: PERIOD_IDS.fy2026,
        applyGeneral: true,
        applyClimate: true,
        applyPractical: false,
        firstTimeAdoption: false,
        consolidationScope: 'custom',
        consolidationNote: '   ',
        includedUnitIds: [],
        valueChainScope: 'both',
        valueChainNote: '',
      }),
    ).rejects.toThrow(/理由/);
  });

  it('バリューチェーンが未決定のままでは「報告の範囲」は完了にならない', async () => {
    await saveSsbjSettings(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      applyGeneral: true,
      applyClimate: true,
      applyPractical: false,
      firstTimeAdoption: false,
      consolidationScope: 'same_as_financial',
      consolidationNote: '',
      includedUnitIds: [],
      valueChainScope: 'not_decided',
      valueChainNote: '',
    });
    const view = await loadSsbjSettings(db, manager(), period(), metrics());
    expect(view.steps[1]?.done).toBe(false);
  });

  it('参照権限しか無い利用者は保存できない', async () => {
    await expect(
      saveSsbjSettings(db, viewer(), {
        reportingPeriodId: PERIOD_IDS.fy2026,
        applyGeneral: true,
        applyClimate: true,
        applyPractical: false,
        firstTimeAdoption: false,
        consolidationScope: 'same_as_financial',
        consolidationNote: '',
        includedUnitIds: [],
        valueChainScope: 'both',
        valueChainNote: '',
      }),
    ).rejects.toThrow();
  });

  it('報告対象の拠点を選ぶと保存される', async () => {
    const saved = await saveSsbjSettings(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      applyGeneral: true,
      applyClimate: true,
      applyPractical: false,
      firstTimeAdoption: false,
      consolidationScope: 'same_as_financial',
      consolidationNote: '',
      includedUnitIds: [UNIT_IDS.hq, UNIT_IDS.east],
      valueChainScope: 'upstream',
      valueChainNote: '',
    });
    expect(saved.includedUnitIds).toEqual([UNIT_IDS.hq, UNIT_IDS.east]);
  });
});

describe('確定', () => {
  it('3 項目すべてが決まるまで確定できない', async () => {
    await saveValidSettings();
    await expect(confirmSsbjSettings(db, manager(), PERIOD_IDS.fy2026, metrics())).rejects.toThrow(
      /決まっていない/,
    );
  });

  it('保存前は確定できない', async () => {
    await expect(confirmSsbjSettings(db, manager(), PERIOD_IDS.fy2026, metrics())).rejects.toThrow(
      /先に分析条件を保存/,
    );
  });

  it('3 項目すべてを決めれば確定でき、誰がいつ確定したかが残る', async () => {
    await saveValidSettings();
    await assessAllTopics();

    const before = await loadSsbjSettings(db, manager(), period(), metrics());
    expect(before.ready).toBe(true);
    expect(before.confirmed).toBe(false);

    await confirmSsbjSettings(db, manager(), PERIOD_IDS.fy2026, metrics());

    const after = await loadSsbjSettings(db, manager(), period(), metrics());
    expect(after.confirmed).toBe(true);
    expect(after.confirmedAt).not.toBeNull();
    expect(after.confirmedByName).toBe('海野 みどり');
  });

  it('確定後に内容を変えると確定が外れる', async () => {
    await saveValidSettings();
    await assessAllTopics();
    await confirmSsbjSettings(db, manager(), PERIOD_IDS.fy2026, metrics());
    expect((await loadSsbjSettings(db, manager(), period(), metrics())).confirmed).toBe(true);

    // 前提が変わったのに確定のままだと、後続の工程が古い前提のまま進む
    await saveSsbjSettings(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      applyGeneral: true,
      applyClimate: true,
      applyPractical: true,
      firstTimeAdoption: false,
      consolidationScope: 'same_as_financial',
      consolidationNote: '',
      includedUnitIds: [],
      valueChainScope: 'both',
      valueChainNote: '',
    });

    expect((await loadSsbjSettings(db, manager(), period(), metrics())).confirmed).toBe(false);
  });

  it('確定は監査ログに残る', async () => {
    await saveValidSettings();
    await assessAllTopics();
    await confirmSsbjSettings(db, manager(), PERIOD_IDS.fy2026, metrics());

    const audit = await db.select('auditEvents', {
      where: { resourceType: 'ssbj_analysis_settings' },
    });
    expect(audit.map((a) => a.afterSummary ?? '').join(' ')).toContain('確定');
  });
});

describe('適用する基準と評価対象の節', () => {
  it('未設定のうちは一般・気候を既定とする', () => {
    expect(includedSectionPrefixes(null)).toEqual(['一般', '気候']);
  });

  it('適用しない基準の要求事項は、実際に一覧から外れる', async () => {
    // 設定前は全 133 件が対象
    const before = await loadSsbjRequirementViews(db, manager(), period());
    expect(before!.views.length).toBe(133);
    expect(before!.views.some((v) => v.item.section.startsWith('一般'))).toBe(true);
    expect(before!.views.some((v) => v.item.section.startsWith('気候'))).toBe(true);

    // 気候関連開示基準だけを適用する
    await saveSsbjSettings(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      applyGeneral: false,
      applyClimate: true,
      applyPractical: false,
      firstTimeAdoption: false,
      consolidationScope: 'same_as_financial',
      consolidationNote: '',
      includedUnitIds: [],
      valueChainScope: 'both',
      valueChainNote: '',
    });

    const after = await loadSsbjRequirementViews(db, manager(), period());
    expect(after!.views.length).toBeLessThan(before!.views.length);
    // 「一般：〜」の要求事項は消え、「気候：〜」だけが残る
    expect(after!.views.some((v) => v.item.section.startsWith('一般'))).toBe(false);
    expect(after!.views.every((v) => v.item.section.startsWith('気候'))).toBe(true);
  });

  it('実務対応基準を足すと、その節の要求事項が現れる', async () => {
    await saveSsbjSettings(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      applyGeneral: false,
      applyClimate: false,
      applyPractical: true,
      firstTimeAdoption: false,
      consolidationScope: 'same_as_financial',
      consolidationNote: '',
      includedUnitIds: [],
      valueChainScope: 'both',
      valueChainNote: '',
    });

    const views = (await loadSsbjRequirementViews(db, manager(), period()))!.views;
    expect(views.length).toBeGreaterThan(0);
    expect(views.every((v) => v.item.section.startsWith('実務対応'))).toBe(true);
  });

  it('ホームの見出し数値も、一覧と同じ件数で数える', async () => {
    // 先に評価行を全件作ってから基準を絞る（後から外した場合の食い違いを見る）
    await loadSsbjRequirementViews(db, manager(), period());

    await saveSsbjSettings(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      applyGeneral: false,
      applyClimate: true,
      applyPractical: false,
      firstTimeAdoption: false,
      consolidationScope: 'same_as_financial',
      consolidationNote: '',
      includedUnitIds: [],
      valueChainScope: 'both',
      valueChainNote: '',
    });

    const views = (await loadSsbjRequirementViews(db, manager(), period()))!.views;
    const headline = await loadSsbjHeadline(db, manager(), period());
    expect(headline!.total).toBe(views.length);
  });

  it('適用しない基準の節は評価対象から外れる', async () => {
    const saved = await saveSsbjSettings(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      applyGeneral: false,
      applyClimate: true,
      applyPractical: true,
      firstTimeAdoption: false,
      consolidationScope: 'same_as_financial',
      consolidationNote: '',
      includedUnitIds: [],
      valueChainScope: 'both',
      valueChainNote: '',
    });
    expect(includedSectionPrefixes(saved)).toEqual(['気候', '実務対応']);
  });
});
