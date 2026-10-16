import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import { ORG_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { GHG_FIXTURE_IDS, GHG_VERIFICATION_UNIT_IDS } from '@/lib/fixtures/ghg-verification';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { runCalculation } from '@/lib/services/ghg/calculation';
import {
  planRunPosting,
  postRunToDataPoints,
  POSTED_SCOPES,
  runShortId,
} from '@/lib/services/ghg/post-to-data-points';
import type { AuthorizationContext, OrganizationType, RoleKey, Uuid } from '@/types/domain';
import { WriteDetectingDbClient } from '../support/write-detecting-db';

/**
 * 算定の記録から Data Point への下書き反映（plan §2.3 post-to-data-points.ts・CR-10・K4）。
 *  - 拠点 ×（scope1・scope2・scope2_location）の Data Point に、報告区分の値（拠点×区分の段の丸め後）を
 *    「下書きの新しい版」（出所 calculation）として積む。承認はしない（既存の承認フローで確定する）
 *  - 算定内訳（data_point_calculations）に「Σ 算定行（記録 #短縮 ID）」の要約を残す
 *  - 承認済みの値の上書きは既存の確認（レビュー権限）＋利用者の確認を通し、下書きへ戻して承認後の変更として残す
 *  - 入力が変わった記録・審査中の Data Point・締め済みの期間には反映しない
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

const author = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
/** データの書込はできるがレビュー権限の無い人（全拠点を担当） */
const writerWithoutReview = () => ctxFor('site-user@demo.local', ['site_contributor']);
const siteUser = () => ctxFor('site-user@demo.local', ['site_contributor'], [UNIT_IDS.east]);
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const other = () =>
  ctxFor('other-enterprise-admin@demo.local', ['enterprise_admin'], [], ORG_IDS.soten);

const CY = GHG_FIXTURE_IDS.period;
const R1 = GHG_FIXTURE_IDS.run;

function cyDataPoints() {
  return fixture.dataPoints.filter(
    (dp) => dp.organizationId === ORG_IDS.aomi && dp.reportingPeriodId === CY && !dp.deletedAt,
  );
}

function metricCodeOf(metricId: Uuid): string {
  return fixture.metrics.find((m) => m.id === metricId)!.code;
}

/** 区分規則 LOGI-01 を最終承認者の名義で承認済みにする（S1 の承認の操作の代わり） */
function approveRule(): void {
  const rule = fixture.ghgClassificationRules.find((r) => r.id === GHG_FIXTURE_IDS.rule)!;
  Object.assign(rule, {
    status: 'approved',
    approvedBy: userId('approver@demo.local'),
    approvedAt: '2026-10-16T01:00:00.000Z',
  });
}

describe('planRunPosting（反映の範囲の下見。書き込み 0）', () => {
  it('R-1 は 5 拠点 × 3 区分＝15 件の新規。値は報告区分の拠点×区分の丸め後', async () => {
    const guarded = new WriteDetectingDbClient(db);
    const plan = await planRunPosting(guarded, author(), R1);
    expect(guarded.writes).toEqual([]);
    expect(plan.blockedReason).toBeNull();
    expect(plan.targets).toHaveLength(15);
    expect(plan.counts).toMatchObject({ create: 15, new_version: 0, approved_overwrite: 0 });
    expect(plan.postable).toBe(15);
    expect(new Set(plan.targets.map((t) => t.scope))).toEqual(new Set(POSTED_SCOPES));
    // Scope3 カテゴリ4（既定区分の参考）は反映しない（収集は本社の指標・Scope1・2 の検証の範囲外）
    expect(plan.targets.some((t) => (t.scope as string) === 'scope3_cat4')).toBe(false);
    const eastScope1 = plan.targets.find(
      (t) => t.unitId === UNIT_IDS.east && t.scope === 'scope1',
    )!;
    const site = plan.run.summary!.reported.sites.find(
      (s) => s.unitId === UNIT_IDS.east && s.scope === 'scope1',
    )!;
    expect(eastScope1.value).toBe(site.rounded);
    expect(eastScope1.unrounded).toBe(site.unrounded);
  });

  it('他社の記録は見つからない。閲覧の権限は企業のメンバー全員（反映できるかは別に示す）', async () => {
    await expect(planRunPosting(db, other(), R1)).rejects.toBeInstanceOf(NotFoundError);
    const plan = await planRunPosting(db, reviewer(), R1);
    expect(plan.permissionReason).not.toBeNull();
  });
});

describe('postRunToDataPoints', () => {
  it('下書きの版（出所 calculation）として積み、承認しない。算定内訳に「Σ 算定行（記録 #短縮 ID）」', async () => {
    expect(cyDataPoints()).toHaveLength(0);
    const result = await postRunToDataPoints(db, author(), R1, { view: 'reported' });
    expect(result).toMatchObject({ created: 15, updated: 0, approvedOverwritten: 0 });

    const dps = cyDataPoints();
    expect(dps).toHaveLength(15);
    // 承認しない（既存の承認フローで確定する）
    expect(dps.every((dp) => dp.status === 'draft')).toBe(true);
    expect(dps.some((dp) => dp.approvedAt !== null || dp.approvedBy !== null)).toBe(false);
    expect(dps.every((dp) => dp.unitOfMeasure === 't-CO2e' && dp.valueKind === 'actual')).toBe(
      true,
    );
    expect(new Set(dps.map((dp) => metricCodeOf(dp.metricId)))).toEqual(new Set(POSTED_SCOPES));
    expect(new Set(dps.map((dp) => dp.unitId))).toEqual(new Set(GHG_VERIFICATION_UNIT_IDS));
    // 境界は既存の数値の登録と同じ規則（全部連結の拠点は「連結」、それ以外は「単体」）
    const east = dps.find((dp) => dp.unitId === UNIT_IDS.east)!;
    const th = dps.find((dp) => dp.unitId === GHG_FIXTURE_IDS.units.th)!;
    expect(east.boundary).toBe('連結');
    expect(th.boundary).toBe('単体');

    const short = runShortId(R1);
    for (const dp of dps) {
      const version = fixture.dataPointVersions.find((v) => v.id === dp.currentVersionId)!;
      expect(version).toMatchObject({
        sourceType: 'calculation',
        status: 'draft',
        value: dp.value,
        versionNo: 1,
      });
      expect(version.sourceReference).toContain(`#${short}`);
      const calc = fixture.calculations.filter((c) => c.dataPointId === dp.id);
      expect(calc).toHaveLength(1);
      expect(calc[0]!.formula).toBe(`Σ 算定行（記録 #${short}）`);
      expect(calc[0]!.result).toBe(dp.value);
      expect(calc[0]!.inputs.length).toBeGreaterThan(0);
      expect(calc[0]!.inputs.every((i) => i.unit === 't-CO2e')).toBe(true);
    }
    const eastScope1 = dps.find(
      (dp) => dp.unitId === UNIT_IDS.east && metricCodeOf(dp.metricId) === 'scope1',
    )!;
    const run = fixture.ghgCalculationRuns.find((r) => r.id === R1)!;
    expect(eastScope1.value).toBe(
      run.summary!.reported.sites.find((s) => s.unitId === UNIT_IDS.east && s.scope === 'scope1')!
        .rounded,
    );
    // 監査ログは既存の種類（下書き反映＝data_updated）を Data Point ごとに
    const audits = fixture.auditEvents.filter(
      (e) => e.eventType === 'data_updated' && dps.some((dp) => dp.id === e.resourceId),
    );
    expect(audits).toHaveLength(15);
  });

  it('同じ値なら新しい版を作らない（2 回目は反映するものが無い）', async () => {
    await postRunToDataPoints(db, author(), R1, { view: 'reported' });
    const versions = fixture.dataPointVersions.length;
    const plan = await planRunPosting(db, author(), R1);
    expect(plan.counts.unchanged).toBe(15);
    expect(plan.postable).toBe(0);
    await expect(
      postRunToDataPoints(db, author(), R1, { view: 'reported' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fixture.dataPointVersions).toHaveLength(versions);
  });

  it('区分規則の承認後の記録 R-2 は、下書きの Data Point に新しい版を積む（再分類分が Scope1 に入る）', async () => {
    await postRunToDataPoints(db, author(), R1, { view: 'reported' });
    approveRule();
    const r2 = await runCalculation(db, author(), {
      periodId: CY,
      unitIds: [...GHG_VERIFICATION_UNIT_IDS],
    });
    if (!r2.ok) throw new Error('算定できるはず');
    const plan = await planRunPosting(db, author(), r2.run.id);
    // EAST の Scope1 だけが変わる（委託物流が報告区分で Scope1 へ移る）
    expect(plan.counts).toMatchObject({ new_version: 1, unchanged: 14, create: 0 });
    const result = await postRunToDataPoints(db, author(), r2.run.id, { view: 'reported' });
    expect(result.updated).toBe(1);
    const eastScope1 = cyDataPoints().find(
      (dp) => dp.unitId === UNIT_IDS.east && metricCodeOf(dp.metricId) === 'scope1',
    )!;
    const site = r2.run.summary!.reported.sites.find(
      (s) => s.unitId === UNIT_IDS.east && s.scope === 'scope1',
    )!;
    expect(eastScope1.value).toBe(site.rounded);
    expect(eastScope1.status).toBe('draft');
    const version = fixture.dataPointVersions.find((v) => v.id === eastScope1.currentVersionId)!;
    expect(version.versionNo).toBe(2);
    expect(version.sourceReference).toContain(`#${runShortId(r2.run.id)}`);
  });

  it('承認済みの値の上書きは、レビュー権限と確認が要る。下書きへ戻し、承認後の変更として残す', async () => {
    await postRunToDataPoints(db, author(), R1, { view: 'reported' });
    const target = cyDataPoints().find(
      (dp) => dp.unitId === UNIT_IDS.east && metricCodeOf(dp.metricId) === 'scope1',
    )!;
    Object.assign(target, {
      status: 'approved',
      approvedBy: userId('approver@demo.local'),
      approvedAt: '2026-10-16T02:00:00.000Z',
    });
    approveRule();
    const r2 = await runCalculation(db, author(), {
      periodId: CY,
      unitIds: [...GHG_VERIFICATION_UNIT_IDS],
    });
    if (!r2.ok) throw new Error('算定できるはず');
    const plan = await planRunPosting(db, author(), r2.run.id);
    expect(plan.counts.approved_overwrite).toBe(1);

    // レビュー権限の無い人は承認済みの値を書き換えられない（既存の確認と同じ。DB のトリガも同じ）
    await expect(
      postRunToDataPoints(db, writerWithoutReview(), r2.run.id, {
        view: 'reported',
        acknowledgeApprovedOverwrite: true,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    // 確認（承認済みの値を下書きへ戻す）が無ければ断る
    await expect(
      postRunToDataPoints(db, author(), r2.run.id, { view: 'reported' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(target.status).toBe('approved');

    const result = await postRunToDataPoints(db, author(), r2.run.id, {
      view: 'reported',
      acknowledgeApprovedOverwrite: true,
    });
    expect(result.approvedOverwritten).toBe(1);
    const after = cyDataPoints().find((dp) => dp.id === target.id)!;
    expect(after.status).toBe('draft');
    expect(after.changedAfterApproval).toBe(true);
    expect(after.approvedBy).toBe(userId('approver@demo.local'));
  });

  it('審査中（提出済み・レビュー中）の Data Point には反映しない（理由を示し、他は反映する）', async () => {
    await postRunToDataPoints(db, author(), R1, { view: 'reported' });
    const target = cyDataPoints().find(
      (dp) => dp.unitId === UNIT_IDS.east && metricCodeOf(dp.metricId) === 'scope1',
    )!;
    target.status = 'in_review';
    approveRule();
    const r2 = await runCalculation(db, author(), {
      periodId: CY,
      unitIds: [...GHG_VERIFICATION_UNIT_IDS],
    });
    if (!r2.ok) throw new Error('算定できるはず');
    const plan = await planRunPosting(db, author(), r2.run.id);
    const skipped = plan.targets.find((t) => t.dataPoint?.id === target.id)!;
    expect(skipped.action).toBe('skip_in_review');
    expect(skipped.reason).toContain('審査中');
    expect(plan.postable).toBe(0);
    const value = target.value;
    await expect(
      postRunToDataPoints(db, author(), r2.run.id, { view: 'reported' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(target.value).toBe(value);
  });

  it('入力が変わった記録（再算定が必要）からは反映しない', async () => {
    approveRule();
    const plan = await planRunPosting(db, author(), R1);
    expect(plan.inputState).toBe('stale');
    expect(plan.blockedReason).toContain('算定をやり直して');
    await expect(
      postRunToDataPoints(db, author(), R1, { view: 'reported' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(cyDataPoints()).toHaveLength(0);
  });

  it('締め済みの期間には反映しない', async () => {
    fixture.periods.find((p) => p.id === CY)!.status = 'closed';
    const plan = await planRunPosting(db, author(), R1);
    expect(plan.blockedReason).toContain('締め済み');
    await expect(
      postRunToDataPoints(db, author(), R1, { view: 'reported' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('権限: データの書込権限の無い人・担当外の拠点を含む記録・他社は反映できない', async () => {
    await expect(
      postRunToDataPoints(db, reviewer(), R1, { view: 'reported' }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      postRunToDataPoints(db, siteUser(), R1, { view: 'reported' }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(postRunToDataPoints(db, other(), R1, { view: 'reported' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(cyDataPoints()).toHaveLength(0);
  });

  it('報告区分以外の見方では反映しない（既定区分は参考の値）', async () => {
    await expect(
      postRunToDataPoints(db, author(), R1, {
        view: 'protocol' as unknown as 'reported',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
