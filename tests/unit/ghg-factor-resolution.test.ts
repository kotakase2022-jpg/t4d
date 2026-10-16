import { describe, expect, it } from 'vitest';
import { resolveFactor, type FactorNeed } from '@/lib/domain/ghg/factor-resolution';
import type { EmissionFactor, EmissionFactorAssignment, EmissionFactorSet } from '@/types/domain';

/**
 * 係数の解決（plan §2.2 factor-resolution.ts・CR-02）。拠点 ＞ 国 ＞ 全社既定。同じ優先度に候補が 2 つ以上・
 * 見つからない・セットが有効でない・国が違う、はエラー（代わりを使わない。plan K6）。経路は文で返す。
 */

const ORG = 'org';
const PERIOD = 'p-cy2025';

function set(
  id: string,
  status: EmissionFactorSet['status'],
  versionLabel: string,
): EmissionFactorSet {
  return {
    id,
    organizationId: ORG,
    code: id,
    name: id,
    origin: 'fixture',
    sourceLabel: '（架空）',
    versionLabel,
    publishedOn: null,
    referenceYear: 2025,
    status,
    activatedBy: null,
    activatedAt: null,
    retiredBy: null,
    retiredAt: null,
    notes: '',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    createdBy: null,
    updatedBy: null,
  };
}

function factor(id: string, setId: string, over: Partial<EmissionFactor> = {}): EmissionFactor {
  return {
    id,
    organizationId: ORG,
    code: id,
    name: id,
    category: 'electricity',
    factorValue: 0.5,
    factorUnit: 'kg-CO2/kWh',
    activityUnit: 'kWh',
    factorYear: 2025,
    factorSource: '（架空）',
    createdAt: '2026-01-01T00:00:00Z',
    factorSetId: setId,
    countryCode: null,
    regionLabel: null,
    basis: 'location',
    activityKind: 'electricity',
    activityCode: 'grid',
    gas: 'co2e',
    calorificValue: null,
    calorificUnit: null,
    carbonFactor: null,
    carbonFactorUnit: null,
    validFrom: null,
    validTo: null,
    params: {},
    ...over,
  };
}

function assignment(
  id: string,
  factorId: string,
  over: Partial<EmissionFactorAssignment> = {},
): EmissionFactorAssignment {
  return {
    id,
    organizationId: ORG,
    reportingPeriodId: PERIOD,
    unitId: null,
    countryCode: null,
    activityKind: 'electricity',
    activityCode: 'grid',
    basis: 'location',
    factorId,
    reason: '',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    createdBy: null,
    updatedBy: null,
    ...over,
  };
}

const SETS = [
  set('S25', 'active', '2025 年版'),
  set('S24', 'active', '2024 年版'),
  set('SD', 'draft', '下書き'),
];
const FACTORS = [
  factor('F-JP', 'S25', { countryCode: 'JP' }),
  factor('F-TH', 'S25', { countryCode: 'TH' }),
  factor('F-TH-24', 'S24', { countryCode: 'TH' }),
  factor('F-DRAFT', 'SD', { countryCode: 'TH' }),
  factor('F-ORG', 'S25'),
];

const need = (over: Partial<FactorNeed> = {}): FactorNeed => ({
  reportingPeriodId: PERIOD,
  unitId: 'u-th',
  unitName: 'タイ工場',
  countryCode: 'TH',
  activityKind: 'electricity',
  activityCode: 'grid',
  activityLabel: '電力',
  basis: 'location',
  ...over,
});

describe('resolveFactor', () => {
  it('拠点 ＞ 国 ＞ 全社の順。経路を文で返す', () => {
    const assignments = [
      assignment('A-ORG', 'F-ORG'),
      assignment('A-TH', 'F-TH', { countryCode: 'TH' }),
      assignment('A-UNIT', 'F-TH-24', { unitId: 'u-th' }),
    ];
    const byUnit = resolveFactor(need(), assignments, FACTORS, SETS);
    expect(byUnit).toMatchObject({
      factor: { id: 'F-TH-24' },
      path: 'unit',
      assignmentId: 'A-UNIT',
    });
    expect('description' in byUnit && byUnit.description).toBe(
      '拠点の割当（タイ工場・電力・2024 年版）',
    );
    const byCountry = resolveFactor(need(), assignments.slice(0, 2), FACTORS, SETS);
    expect(byCountry).toMatchObject({ factor: { id: 'F-TH' }, path: 'country' });
    expect('description' in byCountry && byCountry.description).toBe(
      '国の割当（TH・電力・2025 年版）',
    );
    const byOrg = resolveFactor(
      need({ countryCode: 'VN', unitId: 'u-vn', unitName: 'ベトナム工場' }),
      assignments,
      FACTORS,
      SETS,
    );
    expect(byOrg).toMatchObject({ factor: { id: 'F-ORG' }, path: 'org_default' });
    expect('description' in byOrg && byOrg.description).toBe('全社既定の割当（電力・2025 年版）');
  });

  it('割当が無ければ not_assigned（別の年度・別の基準・別の期間の割当を代わりに使わない）', () => {
    const assignments = [
      assignment('A-MKT', 'F-TH', { countryCode: 'TH', basis: 'market' }),
      assignment('A-OTHER-PERIOD', 'F-TH', { countryCode: 'TH', reportingPeriodId: 'p-fy2026' }),
    ];
    expect(resolveFactor(need(), assignments, FACTORS, SETS)).toEqual({ error: 'not_assigned' });
  });

  it('同じ優先度に 2 つ以上あれば ambiguous', () => {
    const assignments = [
      assignment('A1', 'F-TH', { countryCode: 'TH' }),
      assignment('A2', 'F-TH-24', { countryCode: 'TH' }),
    ];
    expect(resolveFactor(need(), assignments, FACTORS, SETS)).toEqual({ error: 'ambiguous' });
  });

  it('セットが有効でなければ set_not_active、係数が無ければ not_assigned', () => {
    expect(
      resolveFactor(need(), [assignment('A', 'F-DRAFT', { unitId: 'u-th' })], FACTORS, SETS),
    ).toEqual({ error: 'set_not_active' });
    expect(
      resolveFactor(need(), [assignment('A', 'F-MISSING', { unitId: 'u-th' })], FACTORS, SETS),
    ).toEqual({ error: 'not_assigned' });
  });

  it('係数の国と拠点の国が違えば country_mismatch（全社既定に別の国の係数を当てない）', () => {
    expect(resolveFactor(need(), [assignment('A', 'F-JP')], FACTORS, SETS)).toEqual({
      error: 'country_mismatch',
    });
  });

  it('係数の活動の種類が割当と違えば unit_dimension', () => {
    const fuel = factor('F-FUEL', 'S25', {
      activityKind: 'fuel',
      activityCode: 'diesel',
      basis: null,
    });
    expect(
      resolveFactor(
        need(),
        [assignment('A', 'F-FUEL', { unitId: 'u-th' })],
        [...FACTORS, fuel],
        SETS,
      ),
    ).toEqual({ error: 'unit_dimension' });
  });
});
