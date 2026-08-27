import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { loadMateriality, saveMaterialityTopic } from '@/lib/services/materiality';
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

/** 全トピックを評価済みにする（③を満たすため） */
async function assessAllTopics() {
  const { topics } = await loadMateriality(db, manager(), period(), metrics());
  for (const topic of topics) {
    await saveMaterialityTopic(db, manager(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      topicKey: topic.topicKey,
      materiality: 'medium',
      rationale: '当年度の事業内容を踏まえて評価した。',
    });
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
    const view = await loadSsbjSettings(db, manager(), period(), metrics());
    expect(view.assessedTopicCount).toBe(0);
    expect(view.totalTopicCount).toBeGreaterThan(0);
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
