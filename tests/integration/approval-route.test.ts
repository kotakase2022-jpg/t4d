import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { dataPointId, ORG_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import {
  canDecideStep,
  decideApprovalStep,
  loadApprovalProgress,
  loadApprovalProgressMap,
  loadApprovalTimeline,
  loadDefaultRoute,
  saveApprovalRoute,
  summarizeProgress,
} from '@/lib/services/approval-route';
import { transitionDataPoint, updateDataPointValue } from '@/lib/services/data-point-workflow';
import type { AuthorizationContext, RoleKey, Uuid } from '@/types/domain';

/**
 * 最大 5 階層の承認フロー。
 *
 * これまでのデータ承認は 1 段階しか無く、誰の承認で確定したのかを
 * 監査法人へ示せなかった。段階を通ること、飛ばせないこと、
 * いつ誰が承認・修正・差し戻したかが残ることを検査する。
 */

let db: DemoDbClient;
let fixture: FixtureDb;

function ctxFor(email: string, roleKeys: RoleKey[], units: Uuid[] = []): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds: units,
    },
    engagementIds: [],
    demo: true,
  };
}

const admin = () => ctxFor('enterprise-admin@demo.local', ['enterprise_admin']);
const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const approver = () => ctxFor('approver@demo.local', ['approver', 'reviewer']);
const siteUser = () => ctxFor('site-user@demo.local', ['site_contributor'], [UNIT_IDS.east]);

const actorFor: Record<string, () => AuthorizationContext> = {
  reviewer,
  sustainability_manager: manager,
  enterprise_admin: admin,
  approver,
};

/** 承認待ちの段階を、その段階の担当役割で承認する */
async function approveCurrent(target: Uuid, comment = '') {
  const progress = await loadApprovalProgress(db, approver(), target);
  const step = progress.currentStep!;
  return decideApprovalStep(db, actorFor[step.approverRole]!(), {
    dataPointId: target,
    decision: 'approved',
    comment,
  });
}

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('道筋の定義', () => {
  it('既定の道筋が 5 階層で入っている', async () => {
    const route = await loadDefaultRoute(db, admin());
    expect(route?.stages).toHaveLength(5);
    expect(route?.stages.map((s) => s.stageNo)).toEqual([1, 2, 3, 4, 5]);
    // 段数は順序どおりで、名前が空の段階は無い
    for (const stage of route!.stages) expect(stage.name.length).toBeGreaterThan(0);
  });

  it('6 階層以上は作れない', async () => {
    await expect(
      saveApprovalRoute(db, admin(), {
        name: '長すぎる道筋',
        description: '',
        isDefault: false,
        stages: Array.from({ length: 6 }, (_, i) => ({
          name: `${i + 1} 段目`,
          approverRole: 'reviewer',
          approverUserId: null,
          department: '',
        })),
      }),
    ).rejects.toThrow(/最大 5 階層/);
  });

  it('0 階層の道筋は作れない（承認が無くなる）', async () => {
    await expect(
      saveApprovalRoute(db, admin(), {
        name: '空の道筋',
        description: '',
        isDefault: false,
        stages: [],
      }),
    ).rejects.toThrow(/1 つ以上/);
  });

  it('道筋の定義を変えても、進行中のデータの経路は変わらない', async () => {
    const target = dataPointId('EAST', 'water', 'FY2026'); // returned
    const before = await loadApprovalProgress(db, admin(), target);
    expect(before.totalCount).toBe(5);

    const route = await loadDefaultRoute(db, admin());
    await saveApprovalRoute(db, admin(), {
      routeId: route!.route.id,
      name: route!.route.name,
      description: '',
      isDefault: true,
      stages: [
        { name: '担当役員の承認', approverRole: 'approver', approverUserId: null, department: '' },
      ],
    });

    // データ側は自分の写しを持っているので 5 階層のまま
    const after = await loadApprovalProgress(db, admin(), target);
    expect(after.totalCount).toBe(5);
  });

  it('既定の道筋は組織にひとつだけ', async () => {
    await saveApprovalRoute(db, admin(), {
      name: '簡易ルート',
      description: '',
      isDefault: true,
      stages: [
        { name: '担当役員の承認', approverRole: 'approver', approverUserId: null, department: '' },
      ],
    });
    const routes = fixture.approvalRoutes.filter((r) => r.organizationId === ORG_IDS.aomi);
    expect(routes.filter((r) => r.isDefault)).toHaveLength(1);
    expect((await loadDefaultRoute(db, admin()))?.route.name).toBe('簡易ルート');
  });

  it('道筋の定義は管理権限が要る', async () => {
    await expect(
      saveApprovalRoute(db, reviewer(), {
        name: '勝手なルート',
        description: '',
        isDefault: false,
        stages: [{ name: '承認', approverRole: 'reviewer', approverUserId: null, department: '' }],
      }),
    ).rejects.toThrow();
  });
});

describe('段階を順に承認する', () => {
  const target = dataPointId('WEST', 'waste', 'FY2026'); // submitted

  it('提出すると 1 段目が承認待ちになる', async () => {
    const progress = await loadApprovalProgress(db, admin(), target);
    expect(progress.currentStep?.stageNo).toBe(1);
    expect(progress.approvedCount).toBe(0);
    expect(progress.totalCount).toBe(5);
  });

  it('承認すると次の段階へ進む', async () => {
    await approveCurrent(target);
    const progress = await loadApprovalProgress(db, admin(), target);
    expect(progress.approvedCount).toBe(1);
    expect(progress.currentStep?.stageNo).toBe(2);
  });

  it('5 段階すべてを承認すると完了になる', async () => {
    for (let i = 0; i < 5; i += 1) await approveCurrent(target);
    const progress = await loadApprovalProgress(db, admin(), target);
    expect(progress.complete).toBe(true);
    expect(progress.currentStep).toBeNull();
  });

  it('自分の段階でない承認はできない', async () => {
    // 1 段目は「拠点責任者の確認」（reviewer）。承認者役だけの利用者は決められない
    const progress = await loadApprovalProgress(db, admin(), target);
    const step = progress.currentStep!;
    expect(step.approverRole).toBe('reviewer');
    expect(canDecideStep(manager(), step)).toBe(false);
    await expect(
      decideApprovalStep(db, manager(), {
        dataPointId: target,
        decision: 'approved',
        comment: '',
      }),
    ).rejects.toThrow(/承認できるのは/);
  });

  it('段階を飛ばしてデータを承認済みにはできない', async () => {
    await expect(
      transitionDataPoint(db, approver(), { dataPointId: target, to: 'approved' }),
    ).rejects.toThrow(/承認の道筋が残っています/);
  });

  it('入力担当は承認段階に入らない（提出までが役割）', async () => {
    const progress = await loadApprovalProgress(db, admin(), target);
    for (const step of progress.steps) {
      expect(canDecideStep(siteUser(), step)).toBe(false);
    }
  });
});

describe('差し戻し', () => {
  const target = dataPointId('WEST', 'waste', 'FY2026');

  it('理由なしでは差し戻せない', async () => {
    await expect(
      decideApprovalStep(db, reviewer(), {
        dataPointId: target,
        decision: 'returned',
        comment: '   ',
      }),
    ).rejects.toThrow(/理由/);
  });

  it('差し戻すと、誰がなぜ差し戻したかが段階に残る', async () => {
    await decideApprovalStep(db, reviewer(), {
      dataPointId: target,
      decision: 'returned',
      comment: '集計対象の期間が違います。',
    });
    const progress = await loadApprovalProgress(db, admin(), target);
    expect(progress.returnedStep?.stageNo).toBe(1);
    expect(progress.returnedStep?.decidedBy).toBe(userId('reviewer@demo.local'));
    expect(progress.returnedStep?.comment).toContain('集計対象');
    // 差し戻された巡には承認待ちが残らない
    expect(progress.currentStep).toBeNull();
  });

  it('出し直すと次の巡が始まり、前の巡の記録は残る', async () => {
    await decideApprovalStep(db, reviewer(), {
      dataPointId: target,
      decision: 'returned',
      comment: '集計対象の期間が違います。',
    });
    await transitionDataPoint(db, manager(), { dataPointId: target, to: 'returned' });
    await transitionDataPoint(db, manager(), { dataPointId: target, to: 'submitted' });

    const progress = await loadApprovalProgress(db, admin(), target);
    expect(progress.round).toBe(2);
    expect(progress.currentStep?.stageNo).toBe(1);

    // 1 巡目の差し戻しは消えていない
    const all = fixture.dataPointApprovalSteps.filter((s) => s.dataPointId === target);
    expect(all.some((s) => s.round === 1 && s.status === 'returned')).toBe(true);
  });
});

describe('履歴（いつ・誰が・承認／修正／差し戻し）', () => {
  const target = dataPointId('WEST', 'waste', 'FY2026');

  it('承認・差し戻し・修正が 1 本の流れになる', async () => {
    await approveCurrent(target, '拠点の計量記録と一致することを確認しました。');
    await decideApprovalStep(db, manager(), {
      dataPointId: target,
      decision: 'returned',
      comment: '単位が kg のままです。t へ直してください。',
    });
    await updateDataPointValue(db, manager(), {
      dataPointId: target,
      value: 12.5,
      unitOfMeasure: 't',
      changeReason: '単位を t へ修正',
    });

    const timeline = await loadApprovalTimeline(db, admin(), target);

    const kinds = timeline.map((e) => e.kind);
    expect(kinds).toContain('approved');
    expect(kinds).toContain('returned');
    expect(kinds).toContain('modified');

    // 新しいものが上
    for (let i = 1; i < timeline.length; i += 1) {
      expect(timeline[i - 1]!.at >= timeline[i]!.at).toBe(true);
    }

    const returned = timeline.find((e) => e.kind === 'returned')!;
    expect(returned.actorName).toBe('海野 みどり');
    expect(returned.stageLabel).toContain('本社主管部門');
    expect(returned.detail).toContain('単位が kg');

    const approved = timeline.find((e) => e.kind === 'approved')!;
    expect(approved.actorName).toBe('検見川 涼');
    expect(approved.stageLabel).toContain('拠点責任者');

    const modified = timeline.find((e) => e.kind === 'modified')!;
    expect(modified.detail).toContain('単位を t へ修正');
  });

  it('他社のデータの履歴は読めない', async () => {
    const other = ctxFor('enterprise-admin@demo.local', ['enterprise_admin']);
    other.workspace.organizationId = ORG_IDS.soten;
    await expect(loadApprovalTimeline(db, other, target)).rejects.toThrow();
  });
});

describe('一覧向けのまとめ読み', () => {
  it('複数データの進捗をまとめて読める', async () => {
    const ids = [
      dataPointId('WEST', 'waste', 'FY2026'),
      dataPointId('EAST', 'waste', 'FY2026'),
      dataPointId('HQ', 'scope1', 'FY2026'),
    ];
    const map = await loadApprovalProgressMap(db, admin(), ids);
    for (const id of ids) {
      expect(map.get(id)?.totalCount).toBe(5);
    }
    // 承認済みのデータは 5 段階すべて承認済みとして入っている
    expect(map.get(dataPointId('HQ', 'scope1', 'FY2026'))?.complete).toBe(true);
  });

  it('空の一覧を渡しても問い合わせない', async () => {
    const map = await loadApprovalProgressMap(db, admin(), []);
    expect(map.size).toBe(0);
  });

  it('段階が 1 つも無いデータは進捗も空になる', () => {
    const progress = summarizeProgress([]);
    expect(progress.totalCount).toBe(0);
    expect(progress.complete).toBe(false);
    expect(progress.currentStep).toBeNull();
  });
});
