/**
 * 架空 Fixture データセット（指示書 18 章）。
 *
 * - 実在企業・実在監査法人・実在個人は使用しない。
 * - 全 ID は `fid()` により決定論的に生成する。
 * - Demo Mode / Integration テスト / Seed SQL 生成の共通ソース。
 */

import { FIXTURE_TODAY } from '@/lib/config';
import { fid } from './ids';
import type {
  AssuranceIssue,
  AssuranceProcedure,
  DataPoint,
  DisclosureItem,
  MetricDefinition,
  OrganizationUnit,
  PbcRequest,
  ReviewNote,
  RoleKey,
} from '@/types/domain';

// ----------------------------------------------------------------------
// 時刻ユーティリティ（基準日 2026-08-14 / assumptions E-3）
// ----------------------------------------------------------------------

const BASE_MS = Date.parse(`${FIXTURE_TODAY}T00:00:00.000Z`);

/** 基準日から `days` 日前・`hour` 時（UTC）の ISO 文字列。 */
export function at(days: number, hour = 3, minute = 0): string {
  return new Date(BASE_MS - days * 86_400_000 + hour * 3_600_000 + minute * 60_000).toISOString();
}

/** 基準日から `days` 日後の暦日（YYYY-MM-DD）。 */
export function day(offset: number): string {
  return new Date(BASE_MS + offset * 86_400_000).toISOString().slice(0, 10);
}

// ----------------------------------------------------------------------
// 組織
// ----------------------------------------------------------------------

export const ORG_IDS = {
  /** 企業 A（主役） */
  aomi: fid('organization', 'AOMI'),
  /** 企業 B（越権テスト用） */
  soten: fid('organization', 'SOTEN'),
  /** 監査法人 A（主役） */
  aoba: fid('organization', 'AOBA'),
  /** 監査法人 B（越権テスト用） */
  kurobe: fid('organization', 'KUROBE'),
  platform: fid('organization', 'PLATFORM'),
} as const;

export const UNIT_IDS = {
  hq: fid('unit', 'AOMI/HQ'),
  east: fid('unit', 'AOMI/EAST'),
  west: fid('unit', 'AOMI/WEST'),
  eu: fid('unit', 'AOMI/EU'),
  jv: fid('unit', 'AOMI/JV'),
  sup1: fid('unit', 'AOMI/SUP-01'),
  sup2: fid('unit', 'AOMI/SUP-02'),
  sup3: fid('unit', 'AOMI/SUP-03'),
  sup4: fid('unit', 'AOMI/SUP-04'),
  sup5: fid('unit', 'AOMI/SUP-05'),
  sotenHq: fid('unit', 'SOTEN/HQ'),
} as const;

export const PERIOD_IDS = {
  fy2025: fid('period', 'AOMI/FY2025'),
  fy2026: fid('period', 'AOMI/FY2026'),
  sotenFy2026: fid('period', 'SOTEN/FY2026'),
} as const;

export const ENGAGEMENT_IDS = {
  /** あおば保証監査法人 × 青海テクノロジー FY2026 */
  main: fid('engagement', 'AOBA/ENG-2026-001'),
  /** くろべ監査法人 × 蒼天マテリアル FY2026（越権テスト用） */
  other: fid('engagement', 'KUROBE/ENG-2026-900'),
} as const;

// ----------------------------------------------------------------------
// デモユーザー
// ----------------------------------------------------------------------

export interface DemoUserSpec {
  email: string;
  displayName: string;
  jobTitle: string;
  organizationId: string;
  roleKeys: RoleKey[];
  unitScopeIds: string[];
  /** ワークスペース選択画面での並び順 */
  sortOrder: number;
  /** Demo ログイン画面に表示するか */
  featured: boolean;
}

export const DEMO_USERS: DemoUserSpec[] = [
  {
    email: 'enterprise-admin@demo.local',
    displayName: '青海 太郎',
    jobTitle: 'サステナビリティ推進部長',
    organizationId: ORG_IDS.aomi,
    roleKeys: ['enterprise_admin'],
    unitScopeIds: [],
    sortOrder: 1,
    featured: true,
  },
  {
    email: 'site-user@demo.local',
    displayName: '東 一郎',
    jobTitle: '東日本工場 環境管理課',
    organizationId: ORG_IDS.aomi,
    roleKeys: ['site_contributor'],
    unitScopeIds: [UNIT_IDS.east],
    sortOrder: 2,
    featured: true,
  },
  {
    email: 'assurance-manager@demo.local',
    displayName: '青葉 健',
    jobTitle: 'マネージャー',
    organizationId: ORG_IDS.aoba,
    roleKeys: ['assurance_manager'],
    unitScopeIds: [],
    sortOrder: 3,
    featured: true,
  },
  {
    email: 'sustainability@demo.local',
    displayName: '海野 みどり',
    jobTitle: '本社サステナビリティ担当',
    organizationId: ORG_IDS.aomi,
    roleKeys: ['sustainability_manager'],
    unitScopeIds: [],
    sortOrder: 4,
    featured: true,
  },
  {
    email: 'reviewer@demo.local',
    displayName: '検見川 涼',
    jobTitle: 'サステナビリティ推進部 レビュー担当',
    organizationId: ORG_IDS.aomi,
    roleKeys: ['reviewer'],
    unitScopeIds: [],
    sortOrder: 5,
    featured: true,
  },
  {
    email: 'approver@demo.local',
    displayName: '承 花子',
    jobTitle: '執行役員 サステナビリティ担当',
    organizationId: ORG_IDS.aomi,
    roleKeys: ['approver', 'reviewer'],
    unitScopeIds: [],
    sortOrder: 6,
    featured: true,
  },
  {
    email: 'assurance-partner@demo.local',
    displayName: '保 統括',
    jobTitle: '業務執行社員（契約責任者）',
    organizationId: ORG_IDS.aoba,
    roleKeys: ['engagement_partner'],
    unitScopeIds: [],
    sortOrder: 7,
    featured: true,
  },
  {
    email: 'assurance-staff@demo.local',
    displayName: '若葉 新',
    jobTitle: 'スタッフ',
    organizationId: ORG_IDS.aoba,
    roleKeys: ['assurance_staff'],
    unitScopeIds: [],
    sortOrder: 8,
    featured: true,
  },
  {
    // 未アサイン。案件データを一切見られないことの確認用。
    email: 'assurance-admin@demo.local',
    displayName: '法人 管理',
    jobTitle: '監査法人管理者',
    organizationId: ORG_IDS.aoba,
    roleKeys: ['assurance_admin'],
    unitScopeIds: [],
    sortOrder: 9,
    featured: true,
  },
  {
    email: 'other-enterprise-admin@demo.local',
    displayName: '蒼天 次郎',
    jobTitle: '企業管理者（別テナント）',
    organizationId: ORG_IDS.soten,
    roleKeys: ['enterprise_admin'],
    unitScopeIds: [],
    sortOrder: 10,
    featured: false,
  },
  {
    email: 'other-assurance-manager@demo.local',
    displayName: '黒部 誠',
    jobTitle: 'マネージャー（別法人）',
    organizationId: ORG_IDS.kurobe,
    roleKeys: ['assurance_manager'],
    unitScopeIds: [],
    sortOrder: 11,
    featured: false,
  },
];

export const USER_IDS: Record<string, string> = Object.fromEntries(
  DEMO_USERS.map((u) => [u.email, fid('user', u.email)]),
);

export function userId(email: string): string {
  const id = USER_IDS[email];
  if (!id) throw new Error(`Unknown demo user: ${email}`);
  return id;
}

// ----------------------------------------------------------------------
// 指標マスター
// ----------------------------------------------------------------------

interface MetricSpec {
  code: string;
  name: string;
  description: string;
  category: MetricDefinition['category'];
  unit: string;
  baseUnit: string;
  dataType: MetricDefinition['dataType'];
  aggregationMethod: MetricDefinition['aggregationMethod'];
  requiresEvidence: boolean;
  materiality: MetricDefinition['materiality'];
  numerator?: string;
  denominator?: string;
  yoyWarningRatio?: number;
  minValue?: number;
  maxValue?: number;
  /** 集計対象の Unit（HQ 限定のガバナンス指標など） */
  hqOnly?: boolean;
}

const METRIC_SPECS: MetricSpec[] = [
  {
    code: 'scope1',
    name: 'Scope1 排出量',
    description: '直接排出（燃料燃焼・社有車等）',
    category: 'ghg',
    unit: 't-CO2e',
    baseUnit: 't-CO2e',
    dataType: 'number',
    aggregationMethod: 'sum',
    requiresEvidence: true,
    materiality: 'high',
    yoyWarningRatio: 0.3,
    minValue: 0,
  },
  {
    code: 'scope2',
    name: 'Scope2 排出量（マーケット基準）',
    description: '購入電力等に伴う間接排出',
    category: 'ghg',
    unit: 't-CO2e',
    baseUnit: 't-CO2e',
    dataType: 'number',
    aggregationMethod: 'sum',
    requiresEvidence: true,
    materiality: 'high',
    yoyWarningRatio: 0.3,
    minValue: 0,
  },
  {
    code: 'scope3_cat1',
    name: 'Scope3 Category 1（購入した製品・サービス）',
    description: '購買金額 × 排出係数で算定',
    category: 'ghg',
    unit: 't-CO2e',
    baseUnit: 't-CO2e',
    dataType: 'number',
    aggregationMethod: 'sum',
    requiresEvidence: true,
    materiality: 'high',
    yoyWarningRatio: 0.4,
    minValue: 0,
    hqOnly: true,
  },
  {
    code: 'energy',
    name: 'エネルギー使用量',
    description: '電力・都市ガス・燃料の合計',
    category: 'energy',
    unit: 'MWh',
    baseUnit: 'MWh',
    dataType: 'number',
    aggregationMethod: 'sum',
    requiresEvidence: true,
    materiality: 'medium',
    yoyWarningRatio: 0.3,
    minValue: 0,
  },
  {
    code: 'water',
    name: '水使用量',
    description: '上水・工業用水・地下水の合計',
    category: 'water',
    unit: 'm3',
    baseUnit: 'm3',
    dataType: 'number',
    aggregationMethod: 'sum',
    requiresEvidence: false,
    materiality: 'medium',
    yoyWarningRatio: 0.3,
    minValue: 0,
  },
  {
    code: 'waste',
    name: '廃棄物排出量',
    description: '産業廃棄物・一般廃棄物の合計',
    category: 'waste',
    unit: 't',
    baseUnit: 't',
    dataType: 'number',
    aggregationMethod: 'sum',
    requiresEvidence: true,
    materiality: 'medium',
    yoyWarningRatio: 0.3,
    minValue: 0,
  },
  {
    code: 'employees',
    name: '従業員数',
    description: '期末時点の正社員数',
    category: 'human_capital',
    unit: '人',
    baseUnit: '人',
    dataType: 'integer',
    aggregationMethod: 'sum',
    requiresEvidence: false,
    materiality: 'high',
    yoyWarningRatio: 0.2,
    minValue: 0,
  },
  {
    code: 'managers_total',
    name: '管理職数',
    description: '課長相当職以上',
    category: 'human_capital',
    unit: '人',
    baseUnit: '人',
    dataType: 'integer',
    aggregationMethod: 'sum',
    requiresEvidence: false,
    materiality: 'medium',
    minValue: 0,
    hqOnly: true,
  },
  {
    code: 'female_managers',
    name: '女性管理職数',
    description: '課長相当職以上の女性',
    category: 'human_capital',
    unit: '人',
    baseUnit: '人',
    dataType: 'integer',
    aggregationMethod: 'sum',
    requiresEvidence: false,
    materiality: 'medium',
    minValue: 0,
    hqOnly: true,
  },
  {
    code: 'female_manager_ratio',
    name: '女性管理職比率',
    description: '女性管理職数 ÷ 管理職数',
    category: 'human_capital',
    unit: '%',
    baseUnit: '%',
    dataType: 'ratio',
    aggregationMethod: 'ratio',
    requiresEvidence: false,
    materiality: 'high',
    numerator: 'female_managers',
    denominator: 'managers_total',
    minValue: 0,
    maxValue: 100,
    hqOnly: true,
  },
  {
    code: 'officers_total',
    name: '役員総数',
    description: '取締役・監査役・執行役員の合計',
    category: 'governance',
    unit: '人',
    baseUnit: '人',
    dataType: 'integer',
    aggregationMethod: 'sum',
    requiresEvidence: false,
    materiality: 'high',
    minValue: 0,
    hqOnly: true,
  },
  {
    code: 'female_officers',
    name: '女性役員数',
    description: '役員のうち女性',
    category: 'governance',
    unit: '人',
    baseUnit: '人',
    dataType: 'integer',
    aggregationMethod: 'sum',
    requiresEvidence: false,
    materiality: 'high',
    minValue: 0,
    hqOnly: true,
  },
  {
    code: 'female_officer_ratio',
    name: '女性役員比率',
    description: '女性役員数 ÷ 役員総数',
    category: 'governance',
    unit: '%',
    baseUnit: '%',
    dataType: 'ratio',
    aggregationMethod: 'ratio',
    requiresEvidence: false,
    materiality: 'high',
    numerator: 'female_officers',
    denominator: 'officers_total',
    minValue: 0,
    maxValue: 100,
    hqOnly: true,
  },
  {
    code: 'directors_count',
    name: '取締役数',
    description: '取締役会構成員数',
    category: 'governance',
    unit: '人',
    baseUnit: '人',
    dataType: 'integer',
    aggregationMethod: 'latest',
    requiresEvidence: false,
    materiality: 'medium',
    minValue: 0,
    hqOnly: true,
  },
  {
    code: 'female_employees',
    name: '女性従業員数',
    description: '期末時点の女性従業員数（正社員）',
    category: 'human_capital',
    unit: '人',
    baseUnit: '人',
    dataType: 'integer',
    aggregationMethod: 'sum',
    requiresEvidence: false,
    materiality: 'high',
    yoyWarningRatio: 0.2,
    minValue: 0,
  },
  {
    code: 'new_hires',
    name: '新規採用者数',
    description: '当期の新規採用者数（正社員）',
    category: 'human_capital',
    unit: '人',
    baseUnit: '人',
    dataType: 'integer',
    aggregationMethod: 'sum',
    requiresEvidence: false,
    materiality: 'medium',
    yoyWarningRatio: 0.5,
    minValue: 0,
  },
  {
    code: 'turnover_rate',
    name: '離職率',
    description: '当期の離職者数 ÷ 期首従業員数。自己都合・会社都合の区分は定義により異なる',
    category: 'human_capital',
    unit: '%',
    baseUnit: '%',
    dataType: 'ratio',
    aggregationMethod: 'weighted_average',
    requiresEvidence: false,
    materiality: 'high',
    yoyWarningRatio: 0.4,
    minValue: 0,
    maxValue: 100,
  },
  {
    code: 'avg_tenure',
    name: '平均勤続年数',
    description: '期末時点の平均勤続年数',
    category: 'human_capital',
    unit: '年',
    baseUnit: '年',
    dataType: 'number',
    aggregationMethod: 'average',
    requiresEvidence: false,
    materiality: 'medium',
    yoyWarningRatio: 0.2,
    minValue: 0,
  },
  {
    code: 'training_hours',
    name: '一人あたり研修時間',
    description: '当期の総研修時間 ÷ 従業員数',
    category: 'human_capital',
    unit: '時間',
    baseUnit: '時間',
    dataType: 'number',
    aggregationMethod: 'average',
    requiresEvidence: false,
    materiality: 'medium',
    yoyWarningRatio: 0.5,
    minValue: 0,
  },
  {
    code: 'ltifr',
    name: '労働災害度数率（LTIFR）',
    description: '休業災害件数 × 1,000,000 ÷ 総労働時間。100 万時間あたりの件数',
    category: 'human_capital',
    unit: '件/百万時間',
    baseUnit: '件/百万時間',
    dataType: 'number',
    aggregationMethod: 'weighted_average',
    requiresEvidence: true,
    materiality: 'high',
    yoyWarningRatio: 0.8,
    minValue: 0,
  },
  {
    code: 'gender_pay_gap',
    name: '男女賃金格差',
    description: '男性の平均賃金に対する女性の平均賃金の割合。平均値か中央値かは定義により異なる',
    category: 'human_capital',
    unit: '%',
    baseUnit: '%',
    dataType: 'ratio',
    aggregationMethod: 'weighted_average',
    requiresEvidence: false,
    materiality: 'high',
    yoyWarningRatio: 0.3,
    minValue: 0,
    maxValue: 200,
  },
];

export function metricId(orgCode: string, code: string): string {
  return fid('metric', `${orgCode}/${code}`);
}

// ----------------------------------------------------------------------
// Data Point 生成テーブル
// ----------------------------------------------------------------------

interface UnitSpec {
  id: string;
  code: string;
  name: string;
  unitType: OrganizationUnit['unitType'];
  countryCode: string;
  currencyCode: string;
  timezone: string;
  consolidationMethod: OrganizationUnit['consolidationMethod'];
  ownershipPercent: number;
  parent: keyof typeof UNIT_IDS | null;
  /** データ入力対象の Unit か（サプライヤーは Phase 1 では対象外） */
  reports: boolean;
  /** 環境指標の規模係数 */
  scale: number;
}

const AOMI_UNITS: UnitSpec[] = [
  {
    id: UNIT_IDS.hq,
    code: 'HQ',
    name: '本社',
    unitType: 'headquarters',
    countryCode: 'JP',
    currencyCode: 'JPY',
    timezone: 'Asia/Tokyo',
    consolidationMethod: 'full',
    ownershipPercent: 100,
    parent: null,
    reports: true,
    scale: 1,
  },
  {
    id: UNIT_IDS.east,
    code: 'EAST',
    name: '東日本工場',
    unitType: 'site',
    countryCode: 'JP',
    currencyCode: 'JPY',
    timezone: 'Asia/Tokyo',
    consolidationMethod: 'full',
    ownershipPercent: 100,
    parent: 'hq',
    reports: true,
    scale: 3.2,
  },
  {
    id: UNIT_IDS.west,
    code: 'WEST',
    name: '西日本工場',
    unitType: 'site',
    countryCode: 'JP',
    currencyCode: 'JPY',
    timezone: 'Asia/Tokyo',
    consolidationMethod: 'full',
    ownershipPercent: 100,
    parent: 'hq',
    reports: true,
    scale: 2.4,
  },
  {
    id: UNIT_IDS.eu,
    code: 'EU',
    name: '欧州販売子会社',
    unitType: 'subsidiary',
    countryCode: 'NL',
    currencyCode: 'EUR',
    timezone: 'Europe/Amsterdam',
    consolidationMethod: 'full',
    ownershipPercent: 100,
    parent: 'hq',
    reports: true,
    scale: 0.6,
  },
  {
    // 持分法適用会社。データは集めるが連結値には足さない（組織タグ「連結対象のみ」で外れる）
    id: UNIT_IDS.jv,
    code: 'JV',
    name: '青海マテリアル合弁会社',
    unitType: 'subsidiary',
    countryCode: 'JP',
    currencyCode: 'JPY',
    timezone: 'Asia/Tokyo',
    consolidationMethod: 'equity',
    ownershipPercent: 35,
    parent: 'hq',
    reports: true,
    scale: 0.35,
  },
  {
    id: UNIT_IDS.sup1,
    code: 'SUP-01',
    name: '常盤精密工業',
    unitType: 'supplier',
    countryCode: 'JP',
    currencyCode: 'JPY',
    timezone: 'Asia/Tokyo',
    consolidationMethod: 'excluded',
    ownershipPercent: 0,
    parent: 'hq',
    reports: false,
    scale: 0,
  },
  {
    id: UNIT_IDS.sup2,
    code: 'SUP-02',
    name: '橙陽ケミカル',
    unitType: 'supplier',
    countryCode: 'JP',
    currencyCode: 'JPY',
    timezone: 'Asia/Tokyo',
    consolidationMethod: 'excluded',
    ownershipPercent: 0,
    parent: 'hq',
    reports: false,
    scale: 0,
  },
  {
    id: UNIT_IDS.sup3,
    code: 'SUP-03',
    name: '白樺物流',
    unitType: 'supplier',
    countryCode: 'JP',
    currencyCode: 'JPY',
    timezone: 'Asia/Tokyo',
    consolidationMethod: 'excluded',
    ownershipPercent: 0,
    parent: 'hq',
    reports: false,
    scale: 0,
  },
  {
    id: UNIT_IDS.sup4,
    code: 'SUP-04',
    name: 'みなと包装資材',
    unitType: 'supplier',
    countryCode: 'JP',
    currencyCode: 'JPY',
    timezone: 'Asia/Tokyo',
    consolidationMethod: 'excluded',
    ownershipPercent: 0,
    parent: 'hq',
    reports: false,
    scale: 0,
  },
  {
    id: UNIT_IDS.sup5,
    code: 'SUP-05',
    name: 'アルプス電子部品',
    unitType: 'supplier',
    countryCode: 'JP',
    currencyCode: 'JPY',
    timezone: 'Asia/Tokyo',
    consolidationMethod: 'excluded',
    ownershipPercent: 0,
    parent: 'hq',
    reports: false,
    scale: 0,
  },
];

/** FY2025 の基準値（HQ 基準・単位は MetricSpec.unit） */
const FY2025_BASE: Record<string, number> = {
  scope1: 1240.5,
  scope2: 3180.2,
  scope3_cat1: 48210.0,
  energy: 6420.0,
  water: 38500,
  waste: 412.8,
  employees: 480,
  female_employees: 168,
  new_hires: 42,
  turnover_rate: 6.8,
  avg_tenure: 12.4,
  training_hours: 24.6,
  ltifr: 1.42,
  gender_pay_gap: 76.4,
  managers_total: 120,
  female_managers: 18,
  female_manager_ratio: 15,
  officers_total: 12,
  female_officers: 2,
  female_officer_ratio: 16.7,
  directors_count: 9,
};

/** FY2026 の対 FY2025 変化率 */
const FY2026_GROWTH: Record<string, number> = {
  scope1: 0.96,
  scope2: 0.91,
  scope3_cat1: 1.05,
  energy: 0.94,
  water: 1.02,
  waste: 1.08,
  employees: 1.04,
  female_employees: 1.09,
  new_hires: 1.18,
  turnover_rate: 0.92,
  avg_tenure: 1.03,
  training_hours: 1.14,
  ltifr: 0.78,
  gender_pay_gap: 1.03,
  managers_total: 1.05,
  female_managers: 1.28,
  female_manager_ratio: 1.22,
  officers_total: 1.0,
  female_officers: 1.0,
  female_officer_ratio: 1.0,
  directors_count: 1.0,
};

export interface DataPointSeed {
  unitCode: string;
  metricCode: string;
  periodCode: 'FY2025' | 'FY2026';
  value: number;
  unitOfMeasure: string;
  status: DataPoint['status'];
  /** 意図的な異常 Fixture の識別子 */
  anomaly?: string;
  changedAfterApproval?: boolean;
  hasEvidence: boolean;
  /** Snapshot 固定後に企業側が変更した（監査法人の Change Alert 用） */
  changedAfterSnapshot?: boolean;
}

const FY2026_STATUS: Record<string, DataPoint['status']> = {
  'HQ/scope1': 'approved',
  'HQ/scope2': 'approved',
  'HQ/scope3_cat1': 'approved',
  'HQ/energy': 'approved',
  'HQ/water': 'in_review',
  'HQ/waste': 'approved',
  'HQ/employees': 'approved',
  'HQ/managers_total': 'approved',
  'HQ/female_managers': 'approved',
  'HQ/female_manager_ratio': 'approved',
  'HQ/officers_total': 'approved',
  'HQ/female_officers': 'approved',
  'HQ/female_officer_ratio': 'in_review',
  'HQ/directors_count': 'approved',
  'EAST/scope1': 'approved',
  'EAST/scope2': 'approved',
  'EAST/energy': 'approved',
  'EAST/water': 'returned',
  'EAST/waste': 'in_review',
  'EAST/employees': 'approved',
  'WEST/scope1': 'approved',
  'WEST/scope2': 'approved',
  'WEST/energy': 'approved',
  'WEST/water': 'in_review',
  'WEST/waste': 'submitted',
  'WEST/employees': 'approved',
  'EU/scope1': 'submitted',
  'EU/scope2': 'draft',
  'EU/energy': 'draft',
  'EU/water': 'draft',
  'EU/waste': 'draft',
  'EU/employees': 'draft',
};

function roundFor(metricCode: string, value: number): number {
  const spec = METRIC_SPECS.find((m) => m.code === metricCode);
  if (spec?.dataType === 'integer') return Math.round(value);
  if (spec?.dataType === 'ratio') return Math.round(value * 10) / 10;
  return Math.round(value * 10) / 10;
}

export function buildDataPointSeeds(): DataPointSeed[] {
  const seeds: DataPointSeed[] = [];

  for (const period of ['FY2025', 'FY2026'] as const) {
    for (const unit of AOMI_UNITS) {
      if (!unit.reports) continue;
      for (const metric of METRIC_SPECS) {
        if (metric.hqOnly && unit.code !== 'HQ') continue;

        const base = FY2025_BASE[metric.code] ?? 0;
        const isRatioOrCount =
          metric.dataType === 'ratio' || metric.category === 'governance' || metric.hqOnly === true;
        const scaled = isRatioOrCount ? base : base * unit.scale;
        const growth = period === 'FY2026' ? (FY2026_GROWTH[metric.code] ?? 1) : 1;
        let value = roundFor(metric.code, scaled * growth);
        let unitOfMeasure = metric.unit;
        let anomaly: string | undefined;
        const key = `${unit.code}/${metric.code}`;
        const status: DataPoint['status'] =
          period === 'FY2025' ? 'approved' : (FY2026_STATUS[key] ?? 'draft');

        if (period === 'FY2026') {
          // 異常 Fixture（指示書 18 章）
          if (key === 'WEST/water') {
            value = roundFor(metric.code, scaled * 10);
            anomaly = 'yoy_x10';
          }
          if (key === 'EAST/waste') {
            value = roundFor(metric.code, scaled * 1000);
            unitOfMeasure = 'kg';
            anomaly = 'unit_kg_vs_t';
          }
          if (key === 'HQ/female_officers') {
            value = 4;
            anomaly = 'female_officers_exceed_total';
          }
          if (key === 'HQ/officers_total') {
            value = 3;
          }
        }

        const requiresEvidence = metric.requiresEvidence;
        let hasEvidence = requiresEvidence;
        if (period === 'FY2026' && key === 'EU/scope1') {
          hasEvidence = false;
          anomaly = 'missing_evidence';
        }
        if (!requiresEvidence) {
          hasEvidence = key === 'HQ/employees';
        }

        seeds.push({
          unitCode: unit.code,
          metricCode: metric.code,
          periodCode: period,
          value,
          unitOfMeasure,
          status,
          anomaly,
          hasEvidence,
          changedAfterApproval: period === 'FY2026' && key === 'HQ/scope2',
          changedAfterSnapshot:
            period === 'FY2026' && (key === 'EAST/scope1' || key === 'WEST/energy'),
        });
      }
    }
  }
  return seeds;
}

export function dataPointId(unitCode: string, metricCode: string, periodCode: string): string {
  return fid('data_point', `AOMI/${periodCode}/${unitCode}/${metricCode}`);
}

// ----------------------------------------------------------------------
// CDP / SSBJ 架空マスター
// ----------------------------------------------------------------------

interface DisclosureItemSpec {
  code: string;
  section: string;
  questionText: string;
  guidance: string;
  answerType: DisclosureItem['answerType'];
  options?: string[];
  required: boolean;
  changeType2026: DisclosureItem['changeType'];
  /** マッピング対象の指標コード */
  metricCode?: string;
  /** FY2025 の回答（Carry Forward の元） */
  previousAnswer?: string;
  previousNumeric?: number;
}

export const CDP_ITEM_SPECS: DisclosureItemSpec[] = [
  {
    code: 'C0.1',
    section: 'C0 イントロダクション',
    questionText: '貴社の事業内容を記載してください。',
    guidance: '主要製品・サービス、事業所所在地、従業員規模を含めてください。',
    answerType: 'text',
    required: true,
    changeType2026: 'carry_forward',
    previousAnswer:
      '青海テクノロジー株式会社は精密電子部品の設計・製造・販売を行っています。国内 2 工場と欧州販売子会社を有し、連結従業員数は約 480 名です。',
  },
  {
    code: 'C0.2',
    section: 'C0 イントロダクション',
    questionText: '報告対象期間の開始日と終了日を記載してください。',
    guidance: '会計年度と一致させてください。',
    answerType: 'text',
    required: true,
    changeType2026: 'carry_forward',
    previousAnswer: '2025-04-01 〜 2026-03-31',
  },
  {
    code: 'C1.1',
    section: 'C1 ガバナンス',
    questionText: '気候関連課題を監督する取締役会レベルの責任者は存在しますか。',
    guidance: '存在する場合は役職名と監督頻度を記載してください。',
    answerType: 'single_choice',
    options: ['はい', 'いいえ'],
    required: true,
    changeType2026: 'carry_forward',
    previousAnswer: 'はい',
  },
  {
    code: 'C1.1b',
    section: 'C1 ガバナンス',
    questionText: '取締役会における気候関連課題の監督内容を説明してください。',
    guidance: '議題、頻度、意思決定への反映を記載してください。',
    answerType: 'text',
    required: true,
    changeType2026: 'changed',
    previousAnswer:
      '取締役会は四半期ごとにサステナビリティ委員会からの報告を受け、GHG 削減目標の進捗を監督しています。',
  },
  {
    code: 'C1.2',
    section: 'C1 ガバナンス',
    questionText: '取締役会の構成（取締役数・女性役員比率）を記載してください。',
    guidance: '報告期間末日時点の数値を記載してください。',
    answerType: 'numeric',
    required: true,
    changeType2026: 'new',
    metricCode: 'female_officer_ratio',
    previousNumeric: 16.7,
  },
  {
    code: 'C4.1',
    section: 'C4 目標と実績',
    questionText: 'GHG 排出量削減目標を設定していますか。',
    guidance: '基準年、目標年、削減率を記載してください。',
    answerType: 'single_choice',
    options: ['絶対量目標', '原単位目標', '両方', '設定していない'],
    required: true,
    changeType2026: 'carry_forward',
    previousAnswer: '絶対量目標',
  },
  {
    code: 'C6.1',
    section: 'C6 排出量データ',
    questionText: '報告対象期間の Scope1 総排出量（t-CO2e）を記載してください。',
    guidance: '連結範囲の合計値を記載してください。',
    answerType: 'numeric',
    required: true,
    changeType2026: 'carry_forward',
    metricCode: 'scope1',
    previousNumeric: 9052.7,
  },
  {
    code: 'C6.3',
    section: 'C6 排出量データ',
    questionText: '報告対象期間の Scope2（マーケット基準）総排出量（t-CO2e）を記載してください。',
    guidance: 'ロケーション基準と区別して記載してください。',
    answerType: 'numeric',
    required: true,
    changeType2026: 'carry_forward',
    metricCode: 'scope2',
    previousNumeric: 22579.4,
  },
  {
    code: 'C6.5',
    section: 'C6 排出量データ',
    questionText:
      'Scope3 Category 1（購入した製品・サービス）の排出量（t-CO2e）を記載してください。',
    guidance: '算定方法（金額ベース／物量ベース）を併記してください。',
    answerType: 'numeric',
    required: true,
    changeType2026: 'changed',
    metricCode: 'scope3_cat1',
    previousNumeric: 48210.0,
  },
  {
    code: 'C8.2',
    section: 'C8 エネルギー',
    questionText: '報告対象期間のエネルギー総使用量（MWh）を記載してください。',
    guidance: '電力・燃料・熱の合計を記載してください。',
    answerType: 'numeric',
    required: true,
    changeType2026: 'carry_forward',
    metricCode: 'energy',
    previousNumeric: 46864.0,
  },
  {
    code: 'C10.1',
    section: 'C10 検証',
    questionText: '排出量データについて第三者保証を受けていますか。',
    guidance: '保証水準（限定的／合理的）と保証機関を記載してください。',
    answerType: 'single_choice',
    options: ['限定的保証', '合理的保証', '受けていない'],
    required: true,
    changeType2026: 'changed',
    previousAnswer: '受けていない',
  },
  {
    code: 'C12.1',
    section: 'C12 エンゲージメント',
    questionText: 'サプライヤーに対する気候関連のエンゲージメント活動を説明してください。',
    guidance: '対象サプライヤー数と活動内容を記載してください。',
    answerType: 'text',
    required: false,
    changeType2026: 'new',
  },
];

export const SSBJ_ITEM_SPECS: DisclosureItemSpec[] = [
  {
    code: 'SSBJ-G1',
    section: 'ガバナンス',
    questionText: 'サステナビリティ関連のリスク・機会を監視する統治機関を記載してください。',
    guidance: '',
    answerType: 'text',
    required: true,
    changeType2026: 'carry_forward',
  },
  {
    code: 'SSBJ-G2',
    section: 'ガバナンス',
    questionText: '経営者の役割を記載してください。',
    guidance: '',
    answerType: 'text',
    required: true,
    changeType2026: 'carry_forward',
  },
  {
    code: 'SSBJ-S1',
    section: '戦略',
    questionText: '識別したサステナビリティ関連のリスク・機会を記載してください。',
    guidance: '',
    answerType: 'text',
    required: true,
    changeType2026: 'carry_forward',
  },
  {
    code: 'SSBJ-S2',
    section: '戦略',
    questionText: 'ビジネスモデルおよびバリューチェーンへの影響を記載してください。',
    guidance: '',
    answerType: 'text',
    required: true,
    changeType2026: 'carry_forward',
  },
  {
    code: 'SSBJ-S3',
    section: '戦略',
    questionText: '気候関連のシナリオ分析結果を記載してください。',
    guidance: '',
    answerType: 'text',
    required: false,
    changeType2026: 'changed',
  },
  {
    code: 'SSBJ-R1',
    section: 'リスク管理',
    questionText: 'リスクの識別・評価・管理プロセスを記載してください。',
    guidance: '',
    answerType: 'text',
    required: true,
    changeType2026: 'carry_forward',
  },
  {
    code: 'SSBJ-M1',
    section: '指標及び目標',
    questionText: 'Scope1 排出量（t-CO2e）',
    guidance: '',
    answerType: 'numeric',
    required: true,
    changeType2026: 'carry_forward',
    metricCode: 'scope1',
  },
  {
    code: 'SSBJ-M2',
    section: '指標及び目標',
    questionText: 'Scope2 排出量（t-CO2e）',
    guidance: '',
    answerType: 'numeric',
    required: true,
    changeType2026: 'carry_forward',
    metricCode: 'scope2',
  },
  {
    code: 'SSBJ-M3',
    section: '指標及び目標',
    questionText: 'Scope3 排出量（t-CO2e）',
    guidance: '',
    answerType: 'numeric',
    required: true,
    changeType2026: 'changed',
    metricCode: 'scope3_cat1',
  },
  {
    code: 'SSBJ-M4',
    section: '指標及び目標',
    questionText: '女性管理職比率（%）',
    guidance: '',
    answerType: 'numeric',
    required: true,
    changeType2026: 'carry_forward',
    metricCode: 'female_manager_ratio',
  },
];

// ----------------------------------------------------------------------
// 保証手続テンプレート（架空 / ISAE3000 相当の一般的手続）
// ----------------------------------------------------------------------

export const PROCEDURE_SPECS: Array<{
  code: string;
  title: string;
  description: string;
  category: AssuranceProcedure['category'];
  required: boolean;
}> = [
  {
    code: 'P-01',
    title: '母集団の完全性確認',
    description:
      '対象期間・対象組織のデータが漏れなく母集団に含まれていることを、組織マスターおよび報告期間設定と突合して確かめる。',
    category: 'completeness',
    required: true,
  },
  {
    code: 'P-02',
    title: '原資料との照合',
    description:
      'サンプルの値を Evidence（請求書・計測記録等）と照合し、金額・数量・期間の一致を確かめる。',
    category: 'accuracy',
    required: true,
  },
  {
    code: 'P-03',
    title: '再計算',
    description:
      '算定式、活動量、排出係数、単位換算を用いて独立に再計算し、記録値との差異を確かめる。',
    category: 'recalculation',
    required: true,
  },
  {
    code: 'P-04',
    title: '期間帰属（カットオフ）の確認',
    description: 'Evidence の対象期間が報告対象期間に帰属していることを確かめる。',
    category: 'cutoff',
    required: true,
  },
  {
    code: 'P-05',
    title: '単位・換算の妥当性',
    description: '報告単位、換算係数、係数年度が指標定義と整合していることを確かめる。',
    category: 'accuracy',
    required: true,
  },
  {
    code: 'P-06',
    title: '担当者への質問',
    description: '算定方法の変更、見積り、除外の理由について担当者へ質問し、回答を記録する。',
    category: 'inquiry',
    required: false,
  },
  {
    code: 'P-07',
    title: '承認証跡の閲覧',
    description: '企業側のレビュー・承認が権限者により実施されていることを閲覧により確かめる。',
    category: 'inspection',
    required: false,
  },
  {
    code: 'P-08',
    title: 'Snapshot 後変更の評価',
    description: 'Snapshot 固定後の企業側変更について、保証結論への影響を評価する。',
    category: 'completeness',
    required: true,
  },
];

// ----------------------------------------------------------------------
// PBC / Issue / Review Note の Fixture 定義
// ----------------------------------------------------------------------

export const PBC_SPECS: Array<{
  code: string;
  title: string;
  description: string;
  status: PbcRequest['status'];
  priority: PbcRequest['priority'];
  dueOffsetDays: number;
  internalNote: string | null;
  responseBody?: string;
  decision?: 'accepted' | 'rejected';
}> = [
  {
    code: 'PBC-001',
    title: '東日本工場 電力使用量の月次明細',
    description:
      'FY2026 上期の電力使用量について、電力会社発行の月次請求書（4〜9月）をご提出ください。',
    status: 'accepted',
    priority: 'high',
    dueOffsetDays: -20,
    internalNote: 'P-02 照合で使用。受領済み。',
    responseBody: '2026年4月〜9月の請求書 PDF を添付します。',
    decision: 'accepted',
  },
  {
    code: 'PBC-002',
    title: '西日本工場 水使用量の異常値説明',
    description: '前年比 10 倍となっている水使用量について、原因と根拠資料をご提出ください。',
    status: 'under_review',
    priority: 'critical',
    dueOffsetDays: -3,
    internalNote: '未受領のまま Sign-off へ進めないこと。',
    responseBody: '検針データの単位誤り（m3 と L の取り違え）の可能性を調査中です。',
    decision: undefined,
  },
  {
    code: 'PBC-003',
    title: 'Scope3 Cat.1 の排出係数根拠',
    description: '採用した排出係数の出典、係数年度、適用範囲がわかる資料をご提出ください。',
    status: 'sent',
    priority: 'high',
    dueOffsetDays: 5,
    internalNote: null,
  },
  {
    code: 'PBC-004',
    title: '役員構成の確認資料',
    description: '報告期間末日時点の役員名簿（性別記載）をご提出ください。',
    status: 'overdue',
    priority: 'high',
    dueOffsetDays: -6,
    internalNote: '女性役員数 > 役員総数 の矛盾あり。要確認。',
  },
  {
    code: 'PBC-005',
    title: '廃棄物マニフェストの原本',
    description: '東日本工場の産業廃棄物マニフェスト（電子マニフェスト出力）をご提出ください。',
    status: 'draft',
    priority: 'medium',
    dueOffsetDays: 12,
    internalNote: '単位 kg / t 混在の確認後に送付する。',
  },
];

export const ISSUE_SPECS: Array<{
  code: string;
  title: string;
  description: string;
  severity: AssuranceIssue['severity'];
  status: AssuranceIssue['status'];
  metricCode: string | null;
  quantitativeImpact: number | null;
  quantitativeImpactUnit: string | null;
  rootCause: string | null;
  resolution: string | null;
  managementResponse?: string;
}> = [
  {
    code: 'ISS-001',
    title: '女性役員数が役員総数を超えている',
    description:
      'FY2026 の女性役員数 4 名に対し役員総数 3 名が報告されており、論理矛盾が生じている。女性役員比率の算定にも影響する。',
    severity: 'high',
    status: 'open',
    metricCode: 'female_officers',
    quantitativeImpact: null,
    quantitativeImpactUnit: null,
    rootCause: '人事システムからの転記時に、監査役を役員総数へ含めていない可能性。',
    resolution: null,
  },
  {
    code: 'ISS-002',
    title: '東日本工場の廃棄物量が kg 単位で報告されている',
    description:
      '指標定義では t 単位だが、東日本工場のみ kg で報告されている。連結集計時に 1000 倍の誤差となる。',
    severity: 'medium',
    status: 'management_response',
    metricCode: 'waste',
    quantitativeImpact: 1320.9,
    quantitativeImpactUnit: 't',
    rootCause: '拠点側テンプレートの単位欄が未固定。',
    resolution: null,
    managementResponse:
      '拠点テンプレートの単位欄をプルダウン固定へ変更し、FY2026 データを t へ再登録します。',
  },
  {
    code: 'ISS-003',
    title: 'Scope2 の承認後変更が記録されている',
    description:
      '本社 Scope2 について承認後に値が変更されている。変更理由の記録はあるが、再承認証跡が確認できなかった。',
    severity: 'low',
    status: 'resolved',
    metricCode: 'scope2',
    quantitativeImpact: 28.4,
    quantitativeImpactUnit: 't-CO2e',
    rootCause: '再計算後の再承認フローが未整備。',
    resolution: '企業側で再承認を実施し、承認証跡を確認した。',
    managementResponse: '承認後変更時は再承認を必須とするワークフローへ変更しました。',
  },
];

export const REVIEW_NOTE_SPECS: Array<{
  body: string;
  status: ReviewNote['status'];
  sharedWithClient: boolean;
  resolutionComment: string | null;
}> = [
  {
    body: 'P-03（再計算）について、Scope3 Cat.1 の係数年度が FY2025 のままとなっていないか確認すること。係数年度の根拠を調書へ添付すること。',
    status: 'open',
    sharedWithClient: false,
    resolutionComment: null,
  },
  {
    body: '母集団の完全性について、欧州販売子会社が Grant 範囲外である旨を調書に明記すること。保証対象範囲の限定として報告書に反映が必要。',
    status: 'cleared',
    sharedWithClient: true,
    resolutionComment: '調書 WP-1000 に範囲限定の記載を追加した。',
  },
];

// ----------------------------------------------------------------------
// 排出係数（架空値）
// ----------------------------------------------------------------------

export const EMISSION_FACTOR_SPECS: Array<{
  code: string;
  name: string;
  category: string;
  factorValue: number;
  factorUnit: string;
  activityUnit: string;
  factorYear: number;
}> = [
  {
    code: 'EF-PUR-ELEC',
    name: '電子部品（購入金額ベース）',
    category: 'purchased_goods',
    factorValue: 0.00042,
    factorUnit: 't-CO2e/千円',
    activityUnit: '千円',
    factorYear: 2025,
  },
  {
    code: 'EF-PUR-CHEM',
    name: '化学品（購入金額ベース）',
    category: 'purchased_goods',
    factorValue: 0.00081,
    factorUnit: 't-CO2e/千円',
    activityUnit: '千円',
    factorYear: 2025,
  },
  {
    code: 'EF-PUR-PACK',
    name: '包装資材（購入金額ベース）',
    category: 'purchased_goods',
    factorValue: 0.00056,
    factorUnit: 't-CO2e/千円',
    activityUnit: '千円',
    factorYear: 2025,
  },
  {
    code: 'EF-LOGI',
    name: '物流サービス（購入金額ベース）',
    category: 'purchased_services',
    factorValue: 0.00037,
    factorUnit: 't-CO2e/千円',
    activityUnit: '千円',
    factorYear: 2025,
  },
  {
    code: 'EF-ELEC-JP',
    name: '電力（日本・全国平均）',
    category: 'electricity',
    factorValue: 0.000434,
    factorUnit: 't-CO2e/kWh',
    activityUnit: 'kWh',
    factorYear: 2025,
  },
];

/** Scope3 Cat.1 の算定内訳（サプライヤー別購買実績・架空値） */
export const SCOPE3_PURCHASE_ROWS: Array<{
  supplierUnitCode: string;
  item: string;
  amountThousandJpy: number;
  factorCode: string;
}> = [
  {
    supplierUnitCode: 'SUP-01',
    item: '精密加工部品',
    amountThousandJpy: 42_800_000 / 1000,
    factorCode: 'EF-PUR-ELEC',
  },
  {
    supplierUnitCode: 'SUP-02',
    item: '樹脂・接着剤',
    amountThousandJpy: 18_600_000 / 1000,
    factorCode: 'EF-PUR-CHEM',
  },
  {
    supplierUnitCode: 'SUP-03',
    item: '国内輸送',
    amountThousandJpy: 9_400_000 / 1000,
    factorCode: 'EF-LOGI',
  },
  {
    supplierUnitCode: 'SUP-04',
    item: '包装資材',
    amountThousandJpy: 6_200_000 / 1000,
    factorCode: 'EF-PUR-PACK',
  },
  {
    supplierUnitCode: 'SUP-05',
    item: '電子部品',
    amountThousandJpy: 31_500_000 / 1000,
    factorCode: 'EF-PUR-ELEC',
  },
];

export { AOMI_UNITS, METRIC_SPECS, type MetricSpec, type UnitSpec };

/**
 * CDP 質問の適用条件（CDP-P0-002）。
 * 依存先の質問への回答によって、その質問が適用されるかどうかが決まる。
 */
export const CDP_ITEM_CONDITIONS: Array<{
  itemCode: string;
  dependsOnItemCode: string;
  operator: 'equals' | 'not_equals' | 'in' | 'exists';
  value: string;
}> = [
  // 監督責任者が「いる」場合にだけ、監督内容の説明が求められる
  { itemCode: 'C1.1b', dependsOnItemCode: 'C1.1', operator: 'equals', value: 'はい' },
  // 削減目標を設定している場合にだけ、目標に対する検証状況が問われる
  {
    itemCode: 'C10.1',
    dependsOnItemCode: 'C4.1',
    operator: 'not_equals',
    value: '設定していない',
  },
  // Scope3 Cat.1 を算定している場合にだけ、サプライヤーエンゲージメントが問われる
  { itemCode: 'C12.1', dependsOnItemCode: 'C6.5', operator: 'exists', value: '' },
];

/**
 * CSRD（ESRS）の架空縮小マスター（機能追加要望 ②）。
 *
 * 正式な ESRS 開示要求の全量ではなく、デモ用に主要トピックを 12 項目へ縮約した架空マスター。
 * CSRD は当社にとって初年度対応のため、全項目が changeType 'new'（前年回答なし）。
 */
export const CSRD_ITEM_SPECS: DisclosureItemSpec[] = [
  {
    code: 'ESRS2-GOV-1',
    section: 'ESRS 2 全般開示',
    questionText: 'サステナビリティ課題に関する経営・監督機関の役割と構成を開示してください。',
    guidance: '取締役会の監督体制、担当役員、専門性を含めてください。',
    answerType: 'text',
    required: true,
    changeType2026: 'new',
  },
  {
    code: 'ESRS2-SBM-3',
    section: 'ESRS 2 全般開示',
    questionText:
      '重要なインパクト・リスク・機会（IRO）と、戦略およびビジネスモデルとの相互作用を開示してください。',
    guidance: 'ダブルマテリアリティ評価の結果に基づいて記載してください。',
    answerType: 'text',
    required: true,
    changeType2026: 'new',
  },
  {
    code: 'ESRS-E1-1',
    section: 'ESRS E1 気候変動',
    questionText: '気候変動緩和のための移行計画を開示してください。',
    guidance: '1.5°C 目標との整合性、脱炭素化手段、投資計画を含めてください。',
    answerType: 'text',
    required: true,
    changeType2026: 'new',
  },
  {
    code: 'ESRS-E1-4',
    section: 'ESRS E1 気候変動',
    questionText: 'GHG 排出削減目標を開示してください。',
    guidance: '基準年、目標年、対象範囲（Scope1/2/3）、進捗を記載してください。',
    answerType: 'text',
    required: true,
    changeType2026: 'new',
  },
  {
    code: 'ESRS-E1-5',
    section: 'ESRS E1 気候変動',
    questionText: 'エネルギー消費量とエネルギーミックスを開示してください。',
    guidance: '総エネルギー消費量（MWh）と再生可能エネルギー比率を記載してください。',
    answerType: 'numeric',
    required: true,
    changeType2026: 'new',
    metricCode: 'energy',
  },
  {
    code: 'ESRS-E1-6',
    section: 'ESRS E1 気候変動',
    questionText: 'Scope1・Scope2・Scope3 の GHG 総排出量（t-CO2e）を開示してください。',
    guidance:
      'GHG プロトコルに基づく算定方法を併記してください。（本デモの当年値表示は Scope1 の承認済み集計。Scope2/3 は各データ画面を参照）',
    answerType: 'numeric',
    required: true,
    changeType2026: 'new',
    metricCode: 'scope1',
  },
  {
    code: 'ESRS-E3-4',
    section: 'ESRS E3 水資源',
    questionText: '取水量・消費量（m3）を開示してください。',
    guidance: '水ストレス地域における取水量を区別して記載してください。',
    answerType: 'numeric',
    required: false,
    changeType2026: 'new',
    metricCode: 'water',
  },
  {
    code: 'ESRS-E5-5',
    section: 'ESRS E5 資源循環',
    questionText: '廃棄物総量（t）とリサイクル率を開示してください。',
    guidance: '有害廃棄物と非有害廃棄物を区別してください。',
    answerType: 'numeric',
    required: false,
    changeType2026: 'new',
    metricCode: 'waste',
  },
  {
    code: 'ESRS-S1-6',
    section: 'ESRS S1 自社労働力',
    questionText: '従業員数の内訳（雇用形態・地域・性別）を開示してください。',
    guidance: '報告期間末日時点の人数を記載してください。',
    answerType: 'numeric',
    required: true,
    changeType2026: 'new',
    metricCode: 'employees',
  },
  {
    code: 'ESRS-S1-9',
    section: 'ESRS S1 自社労働力',
    questionText: '経営層のダイバーシティ指標（女性管理職比率）を開示してください。',
    guidance: '管理職に占める女性の割合（%）を記載してください。',
    answerType: 'numeric',
    required: true,
    changeType2026: 'new',
    metricCode: 'female_manager_ratio',
  },
  {
    code: 'ESRS-G1-1',
    section: 'ESRS G1 企業行動',
    questionText: '企業文化および事業行動に関する方針を開示してください。',
    guidance: '腐敗防止・内部通報制度・サプライヤー行動規範を含めてください。',
    answerType: 'text',
    required: true,
    changeType2026: 'new',
  },
  {
    code: 'ESRS-G1-4',
    section: 'ESRS G1 企業行動',
    questionText: '腐敗・贈収賄の確定事案の件数を開示してください。',
    guidance: '報告期間中に確定した事案の件数（件）を記載してください。',
    answerType: 'numeric',
    required: false,
    changeType2026: 'new',
  },
];
