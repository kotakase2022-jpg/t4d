/**
 * 財務影響分析の試算モデル（docs/disclosure-first.md §10.3）。
 *
 * 承認済みの非財務データ（基準年度 B の確定連結値）× 画面に示した仮定（URL で変えられる）による
 * **決定論的な試算**。システムには財務データ（売上・費用・資産・価格）が無く、確定データの年数も
 * 少ないため、回帰・弾性値・因果推定などの統計的な推定は行わない。経路と係数は仮定であり、
 * 相関から因果を推定したものではない（画面に常に明示する）。
 *
 * 守っていること:
 *  - 符号は「基準年度の費用構造からの営業利益の増減（円/年）」。＋＝増益、−＝減益。
 *    水準で効く経路（P1・P2・P9・P10）は基準年度に計上されていた水準を差し引く（二重に数えない）
 *  - 未定量（起点の確定値が無い・仮定が未入力）は null。0 にしない。合計は定量化できた経路だけで、
 *    件数（n / N 経路）を必ず添える。制度開始前・時間差で未反映の年は実際に 0（注記付き）
 *  - 経路は起点ごとに独立（省エネで Scope1/2 が減る等の相互作用はモデル化しない）
 *  - 定性情報・IRO を円に換算しない（関連として示すだけ）
 *
 * `server-only` を付けない純粋モジュール（画面・サービス・テストが同じ式を使う）。
 */

import type { EsrsTopic, IroType, TimeHorizon } from '@/types/domain';

const NUMBER_FORMAT = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 3 });

/** 数値の表示（桁区切り・小数 3 桁まで。null は「—」）。client でも使えるよう設定モジュールに依存しない */
function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return NUMBER_FORMAT.format(value);
}

// ======================================================================
// 画面に常に出す注記（文言固定。E2E で確かめる）
// ======================================================================

export const FINANCIAL_IMPACT_NOTICE =
  '試算（仮定に基づく）。予測・保証ではありません。経路と係数は画面に示した仮定で、相関から因果を推定していません';
export const DEMO_BASELINE_NOTICE =
  '架空の財務ベースライン・単価（デモ用）。実在企業の数値ではありません';
export const NO_ASSUMPTIONS_NOTICE =
  '財務データ・単価の前提が登録されていません。仮定を入力すると試算します';

/** データの厚みの注記（確定データの最長年数は画面ごとに数える） */
export function dataDepthNotice(years: number): string {
  return `確定データは最長 ${years} 年分のため、統計的な推定は行いません`;
}

// ======================================================================
// 定数
// ======================================================================

/** 試算期間の年数（B+1〜B+10） */
export const HORIZON_YEARS = 10;

/**
 * 炭素価格 P(t) が立ち上がる年度。化石燃料賦課金（FY2028〜）を起点にした仮定の価格の系列で、
 * 発電事業者の負担金（FY2033〜）・調達先の転嫁も同じ価格の系列を使う（価格水準は法定でない）
 */
export const CARBON_PRICE_START_YEAR = 2028;

/** 年度の表示（年度番号は期間の開始年） */
export function fiscalYearLabel(year: number): string {
  return `FY${year}`;
}

/** 要約・経路図に使う参照年（FY2030 が試算期間に入ればそれ、無ければ B+5） */
export function referenceYearOf(baseYear: number): number {
  return 2030 >= baseYear + 1 && 2030 <= baseYear + HORIZON_YEARS ? 2030 : baseYear + 5;
}

// ======================================================================
// 起点（指標）・財務項目・根拠の種類・シナリオ
// ======================================================================

export const DRIVER_KEYS = [
  'scope1',
  'scope2',
  'energy',
  'water',
  'waste',
  'new_hires',
  'scope3_cat1',
] as const;
export type DriverKey = (typeof DRIVER_KEYS)[number];

export interface DriverSpec {
  key: DriverKey;
  /** 指標マスターの code（起点は基準年度の確定連結値） */
  metricCode: string;
  label: string;
  unit: string;
}

export const DRIVERS: Readonly<Record<DriverKey, DriverSpec>> = {
  scope1: { key: 'scope1', metricCode: 'scope1', label: 'Scope1', unit: 't-CO2e' },
  scope2: {
    key: 'scope2',
    metricCode: 'scope2',
    label: 'Scope2（マーケット基準）',
    unit: 't-CO2e',
  },
  energy: { key: 'energy', metricCode: 'energy', label: 'エネルギー使用量', unit: 'MWh' },
  // 水道料金は使用量（上水・工業用水・地下水の合計）に掛かる。取水量の指標はデモに実績が無い
  water: { key: 'water', metricCode: 'water', label: '水使用量', unit: 'm3' },
  waste: { key: 'waste', metricCode: 'waste', label: '廃棄物排出量', unit: 't' },
  new_hires: { key: 'new_hires', metricCode: 'new_hires', label: '新規採用者数', unit: '人' },
  scope3_cat1: {
    key: 'scope3_cat1',
    metricCode: 'scope3_cat1',
    label: 'Scope3 Cat.1（Scope3 全体ではない）',
    unit: 't-CO2e',
  },
};

export const FINANCIAL_LINES = ['revenue', 'cogs', 'sga', 'extraordinary_loss'] as const;
export type FinancialLine = (typeof FINANCIAL_LINES)[number];

export const FINANCIAL_LINE_LABEL: Record<FinancialLine, string> = {
  revenue: '売上高',
  cogs: '売上原価',
  sga: '販管費',
  extraordinary_loss: '特別損失',
};

export const EVIDENCE_KINDS = ['data', 'assumption', 'unquantified', 'out_of_scope'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const EVIDENCE_KIND_LABEL: Record<EvidenceKind, string> = {
  data: 'データに基づく',
  assumption: '仮定に依存',
  unquantified: '未定量',
  out_of_scope: '算定対象外',
};

export const SCENARIOS = ['bau', 'target', 'custom'] as const;
export type ScenarioKey = (typeof SCENARIOS)[number];

export const SCENARIO_LABEL: Record<ScenarioKey, string> = {
  bau: '現状維持',
  target: '目標達成',
  custom: 'カスタム',
};

export const SCENARIO_MEANING: Record<ScenarioKey, string> = {
  bau: '起点を基準年度の値で固定',
  target: '比較可の目標だけ、基準年度の実績から目標年まで直線、以後一定',
  custom: '起点ごとの年率（%/年、複利）',
};

// ======================================================================
// 仮定
// ======================================================================

export const PATHWAY_IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'] as const;
export type PathwayId = (typeof PATHWAY_IDS)[number];

type LagKey = `lag_${PathwayId}`;

export const ASSUMPTION_KEYS = [
  'carbonPriceStart',
  'carbonPriceStep',
  'fuelShare',
  'passThroughFuel',
  'passThroughPower',
  'passThroughSupplier',
  'energyPrice',
  'waterPrice',
  'wastePrice',
  'refillShare',
  'hiringCost',
  'hiringCostGrowth',
  'injuryCount',
  'injuryCost',
  'floodProbability',
  'floodRecoveryCost',
  'floodDowntimeDays',
  'floodDailyMargin',
  'productRevenue',
  'productMarginRate',
  'productStartYear',
  'productRampYears',
  'abatementCost',
  'discountRate',
  ...PATHWAY_IDS.map((id): LagKey => `lag_${id}`),
] as const;
export type AssumptionKey = (typeof ASSUMPTION_KEYS)[number];

/** 仮定の値。null は未入力（その仮定を使う経路は未定量） */
export type AssumptionValues = Record<AssumptionKey, number | null>;

export const ASSUMPTION_GROUPS = [
  'carbon',
  'unit_price',
  'people',
  'p7',
  'p8',
  'p9',
  'other',
  'lag',
] as const;
export type AssumptionGroup = (typeof ASSUMPTION_GROUPS)[number];

export const ASSUMPTION_GROUP_LABEL: Record<AssumptionGroup, string> = {
  carbon: '炭素価格と転嫁（P1・P2・P10）',
  unit_price: '単価（P3〜P5）',
  people: '人材（P6）',
  p7: '労働災害（P7。入力があるときだけ試算）',
  p8: '浸水（P8。4 つとも入力があるときだけ試算）',
  p9: '低消費電力型製品（P9。入力があるときだけ試算）',
  other: '削減費用・割引率（年合計に足さない参考値）',
  lag: '時間差（年）',
};

export interface AssumptionSpec {
  key: AssumptionKey;
  label: string;
  unit: string;
  min: number;
  max: number;
  /** URL・入力値を丸める小数の桁 */
  decimals: number;
  group: AssumptionGroup;
  /** 感度（±20%）の対象か（年数・時間差は対象外） */
  sensitivity: boolean;
}

function spec(
  key: AssumptionKey,
  label: string,
  unit: string,
  min: number,
  max: number,
  decimals: number,
  group: AssumptionGroup,
  sensitivity = true,
): AssumptionSpec {
  return { key, label, unit, min, max, decimals, group, sensitivity };
}

export const ASSUMPTION_SPECS: readonly AssumptionSpec[] = [
  spec('carbonPriceStart', '炭素価格（開始年 FY2028）', '円/t', 0, 50_000, 0, 'carbon'),
  spec('carbonPriceStep', '炭素価格の上昇幅', '円/t・年', 0, 10_000, 0, 'carbon'),
  spec('fuelShare', 'Scope1 のうち燃料由来の割合', '%', 0, 100, 1, 'carbon'),
  spec('passThroughFuel', '化石燃料賦課金の転嫁率（P1）', '%', 0, 100, 1, 'carbon'),
  spec('passThroughPower', '発電事業者の負担金の転嫁率（P2）', '%', 0, 100, 1, 'carbon'),
  spec('passThroughSupplier', '調達先の炭素コストの転嫁率（P10）', '%', 0, 100, 1, 'carbon'),
  spec('energyPrice', '電力・燃料の単価', '円/MWh', 0, 200_000, 0, 'unit_price'),
  spec('waterPrice', '水道料金の単価', '円/m3', 0, 5_000, 1, 'unit_price'),
  spec('wastePrice', '廃棄物の処理単価', '円/t', 0, 500_000, 0, 'unit_price'),
  spec('refillShare', '新規採用のうち補充採用の割合', '%', 0, 100, 1, 'people'),
  spec('hiringCost', '採用単価', '円/人', 0, 10_000_000, 0, 'people'),
  spec('hiringCostGrowth', '採用単価の上昇率', '%/年', -10, 30, 1, 'people'),
  spec('injuryCount', '労働災害の件数（想定）', '件/年', 0, 1_000, 1, 'p7'),
  spec('injuryCost', '1 件当たりの費用（休業・補償）', '円/件', 0, 100_000_000, 0, 'p7'),
  spec('floodProbability', '浸水の年発生確率', '%/年', 0, 100, 2, 'p8'),
  spec('floodRecoveryCost', '浸水時の復旧費用', '円', 0, 100_000_000_000, 0, 'p8'),
  spec('floodDowntimeDays', '操業停止の日数', '日', 0, 365, 1, 'p8'),
  spec('floodDailyMargin', '日次の限界利益', '円/日', 0, 10_000_000_000, 0, 'p8'),
  spec('productRevenue', '追加売上（立上り後）', '円/年', 0, 1_000_000_000_000, 0, 'p9'),
  spec('productMarginRate', '限界利益率', '%', 0, 100, 1, 'p9'),
  spec('productStartYear', '販売開始年度', '年度', 2020, 2060, 0, 'p9', false),
  spec('productRampYears', '立上り年数', '年', 1, 10, 0, 'p9', false),
  spec('abatementCost', '削減費用（Scope1 の 1 t 当たり）', '円/t', 0, 1_000_000, 0, 'other'),
  spec('discountRate', '割引率（現在価値の参考）', '%', 0, 20, 1, 'other'),
  ...PATHWAY_IDS.map((id) => spec(`lag_${id}`, `時間差（${id}）`, '年', 0, 10, 0, 'lag', false)),
];

const SPEC_BY_KEY = new Map(ASSUMPTION_SPECS.map((s) => [s.key, s]));

export function assumptionSpec(key: AssumptionKey): AssumptionSpec {
  const found = SPEC_BY_KEY.get(key);
  if (!found) throw new Error(`仮定 ${key} の仕様がありません`);
  return found;
}

/** 起点ごとの年率（カスタム）の範囲（%/年、複利） */
export const GROWTH_RATE_RANGE = { min: -30, max: 30, decimals: 1 } as const;

// ======================================================================
// 経路
// ======================================================================

export interface PathwayRelated {
  /** 関連する IRO（CSRD の DMA。リスク・機会）。円にはしない */
  iroTopic?: EsrsTopic;
  iroTypes?: readonly IroType[];
  /** IRO の影響を円にしていないことの注記（例: 渇水時の操業制限） */
  iroUnquantifiedNote?: string;
  /** 関連する定性情報（題名・タグに含まれる語） */
  narrativeKeywords?: readonly string[];
  /** 関連する SSBJ マテリアリティ（topicKey か題名に含まれる語） */
  ssbjTopicKeys?: readonly string[];
  ssbjKeywords?: readonly string[];
}

export interface Pathway {
  id: PathwayId;
  /** 起点。metric は基準年度の確定連結値、input は利用者の入力だけ */
  origin: { kind: 'metric'; driver: DriverKey } | { kind: 'input'; label: string };
  mechanism: string;
  line: FinancialLine;
  /** 起点が増えたときの向き（費用は減益、売上は増益） */
  direction: 'decrease' | 'increase';
  /** 式（年 y、L は時間差） */
  formula: string;
  /** 制度の開始年度（これより前は 0。無ければ null） */
  startYear: number | null;
  defaultLag: number;
  defaultEnabled: boolean;
  /** 試算に要る仮定（時間差を除く） */
  inputs: readonly AssumptionKey[];
  /** 開始前の年の注記 */
  preStartLabel: string;
  related: PathwayRelated;
  /** 経路に添える注記（画面にそのまま出す） */
  note: string | null;
}

export const PATHWAYS: Readonly<Record<PathwayId, Pathway>> = {
  P1: {
    id: 'P1',
    origin: { kind: 'metric', driver: 'scope1' },
    mechanism: '化石燃料賦課金の転嫁',
    line: 'cogs',
    direction: 'decrease',
    formula: '−S1(y−L) × 燃料由来割合 × P(y−L) × 転嫁率',
    startYear: CARBON_PRICE_START_YEAR,
    defaultLag: 0,
    defaultEnabled: true,
    inputs: ['carbonPriceStart', 'carbonPriceStep', 'fuelShare', 'passThroughFuel'],
    preStartLabel: '制度開始前',
    related: { iroTopic: 'E1', iroTypes: ['risk'], narrativeKeywords: ['炭素価格'] },
    note: '地球温暖化対策税（既に燃料価格に含まれる）は上乗せしません。',
  },
  P2: {
    id: 'P2',
    origin: { kind: 'metric', driver: 'scope2' },
    mechanism: '発電事業者の負担金の電気料金転嫁',
    line: 'cogs',
    direction: 'decrease',
    formula: '−S2(y−L) × P(y−L) × 転嫁率',
    startYear: 2033,
    defaultLag: 1,
    defaultEnabled: true,
    inputs: ['carbonPriceStart', 'carbonPriceStep', 'passThroughPower'],
    preStartLabel: '制度開始前',
    related: { iroTopic: 'E1', iroTypes: ['risk'], narrativeKeywords: ['炭素価格'] },
    note: 'マーケット基準の Scope2。ロケーション基準とは合算しません。',
  },
  P3: {
    id: 'P3',
    origin: { kind: 'metric', driver: 'energy' },
    mechanism: '電力・燃料費',
    line: 'cogs',
    direction: 'decrease',
    formula: '−(E(y−L) − E(B)) × 単価',
    startYear: null,
    defaultLag: 0,
    defaultEnabled: true,
    inputs: ['energyPrice'],
    preStartLabel: '開始前',
    related: {},
    note: 'P1・P2 と同じ燃料・電力を別の経路で数えるため、足し合わせると二重計上になりうる点に注意してください。',
  },
  P4: {
    id: 'P4',
    origin: { kind: 'metric', driver: 'water' },
    mechanism: '水道料金',
    line: 'cogs',
    direction: 'decrease',
    formula: '−(W(y−L) − W(B)) × 単価',
    startYear: null,
    defaultLag: 0,
    defaultEnabled: true,
    inputs: ['waterPrice'],
    preStartLabel: '開始前',
    related: {
      iroTopic: 'E3',
      iroTypes: ['risk'],
      iroUnquantifiedNote: '渇水時の操業制限は円にしていません（未定量）。',
    },
    note: null,
  },
  P5: {
    id: 'P5',
    origin: { kind: 'metric', driver: 'waste' },
    mechanism: '処理費',
    line: 'cogs',
    direction: 'decrease',
    formula: '−(T(y−L) − T(B)) × 単価',
    startYear: null,
    defaultLag: 0,
    defaultEnabled: true,
    inputs: ['wastePrice'],
    preStartLabel: '開始前',
    related: {
      iroTopic: 'E5',
      iroTypes: ['opportunity'],
      ssbjTopicKeys: ['circular'],
      ssbjKeywords: ['資源循環'],
    },
    note: null,
  },
  P6: {
    id: 'P6',
    origin: { kind: 'metric', driver: 'new_hires' },
    mechanism: '採用難による採用単価の上昇',
    line: 'sga',
    direction: 'decrease',
    formula: '−H(y−L) × 補充割合 × 採用単価 × ((1+上昇率)^(y−L−B) − 1)',
    startYear: null,
    defaultLag: 1,
    defaultEnabled: true,
    inputs: ['refillShare', 'hiringCost', 'hiringCostGrowth'],
    preStartLabel: '開始前',
    related: { iroTopic: 'S1', iroTypes: ['risk'] },
    note: null,
  },
  P7: {
    id: 'P7',
    origin: { kind: 'input', label: '労働災害（件数は入力）' },
    mechanism: '休業・補償',
    line: 'cogs',
    direction: 'decrease',
    formula: '−件数 × 1 件当たり費用',
    startYear: null,
    defaultLag: 0,
    defaultEnabled: true,
    inputs: ['injuryCount', 'injuryCost'],
    preStartLabel: '開始前',
    related: { ssbjTopicKeys: ['safety'], ssbjKeywords: ['労働安全'] },
    note: '件数は入力があるときだけ使います（度数率から件数を推定しません）。',
  },
  P8: {
    id: 'P8',
    origin: { kind: 'input', label: '浸水（物理的リスク）' },
    mechanism: '復旧・操業停止',
    line: 'extraordinary_loss',
    direction: 'decrease',
    formula: '−年発生確率 × (復旧費用 + 停止日数 × 日次限界利益)',
    startYear: null,
    defaultLag: 0,
    defaultEnabled: true,
    inputs: ['floodProbability', 'floodRecoveryCost', 'floodDowntimeDays', 'floodDailyMargin'],
    preStartLabel: '開始前',
    related: { narrativeKeywords: ['浸水'] },
    note: '期待値（年発生確率を掛けた平均）です。発生した年の損失はこれより大きくなります。',
  },
  P9: {
    id: 'P9',
    origin: { kind: 'input', label: '低消費電力型製品' },
    mechanism: '売上増',
    line: 'revenue',
    direction: 'increase',
    formula: '+追加売上 × 限界利益率 × 立上り係数',
    startYear: null,
    defaultLag: 0,
    defaultEnabled: true,
    inputs: ['productRevenue', 'productMarginRate', 'productStartYear', 'productRampYears'],
    preStartLabel: '販売開始前',
    related: { narrativeKeywords: ['低消費電力'] },
    note: '立上り係数は販売開始年度から立上り年数で 1 に達する直線です。',
  },
  P10: {
    id: 'P10',
    origin: { kind: 'metric', driver: 'scope3_cat1' },
    mechanism: '調達先の炭素コスト転嫁',
    line: 'cogs',
    direction: 'decrease',
    formula: '−C1(y−L) × P(y−L) × 転嫁率',
    startYear: CARBON_PRICE_START_YEAR,
    defaultLag: 3,
    defaultEnabled: false,
    inputs: ['carbonPriceStart', 'carbonPriceStep', 'passThroughSupplier'],
    preStartLabel: '制度開始前',
    related: {},
    note: 'Scope3 のうち Cat.1 だけを起点にします（Scope3 全体ではありません）。既定では無効です。',
  },
};

export function pathwayOriginLabel(pathway: Pathway): string {
  if (pathway.origin.kind === 'input') return pathway.origin.label;
  const driver = DRIVERS[pathway.origin.driver];
  return `${driver.label}（${driver.unit}）`;
}

// ======================================================================
// 既定値
// ======================================================================

/**
 * 既定値の無い仮定（Supabase モード）。価格・単価・割合は空（null）。時間差は経路の定義の既定
 * （制度と転嫁の構造で決まる値で、価格の前提ではない）
 */
export function emptyAssumptionValues(): AssumptionValues {
  const values = Object.fromEntries(ASSUMPTION_KEYS.map((key) => [key, null])) as AssumptionValues;
  for (const id of PATHWAY_IDS) values[`lag_${id}`] = PATHWAYS[id].defaultLag;
  return values;
}

export interface ImpactParams {
  scenario: ScenarioKey;
  assumptions: AssumptionValues;
  /** 起点ごとの年率（%/年、カスタムだけで使う）。既定 0 */
  growthRates: Record<DriverKey, number>;
  enabled: Record<PathwayId, boolean>;
}

export function defaultImpactParams(defaults: AssumptionValues): ImpactParams {
  return {
    scenario: 'bau',
    assumptions: { ...defaults },
    growthRates: Object.fromEntries(DRIVER_KEYS.map((key) => [key, 0])) as Record<
      DriverKey,
      number
    >,
    enabled: Object.fromEntries(
      PATHWAY_IDS.map((id) => [id, PATHWAYS[id].defaultEnabled]),
    ) as Record<PathwayId, boolean>,
  };
}

// ======================================================================
// 試算
// ======================================================================

export interface TargetPath {
  targetYear: number;
  targetValue: number;
  /**
   * 目標の向き（KPI 目標の direction）。渡されたときは、基準年度の実績が既に目標を達成している
   * （削減の目標なら実績 ≤ 目標値、増加なら実績 ≥ 目標値）目標で起点を動かさない。
   * 「目標達成」で達成済みの値から目標値へ戻す（悪化させる）直線を引かないため
   */
  direction?: 'reduce' | 'increase';
}

/** 基準年度の実績が既に目標を達成しているか（向きが無ければ判断しない = false） */
export function targetAlreadyAchieved(origin: number, target: TargetPath): boolean {
  if (target.direction === 'reduce') return origin <= target.targetValue;
  if (target.direction === 'increase') return origin >= target.targetValue;
  return false;
}

export interface SimulationInput {
  /** 基準年度 B（期間の開始年） */
  baseYear: number;
  /** 起点（基準年度の確定連結値）。null・無しは未算定 */
  origins: Partial<Record<DriverKey, number | null>>;
  /** 目標（比較可のものだけ渡す） */
  targets: Partial<Record<DriverKey, TargetPath>>;
  scenario: ScenarioKey;
  assumptions: AssumptionValues;
  growthRates: Partial<Record<DriverKey, number>>;
  enabled: Record<PathwayId, boolean>;
}

export type YearNote = 'pre_start' | 'lag';

export interface PathwayYear {
  year: number;
  /** 円/年。未定量・無効は null（0 にしない）。開始前・時間差の年は 0 */
  value: number | null;
  note: YearNote | null;
}

export type PathwayStatus = 'quantified' | 'no_origin' | 'missing_input' | 'disabled';

export interface PathwayResult {
  pathway: Pathway;
  status: PathwayStatus;
  /** 未定量・無効の理由（定量化できたら null） */
  reason: string | null;
  /** 未入力の仮定 */
  missingInputs: AssumptionKey[];
  lag: number;
  years: PathwayYear[];
  /** 10 年累計（未定量・無効は null） */
  cumulative: number | null;
  /** 初めて効く年（開始前・時間差を過ぎた最初の年。試算期間内に無ければ null） */
  firstEffectYear: number | null;
  band: TimeHorizon | null;
  evidence: EvidenceKind[];
}

export interface SimulationResult {
  scenario: ScenarioKey;
  baseYear: number;
  years: number[];
  pathways: PathwayResult[];
  /** 全経路の数（10） */
  pathwayCount: number;
  /** 有効な経路の数（N） */
  enabledCount: number;
  /** 定量化できた経路の数（n） */
  quantifiedCount: number;
  /** 年合計（定量化できた経路だけ）。定量化できた経路が無ければ null */
  totals: Array<number | null>;
  /** 10 年累計（定量化できた経路だけ）。無ければ null */
  cumulative: number | null;
  /** 参考の現在価値（割引率が未入力・定量化なしなら null） */
  presentValue: number | null;
}

/** 試算期間の年度（B+1〜B+10） */
export function horizonYears(baseYear: number): number[] {
  return Array.from({ length: HORIZON_YEARS }, (_, i) => baseYear + 1 + i);
}

/** 炭素価格 P(t)（仮定）。開始年より前は 0。仮定が未入力なら null */
export function carbonPrice(assumptions: AssumptionValues, year: number): number | null {
  const start = assumptions.carbonPriceStart;
  const step = assumptions.carbonPriceStep;
  if (start === null || step === null) return null;
  if (year < CARBON_PRICE_START_YEAR) return 0;
  return start + step * (year - CARBON_PRICE_START_YEAR);
}

/**
 * 起点の値 D(t)。t ≤ B は D(B)。それ以降はシナリオで決まる:
 * 現状維持 = D(B)、目標達成 = 目標年まで直線・以後一定（目標が無い・目標年が B 以前・
 * 基準年度の実績が既に目標を達成しているなら一定）、カスタム = D(B) × (1 + r)^(t − B)
 */
export function driverValueAt(
  input: Pick<SimulationInput, 'baseYear' | 'origins' | 'targets' | 'scenario' | 'growthRates'>,
  driver: DriverKey,
  year: number,
): number | null {
  const origin = input.origins[driver];
  if (origin === null || origin === undefined || !Number.isFinite(origin)) return null;
  const elapsed = year - input.baseYear;
  if (elapsed <= 0) return origin;
  switch (input.scenario) {
    case 'bau':
      return origin;
    case 'target': {
      const target = input.targets[driver];
      if (!target || target.targetYear <= input.baseYear) return origin;
      if (targetAlreadyAchieved(origin, target)) return origin;
      const share = Math.min(1, elapsed / (target.targetYear - input.baseYear));
      return origin + (target.targetValue - origin) * share;
    }
    case 'custom': {
      const rate = input.growthRates[driver] ?? 0;
      return origin * (1 + rate / 100) ** elapsed;
    }
  }
}

/** 時間帯（初めて効く年 − (B+1)）: 0 → 短期、1〜5 → 中期、6 以上 → 長期 */
export function lagBandOf(firstEffectYear: number | null, baseYear: number): TimeHorizon | null {
  if (firstEffectYear === null) return null;
  const offset = firstEffectYear - (baseYear + 1);
  if (offset <= 0) return 'short';
  if (offset <= 5) return 'medium';
  return 'long';
}

function lagOf(input: SimulationInput, id: PathwayId): number {
  const raw = input.assumptions[`lag_${id}`];
  return raw === null ? PATHWAYS[id].defaultLag : raw;
}

/**
 * 水準で効く経路（制度の負担・追加売上）。金額は「年 t の水準」で、基準年度の費用構造からの増減は
 * 「その年の水準 − 基準年度に計上されていた水準」になる（基準年度に既に始まっていた負担・売上を
 * 新たな影響として数えない）。ほかの経路は基準年度からの差（P3〜P6）か、基準年度の後に起きると
 * 仮定した事象（P7・P8）で、基準年度以前の水準は 0
 */
const LEVEL_PATHWAYS: ReadonlySet<PathwayId> = new Set<PathwayId>(['P1', 'P2', 'P9', 'P10']);

/** 経路が始まる年度（制度の開始・P9 は販売開始年度）。無ければ null */
function pathwayStartOf(pathway: Pathway, input: SimulationInput): number | null {
  return pathway.id === 'P9' ? (input.assumptions.productStartYear ?? null) : pathway.startYear;
}

/**
 * 年 y の注記（金額が 0 になる理由）。L は時間差:
 *  - 暦の年 y が開始年度より前 → 制度開始前（P9 は販売開始前）
 *  - 開始年度を過ぎていても、時間差で効く年 t = y − L が開始前（水準の経路）か基準年度以前
 *    （差・事象の経路）→ 時間差
 * 開始年度を過ぎた年を「開始前」と書かない（制度の表・経路の開始年と食い違わないように）
 */
function yearNoteOf(
  pathway: Pathway,
  input: SimulationInput,
  year: number,
  lag: number,
): YearNote | null {
  const start = pathwayStartOf(pathway, input);
  if (start !== null && year < start) return 'pre_start';
  const t = year - lag;
  if (start !== null && t < start) return 'lag';
  if (!LEVEL_PATHWAYS.has(pathway.id) && t <= input.baseYear) return 'lag';
  return null;
}

/**
 * 時間差で効く年 t の金額（水準）。開始前は 0、差・事象の経路は基準年度以前が 0。
 * 起点は D(t)（t ≤ B は D(B)。§10.3）、炭素価格は P(t)
 */
function pathwayAmountAt(pathway: Pathway, input: SimulationInput, t: number): number {
  const start = pathwayStartOf(pathway, input);
  if (start !== null && t < start) return 0;
  if (!LEVEL_PATHWAYS.has(pathway.id) && t <= input.baseYear) return 0;
  return pathwayValue(pathway, input, t);
}

/** 基準年度 B に計上されていた水準（時間差 L なら年 B − L の水準）。差・事象の経路は 0 */
function baseAmountOf(pathway: Pathway, input: SimulationInput, lag: number): number {
  return pathwayAmountAt(pathway, input, input.baseYear - lag);
}

/** 経路の式の値（年 t の水準。開始前・基準年度の扱いは pathwayAmountAt が決める） */
function pathwayValue(pathway: Pathway, input: SimulationInput, t: number): number {
  const a = input.assumptions;
  const d = (driver: DriverKey) => driverValueAt(input, driver, t) ?? 0;
  const base = (driver: DriverKey) => input.origins[driver] ?? 0;
  const pct = (key: AssumptionKey) => (a[key] ?? 0) / 100;
  const price = carbonPrice(a, t) ?? 0;
  switch (pathway.id) {
    case 'P1':
      return -d('scope1') * pct('fuelShare') * price * pct('passThroughFuel');
    case 'P2':
      return -d('scope2') * price * pct('passThroughPower');
    case 'P3':
      return -(d('energy') - base('energy')) * (a.energyPrice ?? 0);
    case 'P4':
      return -(d('water') - base('water')) * (a.waterPrice ?? 0);
    case 'P5':
      return -(d('waste') - base('waste')) * (a.wastePrice ?? 0);
    case 'P6': {
      const growth = (1 + pct('hiringCostGrowth')) ** Math.max(0, t - input.baseYear) - 1;
      return -d('new_hires') * pct('refillShare') * (a.hiringCost ?? 0) * growth;
    }
    case 'P7':
      return -(a.injuryCount ?? 0) * (a.injuryCost ?? 0);
    case 'P8':
      return (
        -pct('floodProbability') *
        ((a.floodRecoveryCost ?? 0) + (a.floodDowntimeDays ?? 0) * (a.floodDailyMargin ?? 0))
      );
    case 'P9': {
      const start = a.productStartYear ?? t;
      const ramp = Math.min(1, (t - start + 1) / Math.max(1, a.productRampYears ?? 1));
      return (a.productRevenue ?? 0) * pct('productMarginRate') * Math.max(0, ramp);
    }
    case 'P10':
      return -d('scope3_cat1') * price * pct('passThroughSupplier');
  }
}

function sumOrNull(values: ReadonlyArray<number | null>): number | null {
  const numbers = values.filter((v): v is number => v !== null);
  return numbers.length === 0 ? null : numbers.reduce((acc, v) => acc + v, 0);
}

/** 参考の現在価値。Σ 年合計 ÷ (1 + 割引率)^(y − B)。割引率が未入力・値が無ければ null */
export function presentValue(
  totals: ReadonlyArray<number | null>,
  years: readonly number[],
  baseYear: number,
  ratePercent: number | null,
): number | null {
  if (ratePercent === null) return null;
  let any = false;
  let sum = 0;
  totals.forEach((value, index) => {
    if (value === null) return;
    any = true;
    sum += value / (1 + ratePercent / 100) ** ((years[index] ?? baseYear) - baseYear);
  });
  return any ? sum : null;
}

function simulatePathway(pathway: Pathway, input: SimulationInput): PathwayResult {
  const years = horizonYears(input.baseYear);
  const lag = lagOf(input, pathway.id);
  const enabled = input.enabled[pathway.id];
  const missingInputs = pathway.inputs.filter((key) => input.assumptions[key] === null);
  const originMissing =
    pathway.origin.kind === 'metric' &&
    driverValueAt(input, pathway.origin.driver, input.baseYear) === null;

  // 時間帯は構造（制度の開始・時間差・販売開始年度）で決まる。未定量でも示す
  const notes = years.map((y) => yearNoteOf(pathway, input, y, lag));
  const firstIndex = notes.findIndex((note) => note === null);
  const startUnknown = pathway.id === 'P9' && input.assumptions.productStartYear === null;
  const firstEffectYear = firstIndex === -1 || startUnknown ? null : (years[firstIndex] ?? null);
  const band = lagBandOf(firstEffectYear, input.baseYear);

  let status: PathwayStatus;
  let reason: string | null = null;
  if (!enabled) {
    status = 'disabled';
    reason = '無効（算定に含めない）';
  } else if (originMissing) {
    status = 'no_origin';
    reason = '未算定（基準年度の確定値なし）';
  } else if (missingInputs.length > 0) {
    status = 'missing_input';
    reason = `未定量（入力待ち: ${missingInputs.map((key) => assumptionSpec(key).label).join('・')}）`;
  } else {
    status = 'quantified';
  }

  const quantified = status === 'quantified';
  // 基準年度の費用構造からの増減 = 年 y − L の水準 − 基準年度に計上されていた水準。
  // 時間差は曲線をずらすだけで、効き始めた後の年を 0 にしない（開始前・時間差の年は両方 0 になる）
  const baseAmount = quantified ? baseAmountOf(pathway, input, lag) : 0;
  const cells: PathwayYear[] = years.map((year, index) => {
    const note = notes[index] ?? null;
    if (!quantified) return { year, value: null, note };
    const raw = pathwayAmountAt(pathway, input, year - lag) - baseAmount;
    // −0（変化なし × 単価）を 0 にそろえる（表示で「−0.0」にしない）
    return { year, value: raw === 0 ? 0 : raw, note };
  });

  const evidence: EvidenceKind[] =
    status === 'disabled'
      ? ['out_of_scope']
      : !quantified
        ? ['unquantified']
        : pathway.origin.kind === 'metric'
          ? ['data', 'assumption']
          : ['assumption'];

  return {
    pathway,
    status,
    reason,
    missingInputs,
    lag,
    years: cells,
    cumulative: quantified ? cells.reduce((acc, c) => acc + (c.value ?? 0), 0) : null,
    firstEffectYear,
    band,
    evidence,
  };
}

/** 試算（決定論的）。経路は起点ごとに独立に計算する（相互作用はモデル化しない） */
export function simulateFinancialImpact(input: SimulationInput): SimulationResult {
  const years = horizonYears(input.baseYear);
  const pathways = PATHWAY_IDS.map((id) => simulatePathway(PATHWAYS[id], input));
  const quantified = pathways.filter((p) => p.status === 'quantified');
  const totals = years.map((_, index) =>
    quantified.length === 0
      ? null
      : quantified.reduce((acc, p) => acc + (p.years[index]?.value ?? 0), 0),
  );
  return {
    scenario: input.scenario,
    baseYear: input.baseYear,
    years,
    pathways,
    pathwayCount: pathways.length,
    enabledCount: pathways.filter((p) => p.status !== 'disabled').length,
    quantifiedCount: quantified.length,
    totals,
    cumulative: sumOrNull(totals),
    presentValue: presentValue(totals, years, input.baseYear, input.assumptions.discountRate),
  };
}

// ======================================================================
// シナリオの比較（回避コストと削減費用）
// ======================================================================

export interface ScenarioComparison {
  scenario: ScenarioKey;
  /** 回避コスト = 比べるシナリオの 10 年累計 − 現状維持の 10 年累計（＋は損失が減る） */
  avoided: number | null;
  /**
   * 削減費用の 10 年累計（別枠。営業利益に足さない）= Σ max(0, S1_bau(y) − S1_scn(y)) × 削減単価。
   * Scope1 の起点か削減単価が無ければ null
   */
  abatement: number | null;
  abatementByYear: Array<number | null>;
  quantifiedCount: number;
  enabledCount: number;
}

export function compareWithBau(
  bau: SimulationResult,
  other: SimulationResult,
  otherInput: SimulationInput,
): ScenarioComparison {
  const unitCost = otherInput.assumptions.abatementCost;
  const bauInput = { ...otherInput, scenario: 'bau' as const };
  const abatementByYear = other.years.map((year) => {
    const before = driverValueAt(bauInput, 'scope1', year);
    const after = driverValueAt(otherInput, 'scope1', year);
    if (before === null || after === null || unitCost === null) return null;
    return Math.max(0, before - after) * unitCost;
  });
  return {
    scenario: other.scenario,
    avoided:
      bau.cumulative === null || other.cumulative === null
        ? null
        : other.cumulative - bau.cumulative,
    abatement: sumOrNull(abatementByYear),
    abatementByYear,
    quantifiedCount: other.quantifiedCount,
    enabledCount: other.enabledCount,
  };
}

// ======================================================================
// 感度（数値の仮定を 1 つずつ ±20%、他は固定）
// ======================================================================

export interface SensitivityRow {
  key: AssumptionKey;
  label: string;
  unit: string;
  base: number;
  low: number;
  high: number;
  lowCumulative: number | null;
  highCumulative: number | null;
  /** 10 年累計の幅 |high − low| */
  width: number;
}

export interface SensitivityResult {
  baseCumulative: number | null;
  rows: SensitivityRow[];
  /** 動かしても 10 年累計が変わらない（または対象の値が 0・未入力の）仮定の数 */
  omitted: number;
  ratio: number;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round((value + Math.sign(value) * Number.EPSILON) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function clampToSpec(value: number, s: AssumptionSpec): number {
  return Math.min(s.max, Math.max(s.min, roundTo(value, s.decimals)));
}

export function sensitivity(
  input: SimulationInput,
  { ratio = 0.2, top = 8 }: { ratio?: number; top?: number } = {},
): SensitivityResult {
  const base = simulateFinancialImpact(input);
  const rows: SensitivityRow[] = [];
  let omitted = 0;
  for (const s of ASSUMPTION_SPECS) {
    if (!s.sensitivity) continue;
    const value = input.assumptions[s.key];
    if (value === null || value === 0) {
      omitted += 1;
      continue;
    }
    const low = clampToSpec(value * (1 - ratio), s);
    const high = clampToSpec(value * (1 + ratio), s);
    const run = (v: number) =>
      simulateFinancialImpact({ ...input, assumptions: { ...input.assumptions, [s.key]: v } })
        .cumulative;
    const lowCumulative = run(low);
    const highCumulative = run(high);
    const width =
      lowCumulative === null || highCumulative === null
        ? 0
        : Math.abs(highCumulative - lowCumulative);
    if (!(width > 0)) {
      omitted += 1;
      continue;
    }
    rows.push({
      key: s.key,
      label: s.label,
      unit: s.unit,
      base: value,
      low,
      high,
      lowCumulative,
      highCumulative,
      width,
    });
  }
  rows.sort((a, b) => b.width - a.width);
  return {
    baseCumulative: base.cumulative,
    rows: rows.slice(0, top),
    omitted: omitted + Math.max(0, rows.length - top),
    ratio,
  };
}

// ======================================================================
// URL の仮定（parse／serialize）。Cookie には保存しない
// ======================================================================

export type SearchParamsInput = URLSearchParams | Record<string, string | string[] | undefined>;

export interface ParsedImpactParams extends ImpactParams {
  /** 範囲外・数値でない値を既定に戻したときの通知 */
  notices: string[];
  /** a_・r_・p_ のどれかが URL にある、または sc=custom（「仮定を変える」を開いて描く） */
  customized: boolean;
}

function rawValue(input: SearchParamsInput, key: string): string | undefined {
  if (input instanceof URLSearchParams) {
    const all = input.getAll(key);
    return all.length === 0 ? undefined : all[all.length - 1];
  }
  const value = input[key];
  if (Array.isArray(value)) return value[value.length - 1];
  return value;
}

function hasPrefixedKey(input: SearchParamsInput): boolean {
  const keys = input instanceof URLSearchParams ? [...input.keys()] : Object.keys(input);
  return keys.some((key) => /^(a|r|p)_/.test(key));
}

/** 数値の厳密な解釈（桁区切り・全角は許すが、単位や文字が混じった値を黙って数値にしない） */
function parseNumberText(raw: string): number | 'empty' | 'invalid' {
  const text = raw.normalize('NFKC').replace(/[,，\s]/g, '');
  if (text === '') return 'empty';
  if (!/^[-+]?\d+(\.\d+)?$/.test(text)) return 'invalid';
  const value = Number(text);
  return Number.isFinite(value) ? value : 'invalid';
}

function formatSpecValue(value: number | null, unit: string): string {
  return value === null ? '未入力' : `${formatNumber(value)} ${unit}`;
}

/**
 * URL の値を読む。受け付けなかった値は既定に戻し、通知する。
 *
 * 通知には URL の生の文字列を入れない（項目名と規則だけの固定文）。共有されたリンクの値が
 * そのまま画面の通知に出ると、細工した URL で任意の文（偽のログイン先・連絡先など）を
 * 正規の画面の文として見せられるため。範囲外の通知に出すのは、数値として読めた値を丸めたものだけ
 */
export function parseImpactParams(
  input: SearchParamsInput,
  defaults: AssumptionValues,
): ParsedImpactParams {
  const params = defaultImpactParams(defaults);
  const notices: string[] = [];

  const sc = rawValue(input, 'sc');
  if (sc !== undefined && sc !== '') {
    if ((SCENARIOS as readonly string[]).includes(sc)) {
      params.scenario = sc as ScenarioKey;
    } else {
      notices.push(
        `シナリオの指定が読めないため（${SCENARIOS.map((s) => SCENARIO_LABEL[s]).join('・')} のどれでもない）、現状維持で表示しています。`,
      );
    }
  }

  for (const s of ASSUMPTION_SPECS) {
    const raw = rawValue(input, `a_${s.key}`);
    if (raw === undefined) continue;
    const parsed = parseNumberText(raw);
    if (parsed === 'empty') {
      params.assumptions[s.key] = null;
      continue;
    }
    const fallback = `既定値（${formatSpecValue(defaults[s.key], s.unit)}）に戻しました。`;
    if (parsed === 'invalid') {
      notices.push(`「${s.label}」の値が数値ではないため、${fallback}`);
      continue;
    }
    const value = roundTo(parsed, s.decimals);
    if (value < s.min || value > s.max) {
      notices.push(
        `「${s.label}」の値 ${formatNumber(value)} は範囲（${formatNumber(s.min)}〜${formatNumber(s.max)} ${s.unit}）の外のため、${fallback}`,
      );
      continue;
    }
    params.assumptions[s.key] = value;
  }

  for (const driver of DRIVER_KEYS) {
    const raw = rawValue(input, `r_${driver}`);
    if (raw === undefined) continue;
    const parsed = parseNumberText(raw);
    if (parsed === 'empty') continue;
    const label = `${DRIVERS[driver].label}の年率`;
    if (parsed === 'invalid') {
      notices.push(`「${label}」の値が数値ではないため、0 %/年に戻しました。`);
      continue;
    }
    const value = roundTo(parsed, GROWTH_RATE_RANGE.decimals);
    if (value < GROWTH_RATE_RANGE.min || value > GROWTH_RATE_RANGE.max) {
      notices.push(
        `「${label}」の値 ${formatNumber(value)} は範囲（${GROWTH_RATE_RANGE.min}〜${GROWTH_RATE_RANGE.max} %/年）の外のため、0 %/年に戻しました。`,
      );
      continue;
    }
    params.growthRates[driver] = value;
  }

  for (const id of PATHWAY_IDS) {
    const raw = rawValue(input, `p_${id}`);
    if (raw === undefined || raw === '') continue;
    if (raw === '1' || raw === '0') {
      params.enabled[id] = raw === '1';
    } else {
      notices.push(
        `経路 ${id} の有効・無効の値が読めないため（1 か 0）、既定（${PATHWAYS[id].defaultEnabled ? '有効' : '無効'}）に戻しました。`,
      );
    }
  }

  return {
    ...params,
    notices,
    customized: params.scenario === 'custom' || hasPrefixedKey(input),
  };
}

/** URL のクエリ（先頭の ? なし）。既定と同じ値は書かない（短い URL で共有できる） */
export function serializeImpactParams(params: ImpactParams, defaults: AssumptionValues): string {
  const query = new URLSearchParams();
  if (params.scenario !== 'bau') query.set('sc', params.scenario);
  for (const s of ASSUMPTION_SPECS) {
    const value = params.assumptions[s.key];
    if (value === defaults[s.key]) continue;
    query.set(`a_${s.key}`, value === null ? '' : String(value));
  }
  for (const driver of DRIVER_KEYS) {
    const value = params.growthRates[driver];
    if (value !== 0) query.set(`r_${driver}`, String(value));
  }
  for (const id of PATHWAY_IDS) {
    if (params.enabled[id] !== PATHWAYS[id].defaultEnabled) {
      query.set(`p_${id}`, params.enabled[id] ? '1' : '0');
    }
  }
  return query.toString();
}

// ======================================================================
// 表示
// ======================================================================

const MILLION_FORMAT = new Intl.NumberFormat('ja-JP', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * 百万円・小数 1 桁（丸めは表示だけ）。符号を必ず付ける（＋は増益、−は減益）。0 は「0.0」。
 * 小さな負の値が「−0.0」になるのは、符号を実際の値で決めるため（0 と読ませない）
 */
export function formatMillionYen(value: number): string {
  const text = MILLION_FORMAT.format(Math.abs(value) / 1_000_000);
  if (value > 0) return `+${text}`;
  if (value < 0) return `−${text}`;
  return text;
}

/** 円（桁区切り、小数なし）。負は「−」 */
export function formatYen(value: number): string {
  const text = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 }).format(Math.abs(value));
  return value < 0 ? `−${text}` : text;
}

function pctText(value: number | null): string {
  return `${formatNumber(value)}%`;
}

/**
 * 値を埋めた式（参照年の 1 年分）。定量化できていない経路・開始前の年は理由を返す
 */
export function describeFormula(
  result: PathwayResult,
  input: SimulationInput,
  year: number,
): string {
  if (result.status !== 'quantified') return result.reason ?? '未定量';
  const cell = result.years.find((y) => y.year === year);
  if (!cell || cell.value === null) return '未定量';
  if (cell.note === 'pre_start') {
    return `${fiscalYearLabel(year)} は${result.pathway.preStartLabel}のため 0 円`;
  }
  if (cell.note === 'lag') {
    return `${fiscalYearLabel(year)} は時間差（${result.lag} 年）のため未反映（0 円）`;
  }
  const t = year - result.lag;
  const a = input.assumptions;
  const d = (driver: DriverKey) =>
    `${formatNumber(driverValueAt(input, driver, t))} ${DRIVERS[driver].unit}`;
  const base = (driver: DriverKey) =>
    `${formatNumber(input.origins[driver] ?? null)} ${DRIVERS[driver].unit}`;
  const price = `${formatNumber(carbonPrice(a, t))} 円/t`;
  // 水準の経路で基準年度に既に計上されていた分があれば、差し引いたことを式に書く
  const baseAmount = LEVEL_PATHWAYS.has(result.pathway.id)
    ? baseAmountOf(result.pathway, input, result.lag)
    : 0;
  const resultText =
    baseAmount === 0
      ? `${formatYen(cell.value)} 円`
      : `${formatYen(pathwayAmountAt(result.pathway, input, t))} 円 − 基準年度 ${fiscalYearLabel(input.baseYear)} に計上済みの分（${formatYen(baseAmount)} 円）= ${formatYen(cell.value)} 円`;
  switch (result.pathway.id) {
    case 'P1':
      return `−${d('scope1')} × 燃料由来 ${pctText(a.fuelShare)} × 炭素価格 ${price} × 転嫁率 ${pctText(a.passThroughFuel)} = ${resultText}`;
    case 'P2':
      return `−${d('scope2')} × 炭素価格 ${price} × 転嫁率 ${pctText(a.passThroughPower)} = ${resultText}`;
    case 'P3':
      return `−(${d('energy')} − ${base('energy')}) × ${formatNumber(a.energyPrice)} 円/MWh = ${resultText}`;
    case 'P4':
      return `−(${d('water')} − ${base('water')}) × ${formatNumber(a.waterPrice)} 円/m3 = ${resultText}`;
    case 'P5':
      return `−(${d('waste')} − ${base('waste')}) × ${formatNumber(a.wastePrice)} 円/t = ${resultText}`;
    case 'P6':
      return `−${d('new_hires')} × 補充 ${pctText(a.refillShare)} × ${formatNumber(a.hiringCost)} 円/人 × ((1 + ${pctText(a.hiringCostGrowth)})^${Math.max(0, t - input.baseYear)} − 1) = ${resultText}`;
    case 'P7':
      return `−${formatNumber(a.injuryCount)} 件 × ${formatNumber(a.injuryCost)} 円/件 = ${resultText}`;
    case 'P8':
      return `−${pctText(a.floodProbability)} × (${formatNumber(a.floodRecoveryCost)} 円 + ${formatNumber(a.floodDowntimeDays)} 日 × ${formatNumber(a.floodDailyMargin)} 円/日) = ${resultText}`;
    case 'P9': {
      const start = a.productStartYear ?? t;
      const ramp = Math.min(1, (t - start + 1) / Math.max(1, a.productRampYears ?? 1));
      return `+${formatNumber(a.productRevenue)} 円 × ${pctText(a.productMarginRate)} × 立上り ${formatNumber(Math.round(ramp * 1000) / 1000)} = ${resultText}`;
    }
    case 'P10':
      return `−${d('scope3_cat1')} × 炭素価格 ${price} × 転嫁率 ${pctText(a.passThroughSupplier)} = ${resultText}`;
  }
}

// ======================================================================
// 制度の前提の参考表示（GX-ETS の参加義務）
// ======================================================================

/** GX-ETS の参加義務の目安（直近 3 年度平均の直接 CO2 排出、t） */
export const GX_ETS_THRESHOLD_T = 100_000;

/**
 * 「直接の義務対象外」と書ける Scope1 の上限（目安の半分）。判定は直近 3 年度平均の直接 CO2 で、
 * Scope1（CO2e）の 1 年度の値では決まらないため、目安に近い値では義務の有無を書かない
 */
export const GX_ETS_CLEARLY_BELOW_T = GX_ETS_THRESHOLD_T / 2;

export interface GxEtsReferenceInput {
  /** 基準年度の Scope1 の確定連結値（t-CO2e）。無ければ null */
  scope1: number | null;
  basePeriodCode: string;
  /** ヘッダーの報告期間。締め済みでなければ、当年度の値はまだ揃っていない */
  headerPeriod: { code: string; closed: boolean; statusLabel: string };
}

/**
 * GX-ETS の行の「この試算での扱い」。Scope1 の規模で書き分け、目安の 10 万 t を超える・近い会社に
 * 「義務対象外」と書かない。3 年平均を出さない理由は、ヘッダーの期間の状態から書く
 */
export function gxEtsReferenceNote({
  scope1,
  basePeriodCode,
  headerPeriod,
}: GxEtsReferenceInput): string {
  if (scope1 === null) return '参考: Scope1 の確定値が無いため、義務対象かの参考も示しません';
  const scale = `${basePeriodCode} の Scope1 は約 ${(scope1 / 10_000).toFixed(1)} 万 t-CO2e`;
  const noAverage = headerPeriod.closed
    ? 'CO2e であり直接 CO2 の値ではないため、3 年平均も出しません'
    : `CO2e であり、${headerPeriod.code} は${headerPeriod.statusLabel}のため 3 年平均も出しません`;
  if (scope1 < GX_ETS_CLEARLY_BELOW_T) {
    return `参考: 直接の義務対象外の規模（${scale}。${noAverage}）`;
  }
  if (scope1 >= GX_ETS_THRESHOLD_T) {
    return `参考: 目安の 10 万 t 以上の規模で、参加義務の対象になりえます（${scale}）。判定は直近 3 年度平均の直接 CO2 で行うため、この画面では決めません（${noAverage}）`;
  }
  return `参考: 義務対象かはこの画面では判断できません（${scale}で目安の 10 万 t に近い）。判定は直近 3 年度平均の直接 CO2 で行います（${noAverage}）`;
}
