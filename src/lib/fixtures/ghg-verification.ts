import {
  DEFAULT_ATTRIBUTION_ORDER,
  RECONCILIATION_CHECKER_VERSION,
  attribute,
  attributionLinesFrom,
} from '@/lib/domain/ghg/attribution';
import { calculateRun, recalculate, type GhgCalculationOutput } from '@/lib/domain/ghg/calculate';
import { cleanFloat, roundEmission } from '@/lib/domain/ghg/rounding';
import { selectCalculationInputs, type GhgSourceRows } from '@/lib/domain/ghg/select-inputs';
import { ORG_IDS, UNIT_IDS, at, userId } from './dataset';
import { fid } from './ids';
import type { FixtureDb } from './store';
import type {
  BaselineRow,
  EmissionFactor,
  EmissionFactorAssignment,
  EmissionFactorSet,
  FactorActivityKind,
  GhgActivityLine,
  GhgCalculationLine,
  GhgCalculationPolicy,
  GhgClassificationRule,
  OrganizationUnit,
  ReconciliationTolerance,
  ReportingPeriod,
  TonKmPolicy,
  Uuid,
} from '@/types/domain';

/**
 * Scope1・2 の算定と既存結果との照合の架空の Fixture（plan §2.6。2026-10-16 の要望の実演用）。
 *
 * **すべて架空**: 係数（電力・燃料の 2 段係数・改良トンキロ法の式の A・B・S・見なし積載率の原単位表）は
 * 告示・公表値と変えてある（実係数ではないことを数値でも保つ）。拠点・活動量・既存の算定結果も架空。
 * 海外の検証拠点の国は TH・VN・MX・US（plan K12・D2）。
 *
 * 算定の記録 R-1 と照合 R-1 の数値は手で書かず、src/lib/domain/ghg/* の純関数で作る。
 * 既存の算定結果 BL-1 には、照合の画面で 6 種の原因が別々の項目として出るよう差を仕込む:
 *  ① VN1 の電力は 2024 年版の係数（係数） ② TH1 は月ごとに kg で切り捨て（丸め）
 *  ③ EAST の都市ガスは m3 を Nm3 として換算なし（単位換算） ④ MX1 は 12 月の軽油の行が無い（対象範囲・片側のみ）
 *  ⑤ EAST の委託物流を Scope1 に計上（区分。R-1 は区分規則が承認前なので Scope3 カテゴリ4）
 *  ⑥ US1 は拠点×区分の合計だけで、2024 年版の係数で算定した値（原因不明〔残差〕。仮説の再計算で差が閉じる）
 */

const ORG = ORG_IDS.aomi;
const AUTHOR = userId('sustainability@demo.local');

export const GHG_FIXTURE_IDS = {
  units: {
    th: fid('unit', 'AOMI/TH1'),
    vn: fid('unit', 'AOMI/VN1'),
    mx: fid('unit', 'AOMI/MX1'),
    us: fid('unit', 'AOMI/US1'),
  },
  period: fid('period', 'AOMI/CY2025'),
  sets: {
    org2025: fid('emission_factor_set', 'AOMI/ORG-2025'),
    org2024: fid('emission_factor_set', 'AOMI/ORG-2024'),
  },
  policy: fid('ghg_calculation_policy', 'AOMI/CY2025/v1'),
  rule: fid('ghg_classification_rule', 'AOMI/LOGI-01'),
  run: fid('ghg_calculation_run', 'AOMI/CY2025/R-1'),
  baseline: fid('ghg_baseline_result', 'AOMI/CY2025/BL-1'),
  reconciliation: fid('ghg_reconciliation', 'AOMI/CY2025/R-1'),
} as const;

/** 算定の検証拠点（国内 1・海外 4） */
export const GHG_VERIFICATION_UNIT_IDS: readonly Uuid[] = [
  UNIT_IDS.east,
  GHG_FIXTURE_IDS.units.th,
  GHG_FIXTURE_IDS.units.vn,
  GHG_FIXTURE_IDS.units.mx,
  GHG_FIXTURE_IDS.units.us,
];

/** 将来の展開対象の総拠点数（架空） */
export const GHG_ROLLOUT_TOTAL_SITES = 30;

/** 区分規則の根拠（架空） */
export const LOGI_RULE_RATIONALE = '（架空）主要製品の輸送で、自社便と同じ管理をしているため';

/** 照合 R-1 の許容差（Fixture の人の入力。既定値ではない） */
export const GHG_FIXTURE_TOLERANCE: ReconciliationTolerance = {
  scope1: { absoluteT: 0.05, relativePct: 0.1 },
  scope2: { absoluteT: 0.05, relativePct: 0.1 },
  scope2_location: { absoluteT: 0.05, relativePct: 0.1 },
  scope3_cat4: { absoluteT: 0.05, relativePct: 0.1 },
};

const SITES: ReadonlyArray<{
  key: keyof typeof GHG_FIXTURE_IDS.units;
  code: string;
  name: string;
  country: string;
  currency: string;
  timezone: string;
}> = [
  {
    key: 'th',
    code: 'TH1',
    name: 'タイ工場',
    country: 'TH',
    currency: 'THB',
    timezone: 'Asia/Bangkok',
  },
  {
    key: 'vn',
    code: 'VN1',
    name: 'ベトナム工場',
    country: 'VN',
    currency: 'VND',
    timezone: 'Asia/Ho_Chi_Minh',
  },
  {
    key: 'mx',
    code: 'MX1',
    name: 'メキシコ工場',
    country: 'MX',
    currency: 'MXN',
    timezone: 'America/Mexico_City',
  },
  {
    key: 'us',
    code: 'US1',
    name: '米国工場',
    country: 'US',
    currency: 'USD',
    timezone: 'America/Chicago',
  },
];

const MONTHS = Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}-01`);

/** 月の揺らぎ（決定論。夏と冬に少し増える） */
function seasonal(base: number, monthIndex: number, amplitude = 0.07): number {
  return Math.round(base * (1 + amplitude * Math.cos((2 * Math.PI * (monthIndex - 1)) / 12)));
}

// ----------------------------------------------------------------------
// 係数（すべて架空。告示・公表値とは変えてある）
// ----------------------------------------------------------------------

interface FactorSpec {
  key: string;
  name: string;
  kind: FactorActivityKind;
  code: string;
  basis?: 'location' | 'market';
  country?: string;
  value?: number;
  unit?: string;
  activityUnit: string;
  calorific?: [number, string];
  carbon?: [number, string];
  params?: Record<string, unknown>;
}

const ELECTRICITY_LOCATION: Record<string, [number, number]> = {
  // 国 → [2025 年版, 2024 年版]（kg-CO2/kWh。架空）
  JP: [0.437, 0.446],
  TH: [0.512, 0.521],
  VN: [0.668, 0.694],
  MX: [0.447, 0.455],
  US: [0.366, 0.374],
};

/** 改良トンキロ法の式（告示の形。A・B・S は架空の値） */
function dieselFormula(version: 2025 | 2024): Record<string, unknown> {
  const shift = version === 2025 ? 0 : 0.1;
  return {
    S: 0.809,
    classes: {
      y2025: { A: 8.71 + shift, B: 0.618, payloadMinKg: 1000 },
      y2022: { A: 10.6 + shift, B: 0.651, payloadMaxKg: 2000 },
      y2015: { A: 13.8 + shift, B: 0.655 },
      unverified: { A: 14.8 + shift, B: 0.651, lnA: 2.697 },
    },
  };
}

/** 見なし積載率の原単位表（架空・事業用の 6 区分） */
function dieselDefaults(version: 2025 | 2024): Record<string, unknown> {
  const f = version === 2025 ? 1 : 1.01;
  const r = (v: number) => Math.round(v * f * 10000) / 10000;
  return {
    table: [
      {
        vehicleUse: 'commercial',
        minKg: 1000,
        maxKg: 2000,
        loadPct: 26,
        values: { y2025: r(0.281), y2022: r(0.281), y2015: r(0.344), unverified: r(0.379) },
      },
      {
        vehicleUse: 'commercial',
        minKg: 2000,
        maxKg: 4000,
        loadPct: 33,
        values: { y2025: r(0.147), y2015: r(0.176), unverified: r(0.195) },
      },
      {
        vehicleUse: 'commercial',
        minKg: 4000,
        maxKg: 6000,
        loadPct: 37,
        values: { y2025: r(0.0973), y2015: r(0.115), unverified: r(0.127) },
      },
      {
        vehicleUse: 'commercial',
        minKg: 6000,
        maxKg: 8000,
        loadPct: 39,
        values: { y2025: r(0.0788), y2015: r(0.0921), unverified: r(0.103) },
      },
      {
        vehicleUse: 'commercial',
        minKg: 8000,
        maxKg: 12000,
        loadPct: 50,
        values: { y2025: r(0.0497), y2015: r(0.0571), unverified: r(0.0634) },
      },
      {
        vehicleUse: 'commercial',
        minKg: 12000,
        maxKg: null,
        loadPct: 50,
        values: { y2025: r(0.0362), y2015: r(0.0409), unverified: r(0.0455) },
      },
    ],
  };
}

function factorSpecs(version: 2025 | 2024): FactorSpec[] {
  const v25 = version === 2025;
  const specs: FactorSpec[] = [
    {
      key: 'DIESEL',
      name: '軽油',
      kind: 'fuel',
      code: 'diesel',
      activityUnit: 'kL',
      calorific: [v25 ? 38.3 : 37.9, 'GJ/kL'],
      carbon: [v25 ? 0.01874 : 0.01868, 'tC/GJ'],
    },
    {
      key: 'GASOLINE',
      name: '揮発油',
      kind: 'fuel',
      code: 'gasoline',
      activityUnit: 'kL',
      calorific: [v25 ? 33.7 : 34.2, 'GJ/kL'],
      carbon: [v25 ? 0.01866 : 0.01842, 'tC/GJ'],
    },
    {
      key: 'CITYGAS',
      name: '都市ガス',
      kind: 'gas',
      code: 'city_gas',
      activityUnit: 'kNm3',
      calorific: [v25 ? 44.6 : 44.9, 'GJ/千Nm3'],
      carbon: [v25 ? 0.01362 : 0.01359, 'tC/GJ'],
    },
    {
      key: 'ELEC-MKT-RESIDUAL',
      name: '電力（マーケット基準・組織の代替値）',
      kind: 'electricity',
      code: 'grid',
      basis: 'market',
      value: v25 ? 0.552 : 0.561,
      unit: 'kg-CO2/kWh',
      activityUnit: 'kWh',
    },
    {
      key: 'ELEC-MKT-EAST-GREEN-01',
      name: '電力（マーケット基準・東日本工場の契約）',
      kind: 'electricity',
      code: 'EAST-GREEN-01',
      basis: 'market',
      value: v25 ? 0.214 : 0.226,
      unit: 'kg-CO2/kWh',
      activityUnit: 'kWh',
    },
    {
      key: 'TONKM-FORMULA-DIESEL',
      name: '改良トンキロ法の式（軽油）',
      kind: 'transport_formula',
      code: 'diesel',
      value: 0,
      unit: 'L/tkm',
      activityUnit: 'tkm',
      params: dieselFormula(version),
    },
    {
      key: 'TONKM-DEFAULT-DIESEL',
      name: '見なし積載率の原単位表（軽油）',
      kind: 'transport_default',
      code: 'diesel',
      value: 0,
      unit: 'L/tkm',
      activityUnit: 'tkm',
      params: dieselDefaults(version),
    },
  ];
  for (const [country, values] of Object.entries(ELECTRICITY_LOCATION)) {
    specs.push({
      key: `ELEC-LOC-${country}`,
      name: `電力（ロケーション基準・${country}）`,
      kind: 'electricity',
      code: 'grid',
      basis: 'location',
      country,
      value: v25 ? values[0] : values[1],
      unit: 'kg-CO2/kWh',
      activityUnit: 'kWh',
    });
  }
  return specs;
}

export function ghgFactorId(version: 2025 | 2024, key: string): Uuid {
  return fid('emission_factor', `AOMI/ORG-${version}/${key}`);
}

function buildFactors(version: 2025 | 2024): EmissionFactor[] {
  const setId = version === 2025 ? GHG_FIXTURE_IDS.sets.org2025 : GHG_FIXTURE_IDS.sets.org2024;
  return factorSpecs(version).map((spec) => {
    const twoStage = spec.calorific && spec.carbon;
    const effective = twoStage
      ? spec.calorific![0] * spec.carbon![0] * (44 / 12)
      : (spec.value ?? 0);
    return {
      id: ghgFactorId(version, spec.key),
      organizationId: ORG,
      code: `ORG-${version}-${spec.key}`,
      name: `${spec.name}（架空）`,
      category: 'scope12',
      factorValue: Math.round(effective * 1e6) / 1e6,
      factorUnit: spec.unit ?? `t-CO2/${spec.activityUnit}`,
      activityUnit: spec.activityUnit,
      factorYear: version,
      factorSource: 'FIXTURE（架空値・実係数ではありません）',
      createdAt: at(version === 2025 ? 62 : 64),
      factorSetId: setId,
      countryCode: spec.country ?? null,
      regionLabel: null,
      basis: spec.basis ?? null,
      activityKind: spec.kind,
      activityCode: spec.code,
      gas: 'co2e',
      calorificValue: spec.calorific ? spec.calorific[0] : null,
      calorificUnit: spec.calorific ? spec.calorific[1] : null,
      carbonFactor: spec.carbon ? spec.carbon[0] : null,
      carbonFactorUnit: spec.carbon ? spec.carbon[1] : null,
      validFrom: `${version}-01-01`,
      validTo: `${version}-12-31`,
      params: spec.params ?? {},
    };
  });
}

function buildSet(version: 2025 | 2024): EmissionFactorSet {
  return {
    id: version === 2025 ? GHG_FIXTURE_IDS.sets.org2025 : GHG_FIXTURE_IDS.sets.org2024,
    organizationId: ORG,
    code: `ORG-${version}`,
    name: `組織指定（架空）${version} 年版`,
    origin: 'fixture',
    sourceLabel: 'FIXTURE（架空値・実係数ではありません）',
    versionLabel: `${version} 年版`,
    publishedOn: `${version}-03-31`,
    referenceYear: version,
    status: 'active',
    activatedBy: AUTHOR,
    activatedAt: at(version === 2025 ? 61 : 63),
    retiredBy: null,
    retiredAt: null,
    notes: '（架空）実演用の係数のセットです。',
    createdAt: at(version === 2025 ? 62 : 64),
    updatedAt: at(version === 2025 ? 61 : 63),
    createdBy: AUTHOR,
    updatedBy: AUTHOR,
  };
}

// ----------------------------------------------------------------------
// 割当・方針・区分規則
// ----------------------------------------------------------------------

function buildAssignments(): EmissionFactorAssignment[] {
  const out: EmissionFactorAssignment[] = [];
  const add = (
    key: string,
    factorKey: string,
    over: Partial<EmissionFactorAssignment> &
      Pick<EmissionFactorAssignment, 'activityKind' | 'activityCode'>,
  ) =>
    out.push({
      id: fid('emission_factor_assignment', `AOMI/CY2025/${key}`),
      organizationId: ORG,
      reportingPeriodId: GHG_FIXTURE_IDS.period,
      unitId: null,
      countryCode: null,
      basis: null,
      factorId: ghgFactorId(2025, factorKey),
      reason: '（架空）2025 年分は 2025 年版を全社で使う',
      createdAt: at(60),
      updatedAt: at(60),
      createdBy: AUTHOR,
      updatedBy: AUTHOR,
      ...over,
    });
  add('fuel/diesel', 'DIESEL', { activityKind: 'fuel', activityCode: 'diesel' });
  add('fuel/gasoline', 'GASOLINE', { activityKind: 'fuel', activityCode: 'gasoline' });
  add('gas/city_gas', 'CITYGAS', { activityKind: 'gas', activityCode: 'city_gas' });
  for (const country of Object.keys(ELECTRICITY_LOCATION)) {
    add(`electricity/location/${country}`, `ELEC-LOC-${country}`, {
      activityKind: 'electricity',
      activityCode: 'grid',
      basis: 'location',
      countryCode: country,
      reason: '（架空）ロケーション基準は国ごとの係数',
    });
  }
  add('electricity/market/residual', 'ELEC-MKT-RESIDUAL', {
    activityKind: 'electricity',
    activityCode: 'grid',
    basis: 'market',
    reason: '（架空）契約の係数が無い拠点は組織の代替値',
  });
  add('electricity/market/EAST-GREEN-01', 'ELEC-MKT-EAST-GREEN-01', {
    activityKind: 'electricity',
    activityCode: 'EAST-GREEN-01',
    basis: 'market',
    unitId: UNIT_IDS.east,
    reason: '（架空）東日本工場の電力の契約',
  });
  add('transport_formula/diesel', 'TONKM-FORMULA-DIESEL', {
    activityKind: 'transport_formula',
    activityCode: 'diesel',
  });
  add('transport_default/diesel', 'TONKM-DEFAULT-DIESEL', {
    activityKind: 'transport_default',
    activityCode: 'diesel',
  });
  return out;
}

export const GHG_FIXTURE_TONKM_POLICY: TonKmPolicy = {
  shape: 'kokuji',
  minLoadPct: 10,
  over100: 'error',
  payloadRangeKg: { min: 350, max: 20500 },
  payloadOutOfRange: 'warn',
  overseas: 'warn',
  intensityRounding: { significant: 3, method: 'half_up' },
};

function buildPolicy(): GhgCalculationPolicy {
  return {
    id: GHG_FIXTURE_IDS.policy,
    organizationId: ORG,
    reportingPeriodId: GHG_FIXTURE_IDS.period,
    versionNo: 1,
    rounding: [
      { stage: 'site_activity', digits: 3, unit: 't', method: 'half_up' },
      { stage: 'site_scope', digits: 1, unit: 't', method: 'half_up' },
    ],
    conversions: [{ from: 'm3', to: 'Nm3', multiplier: 0.93, source: '（架空）温度・圧力補正' }],
    tonkm: GHG_FIXTURE_TONKM_POLICY,
    notes: '（架空）2025 年分の算定方針。',
    createdAt: at(59),
    createdBy: AUTHOR,
  };
}

function buildRule(): GhgClassificationRule {
  return {
    id: GHG_FIXTURE_IDS.rule,
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
    rationale: LOGI_RULE_RATIONALE,
    disclosureNote: '（架空）委託物流（主要製品）は組織の算定ルールにより Scope1 に含めています。',
    effectiveFromPeriodId: GHG_FIXTURE_IDS.period,
    effectiveToPeriodId: null,
    status: 'proposed',
    proposedBy: AUTHOR,
    approvedBy: null,
    approvedAt: null,
    withdrawnBy: null,
    withdrawnAt: null,
    createdAt: at(10),
    updatedAt: at(10),
  };
}

// ----------------------------------------------------------------------
// 活動量（確定済みのバッチ）
// ----------------------------------------------------------------------

interface EnergyProfile {
  electricity: number;
  diesel: number;
  dieselUnit: 'L' | 'gal';
  gasoline: number;
  cityGas?: number;
  contract?: string;
}

const ENERGY: Record<string, EnergyProfile> = {
  [UNIT_IDS.east]: {
    electricity: 1_850_000,
    diesel: 4200,
    dieselUnit: 'L',
    gasoline: 1100,
    cityGas: 32_000,
    contract: 'EAST-GREEN-01',
  },
  [GHG_FIXTURE_IDS.units.th]: {
    electricity: 920_000,
    diesel: 2600,
    dieselUnit: 'L',
    gasoline: 700,
  },
  [GHG_FIXTURE_IDS.units.vn]: {
    electricity: 780_000,
    diesel: 2100,
    dieselUnit: 'L',
    gasoline: 500,
  },
  [GHG_FIXTURE_IDS.units.mx]: {
    electricity: 650_000,
    diesel: 1800,
    dieselUnit: 'L',
    gasoline: 450,
  },
  [GHG_FIXTURE_IDS.units.us]: {
    electricity: 540_000,
    diesel: 480,
    dieselUnit: 'gal',
    gasoline: 300,
  },
};

export function ghgBatchId(unitCode: string, kind: 'energy' | 'transport'): Uuid {
  return fid('ghg_activity_batch', `AOMI/CY2025/${unitCode}/${kind}`);
}

/** 委託物流の輸送実績（EAST・24 行。積載率なし 4 行・5% の行 1 行・最大積載量 25,000kg の行 1 行） */
const SHIPMENTS: ReadonlyArray<{
  weightT: number;
  km: number;
  payloadKg: number;
  load: number | null;
  economy: 'y2025' | 'y2015' | 'unverified';
}> = [
  { weightT: 2.2, km: 180, payloadKg: 4000, load: 55, economy: 'unverified' },
  { weightT: 6.1, km: 240, payloadKg: 10000, load: 61, economy: 'y2025' },
  { weightT: 1.8, km: 95, payloadKg: 3000, load: null, economy: 'unverified' },
  { weightT: 3.4, km: 310, payloadKg: 8000, load: 42.5, economy: 'y2015' },
  { weightT: 4.6, km: 150, payloadKg: 10000, load: 46, economy: 'y2025' },
  { weightT: 2.9, km: 205, payloadKg: 4000, load: 72.5, economy: 'unverified' },
  { weightT: 0.2, km: 60, payloadKg: 4000, load: 5, economy: 'unverified' },
  { weightT: 5.2, km: 270, payloadKg: 12000, load: 43, economy: 'y2015' },
  { weightT: 7.8, km: 330, payloadKg: 10000, load: 78, economy: 'y2025' },
  { weightT: 2.5, km: 120, payloadKg: 5000, load: null, economy: 'y2015' },
  { weightT: 11.3, km: 410, payloadKg: 25000, load: 45, economy: 'unverified' },
  { weightT: 3.1, km: 160, payloadKg: 4000, load: 77.5, economy: 'unverified' },
  { weightT: 4.4, km: 230, payloadKg: 8000, load: 55, economy: 'y2015' },
  { weightT: 2.0, km: 140, payloadKg: 3000, load: null, economy: 'unverified' },
  { weightT: 6.6, km: 285, payloadKg: 10000, load: 66, economy: 'y2025' },
  { weightT: 3.7, km: 175, payloadKg: 6000, load: 61.5, economy: 'y2015' },
  { weightT: 2.4, km: 110, payloadKg: 4000, load: 60, economy: 'unverified' },
  { weightT: 5.9, km: 320, payloadKg: 10000, load: 59, economy: 'y2025' },
  { weightT: 1.6, km: 85, payloadKg: 3000, load: null, economy: 'unverified' },
  { weightT: 4.1, km: 260, payloadKg: 8000, load: 51, economy: 'y2015' },
  { weightT: 3.3, km: 190, payloadKg: 4000, load: 82.5, economy: 'unverified' },
  { weightT: 6.8, km: 300, payloadKg: 10000, load: 68, economy: 'y2025' },
  { weightT: 2.7, km: 130, payloadKg: 5000, load: 54, economy: 'y2015' },
  { weightT: 4.9, km: 220, payloadKg: 8000, load: 61, economy: 'unverified' },
];

function shipmentRef(index: number): string {
  const month = Math.floor(index / 2) + 1;
  return `SHP-2025${String(month).padStart(2, '0')}-${index % 2 === 0 ? 'A' : 'B'}`;
}

function buildActivity(db: FixtureDb, units: readonly OrganizationUnit[]) {
  const confirmedAt = at(20);
  for (const unit of units) {
    const profile = ENERGY[unit.id]!;
    const batchId = ghgBatchId(unit.code, 'energy');
    const lines: GhgActivityLine[] = [];
    const push = (
      over: Partial<GhgActivityLine> &
        Pick<GhgActivityLine, 'month' | 'activityKind' | 'activityCode'>,
    ) =>
      lines.push({
        id: fid('ghg_activity_line', `${batchId}/${lines.length + 1}`),
        organizationId: ORG,
        batchId,
        lineNo: lines.length + 1,
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
        createdAt: at(22),
        ...over,
      });
    MONTHS.forEach((month, i) => {
      const m = i + 1;
      push({
        month,
        activityKind: 'electricity',
        activityCode: 'grid',
        amount: seasonal(profile.electricity, m),
        unit: 'kWh',
        contractCode: profile.contract ?? null,
      });
      push({
        month,
        activityKind: 'fuel',
        activityCode: 'diesel',
        amount: seasonal(profile.diesel, m, 0.05),
        unit: profile.dieselUnit,
      });
      push({
        month,
        activityKind: 'fuel',
        activityCode: 'gasoline',
        amount: seasonal(profile.gasoline, m, 0.04),
        unit: 'L',
      });
      if (profile.cityGas) {
        push({
          month,
          activityKind: 'gas',
          activityCode: 'city_gas',
          amount: seasonal(profile.cityGas, m, 0.18),
          unit: 'm3',
        });
      }
    });
    db.ghgActivityBatches.push({
      id: batchId,
      organizationId: ORG,
      reportingPeriodId: GHG_FIXTURE_IDS.period,
      unitId: unit.id,
      kind: 'energy',
      source: 'fixture',
      fileName: `（架空）エネルギー_${unit.code}_2025.xlsx`,
      fileSha256: null,
      rowCount: lines.length,
      status: 'confirmed',
      confirmedBy: AUTHOR,
      confirmedAt,
      supersedesBatchId: null,
      createdAt: at(22),
      createdBy: AUTHOR,
      updatedAt: confirmedAt,
    });
    db.ghgActivityLines.push(...lines);
  }

  // 東日本工場の輸送（自社便の燃料〔燃料法〕と委託物流の輸送実績〔改良トンキロ法〕）
  const transportBatch = ghgBatchId('EAST', 'transport');
  const lines: GhgActivityLine[] = [];
  const base = (over: Partial<GhgActivityLine>): GhgActivityLine => ({
    id: fid('ghg_activity_line', `${transportBatch}/${lines.length + 1}`),
    organizationId: ORG,
    batchId: transportBatch,
    lineNo: lines.length + 1,
    month: MONTHS[0]!,
    activityKind: 'transport',
    activityCode: 'own_fleet',
    amount: null,
    unit: null,
    contractCode: null,
    shipmentRef: null,
    cargoWeightT: null,
    distanceKm: null,
    tonKm: null,
    fuelCode: 'diesel',
    maxPayloadKg: null,
    loadFactorPct: null,
    vehicleUse: null,
    fuelEconomyClass: null,
    carrierKind: null,
    cargoKind: null,
    attributes: {},
    note: '',
    createdAt: at(21),
    ...over,
  });
  MONTHS.forEach((month, i) => {
    lines.push(
      base({
        month,
        activityCode: 'own_fleet',
        amount: seasonal(1350, i + 1, 0.06),
        unit: 'L',
        carrierKind: 'own_fleet',
        vehicleUse: 'private',
        note: '（架空）自社便の燃料（燃料法）',
      }),
    );
  });
  SHIPMENTS.forEach((s, index) => {
    lines.push(
      base({
        month: MONTHS[Math.floor(index / 2)]!,
        activityCode: 'contracted',
        shipmentRef: shipmentRef(index),
        cargoWeightT: s.weightT,
        distanceKm: s.km,
        maxPayloadKg: s.payloadKg,
        loadFactorPct: s.load,
        vehicleUse: 'commercial',
        fuelEconomyClass: s.economy,
        carrierKind: 'contracted',
        cargoKind: 'main_product',
        note: '（架空）委託物流（主要製品）',
      }),
    );
  });
  db.ghgActivityBatches.push({
    id: transportBatch,
    organizationId: ORG,
    reportingPeriodId: GHG_FIXTURE_IDS.period,
    unitId: UNIT_IDS.east,
    kind: 'transport',
    source: 'fixture',
    fileName: '（架空）輸送実績_EAST_2025.csv',
    fileSha256: null,
    rowCount: lines.length,
    status: 'confirmed',
    confirmedBy: AUTHOR,
    confirmedAt,
    supersedesBatchId: null,
    createdAt: at(21),
    createdBy: AUTHOR,
    updatedAt: confirmedAt,
  });
  db.ghgActivityLines.push(...lines);
}

// ----------------------------------------------------------------------
// 算定の入力（Fixture の行から。サービスと同じ選び方）
// ----------------------------------------------------------------------

export function ghgSourceRowsFromFixture(db: FixtureDb, period: ReportingPeriod): GhgSourceRows {
  const org = db.organizations.find((o) => o.id === ORG)!;
  return {
    organization: { id: ORG, countryCode: org.countryCode },
    period,
    periods: db.periods.filter((p) => p.organizationId === ORG),
    units: db.units.filter((u) => u.organizationId === ORG),
    policies: db.ghgCalculationPolicies.filter((p) => p.organizationId === ORG),
    sets: db.emissionFactorSets.filter((s) => s.organizationId === ORG),
    factors: db.emissionFactors.filter((f) => f.organizationId === ORG),
    assignments: db.emissionFactorAssignments.filter((a) => a.organizationId === ORG),
    rules: db.ghgClassificationRules.filter((r) => r.organizationId === ORG),
    batches: db.ghgActivityBatches.filter((b) => b.organizationId === ORG),
    lines: db.ghgActivityLines.filter((l) => l.organizationId === ORG),
  };
}

// ----------------------------------------------------------------------
// 既存の算定結果 BL-1（差を仕込む）
// ----------------------------------------------------------------------

const UNIT_CODE: Record<string, string> = {
  [UNIT_IDS.east]: 'EAST',
  [GHG_FIXTURE_IDS.units.th]: 'TH1',
  [GHG_FIXTURE_IDS.units.vn]: 'VN1',
  [GHG_FIXTURE_IDS.units.mx]: 'MX1',
  [GHG_FIXTURE_IDS.units.us]: 'US1',
};

function rowFrom(
  lines: readonly GhgCalculationLine[],
  rowNo: number,
  scope: BaselineRow['scope'],
): BaselineRow {
  const first = lines[0]!;
  const sum = (pick: (l: GhgCalculationLine) => number) => lines.reduce((a, l) => a + pick(l), 0);
  return {
    rowNo,
    siteCode: UNIT_CODE[first.unitId]!,
    unitId: first.unitId,
    scope,
    activityKind: first.activityKind,
    activityCode: first.activityCode,
    month: first.month,
    shipmentRef: null,
    activityAmount: sum((l) => l.activityAmount),
    activityUnit: first.activityUnit,
    convertedAmount: sum((l) => l.convertedAmount),
    convertedUnit: first.convertedUnit,
    factorValue: first.factorValue,
    factorUnit: first.factorUnit,
    factorYear: first.factorYear,
    method: first.method,
    emissions: sum((l) => l.emissionsUnrounded),
    emissionsUnit: 't-CO2e',
    rounding: null,
    roundingNote: '',
  };
}

function buildBaselineRows(
  r1: GhgCalculationOutput,
  r1With2024: GhgCalculationOutput,
): BaselineRow[] {
  const rows: BaselineRow[] = [];
  const groups = new Map<string, GhgCalculationLine[]>();
  for (const line of r1.lines) {
    if (line.unitId === GHG_FIXTURE_IDS.units.us) continue;
    const key = `${line.unitId}|${line.method}|${line.activityKind}:${line.activityCode}|${line.month}`;
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  const vn2024 = new Map(
    r1With2024.lines
      .filter((l) => l.unitId === GHG_FIXTURE_IDS.units.vn && l.activityKind === 'electricity')
      .map((l) => [`${l.activityLineId}|${l.method}`, l]),
  );
  for (const lines of groups.values()) {
    const first = lines[0]!;
    // ④ MX1 は 12 月の軽油の行が無い（対象範囲・片側のみ）
    if (
      first.unitId === GHG_FIXTURE_IDS.units.mx &&
      first.activityCode === 'diesel' &&
      first.month === '2025-12-01'
    ) {
      continue;
    }
    // ⑤ EAST の委託物流は会社方針で Scope1 に計上（T4D の R-1 は区分規則が承認前なので Scope3 カテゴリ4）
    const scope = first.activityCode === 'contracted' ? 'scope1' : first.reportedScope;
    const row = rowFrom(lines, rows.length + 1, scope);
    if (first.unitId === GHG_FIXTURE_IDS.units.vn && first.activityKind === 'electricity') {
      // ① VN1 の電力は 2024 年版の係数
      const alt = vn2024.get(`${first.activityLineId}|${first.method}`)!;
      row.factorValue = alt.factorValue;
      row.factorUnit = alt.factorUnit;
      row.factorYear = alt.factorYear;
      row.emissions = alt.emissionsUnrounded;
    }
    if (first.unitId === GHG_FIXTURE_IDS.units.th) {
      // ② TH1 は月ごとの行を kg で切り捨て
      row.rounding = { stage: 'month', unit: 'kg', digits: 0, method: 'truncate' };
      row.roundingNote = '月ごと・kg・切り捨て';
      row.emissions = Math.round(
        // 既存の算定（表計算）は 10 進で計算するため、2 進の誤差を落としてから切り捨てる
        roundEmission(cleanFloat(row.emissions), { digits: 0, unit: 'kg', method: 'truncate' }) *
          1000,
      );
      row.emissionsUnit = 'kg-CO2e';
    }
    if (first.activityCode === 'city_gas') {
      // ③ EAST の都市ガスは m3 を Nm3 として換算なし（換算後の量＝m3 と同じ値）
      const effective = Number(first.methodDetail.effectiveFactorT);
      row.convertedAmount = (row.activityAmount ?? 0) / 1000;
      row.convertedUnit = '千Nm3';
      row.emissions = row.convertedAmount * effective;
    }
    rows.push(row);
  }
  // ⑥ US1 は拠点×区分の合計だけ（2024 年版の係数で算定した値。丸めの記述なし）
  for (const site of r1With2024.summary.reported.sites) {
    if (site.unitId !== GHG_FIXTURE_IDS.units.us) continue;
    rows.push({
      rowNo: rows.length + 1,
      siteCode: 'US1',
      unitId: GHG_FIXTURE_IDS.units.us,
      scope: site.scope,
      activityKind: null,
      activityCode: null,
      month: null,
      shipmentRef: null,
      activityAmount: null,
      activityUnit: null,
      convertedAmount: null,
      convertedUnit: null,
      factorValue: null,
      factorUnit: null,
      factorYear: null,
      method: null,
      emissions: site.rounded,
      emissionsUnit: 't-CO2e',
      rounding: null,
      roundingNote: '',
    });
  }
  return rows;
}

/** 架空の既存結果のファイルの sha256（ファイルは保存しない。行の内容から決定論で作る） */
function baselineSha(rows: readonly BaselineRow[]): string {
  // ids.ts の FNV（32 文字）を 2 つつなげて 64 桁の 16 進にする（実ファイルの sha256 ではない。架空）
  const text = JSON.stringify(rows);
  const a = fid('baseline_file', text).replace(/-/g, '');
  const b = fid('baseline_file#2', text).replace(/-/g, '');
  return `${a}${b}`.slice(0, 64);
}

// ----------------------------------------------------------------------
// 入口
// ----------------------------------------------------------------------

export function seedGhgVerification(db: FixtureDb): void {
  const maxSort = db.units
    .filter((u) => u.organizationId === ORG)
    .reduce((m, u) => Math.max(m, u.sortOrder), 0);
  const newUnits: OrganizationUnit[] = SITES.map((s, i) => ({
    id: GHG_FIXTURE_IDS.units[s.key],
    organizationId: ORG,
    parentId: UNIT_IDS.hq,
    code: s.code,
    name: s.name,
    unitType: 'site',
    countryCode: s.country,
    currencyCode: s.currency,
    timezone: s.timezone,
    // FY（年度）の連結集計・完了率・テンプレートを変えない（plan §2.6 の reports: false）。拠点の名簿に
    // 「連結対象外」と理由を出し、FY の『全拠点が承認済み』の分母・前年補完の推計に入れない
    consolidationMethod: 'excluded',
    ownershipPercent: 100,
    exclusionReason: '（架空）Scope1・2 の算定の検証用の拠点（年度の連結集計には含めない）',
    sortOrder: maxSort + 1 + i,
    deletedAt: null,
    createdAt: at(120),
    updatedAt: at(120),
    createdBy: null,
    updatedBy: null,
  }));
  db.units.push(...newUnits);

  const period: ReportingPeriod = {
    id: GHG_FIXTURE_IDS.period,
    organizationId: ORG,
    code: 'CY2025',
    label: '2025年（暦年 2025-01-01〜2025-12-31）',
    startDate: '2025-01-01',
    endDate: '2025-12-31',
    status: 'reviewing',
    submissionDueDate: null,
    createdAt: at(120),
    updatedAt: at(120),
    createdBy: null,
    updatedBy: null,
  };
  db.periods.push(period);

  db.emissionFactorSets.push(buildSet(2025), buildSet(2024));
  db.emissionFactors.push(...buildFactors(2025), ...buildFactors(2024));
  db.emissionFactorAssignments.push(...buildAssignments());
  db.ghgCalculationPolicies.push(buildPolicy());
  db.ghgClassificationRules.push(buildRule());

  const verificationUnits = GHG_VERIFICATION_UNIT_IDS.map((id) =>
    db.units.find((u) => u.id === id)!,
  );
  buildActivity(db, verificationUnits);

  // 算定の記録 R-1（区分規則は承認前なので、委託物流は既定区分の Scope3 カテゴリ4）
  const source = ghgSourceRowsFromFixture(db, period);
  const inputs = selectCalculationInputs(source, GHG_VERIFICATION_UNIT_IDS);
  if (!inputs) throw new Error('Fixture: 算定方針がありません');
  const createdAt = at(3);
  const r1 = calculateRun(inputs, { runId: GHG_FIXTURE_IDS.run, createdAt });
  if (r1.errors.length > 0) {
    throw new Error(
      `Fixture: 算定 R-1 にエラーがあります: ${r1.errors.map((e) => e.message).join(' / ')}`,
    );
  }
  db.ghgCalculationRuns.push({
    id: GHG_FIXTURE_IDS.run,
    organizationId: ORG,
    reportingPeriodId: period.id,
    unitIds: [...GHG_VERIFICATION_UNIT_IDS],
    policyId: inputs.policy.id,
    factorSetIds: r1.factorSetIds,
    ruleIds: r1.ruleIds,
    activityBatchIds: r1.activityBatchIds,
    inputHash: r1.inputHash,
    engineVersion: r1.engineVersion,
    summary: r1.summary,
    lineCount: r1.lines.length,
    createdAt,
    createdBy: AUTHOR,
  });
  db.ghgCalculationLines.push(...r1.lines);

  // 既存の算定結果 BL-1
  const r1With2024 = recalculate(
    inputs,
    { factorSetId: GHG_FIXTURE_IDS.sets.org2024 },
    { runId: `${GHG_FIXTURE_IDS.run}#2024`, createdAt },
  );
  if (r1With2024.errors.length > 0) {
    throw new Error('Fixture: 2024 年版での再計算にエラーがあります');
  }
  const rows = buildBaselineRows(r1, r1With2024);
  db.ghgBaselineResults.push({
    id: GHG_FIXTURE_IDS.baseline,
    organizationId: ORG,
    reportingPeriodId: period.id,
    label: '既存算定結果（架空）CY2025',
    fileName: '（架空）既存算定結果_CY2025.xlsx',
    fileSha256: baselineSha(rows),
    granularity: 'line',
    rows,
    unitMapping: Object.fromEntries(Object.entries(UNIT_CODE).map(([id, code]) => [code, id])),
    rowCount: rows.length,
    supersedesId: null,
    createdAt: at(2, 2),
    createdBy: AUTHOR,
  });

  // 照合 R-1（許容差は Fixture の人の入力。確認の記録は無い）
  const shipmentOf = new Map(source.lines.map((l) => [l.id, l.shipmentRef]));
  const result = attribute(
    attributionLinesFrom(r1.lines, (id) => shipmentOf.get(id) ?? null),
    rows,
    { t4dRounding: inputs.policy.rounding, tolerance: GHG_FIXTURE_TOLERANCE },
  );
  db.ghgReconciliations.push({
    id: GHG_FIXTURE_IDS.reconciliation,
    organizationId: ORG,
    runId: GHG_FIXTURE_IDS.run,
    baselineId: GHG_FIXTURE_IDS.baseline,
    tolerance: GHG_FIXTURE_TOLERANCE,
    attributionOrder: [...DEFAULT_ATTRIBUTION_ORDER],
    result,
    checkerVersion: RECONCILIATION_CHECKER_VERSION,
    createdAt: at(2),
    createdBy: AUTHOR,
  });
}
