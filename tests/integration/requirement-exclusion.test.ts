import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError, permissionsFor } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { DISCLOSURE_FIRST_IDS as IDS } from '@/lib/fixtures/disclosure-first';
import { TRIAL_ASSESSMENT_IDS, pendingSsbjExclusionItemId } from '@/lib/fixtures/trial-case';
import { ESRS_40A_SAMPLE_VERSION_ID, esrs40aSampleItemId } from '@/lib/fixtures/trial-ids';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { DEMO_TEXT_LIMITS, acceptTrialEdit } from '@/lib/repositories/demo-trial-checks';
import { loadRequirementMatrix } from '@/lib/services/requirement-matrix';
import { buildRequirementRows, getProject } from '@/lib/services/disclosure-project';
import {
  loadProjectRequirementDetail,
  saveProjectRequirementAssessment,
  type SaveProjectRequirementAssessmentInput,
} from '@/lib/services/project-requirement-assessment';
import {
  decideExclusion,
  exclusionDecisionBlocker,
  listPendingExclusions,
  loadExclusionStatus,
  requestExclusion,
  withdrawExclusion,
  type ExclusionTargetInput,
} from '@/lib/services/requirement-exclusion';
import { loadSsbjRequirementDetail } from '@/lib/services/ssbj-gap';
import { saveSsbjSettings } from '@/lib/services/ssbj-settings';
import { WriteDetectingDbClient } from '../support/write-detecting-db';
import type { AuthorizationContext, PermissionKey, RoleKey } from '@/types/domain';

/**
 * 要求事項の判断の保存（NF-01 の保存）と、対象外・非重要の申請と承認（NF-02。int:requirement-exclusion）。
 *  - 表示では行を作らない／保存の操作でだけ行と履歴を作る
 *  - 申請者・理由を記録した人は承認できない（職務分離）・理由を変えると承認は無効・承認待ちは分母に残る
 *  - 他の組織は「見つかりません」・権限の無い役割は断る
 *  - 保存した行は Demo の Cookie から戻すときの検査（DB と同じ規則）を通る
 */

let fixture: FixtureDb;
let db: DemoDbClient;

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  organizationId: string = ORG_IDS.aomi,
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType: 'enterprise',
      organizationName: 'テスト（架空）',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const author = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const approver = () => ctxFor('approver@demo.local', ['approver']);
const viewer = () => ctxFor('enterprise-admin@demo.local', ['viewer']);
const otherTenantApprover = () =>
  ctxFor('other-enterprise-admin@demo.local', ['approver'], ORG_IDS.soten);

const PF_40A = IDS.projectFrameworks.fy2026Esrs40a;
const S06: ExclusionTargetInput = {
  source: 'project_assessment',
  itemId: esrs40aSampleItemId('40A-S06'),
  projectFrameworkId: PF_40A,
};

function input(
  code: string,
  patch: Partial<SaveProjectRequirementAssessmentInput> = {},
): SaveProjectRequirementAssessmentInput {
  return {
    projectFrameworkId: PF_40A,
    itemId: esrs40aSampleItemId(code),
    applicability: 'applicable',
    applicabilityReason: '（テスト）全社共通の取組のため適用と判断。',
    ruleRef: '（サンプル）',
    disclosureCoverage: 'partial',
    dataCoverage: 'mostly_covered',
    processCoverage: 'partial',
    missingInformation: '',
    ownerUserId: userId('sustainability@demo.local'),
    dueOn: '2027-03-31',
    actionNote: '',
    changeReason: 'テストの判断',
    ...patch,
  };
}

async function rowOf(code: string) {
  const matrix = await loadRequirementMatrix(db, author(), {
    projectId: IDS.projects.fy2026,
    frameworkVersionIds: [ESRS_40A_SAMPLE_VERSION_ID],
  });
  return matrix.rows.find((r) => r.itemId === esrs40aSampleItemId(code))!;
}

/** Demo の Cookie から戻すときの権限の検査（fixture のメンバーシップ・役割から引く） */
function demoCan(organizationId: unknown, user: unknown, permission: PermissionKey): boolean {
  const memberships = fixture.memberships.filter(
    (m) => m.organizationId === organizationId && m.userId === user && m.status === 'active',
  );
  const roles = fixture.membershipRoles
    .filter((r) => memberships.some((m) => m.id === r.membershipId))
    .map((r) => r.roleKey);
  return permissionsFor(roles).has(permission);
}

function acceptedOnReplay(table: string, row: object): boolean {
  const next = row as Record<string, unknown>;
  const others = (fixture[table as keyof FixtureDb] as unknown as Array<{ id: string }>).filter(
    (r) => r.id !== next.id,
  );
  // 戻す前の状態（その行が無い）で検査する
  const saved = fixture[table as keyof FixtureDb];
  (fixture as unknown as Record<string, unknown>)[table] = others;
  try {
    return acceptTrialEdit(fixture, table, undefined, next, demoCan);
  } finally {
    (fixture as unknown as Record<string, unknown>)[table] = saved;
  }
}

describe('要求事項の判断の保存（NF-01）', () => {
  it('表示では行を作らず、保存の操作でだけ判断と履歴を作る', async () => {
    const guarded = new WriteDetectingDbClient(db);
    await loadProjectRequirementDetail(guarded, author(), {
      projectId: IDS.projects.fy2026,
      itemId: esrs40aSampleItemId('40A-S02'),
    });
    expect(guarded.writes).toEqual([]);
    expect(
      fixture.projectRequirementAssessments.some(
        (a) => a.itemId === esrs40aSampleItemId('40A-S02'),
      ),
    ).toBe(false);

    const before = await rowOf('40A-S02');
    expect(before.category).toBe('undetermined');

    const result = await saveProjectRequirementAssessment(db, author(), input('40A-S02'));
    expect(result.changed).toBe(true);
    expect(result.assessment.decidedBy).toBe(author().userId);
    const events = fixture.projectRequirementAssessmentEvents.filter(
      (e) => e.assessmentId === result.assessment.id,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.before).toBeNull();
    expect(events[0]!.after).toMatchObject({ applicability: 'applicable' });
    expect(
      fixture.auditEvents.some(
        (e) => e.eventType === 'requirement_assessed' && e.resourceId === result.assessment.id,
      ),
    ).toBe(true);

    const after = await rowOf('40A-S02');
    expect(after.decisionLabel).toBe('適用');
    expect(after.decisionSourceLabel).toBe('判断の記録');
    // サンプルの基準は充足確認済みにしない（K6）
    expect(after.category).not.toBe('confirmed');

    // Cookie から戻すときの検査（DB の RLS・トリガと同じ規則）を通る
    expect(acceptedOnReplay('projectRequirementAssessments', result.assessment)).toBe(true);
    expect(acceptedOnReplay('projectRequirementAssessmentEvents', events[0]!)).toBe(true);
  });

  it('変更が無ければ行も履歴も書かない', async () => {
    const first = await saveProjectRequirementAssessment(db, author(), input('40A-S02'));
    const count = fixture.projectRequirementAssessmentEvents.length;
    const again = await saveProjectRequirementAssessment(db, author(), input('40A-S02'));
    expect(again.changed).toBe(false);
    expect(again.assessment.id).toBe(first.assessment.id);
    expect(fixture.projectRequirementAssessmentEvents).toHaveLength(count);
  });

  it('対象外・非重要は理由が必須。理由の上限は Demo で 400 字', async () => {
    await expect(
      saveProjectRequirementAssessment(
        db,
        author(),
        input('40A-S02', { applicability: 'not_applicable', applicabilityReason: '  ' }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      saveProjectRequirementAssessment(
        db,
        author(),
        input('40A-S02', { applicabilityReason: 'あ'.repeat(DEMO_TEXT_LIMITS.note + 1) }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('SSBJ の基準・別の版の要求事項・他の組織・権限の無い役割は保存できない', async () => {
    await expect(
      saveProjectRequirementAssessment(db, author(), {
        ...input('40A-S02'),
        projectFrameworkId: IDS.projectFrameworks.fy2026Ssbj,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const ssbjPf = fixture.projectFrameworks.find(
      (f) => f.id === IDS.projectFrameworks.fy2026Ssbj,
    )!;
    await expect(
      saveProjectRequirementAssessment(db, author(), {
        ...input('40A-S02'),
        projectFrameworkId: ssbjPf.id,
        itemId: fixture.disclosureItems.find(
          (i) => i.code === '気候-10' && i.frameworkVersionId === ssbjPf.frameworkVersionId,
        )!.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      saveProjectRequirementAssessment(db, otherTenantApprover(), input('40A-S02')),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      saveProjectRequirementAssessment(
        db,
        ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten),
        input('40A-S02'),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      saveProjectRequirementAssessment(db, approver(), input('40A-S02')),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      saveProjectRequirementAssessment(db, viewer(), input('40A-S02')),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('対象外・非重要の申請と承認（NF-02）', () => {
  it('承認待ちは分母に残り（未判定）、別の人の承認で対象外になる', async () => {
    const pending = await rowOf('40A-S06');
    expect(pending.category).toBe('undetermined');
    expect(pending.exclusionReason).not.toBeNull();

    const status = await loadExclusionStatus(db, approver(), S06);
    expect(status.state.state).toBe('requested');
    expect(exclusionDecisionBlocker(approver(), status)).toBeNull();

    const event = await decideExclusion(db, approver(), { ...S06, decision: 'approved' });
    expect(event.event).toBe('approved');
    expect(acceptedOnReplay('requirementExclusionEvents', event)).toBe(true);
    expect(
      fixture.auditEvents.some(
        (e) => e.eventType === 'exclusion_decided' && e.resourceId === event.id,
      ),
    ).toBe(true);

    const approved = await rowOf('40A-S06');
    expect(approved.category).toBe('excluded');
    expect(approved.approvedByName).not.toBeNull();
    expect(approved.approvedAt).toBe(event.createdAt);
  });

  it('申請した人・理由を記録した人は承認できない（職務分離）', async () => {
    // 申請者（作成担当）に承認の権限を足しても、自分の申請は承認できない
    const selfApprover = ctxFor('sustainability@demo.local', [
      'sustainability_manager',
      'approver',
    ]);
    const status = await loadExclusionStatus(db, selfApprover, S06);
    expect(exclusionDecisionBlocker(selfApprover, status)).toContain('職務分離');
    await expect(
      decideExclusion(db, selfApprover, { ...S06, decision: 'approved' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(
      fixture.requirementExclusionEvents.filter(
        (e) => e.event === 'approved' && e.itemId === S06.itemId,
      ),
    ).toHaveLength(0);
  });

  it('編集の権限しか無い人は承認できない', async () => {
    await expect(
      decideExclusion(db, reviewer(), { ...S06, decision: 'approved' }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('承認の後に理由を変えると承認は無効になり（再承認が必要）、分母に戻る', async () => {
    await decideExclusion(db, approver(), { ...S06, decision: 'approved' });
    expect((await rowOf('40A-S06')).category).toBe('excluded');

    const saved = await saveProjectRequirementAssessment(
      db,
      author(),
      input('40A-S06', {
        applicability: 'not_applicable',
        applicabilityReason:
          '（テスト）水資源の利用は事業所の立地から重要ではないと判断（理由を更新）。',
        disclosureCoverage: null,
        dataCoverage: null,
        processCoverage: null,
      }),
    );
    expect(saved.exclusionChanged).toBe(true);
    const status = await loadExclusionStatus(db, author(), S06);
    expect(status.state.state).toBe('reapproval_required');
    expect((await rowOf('40A-S06')).category).toBe('undetermined');

    // 申請し直して、別の人が承認すれば対象外に戻る
    const requested = await requestExclusion(db, reviewer(), S06);
    expect(acceptedOnReplay('requirementExclusionEvents', requested)).toBe(true);
    // 理由を記録した人（作成担当）でなく、申請者（レビュー担当）でもない承認者
    await decideExclusion(db, approver(), { ...S06, decision: 'approved' });
    expect((await rowOf('40A-S06')).category).toBe('excluded');
  });

  it('差戻しは理由が必須で、差し戻すと申請し直せる。取り下げもできる', async () => {
    await expect(
      decideExclusion(db, approver(), { ...S06, decision: 'returned', note: ' ' }),
    ).rejects.toBeInstanceOf(ValidationError);
    const returned = await decideExclusion(db, approver(), {
      ...S06,
      decision: 'returned',
      note: '（テスト）水ストレスの評価の出典を理由に書いてください。',
    });
    expect(returned.note).toContain('出典');
    expect((await loadExclusionStatus(db, author(), S06)).state.state).toBe('returned');
    expect((await rowOf('40A-S06')).category).toBe('undetermined');

    await requestExclusion(db, author(), S06);
    expect((await loadExclusionStatus(db, author(), S06)).state.state).toBe('requested');
    await expect(requestExclusion(db, author(), S06)).rejects.toBeInstanceOf(ValidationError);
    await withdrawExclusion(db, author(), S06);
    expect((await loadExclusionStatus(db, author(), S06)).state.state).toBe('not_requested');
  });

  it('理由の無い判断・未判定は申請できない', async () => {
    await expect(
      requestExclusion(db, author(), {
        source: 'project_assessment',
        itemId: esrs40aSampleItemId('40A-S08'),
        projectFrameworkId: PF_40A,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(TRIAL_ASSESSMENT_IDS['40A-S08']).toBeDefined();
  });

  it('SSBJ の評価の対象外も同じ規則で承認できる（申請中の 1 件）', async () => {
    const itemId = pendingSsbjExclusionItemId(fixture)!;
    expect(itemId).toBeTruthy();
    const target: ExclusionTargetInput = {
      source: 'ssbj_assessment',
      itemId,
      reportingPeriodId: PERIOD_IDS.fy2026,
    };
    const ssbjRow = async () => {
      const matrix = await loadRequirementMatrix(db, author(), { projectId: IDS.projects.fy2026 });
      return matrix.rows.find((r) => r.itemId === itemId)!;
    };
    expect((await ssbjRow()).category).toBe('undetermined');
    const event = await decideExclusion(db, approver(), { ...target, decision: 'approved' });
    expect(acceptedOnReplay('requirementExclusionEvents', event)).toBe(true);
    expect((await ssbjRow()).category).toBe('excluded');
  });

  it('他の組織の要求事項・期間は「見つかりません」', async () => {
    await expect(
      decideExclusion(db, otherTenantApprover(), { ...S06, decision: 'approved' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requestExclusion(
        db,
        ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], ORG_IDS.soten),
        { source: 'ssbj_assessment', itemId: S06.itemId, reportingPeriodId: PERIOD_IDS.fy2026 },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('閲覧だけの役割は申請できない', async () => {
    await expect(requestExclusion(db, viewer(), S06)).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('判断の区分（exclusionDecision）', () => {
  it('承認待ちで kind が「未判定」でも、行から対象外・非重要の区分が分かる（ラベルに頼らない）', async () => {
    const rows = async () => {
      const detail = await getProject(db, author(), IDS.projects.fy2026);
      const view = detail.frameworks.find((f) => f.projectFramework.id === PF_40A)!;
      return (await buildRequirementRows(db, author(), detail, view)).rows;
    };
    const pending = (await rows()).find((r) => r.item.id === S06.itemId)!;
    expect(pending.decision.kind).toBe('not_assessed');
    expect(pending.decision.exclusionDecision).toBe('not_applicable');
    const applicable = (await rows()).find((r) => r.item.id === esrs40aSampleItemId('40A-S01'))!;
    expect(applicable.decision.exclusionDecision).toBeNull();

    await decideExclusion(db, approver(), { ...S06, decision: 'approved' });
    const approved = (await rows()).find((r) => r.item.id === S06.itemId)!;
    expect(approved.decision.kind).toBe('not_applicable');
    expect(approved.decision.exclusionDecision).toBe('not_applicable');
  });
});

describe('承認待ちの一覧（ホームの Attention。listPendingExclusions）', () => {
  it('組織の承認待ち（40a の S06 と SSBJ の 1 件）を、詳細の行き先付きで返す。書き込まない', async () => {
    const spy = new WriteDetectingDbClient(db);
    const pending = await listPendingExclusions(spy, approver());
    expect(spy.writes).toEqual([]);
    const s06 = pending.find((p) => p.itemId === S06.itemId)!;
    expect(s06).toMatchObject({
      itemCode: '40A-S06',
      source: 'project_assessment',
      href: `/enterprise/disclosure-projects/${IDS.projects.fy2026}/requirements/${S06.itemId}`,
    });
    const ssbjItemId = pendingSsbjExclusionItemId(fixture)!;
    // SSBJ の詳細はヘッダーの年度で開くため、申請の年度を ?period= で明示する
    expect(pending.find((p) => p.itemId === ssbjItemId)?.href).toBe(
      `/enterprise/disclosures/ssbj/requirements/${ssbjItemId}?period=${PERIOD_IDS.fy2026}`,
    );
    expect(pending).toHaveLength(2);
  });

  it('SSBJ の分析条件で適用しない基準の要求事項は、詳細が開けない（404）ので承認待ちに数えない', async () => {
    const ssbjItemId = pendingSsbjExclusionItemId(fixture)!;
    // Fixture の SSBJ の申請は実務対応基準第1号の要求事項（実務-9）。実務対応基準を適用しない条件にする
    await saveSsbjSettings(db, author(), {
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
    const period = fixture.periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
    expect(await loadSsbjRequirementDetail(db, approver(), period, ssbjItemId)).toBeNull();

    const pending = await listPendingExclusions(db, approver());
    expect(pending.map((p) => p.itemId)).not.toContain(ssbjItemId);
    expect(pending.map((p) => p.itemCode)).toEqual(['40A-S06']);
  });

  it('承認・取り下げた申請は出さない。他の組織・閲覧権限の無い役割には何も返さない', async () => {
    await decideExclusion(db, approver(), { ...S06, decision: 'approved' });
    const after = await listPendingExclusions(db, approver());
    expect(after.map((p) => p.itemId)).not.toContain(S06.itemId);
    expect(after).toHaveLength(1);
    expect(await listPendingExclusions(db, otherTenantApprover())).toEqual([]);
    const site = ctxFor('site-user@demo.local', ['site_contributor']);
    expect(await listPendingExclusions(db, site)).toEqual([]);
  });
});
