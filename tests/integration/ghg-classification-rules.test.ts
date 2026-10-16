import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError } from '@/lib/authorization/can';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import {
  GHG_FIXTURE_IDS,
  GHG_VERIFICATION_UNIT_IDS,
  LOGI_RULE_RATIONALE,
} from '@/lib/fixtures/ghg-verification';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { compactRow } from '@/lib/repositories/demo-compact';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import {
  applyDemoEdits,
  decodeDemoEdits,
  encodeDemoEditStream,
  type DemoEdit,
} from '@/lib/repositories/demo-edit-codec';
import { runCalculation } from '@/lib/services/ghg/calculation';
import {
  approvalBlockedReason,
  approveRule,
  listClassificationRules,
  listDoubleCountChecks,
  proposeRule,
  protocolScopesOfMatch,
  withdrawRule,
  type ProposeRuleInput,
} from '@/lib/services/ghg/classification-rules';
import type { AuthorizationContext, OrganizationType, RoleKey, Uuid } from '@/types/domain';

/**
 * 区分規則（plan §2.3 classification-rules.ts・CR-07・int:ghg-classification-rules）。
 *  - 提案は本人名義・根拠は必須。承認は提案者以外の enterprise.data.approve（本人の提案は AuthorizationError）
 *  - 再分類は Scope1 と Scope3 カテゴリ4 の間だけ。条件は既定区分が 1 つに決まるもの
 *  - 承認すると算定の報告区分が変わる（委託物流が Scope1 へ）。重なる承認済みの規則があれば承認しない
 *  - 取り下げは metric.manage か data.approve。Demo の Cookie から戻した承認も同じ規則を通る
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
  unitScopeIds: Uuid[] = [],
  organizationId: Uuid = ORG_IDS.aomi,
  organizationType: OrganizationType = 'enterprise',
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType,
      organizationName: 'テスト',
      roleKeys,
      unitScopeIds,
    },
    engagementIds: [],
    demo: true,
  };
}

const proposer = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
/** 提案者が承認の権限も持つ（職務分離で断る） */
const proposerWithApproval = () =>
  ctxFor('sustainability@demo.local', ['sustainability_manager', 'approver']);
const approver = () => ctxFor('approver@demo.local', ['approver']);
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const other = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], [], ORG_IDS.soten);

const RULE = GHG_FIXTURE_IDS.rule;

function proposal(over: Partial<ProposeRuleInput> = {}): ProposeRuleInput {
  return {
    code: 'LOGI-02',
    name: '委託物流（主要製品）を Scope1 とする（改訂）',
    match: { activityKinds: ['transport'], carrierKinds: ['contracted'], cargoKinds: ['主要製品'] },
    reportedScope: 'scope1',
    rationale: '（架空）主要製品の輸送は自社便と同じ管理をしているため',
    disclosureNote: '（架空）委託物流（主要製品）は組織の算定ルールにより Scope1 に含めています。',
    effectiveFromPeriodId: GHG_FIXTURE_IDS.period,
    effectiveToPeriodId: null,
    ...over,
  };
}

describe('listClassificationRules', () => {
  it('Fixture の LOGI-01 は承認待ち（提案者・条件の文・適用開始の期間）', async () => {
    const rules = await listClassificationRules(db, reviewer());
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      proposerName: '海野 みどり',
      approverName: null,
      matchText: '輸送 × 委託（自社が荷主の外部業者） × 貨物 主要製品',
    });
    expect(rules[0]!.rule).toMatchObject({ status: 'proposed', rationale: LOGI_RULE_RATIONALE });
    expect(rules[0]!.fromPeriod?.code).toBe('CY2025');
    expect(await listClassificationRules(db, other())).toEqual([]);
  });
});

describe('approveRule（職務分離）', () => {
  it('提案者本人は承認できない（承認の権限があっても）。権限の無い人も承認できない', async () => {
    await expect(approveRule(db, proposerWithApproval(), RULE)).rejects.toThrow(
      new AuthorizationError('提案者は承認できません。'),
    );
    await expect(approveRule(db, proposer(), RULE)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(approveRule(db, reviewer(), RULE)).rejects.toBeInstanceOf(AuthorizationError);
    const rule = fixture.ghgClassificationRules.find((r) => r.id === RULE)!;
    expect(approvalBlockedReason(proposerWithApproval(), rule)).toBe(
      '提案者は承認できません（職務分離）。',
    );
    expect(approvalBlockedReason(approver(), rule)).toBeNull();
    expect(rule.status).toBe('proposed');
  });

  it('最終承認者が承認すると本人名義で記録し、算定で委託物流が報告区分 Scope1 になる', async () => {
    const before = await runCalculation(db, proposer(), {
      periodId: GHG_FIXTURE_IDS.period,
      unitIds: [...GHG_VERIFICATION_UNIT_IDS],
    });
    if (!before.ok) throw new Error('算定できません');
    const contractedBefore = before.lines.filter(
      (l) => l.unitId === UNIT_IDS.east && l.method === 'tonkm_improved',
    );
    expect(contractedBefore.every((l) => l.reportedScope === 'scope3_cat4')).toBe(true);

    const approved = await approveRule(db, approver(), RULE);
    expect(approved).toMatchObject({
      status: 'approved',
      approvedBy: userId('approver@demo.local'),
    });
    const audit = fixture.auditEvents.find((e) => e.resourceId === RULE)!;
    expect(audit).toMatchObject({
      eventType: 'data_approved',
      resourceType: 'ghg_classification_rule',
    });
    await expect(approveRule(db, approver(), RULE)).rejects.toThrow(/承認待ちの規則だけ/);

    const after = await runCalculation(db, proposer(), {
      periodId: GHG_FIXTURE_IDS.period,
      unitIds: [...GHG_VERIFICATION_UNIT_IDS],
    });
    if (!after.ok) throw new Error('算定できません');
    const contracted = after.lines.filter(
      (l) => l.unitId === UNIT_IDS.east && l.method === 'tonkm_improved',
    );
    expect(contracted.length).toBeGreaterThan(0);
    expect(contracted.every((l) => l.protocolScope === 'scope3_cat4')).toBe(true);
    expect(
      contracted.every((l) => l.reportedScope === 'scope1' && l.classificationRuleId === RULE),
    ).toBe(true);
  });

  it('Cookie から戻した承認は同じ規則で受け付ける（提案者と別人・承認の権限）', async () => {
    const approved = await approveRule(db, approver(), RULE);
    const v = compactRow(
      'ghgClassificationRules',
      approved as unknown as Record<string, unknown>,
      fixture,
    );
    if (!v) throw new Error('Cookie に載らない形です');
    const restored = createFixtureDb();
    applyDemoEdits(
      restored,
      decodeDemoEdits(
        encodeDemoEditStream([{ t: 'ghgClassificationRules', id: RULE, v } as DemoEdit]),
      ),
    );
    expect(restored.ghgClassificationRules.find((r) => r.id === RULE)).toMatchObject({
      status: 'approved',
      approvedBy: userId('approver@demo.local'),
    });
  });

  it('同じ活動に当てはまる承認済みの規則があれば承認しない（取り下げてから）', async () => {
    const second = await proposeRule(db, proposer(), proposal());
    await approveRule(db, approver(), RULE);
    await expect(approveRule(db, approver(), second.id)).rejects.toThrow(
      /承認済みの規則「委託物流（主要製品）を自社便と同様に Scope1 とする」（LOGI-01）があります/,
    );
    await withdrawRule(db, approver(), RULE, { reason: '改訂版へ' });
    await expect(approveRule(db, approver(), second.id)).resolves.toMatchObject({
      status: 'approved',
    });
  });
});

describe('proposeRule', () => {
  it('本人名義・承認待ちで記録する（既定区分は条件から決まる）', async () => {
    const rule = await proposeRule(db, proposer(), proposal());
    expect(rule).toMatchObject({
      status: 'proposed',
      proposedBy: userId('sustainability@demo.local'),
      protocolScope: 'scope3_cat4',
      reportedScope: 'scope1',
      match: {
        activityKinds: ['transport'],
        carrierKinds: ['contracted'],
        cargoKinds: ['main_product'],
      },
    });
    const audit = fixture.auditEvents.find((e) => e.resourceId === rule.id)!;
    expect(audit).toMatchObject({ eventType: 'settings_changed' });
  });

  it('根拠は必須・既定区分が 1 つに決まらない条件・Scope2 への移動・同じコードは断る', async () => {
    await expect(proposeRule(db, proposer(), proposal({ rationale: '  ' }))).rejects.toThrow(
      /根拠を入力してください/,
    );
    await expect(
      proposeRule(db, proposer(), proposal({ match: { activityKinds: ['transport'] } })),
    ).rejects.toThrow(/既定区分が 1 つに決まるよう/);
    await expect(
      proposeRule(db, proposer(), proposal({ reportedScope: 'scope2' })),
    ).rejects.toThrow(/Scope1 か Scope3 カテゴリ4/);
    await expect(
      proposeRule(db, proposer(), proposal({ reportedScope: 'scope3_cat4' })),
    ).rejects.toThrow(/既定区分と同じ/);
    await expect(proposeRule(db, proposer(), proposal({ code: 'LOGI-01' }))).rejects.toThrow(
      /既にあります/,
    );
    await expect(proposeRule(db, reviewer(), proposal())).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it('条件から決まる既定区分（輸送 × 委託 → Scope3 カテゴリ4、輸送 × 自社便 → Scope1）', () => {
    expect(
      protocolScopesOfMatch({ activityKinds: ['transport'], carrierKinds: ['contracted'] }),
    ).toEqual(['scope3_cat4']);
    expect(
      protocolScopesOfMatch({ activityKinds: ['transport'], carrierKinds: ['own_fleet'] }),
    ).toEqual(['scope1']);
    expect(protocolScopesOfMatch({ activityKinds: ['electricity'] }).sort()).toEqual([
      'scope2',
      'scope2_location',
    ]);
  });

  it('デモでは区分規則は 6 件まで', async () => {
    for (const n of [2, 3, 4, 5, 6]) {
      await proposeRule(db, proposer(), proposal({ code: `R-${n}` }));
    }
    await expect(proposeRule(db, proposer(), proposal({ code: 'R-7' }))).rejects.toThrow(
      /6 件まで/,
    );
  });
});

describe('withdrawRule', () => {
  it('方針の管理か承認の権限で取り下げる（本人名義）。取り下げ済み・権限なしは断る', async () => {
    await expect(withdrawRule(db, reviewer(), RULE, { reason: '' })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    const withdrawn = await withdrawRule(db, proposer(), RULE, { reason: '内容を直して出し直す' });
    expect(withdrawn).toMatchObject({
      status: 'withdrawn',
      withdrawnBy: userId('sustainability@demo.local'),
    });
    await expect(withdrawRule(db, approver(), RULE, { reason: '' })).rejects.toThrow(
      /取り下げ済み/,
    );
    // 取り下げた規則のコードは使い直せる
    await expect(proposeRule(db, proposer(), proposal({ code: 'LOGI-01' }))).resolves.toMatchObject(
      { code: 'LOGI-01', status: 'proposed' },
    );
  });
});

describe('listDoubleCountChecks（二重計上の確認。規則ベース・止めない）', () => {
  it('委託物流を Scope1 へ動かす規則が効く期間に、Scope3 カテゴリ1 の内訳に物流の行があれば知らせる', async () => {
    // CY2025 には Scope3 カテゴリ1 の内訳が無い
    expect(await listDoubleCountChecks(db, reviewer(), GHG_FIXTURE_IDS.period)).toEqual([]);
    // FY2026 の内訳には物流の購入（国内輸送）がある。LOGI-01 は CY2025 から終わりなしで効く
    const checks = await listDoubleCountChecks(db, reviewer(), PERIOD_IDS.fy2026);
    expect(checks.map((c) => c.rule.code)).toEqual(['LOGI-01']);
    expect(checks[0]!.warnings[0]!.message).toContain('Scope3 の内訳');
    // 取り下げた規則は数えない
    await withdrawRule(db, proposer(), RULE, { reason: '' });
    expect(await listDoubleCountChecks(db, reviewer(), PERIOD_IDS.fy2026)).toEqual([]);
  });
});
