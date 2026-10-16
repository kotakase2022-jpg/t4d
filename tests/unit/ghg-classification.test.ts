import { describe, expect, it } from 'vitest';
import {
  classify,
  doubleCountWarnings,
  dualView,
  protocolScopeOf,
  type ClassifiableLine,
} from '@/lib/domain/ghg/classification';
import type { GhgClassificationRule, ReportingPeriod } from '@/types/domain';

/**
 * 区分（plan §2.2 classification.ts・CR-07・K7）。既定区分は GHG プロトコル、報告区分は承認済みかつ適用期間内の
 * 規則だけが変える。不変条件: Σ(報告の scope1＋scope3) ＝ Σ(既定の scope1＋scope3)。Scope2 の 2 基準は足さない。
 */

const period = (id: string, start: string, end: string): ReportingPeriod => ({
  id,
  organizationId: 'org',
  code: id,
  label: id,
  startDate: start,
  endDate: end,
  status: 'collecting',
  submissionDueDate: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  createdBy: null,
  updatedBy: null,
});
const CY2024 = period('CY2024', '2024-01-01', '2024-12-31');
const CY2025 = period('CY2025', '2025-01-01', '2025-12-31');
const PERIODS = [CY2024, CY2025];

const rule = (over: Partial<GhgClassificationRule> = {}): GhgClassificationRule => ({
  id: 'R1',
  organizationId: 'org',
  code: 'LOGI-01',
  name: '委託物流（主要製品）を自社便と同様に Scope1 とする',
  match: {
    activityKinds: ['transport'],
    carrierKinds: ['contracted'],
    cargoKinds: ['main_product'],
  },
  protocolScope: 'scope3_cat4',
  reportedScope: 'scope1',
  rationale: '（架空）',
  disclosureNote: '',
  effectiveFromPeriodId: 'CY2025',
  effectiveToPeriodId: null,
  status: 'approved',
  proposedBy: 'a',
  approvedBy: 'b',
  approvedAt: '2026-01-02T00:00:00Z',
  withdrawnBy: null,
  withdrawnAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  ...over,
});

const contracted: ClassifiableLine = {
  unitId: 'east',
  activityKind: 'transport',
  method: 'tonkm_improved',
  carrierKind: 'contracted',
  cargoKind: 'main_product',
};

describe('既定区分（GHG プロトコル）', () => {
  it('燃料・自社便＝scope1、電力＝scope2_location／scope2、委託＝scope3_cat4', () => {
    expect(
      protocolScopeOf({
        ...contracted,
        activityKind: 'fuel',
        method: 'fuel_combustion',
        carrierKind: null,
      }),
    ).toBe('scope1');
    expect(
      protocolScopeOf({ ...contracted, carrierKind: 'own_fleet', method: 'fuel_method' }),
    ).toBe('scope1');
    expect(
      protocolScopeOf({
        ...contracted,
        activityKind: 'electricity',
        method: 'electricity_location',
        carrierKind: null,
      }),
    ).toBe('scope2_location');
    expect(
      protocolScopeOf({
        ...contracted,
        activityKind: 'electricity',
        method: 'electricity_market',
        carrierKind: null,
      }),
    ).toBe('scope2');
    expect(protocolScopeOf(contracted)).toBe('scope3_cat4');
  });
});

describe('classify', () => {
  it('承認済み・適用期間内・条件が一致する規則だけが報告区分を変える', () => {
    expect(classify(contracted, [rule()], CY2025, PERIODS)).toEqual({
      protocolScope: 'scope3_cat4',
      reportedScope: 'scope1',
      ruleId: 'R1',
    });
  });

  it('提案中・取り下げ・適用期間外・条件が違う規則は効かない', () => {
    const unchanged = { protocolScope: 'scope3_cat4', reportedScope: 'scope3_cat4', ruleId: null };
    expect(
      classify(
        contracted,
        [rule({ status: 'proposed', approvedBy: null, approvedAt: null })],
        CY2025,
        PERIODS,
      ),
    ).toEqual(unchanged);
    expect(classify(contracted, [rule({ status: 'withdrawn' })], CY2025, PERIODS)).toEqual(
      unchanged,
    );
    expect(classify(contracted, [rule()], CY2024, PERIODS)).toEqual(unchanged);
    expect(
      classify(
        contracted,
        [rule({ effectiveToPeriodId: 'CY2024', effectiveFromPeriodId: null })],
        CY2025,
        PERIODS,
      ),
    ).toEqual(unchanged);
    expect(classify({ ...contracted, cargoKind: 'other' }, [rule()], CY2025, PERIODS)).toEqual(
      unchanged,
    );
    expect(
      classify(
        { ...contracted, carrierKind: 'own_fleet', method: 'fuel_method' },
        [rule()],
        CY2025,
        PERIODS,
      ),
    ).toEqual({
      protocolScope: 'scope1',
      reportedScope: 'scope1',
      ruleId: null,
    });
  });

  it('既定区分が規則の既定区分と違う行には当てない。当てはまる規則が 2 つ以上なら conflict', () => {
    expect(
      classify(contracted, [rule({ protocolScope: 'scope1' })], CY2025, PERIODS).ruleId,
    ).toBeNull();
    const result = classify(
      contracted,
      [rule(), rule({ id: 'R2', code: 'LOGI-02' })],
      CY2025,
      PERIODS,
    );
    expect(result).toMatchObject({
      reportedScope: 'scope3_cat4',
      ruleId: null,
      conflict: ['R1', 'R2'],
    });
  });
});

describe('dualView（二重表示）', () => {
  const lines = [
    {
      unitId: 'east',
      protocolScope: 'scope1' as const,
      reportedScope: 'scope1' as const,
      classificationRuleId: null,
      emissions: 10,
    },
    {
      unitId: 'east',
      protocolScope: 'scope3_cat4' as const,
      reportedScope: 'scope1' as const,
      classificationRuleId: 'R1',
      emissions: 4,
    },
    {
      unitId: 'east',
      protocolScope: 'scope3_cat4' as const,
      reportedScope: 'scope3_cat4' as const,
      classificationRuleId: null,
      emissions: 1,
    },
    {
      unitId: 'east',
      protocolScope: 'scope2_location' as const,
      reportedScope: 'scope2_location' as const,
      classificationRuleId: null,
      emissions: 7,
    },
    {
      unitId: 'east',
      protocolScope: 'scope2' as const,
      reportedScope: 'scope2' as const,
      classificationRuleId: null,
      emissions: 5,
    },
  ];

  it('報告区分・既定区分・再分類分。Σ(scope1＋scope3) は両方の見方で同じ', () => {
    const view = dualView(lines);
    expect(view.reported).toEqual({ scope1: 14, scope2: 5, scope2_location: 7, scope3_cat4: 1 });
    expect(view.protocol).toEqual({ scope1: 10, scope2: 5, scope2_location: 7, scope3_cat4: 5 });
    expect(view.reclassified).toEqual([
      { ruleId: 'R1', from: 'scope3_cat4', to: 'scope1', amount: 4 },
    ]);
    expect(view.reported.scope1 + view.reported.scope3_cat4).toBe(
      view.protocol.scope1 + view.protocol.scope3_cat4,
    );
  });

  it('Scope2 の 2 基準は別々に持ち、合計しない（区分の値は 4 つだけ）', () => {
    const view = dualView(lines);
    expect(Object.keys(view.reported).sort()).toEqual([
      'scope1',
      'scope2',
      'scope2_location',
      'scope3_cat4',
    ]);
  });
});

describe('doubleCountWarnings（二重計上の警告）', () => {
  it('再分類した輸送と同じ輸送を Scope3 の内訳でも数えていそうなら警告する', () => {
    const warnings = doubleCountWarnings(
      [
        {
          ...contracted,
          reportedScope: 'scope1',
          protocolScope: 'scope3_cat4',
          classificationRuleId: 'R1',
        },
      ],
      [{ label: '（架空）物流サービス（金額ベース）' }, { label: '（架空）原材料A' }],
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      ruleId: 'R1',
      inputLabel: '（架空）物流サービス（金額ベース）',
    });
  });

  it('再分類が無ければ警告しない', () => {
    expect(
      doubleCountWarnings(
        [
          {
            ...contracted,
            reportedScope: 'scope3_cat4',
            protocolScope: 'scope3_cat4',
            classificationRuleId: null,
          },
        ],
        [{ label: '（架空）物流サービス' }],
      ),
    ).toEqual([]);
  });
});
