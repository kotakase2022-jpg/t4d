import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import {
  addMaterialityTopic,
  assessMaterialityTopic,
  deleteMaterialityTopic,
  loadMateriality,
  updateMaterialityTopic,
} from '@/lib/services/materiality';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * マテリアリティの追加・編集・削除・評価。
 *
 * 課題は固定一覧ではなく、利用者が自由記述で登録する。
 * 評価理由は必須。削除は論理削除で、評価の記録は行として残る。
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
const siteUser = () => ctxFor('site-user@demo.local', ['site_contributor']);

const period = () => fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
const metrics = () => fixture.metrics.filter((m) => m.organizationId === ORG_IDS.aomi);

async function addTopic(title = '気候変動に伴う炭素価格の上昇') {
  return addMaterialityTopic(db, manager(), metrics(), {
    reportingPeriodId: PERIOD_IDS.fy2026,
    title,
    category: 'environment',
    metricCodes: ['scope1', 'scope2'],
  });
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('追加（自由記述 → 区分 → 項目）', () => {
  it('登録でき、未評価から始まり、一覧に出る', async () => {
    const topic = await addTopic();
    expect(topic.materiality).toBe('not_assessed');
    expect(topic.metricCodes).toEqual(['scope1', 'scope2']);

    const { topics } = await loadMateriality(db, manager(), period(), metrics());
    expect(topics).toHaveLength(1);
    expect(topics[0]?.title).toBe('気候変動に伴う炭素価格の上昇');
    // 項目（対象指標）の表示名が解決される
    expect(topics[0]?.metricNames).toContain('Scope1 排出量');
  });

  it('名前が空・空白のみでは追加できない', async () => {
    for (const title of ['', '   ']) {
      await expect(
        addMaterialityTopic(db, manager(), metrics(), {
          reportingPeriodId: PERIOD_IDS.fy2026,
          title,
          category: 'environment',
          metricCodes: [],
        }),
      ).rejects.toThrow(/入力してください/);
    }
  });

  it('101 文字以上の名前は弾く', async () => {
    await expect(addTopic('あ'.repeat(101))).rejects.toThrow(/100 文字以内/);
  });

  it('同じ名前の課題は二重登録できない', async () => {
    await addTopic();
    await expect(addTopic()).rejects.toThrow(/既に登録されています/);
  });

  it('不正な区分は弾く', async () => {
    await expect(
      addMaterialityTopic(db, manager(), metrics(), {
        reportingPeriodId: PERIOD_IDS.fy2026,
        title: 'テスト課題',
        category: 'invalid' as never,
        metricCodes: [],
      }),
    ).rejects.toThrow(/区分/);
  });

  it('指標マスターに無いコードは黙って捨てる（画面偽装への備え）', async () => {
    const topic = await addMaterialityTopic(db, manager(), metrics(), {
      reportingPeriodId: PERIOD_IDS.fy2026,
      title: 'テスト課題',
      category: 'environment',
      metricCodes: ['scope1', 'no_such_metric', 'scope1'],
    });
    expect(topic.metricCodes).toEqual(['scope1']);
  });

  it('他組織の期間へは追加できない', async () => {
    await expect(
      addMaterialityTopic(db, manager(), metrics(), {
        reportingPeriodId: PERIOD_IDS.sotenFy2026,
        title: '越権テスト',
        category: 'environment',
        metricCodes: [],
      }),
    ).rejects.toThrow();
  });

  it('書き込み権限が無い利用者は追加できない', async () => {
    await expect(
      addMaterialityTopic(db, siteUser(), metrics(), {
        reportingPeriodId: PERIOD_IDS.fy2026,
        title: '権限テスト',
        category: 'environment',
        metricCodes: [],
      }),
    ).rejects.toThrow();
  });
});

describe('編集', () => {
  it('名前と区分を変えられ、評価は変わらない', async () => {
    const topic = await addTopic();
    await assessMaterialityTopic(db, manager(), {
      topicId: topic.id,
      materiality: 'high',
      rationale: '規制の影響を直接受けるため。',
    });

    const updated = await updateMaterialityTopic(db, manager(), {
      topicId: topic.id,
      title: '炭素価格・排出規制への対応',
      category: 'environment',
    });
    expect(updated.title).toBe('炭素価格・排出規制への対応');
    expect(updated.materiality).toBe('high');
    expect(updated.rationale).toBe('規制の影響を直接受けるため。');
  });

  it('別の課題と同じ名前へは変えられない', async () => {
    await addTopic('課題A');
    const b = await addTopic('課題B');
    await expect(
      updateMaterialityTopic(db, manager(), {
        topicId: b.id,
        title: '課題A',
        category: 'environment',
      }),
    ).rejects.toThrow(/既に登録されています/);
  });

  it('存在しない ID・他組織の ID は存在ごと秘匿する', async () => {
    await expect(
      updateMaterialityTopic(db, manager(), {
        topicId: '00000000-0000-4000-8000-000000000000',
        title: 'x',
        category: 'environment',
      }),
    ).rejects.toThrow(/見つかりません/);
  });
});

describe('削除', () => {
  it('削除すると一覧から消えるが、行は論理削除で残る', async () => {
    const topic = await addTopic();
    await deleteMaterialityTopic(db, manager(), topic.id);

    const { topics } = await loadMateriality(db, manager(), period(), metrics());
    expect(topics).toHaveLength(0);

    // 行そのものは残る（評価の記録は監査で問われる）
    const raw = fixture.materialityTopics.find((t) => t.id === topic.id);
    expect(raw?.deletedAt).not.toBeNull();
  });

  it('削除した課題と同じ名前で作り直せる', async () => {
    const topic = await addTopic();
    await deleteMaterialityTopic(db, manager(), topic.id);
    const again = await addTopic();
    expect(again.id).not.toBe(topic.id);
  });

  it('削除済みの課題は編集も評価もできない', async () => {
    const topic = await addTopic();
    await deleteMaterialityTopic(db, manager(), topic.id);
    await expect(
      assessMaterialityTopic(db, manager(), {
        topicId: topic.id,
        materiality: 'high',
        rationale: 'x',
      }),
    ).rejects.toThrow(/見つかりません/);
  });
});

describe('評価（理由は必須）', () => {
  it('理由なしでは評価できない（重要でない場合も含む）', async () => {
    const topic = await addTopic();
    for (const level of ['high', 'medium', 'low', 'not_material']) {
      await expect(
        assessMaterialityTopic(db, manager(), {
          topicId: topic.id,
          materiality: level,
          rationale: '   ',
        }),
      ).rejects.toThrow(/評価理由を入力してください（必須）/);
    }
  });

  it('未評価へ戻すときだけ理由なしを許す', async () => {
    const topic = await addTopic();
    await assessMaterialityTopic(db, manager(), {
      topicId: topic.id,
      materiality: 'high',
      rationale: '規制影響が大きいため。',
    });
    const reverted = await assessMaterialityTopic(db, manager(), {
      topicId: topic.id,
      materiality: 'not_assessed',
      rationale: '',
    });
    expect(reverted.materiality).toBe('not_assessed');
    expect(reverted.assessedAt).toBeNull();
  });

  it('評価すると誰がいつ評価したかが残る', async () => {
    const topic = await addTopic();
    const assessed = await assessMaterialityTopic(db, manager(), {
      topicId: topic.id,
      materiality: 'medium',
      rationale: '中期的に影響が見込まれるため。',
    });
    expect(assessed.assessedBy).toBe(userId('sustainability@demo.local'));
    expect(assessed.assessedAt).not.toBeNull();
  });

  it('1001 文字以上の理由は弾く', async () => {
    const topic = await addTopic();
    await expect(
      assessMaterialityTopic(db, manager(), {
        topicId: topic.id,
        materiality: 'high',
        rationale: 'あ'.repeat(1001),
      }),
    ).rejects.toThrow(/1000 文字以内/);
  });

  it('不正な評価値は弾く', async () => {
    const topic = await addTopic();
    await expect(
      assessMaterialityTopic(db, manager(), {
        topicId: topic.id,
        materiality: 'critical',
        rationale: 'x',
      }),
    ).rejects.toThrow(/不正/);
  });
});

describe('前年度との分離', () => {
  it('FY2025 の課題（Fixture）は当年度の一覧に混ざらない', async () => {
    const fy2025 = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2025)!;
    const prev = await loadMateriality(db, manager(), fy2025, metrics());
    expect(prev.topics.length).toBeGreaterThan(0);

    const current = await loadMateriality(db, manager(), period(), metrics());
    expect(current.topics).toHaveLength(0);
  });
});
