import { beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '@/lib/authorization/can';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import {
  evaluateApplicability,
  evaluateCondition,
  loadApplicability,
} from '@/lib/services/disclosure-applicability';
import type {
  AuthorizationContext,
  DisclosureItemCondition,
  DisclosureResponse,
  ReportingPeriod,
  RoleKey,
} from '@/types/domain';

/**
 * 企業別の適用質問判定（CDP-P0-002）の Integration テスト。
 * 判定は規則ベース（AI ではない）ので、根拠が再現することも検証する。
 */

let db: DemoDbClient;
let fixture: FixtureDb;
let current: ReportingPeriod;

function ctxFor(email: string, organizationId: string, roleKeys: RoleKey[]): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const manager = () => ctxFor('sustainability@demo.local', ORG_IDS.aomi, ['sustainability_manager']);
const otherOrg = () =>
  ctxFor('other-enterprise-admin@demo.local', ORG_IDS.soten, ['enterprise_admin']);

function condition(over: Partial<DisclosureItemCondition> = {}): DisclosureItemCondition {
  return {
    id: 'c1',
    itemId: 'i1',
    dependsOnItemCode: 'C1.1',
    operator: 'equals',
    value: 'はい',
    ...over,
  };
}

function response(over: Partial<DisclosureResponse> = {}): DisclosureResponse {
  return {
    id: 'r1',
    organizationId: ORG_IDS.aomi,
    itemId: 'i0',
    reportingPeriodId: PERIOD_IDS.fy2026,
    status: 'approved',
    currentVersionId: null,
    answerText: null,
    answerNumeric: null,
    answerChoice: [],
    ownerUserId: null,
    reviewerUserId: null,
    approvedAt: null,
    approvedBy: null,
    previousResponseId: null,
    carryForwardDecision: null,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    createdBy: null,
    updatedBy: null,
    ...over,
  };
}

beforeEach(async () => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
  const periods = await db.select('periods', { where: { organizationId: ORG_IDS.aomi } });
  current = periods.find((p) => p.id === PERIOD_IDS.fy2026)!;
});

describe('条件評価（規則ベース）', () => {
  it('equals: 一致すれば適用、しなければ非適用', () => {
    expect(evaluateCondition(condition(), response({ answerChoice: ['はい'] })).satisfied).toBe(
      true,
    );
    expect(evaluateCondition(condition(), response({ answerChoice: ['いいえ'] })).satisfied).toBe(
      false,
    );
  });

  it('not_equals: 指定値以外なら適用', () => {
    const c = condition({ operator: 'not_equals', value: '設定していない' });
    expect(evaluateCondition(c, response({ answerChoice: ['絶対量目標'] })).satisfied).toBe(true);
    expect(evaluateCondition(c, response({ answerChoice: ['設定していない'] })).satisfied).toBe(
      false,
    );
  });

  it('in: カンマ区切りのいずれかに一致すれば適用', () => {
    const c = condition({ operator: 'in', value: '限定的保証, 合理的保証' });
    expect(evaluateCondition(c, response({ answerChoice: ['合理的保証'] })).satisfied).toBe(true);
    expect(evaluateCondition(c, response({ answerChoice: ['受けていない'] })).satisfied).toBe(
      false,
    );
  });

  it('exists: 回答があれば適用', () => {
    const c = condition({ operator: 'exists', value: '' });
    expect(evaluateCondition(c, response({ answerNumeric: 48210 })).satisfied).toBe(true);
  });

  it('依存先が未回答なら判定不能（要確認）', () => {
    expect(evaluateCondition(condition(), null).satisfied).toBeNull();
    expect(
      evaluateCondition(condition(), response({ status: 'not_started' })).satisfied,
    ).toBeNull();
    // status は draft でも中身が空なら判定できない
    expect(evaluateCondition(condition(), response({ status: 'draft' })).satisfied).toBeNull();
  });

  it('判定根拠に依存先の質問コードが必ず含まれる', () => {
    for (const op of ['equals', 'not_equals', 'in', 'exists'] as const) {
      const r = evaluateCondition(
        condition({ operator: op }),
        response({ answerChoice: ['はい'] }),
      );
      expect(r.reason).toContain('C1.1');
    }
    expect(evaluateCondition(condition(), null).reason).toContain('C1.1');
  });
});

describe('適用判定の実行（CDP-P0-002）', () => {
  it('全質問に判定が付き、保存される', async () => {
    const ctx = manager();
    const items = await db.select('disclosureItems', {});
    const cdpItemCount = items.filter((i) => i.code.startsWith('C')).length;

    const { decisions, counts } = await evaluateApplicability(db, ctx, 'cdp', current);

    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.length).toBeLessThanOrEqual(cdpItemCount);
    expect(counts.applicable + counts.not_applicable + counts.needs_check).toBe(decisions.length);

    const saved = await loadApplicability(db, ctx, current.id);
    expect(saved.size).toBe(decisions.length);
    for (const d of decisions) {
      expect(saved.get(d.itemId)?.applicability).toBe(d.applicability);
      expect(saved.get(d.itemId)?.reason).not.toBe('');
    }
  });

  it('条件付き質問には条件由来の根拠が付き、条件無しは既定で適用になる', async () => {
    const { decisions } = await evaluateApplicability(db, manager(), 'cdp', current);
    const byCode = new Map(decisions.map((d) => [d.itemCode, d]));

    // C1.1b は C1.1 に依存する（Fixture の条件）
    const conditional = byCode.get('C1.1b');
    expect(conditional).toBeDefined();
    expect(conditional!.reason).toContain('C1.1');

    // C0.1 には条件が無い
    const unconditional = byCode.get('C0.1');
    expect(unconditional?.applicability).toBe('applicable');
    expect(unconditional?.reason).toContain('適用条件が設定されていない');
  });

  it('同じ入力なら何度実行しても同じ判定になる（規則ベースの再現性）', async () => {
    const ctx = manager();
    const first = await evaluateApplicability(db, ctx, 'cdp', current);
    const second = await evaluateApplicability(db, ctx, 'cdp', current);

    expect(second.decisions.map((d) => `${d.itemCode}:${d.applicability}:${d.reason}`)).toEqual(
      first.decisions.map((d) => `${d.itemCode}:${d.applicability}:${d.reason}`),
    );
    // 再実行しても行が増えない（unique 制約に合わせて更新する）
    const saved = await loadApplicability(db, ctx, current.id);
    expect(saved.size).toBe(first.decisions.length);
  });

  it('依存先の回答に応じて 要確認 → 適用 → 非適用 と切り替わる', async () => {
    const ctx = manager();
    const responses = await db.select('disclosureResponses', {
      where: { organizationId: ORG_IDS.aomi, reportingPeriodId: current.id },
    });
    const items = await db.select('disclosureItems', {
      where: { id: { in: responses.map((r) => r.itemId) } },
    });
    const c11 = items.find((i) => i.code === 'C1.1');
    // 前提が崩れたらテストが素通りしないよう、ここで落とす
    expect(c11, 'Fixture に C1.1 の回答が必要です').toBeDefined();
    const target = responses.find((r) => r.itemId === c11!.id)!;
    expect(target).toBeDefined();

    // 当年度の C1.1 はまだ未回答なので、依存先の C1.1b は「要確認」
    const initial = await evaluateApplicability(db, ctx, 'cdp', current);
    expect(initial.decisions.find((d) => d.itemCode === 'C1.1b')?.applicability).toBe(
      'needs_check',
    );

    // 「はい」と回答すると適用になる
    await db.update('disclosureResponses', target.id, {
      status: 'approved',
      answerText: 'はい',
      answerChoice: ['はい'],
    });
    const affirmative = await evaluateApplicability(db, ctx, 'cdp', current);
    expect(affirmative.decisions.find((d) => d.itemCode === 'C1.1b')?.applicability).toBe(
      'applicable',
    );

    // 「いいえ」へ変えると非適用へ切り替わる
    await db.update('disclosureResponses', target.id, {
      status: 'approved',
      answerText: 'いいえ',
      answerChoice: ['いいえ'],
    });

    const { decisions } = await evaluateApplicability(db, ctx, 'cdp', current);
    const c11b = decisions.find((d) => d.itemCode === 'C1.1b');
    expect(c11b?.applicability).toBe('not_applicable');
    expect(c11b?.reason).toContain('はい');
  });

  it('他組織の期間を指定すると 404 相当になる（テナント分離）', async () => {
    await expect(evaluateApplicability(db, otherOrg(), 'cdp', current)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('他組織の判定結果は読めない（テナント分離）', async () => {
    await evaluateApplicability(db, manager(), 'cdp', current);
    const leaked = await loadApplicability(db, otherOrg(), current.id);
    expect(leaked.size).toBe(0);
  });

  it('開示の書き込み権限が無いロールは実行できない', async () => {
    const viewer = ctxFor('site-user@demo.local', ORG_IDS.aomi, ['viewer']);
    await expect(evaluateApplicability(db, viewer, 'cdp', current)).rejects.toThrow();
  });
});
