import { beforeEach, describe, expect, it } from 'vitest';
import { AuthorizationError } from '@/lib/authorization/can';
import { ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import {
  GHG_FIXTURE_IDS,
  GHG_FIXTURE_TONKM_POLICY,
  GHG_VERIFICATION_UNIT_IDS,
} from '@/lib/fixtures/ghg-verification';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { loadGhgInputs } from '@/lib/services/ghg/inputs';
import {
  DEFAULT_TONKM_POLICY,
  loadCalculationPolicy,
  saveCalculationPolicy,
  type SavePolicyInput,
} from '@/lib/services/ghg/policy';
import type { AuthorizationContext, OrganizationType, RoleKey, Uuid } from '@/types/domain';

/**
 * 算定方針（丸め・組織の単位換算・改良トンキロ法の組織の設定。plan §2.3 policy.ts・CR-03・CR-04・int:ghg-policy）。
 *  - 版を積む（前の版は残る）。同じ内容・別の操作で更新された後の保存は断る
 *  - 換算は次元をまたぐものだけ（同じ次元は内蔵の換算）。同じ次元の組が 2 つあれば断る（算定が決められない）
 *  - 期間に方針が無いときの初期値は、公的資料で確認できなかった扱いを「止める／警告」にする
 *  - 方針を変えると入力ハッシュが変わる（記録は「入力が変わった」になる）
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

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
const CY = GHG_FIXTURE_IDS.period;

async function base(): Promise<SavePolicyInput> {
  const overview = await loadCalculationPolicy(db, manager(), CY);
  return { periodId: CY, baseVersionNo: overview.current?.versionNo ?? null, ...overview.draft };
}

describe('loadCalculationPolicy', () => {
  it('Fixture の CY2025 は版 1（丸め 2 段・都市ガスの換算・改良トンキロ法の設定）', async () => {
    const overview = await loadCalculationPolicy(db, reviewer(), CY);
    expect(overview.current?.versionNo).toBe(1);
    expect(overview.versions).toHaveLength(1);
    expect(overview.draft.tonkm).toEqual(GHG_FIXTURE_TONKM_POLICY);
    expect(overview.draft.conversions[0]).toMatchObject({
      from: 'm3',
      to: 'Nm3',
      multiplier: 0.93,
    });
    expect(overview.names.get(userId('sustainability@demo.local'))).toBe('海野 みどり');
  });

  it('方針の無い期間の初期値: 告示の形・下限 10%・100% 超は止める・範囲外と海外は警告', async () => {
    const overview = await loadCalculationPolicy(db, reviewer(), PERIOD_IDS.fy2026);
    expect(overview.current).toBeNull();
    expect(overview.draft.rounding).toEqual([]);
    expect(overview.draft.tonkm).toEqual(DEFAULT_TONKM_POLICY);
    expect(DEFAULT_TONKM_POLICY).toMatchObject({
      shape: 'kokuji',
      minLoadPct: 10,
      over100: 'error',
      payloadOutOfRange: 'warn',
      overseas: 'warn',
    });
  });
});

describe('saveCalculationPolicy', () => {
  it('新しい版を積み（前の版は残る）、入力ハッシュが変わる', async () => {
    const before = await loadGhgInputs(db, manager(), {
      periodId: CY,
      unitIds: [...GHG_VERIFICATION_UNIT_IDS],
    });
    const input = await base();
    const saved = await saveCalculationPolicy(db, manager(), {
      ...input,
      rounding: [{ stage: 'month', digits: 0, unit: 'kg', method: 'truncate' }],
      notes: '（架空）月ごとに kg で切り捨て',
    });
    expect(saved).toMatchObject({ versionNo: 2, createdBy: userId('sustainability@demo.local') });
    expect(fixture.ghgCalculationPolicies.filter((p) => p.reportingPeriodId === CY)).toHaveLength(
      2,
    );
    const after = await loadGhgInputs(db, manager(), {
      periodId: CY,
      unitIds: [...GHG_VERIFICATION_UNIT_IDS],
    });
    expect(after.inputHash).not.toBe(before.inputHash);
    const audit = fixture.auditEvents.find((e) => e.resourceId === saved.id)!;
    expect(audit).toMatchObject({
      eventType: 'settings_changed',
      resourceType: 'ghg_calculation_policy',
    });
  });

  it('同じ内容・別の操作で更新された後の保存は断る', async () => {
    const input = await base();
    await expect(saveCalculationPolicy(db, manager(), input)).rejects.toThrow(/前の版と同じ内容/);
    await saveCalculationPolicy(db, manager(), { ...input, notes: '版 2' });
    await expect(
      saveCalculationPolicy(db, manager(), { ...input, notes: '版 2 の別案' }),
    ).rejects.toThrow(/別の操作で算定方針が更新されました/);
  });

  it('換算は次元をまたぐものだけ・同じ次元の組は 1 つ・出典は必須・倍率は正', async () => {
    const input = await base();
    const save = (conversions: SavePolicyInput['conversions']) =>
      saveCalculationPolicy(db, manager(), { ...input, conversions });
    await expect(save([{ from: 'L', to: 'kL', multiplier: 0.001, source: 'x' }])).rejects.toThrow(
      /同じ種類の単位です/,
    );
    await expect(
      save([
        { from: 'm3', to: 'Nm3', multiplier: 0.93, source: 'a' },
        { from: 'L', to: 'Nm3', multiplier: 0.001, source: 'b' },
      ]),
    ).rejects.toThrow(/同じ種類の組の換算です/);
    await expect(save([{ from: 'm3', to: 'Nm3', multiplier: 0.93, source: '' }])).rejects.toThrow(
      /出典/,
    );
    await expect(save([{ from: 'm3', to: 'Nm3', multiplier: 0, source: 'a' }])).rejects.toThrow(
      /倍率/,
    );
    await expect(save([{ from: 'bbl', to: 'Nm3', multiplier: 1, source: 'a' }])).rejects.toThrow(
      /読めません/,
    );
  });

  it('丸めの段は 1 つずつ・桁は 0〜12・改良トンキロ法の範囲は下限 < 上限', async () => {
    const input = await base();
    await expect(
      saveCalculationPolicy(db, manager(), {
        ...input,
        rounding: [
          { stage: 'line', digits: 3, unit: 't', method: 'half_up' },
          { stage: 'line', digits: 1, unit: 't', method: 'half_up' },
        ],
      }),
    ).rejects.toThrow(/2 つあります/);
    await expect(
      saveCalculationPolicy(db, manager(), {
        ...input,
        rounding: [{ stage: 'total', digits: 13, unit: 't', method: 'half_up' }],
      }),
    ).rejects.toThrow(/0〜12/);
    await expect(
      saveCalculationPolicy(db, manager(), {
        ...input,
        tonkm: { ...input.tonkm, payloadRangeKg: { min: 20000, max: 300 } },
      }),
    ).rejects.toThrow(/下限は上限より小さい/);
  });

  it('デモでは版は 1 つの期間に 5 つまで', async () => {
    let input = await base();
    for (const n of [2, 3, 4, 5]) {
      const saved = await saveCalculationPolicy(db, manager(), { ...input, notes: `版 ${n}` });
      input = { ...input, baseVersionNo: saved.versionNo };
    }
    await expect(saveCalculationPolicy(db, manager(), { ...input, notes: '版 6' })).rejects.toThrow(
      /5 つまで/,
    );
  });

  it('権限の無い人・締めた期間は断る', async () => {
    const input = await base();
    await expect(
      saveCalculationPolicy(db, reviewer(), { ...input, notes: 'x' }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      saveCalculationPolicy(db, manager(), {
        ...input,
        periodId: PERIOD_IDS.fy2025,
        baseVersionNo: null,
      }),
    ).rejects.toThrow(/締めた期間/);
  });
});
