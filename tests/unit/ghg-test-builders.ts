import type { GhgCalculationInputs } from '@/lib/domain/ghg/calculate';
import type {
  EmissionFactor,
  EmissionFactorAssignment,
  EmissionFactorSet,
  GhgActivityBatch,
  GhgActivityLine,
  GhgCalculationPolicy,
  GhgClassificationRule,
  TonKmPolicy,
} from '@/types/domain';

/**
 * GHG の算定・照合の単体テストの入力を組み立てる小道具（架空の値。実係数ではない）。
 * 係数の値はテストの入力で、Fixture の係数（src/lib/fixtures/ghg-verification.ts）とは別。
 */

export const ORG = 'org-test';
export const PERIOD = {
  id: 'p-cy',
  code: 'CY2025',
  startDate: '2025-01-01',
  endDate: '2025-12-31',
};
export const UNITS = [
  { id: 'u-jp', code: 'JP1', name: '国内工場', countryCode: 'JP' },
  { id: 'u-th', code: 'TH1', name: 'タイ工場', countryCode: 'TH' },
];

const T = '2026-01-01T00:00:00.000Z';

export function set(
  id: string,
  versionLabel: string,
  status: EmissionFactorSet['status'] = 'active',
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
    createdAt: T,
    updatedAt: T,
    createdBy: null,
    updatedBy: null,
  };
}

export function factor(id: string, setId: string, over: Partial<EmissionFactor>): EmissionFactor {
  return {
    id,
    organizationId: ORG,
    code: id,
    name: id,
    category: 'scope12',
    factorValue: 0,
    factorUnit: 't-CO2/kL',
    activityUnit: 'kL',
    factorYear: 2025,
    factorSource: '（架空）',
    createdAt: T,
    factorSetId: setId,
    countryCode: null,
    regionLabel: null,
    basis: null,
    activityKind: 'fuel',
    activityCode: 'diesel',
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

export function assign(
  id: string,
  factorId: string,
  over: Partial<EmissionFactorAssignment>,
): EmissionFactorAssignment {
  return {
    id,
    organizationId: ORG,
    reportingPeriodId: PERIOD.id,
    unitId: null,
    countryCode: null,
    activityKind: 'fuel',
    activityCode: 'diesel',
    basis: null,
    factorId,
    reason: '',
    createdAt: T,
    updatedAt: T,
    createdBy: null,
    updatedBy: null,
    ...over,
  };
}

export const TONKM_POLICY: TonKmPolicy = {
  shape: 'kokuji',
  minLoadPct: 10,
  over100: 'error',
  payloadRangeKg: { min: 350, max: 20500 },
  payloadOutOfRange: 'warn',
  overseas: 'warn',
  intensityRounding: null,
};

export function policy(over: Partial<GhgCalculationPolicy> = {}): GhgCalculationPolicy {
  return {
    id: 'pol-1',
    organizationId: ORG,
    reportingPeriodId: PERIOD.id,
    versionNo: 1,
    rounding: [],
    conversions: [],
    tonkm: TONKM_POLICY,
    notes: '',
    createdAt: T,
    createdBy: null,
    ...over,
  };
}

export function batch(
  id: string,
  unitId: string,
  kind: GhgActivityBatch['kind'] = 'energy',
): GhgActivityBatch {
  return {
    id,
    organizationId: ORG,
    reportingPeriodId: PERIOD.id,
    unitId,
    kind,
    source: 'fixture',
    fileName: `${id}.csv`,
    fileSha256: null,
    rowCount: 0,
    status: 'confirmed',
    confirmedBy: null,
    confirmedAt: T,
    supersedesBatchId: null,
    createdAt: T,
    createdBy: null,
    updatedAt: T,
  };
}

export function line(
  id: string,
  batchId: string,
  lineNo: number,
  over: Partial<GhgActivityLine>,
): GhgActivityLine {
  return {
    id,
    organizationId: ORG,
    batchId,
    lineNo,
    month: '2025-01-01',
    activityKind: 'fuel',
    activityCode: 'diesel',
    amount: null,
    unit: null,
    contractCode: null,
    shipmentRef: null,
    cargoWeightT: null,
    distanceKm: null,
    tonKm: null,
    fuelCode: null,
    maxPayloadKg: null,
    loadFactorPct: null,
    vehicleUse: null,
    fuelEconomyClass: null,
    carrierKind: null,
    cargoKind: null,
    attributes: {},
    note: '',
    createdAt: T,
    ...over,
  };
}

export function rule(over: Partial<GhgClassificationRule> = {}): GhgClassificationRule {
  return {
    id: 'rule-1',
    organizationId: ORG,
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
    effectiveFromPeriodId: null,
    effectiveToPeriodId: null,
    status: 'approved',
    proposedBy: 'a',
    approvedBy: 'b',
    approvedAt: T,
    withdrawnBy: null,
    withdrawnAt: null,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

/** 架空の係数セット 2 つ（25・24 年版）と割当・活動量（国内 1・タイ 1） */
export function baseInputs(over: Partial<GhgCalculationInputs> = {}): GhgCalculationInputs {
  const sets = [set('S25', '2025 年版'), set('S24', '2024 年版')];
  const factors = [
    factor('F-DIESEL-25', 'S25', {
      calorificValue: 38.5,
      calorificUnit: 'GJ/kL',
      carbonFactor: 0.0186,
      carbonFactorUnit: 'tC/GJ',
    }),
    factor('F-DIESEL-24', 'S24', {
      calorificValue: 38.1,
      calorificUnit: 'GJ/kL',
      carbonFactor: 0.0185,
      carbonFactorUnit: 'tC/GJ',
    }),
    factor('F-GAS-25', 'S25', {
      activityKind: 'gas',
      activityCode: 'city_gas',
      factorValue: 2.1,
      factorUnit: 't-CO2/kNm3',
      activityUnit: 'kNm3',
    }),
    factor('F-GAS-24', 'S24', {
      activityKind: 'gas',
      activityCode: 'city_gas',
      factorValue: 2.0,
      factorUnit: 't-CO2/kNm3',
      activityUnit: 'kNm3',
    }),
    factor('F-EL-JP-25', 'S25', {
      activityKind: 'electricity',
      activityCode: 'grid',
      basis: 'location',
      countryCode: 'JP',
      factorValue: 0.45,
      factorUnit: 'kg-CO2/kWh',
      activityUnit: 'kWh',
    }),
    factor('F-EL-TH-25', 'S25', {
      activityKind: 'electricity',
      activityCode: 'grid',
      basis: 'location',
      countryCode: 'TH',
      factorValue: 0.5,
      factorUnit: 'kg-CO2/kWh',
      activityUnit: 'kWh',
    }),
    factor('F-EL-TH-24', 'S24', {
      activityKind: 'electricity',
      activityCode: 'grid',
      basis: 'location',
      countryCode: 'TH',
      factorValue: 0.52,
      factorUnit: 'kg-CO2/kWh',
      activityUnit: 'kWh',
    }),
    factor('F-EL-JP-24', 'S24', {
      activityKind: 'electricity',
      activityCode: 'grid',
      basis: 'location',
      countryCode: 'JP',
      factorValue: 0.46,
      factorUnit: 'kg-CO2/kWh',
      activityUnit: 'kWh',
    }),
    factor('F-MKT-25', 'S25', {
      activityKind: 'electricity',
      activityCode: 'grid',
      basis: 'market',
      factorValue: 0.6,
      factorUnit: 'kg-CO2/kWh',
      activityUnit: 'kWh',
    }),
    factor('F-MKT-24', 'S24', {
      activityKind: 'electricity',
      activityCode: 'grid',
      basis: 'market',
      factorValue: 0.61,
      factorUnit: 'kg-CO2/kWh',
      activityUnit: 'kWh',
    }),
    factor('F-CONTRACT-A', 'S25', {
      activityKind: 'electricity',
      activityCode: 'CONTRACT-A',
      basis: 'market',
      factorValue: 0.3,
      factorUnit: 'kg-CO2/kWh',
      activityUnit: 'kWh',
    }),
    factor('F-FORMULA-25', 'S25', {
      activityKind: 'transport_formula',
      activityCode: 'diesel',
      factorValue: 0,
      factorUnit: 'L/tkm',
      activityUnit: 'tkm',
      params: {
        S: 0.8,
        classes: { unverified: { A: 14.5, B: 0.65, lnA: 2.68 }, y2025: { A: 8.5, B: 0.62 } },
      },
    }),
    factor('F-DEFAULT-25', 'S25', {
      activityKind: 'transport_default',
      activityCode: 'diesel',
      factorValue: 0,
      factorUnit: 'L/tkm',
      activityUnit: 'tkm',
      params: {
        table: [
          {
            vehicleUse: 'commercial',
            minKg: 2000,
            maxKg: 4000,
            loadPct: 33,
            values: { unverified: 0.2, y2025: 0.15 },
          },
        ],
      },
    }),
  ];
  const assignments = [
    assign('A-DIESEL', 'F-DIESEL-25', {}),
    assign('A-GAS', 'F-GAS-25', { activityKind: 'gas', activityCode: 'city_gas' }),
    assign('A-EL-JP', 'F-EL-JP-25', {
      activityKind: 'electricity',
      activityCode: 'grid',
      basis: 'location',
      countryCode: 'JP',
    }),
    assign('A-EL-TH', 'F-EL-TH-25', {
      activityKind: 'electricity',
      activityCode: 'grid',
      basis: 'location',
      countryCode: 'TH',
    }),
    assign('A-MKT', 'F-MKT-25', {
      activityKind: 'electricity',
      activityCode: 'grid',
      basis: 'market',
    }),
    assign('A-CONTRACT', 'F-CONTRACT-A', {
      activityKind: 'electricity',
      activityCode: 'CONTRACT-A',
      basis: 'market',
      unitId: 'u-jp',
    }),
    assign('A-FORMULA', 'F-FORMULA-25', {
      activityKind: 'transport_formula',
      activityCode: 'diesel',
    }),
    assign('A-DEFAULT', 'F-DEFAULT-25', {
      activityKind: 'transport_default',
      activityCode: 'diesel',
    }),
  ];
  const batches = [
    batch('B-JP', 'u-jp'),
    batch('B-JP-T', 'u-jp', 'transport'),
    batch('B-TH', 'u-th'),
  ];
  const lines = [
    line('L1', 'B-JP', 1, { amount: 1200, unit: 'L' }),
    line('L2', 'B-JP', 2, {
      activityKind: 'gas',
      activityCode: 'city_gas',
      amount: 1000,
      unit: 'm3',
    }),
    line('L3', 'B-JP', 3, {
      activityKind: 'electricity',
      activityCode: 'grid',
      amount: 10000,
      unit: 'kWh',
      contractCode: 'CONTRACT-A',
    }),
    line('L4', 'B-TH', 1, {
      activityKind: 'electricity',
      activityCode: 'grid',
      amount: 5000,
      unit: 'kWh',
    }),
    line('L5', 'B-TH', 2, { amount: 100, unit: 'gal' }),
    line('L6', 'B-JP-T', 1, {
      activityKind: 'transport',
      activityCode: 'contracted',
      shipmentRef: 'S-001',
      cargoWeightT: 2.2,
      distanceKm: 180,
      fuelCode: 'diesel',
      maxPayloadKg: 4000,
      loadFactorPct: 55,
      vehicleUse: 'commercial',
      fuelEconomyClass: 'unverified',
      carrierKind: 'contracted',
      cargoKind: 'main_product',
    }),
    line('L7', 'B-JP-T', 2, {
      activityKind: 'transport',
      activityCode: 'contracted',
      shipmentRef: 'S-002',
      tonKm: 1250,
      fuelCode: 'diesel',
      maxPayloadKg: 3000,
      loadFactorPct: null,
      vehicleUse: 'commercial',
      fuelEconomyClass: 'unverified',
      carrierKind: 'contracted',
      cargoKind: 'main_product',
    }),
    line('L8', 'B-JP-T', 3, {
      activityKind: 'transport',
      activityCode: 'own_fleet',
      amount: 300,
      unit: 'L',
      fuelCode: 'diesel',
      carrierKind: 'own_fleet',
    }),
  ];
  return {
    organizationId: ORG,
    organizationCountryCode: 'JP',
    period: PERIOD,
    periods: [PERIOD],
    units: UNITS,
    unitIds: ['u-jp', 'u-th'],
    policy: policy({
      conversions: [{ from: 'm3', to: 'Nm3', multiplier: 0.93, source: '（架空）温度・圧力補正' }],
    }),
    factorSets: sets,
    factors,
    assignments,
    rules: [],
    batches,
    lines,
    ...over,
  };
}
