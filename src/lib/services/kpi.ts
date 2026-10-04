import 'server-only';

import { randomUUID } from 'node:crypto';
import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, assertEnterpriseWorkspace } from '@/lib/authorization/can';
import { ValidationError } from '@/lib/errors/user-facing';
import {
  computeConsolidatedAggregation,
  consolidationFactor,
  hasUsableValue,
  isActualValue,
  isCountedInTotals,
  valueKindOf,
  type ConsolidatedAggregation,
} from '@/lib/services/aggregation';
import { loadOwnedSnapshot, SNAPSHOT_KIND_DISPLAY } from '@/lib/services/report-snapshot';
import type { DbClient } from '@/lib/repositories/types';
import {
  KPI_DIRECTIONS,
  KPI_TARGET_TYPES,
  type AuthorizationContext,
  type AvailabilityStatus,
  type DataPoint,
  type DataPointStatus,
  type DataPointVersion,
  type IsoDateTime,
  type KpiDirection,
  type KpiTarget,
  type KpiTargetType,
  type MetricDefinition,
  type NarrativeRecord,
  type OrganizationUnit,
  type ReportSnapshotKind,
  type ReportingPeriod,
  type Uuid,
} from '@/types/domain';

/**
 * ESG 経営ダッシュボードの KPI と目標（指示書 §6.11、docs/disclosure-first.md §6 /enterprise/esg）。
 *
 * 開示業務で登録した Data Point をそのまま使い、KPI 用の別コピーは作らない。
 *
 * 実績（最新承認値モード）
 *  - GHG 画面と同じ連結値（computeConsolidatedAggregation: 持分調整・内部取引控除後、承認済みのみ）。
 *    Copilot 等の単純合計（org-snapshot）は使わない（開示の数値と食い違うため）。
 *  - 実績に使うのは「対象の全拠点が承認済み」の年度だけ（最新の確定年度）。集計途中の年度は
 *    承認済み分の途中集計として別に示し、進捗率・前年差には使わない（途中の合計は小さく出て良く見えるため）。
 *  - 未承認の訂正（承認後に直して未承認に戻った値）は混ぜない。
 * 目標
 *  - 進捗率は (基準値 − 実績) ÷ (基準値 − 目標値)。分母 0 は計算しない。負値・100% 超は意味を添えて残す。
 *  - 目標と実績の境界・算定方法（総量／原単位）が違えば進捗率を出さず「比較条件の確認が必要」とする（A33）。
 * 前年同条件との差
 *  - 対象拠点・境界・算定方法が前年と同じときだけ差を出す。違えば「比較条件の確認が必要」（A34）。
 * 定義の区別
 *  - Scope2 のマーケット基準とロケーション基準は別カードで、足さない（A08）。
 *  - Scope3 の合計は scope3_total の登録値だけ。Cat.1 を Scope3 全体として示さない（A09）。
 *  - 男女賃金は指標の定義（比率か格差率か）をそのまま示し、相互に換算しない（A12）。
 *  - 労災は件数と度数率を分け、件数の代わりに率を示さない（A14）。率の全社値は分子・分母から再計算し、
 *    拠点値の単純平均は使わない（A13）。
 * スナップショット照合モード
 *  - 選んだレポートのスナップショットが引用した版の値を示し、最新承認値との差と更新理由を並べる。
 *    最新値が過去のレポートを変えたようには見せない。
 */

// ======================================================================
// KPI の定義
// ======================================================================

export const KPI_KEYS = [
  'scope1',
  'scope2_market',
  'scope2_location',
  'scope3',
  'gender_pay',
  'occupational_safety',
] as const;
export type KpiKey = (typeof KPI_KEYS)[number];

export type KpiKind = 'ghg' | 'scope3' | 'ratio' | 'safety';

export interface KpiSpec {
  key: KpiKey;
  label: string;
  /** カードの主となる指標（Scope3 は合計、労災は件数） */
  metricCode: string;
  /** カードに並べる副指標（Scope3 のカテゴリ、労災の死亡者数・度数率） */
  subMetricCodes: readonly string[];
  kind: KpiKind;
  /** 定義上の注意（画面にそのまま出す） */
  note: string;
  /** 関連する定性情報を探すタグ */
  narrativeTags: readonly string[];
}

const SCOPE3_CATEGORY_CODES = Array.from({ length: 15 }, (_, i) => `scope3_cat${i + 1}`);

export const KPI_SPECS: Readonly<Record<KpiKey, KpiSpec>> = {
  scope1: {
    key: 'scope1',
    label: 'Scope1',
    metricCode: 'scope1',
    subMetricCodes: [],
    kind: 'ghg',
    note: 'GHG 画面と同じ連結値（持分調整・内部取引控除後。承認済みのデータのみ）。',
    narrativeTags: ['気候'],
  },
  scope2_market: {
    key: 'scope2_market',
    label: 'Scope2（マーケット基準）',
    metricCode: 'scope2',
    subMetricCodes: [],
    kind: 'ghg',
    note: 'マーケット基準。ロケーション基準とは別の指標で、合算しません。',
    narrativeTags: ['気候'],
  },
  scope2_location: {
    key: 'scope2_location',
    label: 'Scope2（ロケーション基準）',
    metricCode: 'scope2_location',
    subMetricCodes: [],
    kind: 'ghg',
    note: 'ロケーション基準。マーケット基準とは別の指標で、合算しません。',
    narrativeTags: ['気候'],
  },
  scope3: {
    key: 'scope3',
    label: 'Scope3',
    metricCode: 'scope3_total',
    subMetricCodes: SCOPE3_CATEGORY_CODES,
    kind: 'scope3',
    note: '合計は「Scope3 排出量（合計）」の登録値だけを使います。カテゴリ別の値を足し上げて合計とせず、Cat.1 だけを Scope3 全体として示しません。',
    narrativeTags: ['気候'],
  },
  gender_pay: {
    key: 'gender_pay',
    label: '男女賃金',
    metricCode: 'gender_pay_gap',
    subMetricCodes: [],
    kind: 'ratio',
    note: '比率（女性 ÷ 男性 × 100）と格差率（(男性 − 女性) ÷ 男性 × 100）は別の定義です。指標に登録された定義のまま示し、自動で換算・同一視しません。',
    narrativeTags: ['人的資本', '賃金'],
  },
  occupational_safety: {
    key: 'occupational_safety',
    label: '労災',
    metricCode: 'work_related_injuries',
    subMetricCodes: ['work_related_fatalities', 'ltifr'],
    kind: 'safety',
    note: '件数と度数率（LTIFR）は別の指標です。件数の代わりに率を示しません。率の全社値は分子・分母から再計算し、拠点値の単純平均は使いません。',
    narrativeTags: ['人的資本', '労働安全'],
  },
};

export function isKpiKey(value: string | null | undefined): value is KpiKey {
  return KPI_KEYS.includes(value as KpiKey);
}

const ALL_KPI_METRIC_CODES = [
  ...new Set(
    KPI_KEYS.flatMap((key) => [KPI_SPECS[key].metricCode, ...KPI_SPECS[key].subMetricCodes]),
  ),
];

// ======================================================================
// 純粋関数: 進捗率・目標差・比較条件
// ======================================================================

export type ProgressResult =
  | { status: 'ok'; rate: number; explanation: string }
  | {
      status: 'unavailable';
      code: 'not_comparable' | 'no_base' | 'no_actual' | 'zero_denominator' | 'direction_mismatch';
      reason: string;
    };

export const PROGRESS_FORMULA = '(基準値 − 実績値) ÷ (基準値 − 目標値) × 100';

/**
 * 目標の進捗率（%）。削減・増加どちらの目標でも同じ式で向きが揃う
 * （(基準 − 実績) ÷ (基準 − 目標) = (実績 − 基準) ÷ (目標 − 基準)）。
 * 値は丸めずに返す（表示で丸める。保存値と表示を分ける）。
 */
export function computeTargetProgress(input: {
  baseValue: number | null;
  targetValue: number;
  actualValue: number | null;
  direction: KpiDirection;
  comparable: boolean;
  comparabilityReasons?: readonly string[];
}): ProgressResult {
  if (!input.comparable) {
    return {
      status: 'unavailable',
      code: 'not_comparable',
      reason: `比較条件の確認が必要: ${(input.comparabilityReasons ?? []).join(' ／ ') || '目標と実績の算定条件が一致しません。'}`,
    };
  }
  if (input.baseValue === null || !Number.isFinite(input.baseValue)) {
    return {
      status: 'unavailable',
      code: 'no_base',
      reason: '基準値が登録されていないため、進捗率を計算できません。',
    };
  }
  if (input.actualValue === null || !Number.isFinite(input.actualValue)) {
    return {
      status: 'unavailable',
      code: 'no_actual',
      reason: '確定した実績（全拠点が承認済みの年度）が無いため、進捗率を計算できません。',
    };
  }
  const denominator = input.baseValue - input.targetValue;
  if (denominator === 0) {
    return {
      status: 'unavailable',
      code: 'zero_denominator',
      reason: '基準値と目標値が同じため、進捗率を定義できません（分母が 0）。',
    };
  }
  const wrongDirection = input.direction === 'reduce' ? denominator < 0 : denominator > 0;
  if (wrongDirection) {
    return {
      status: 'unavailable',
      code: 'direction_mismatch',
      reason: `目標値が基準値に対して「${input.direction === 'reduce' ? '削減' : '増加'}」の向きになっていません。目標の登録内容を確認してください。`,
    };
  }
  const rate = ((input.baseValue - input.actualValue) / denominator) * 100;
  let explanation: string;
  if (rate < 0) {
    explanation =
      input.direction === 'reduce'
        ? '実績が基準値を上回っています（基準年より増えています）。負の値は目標から遠ざかったことを表します。'
        : '実績が基準値を下回っています（基準年より減っています）。負の値は目標から遠ざかったことを表します。';
  } else if (rate > 100) {
    explanation = '実績が目標値を超えています（100% 超は目標を上回って達成したことを表します）。';
  } else {
    explanation = '基準値から目標値までのうち、実績がどこまで進んだかを表します。';
  }
  return { status: 'ok', rate, explanation };
}

export type TargetGapResult =
  { status: 'ok'; gap: number; text: string } | { status: 'unavailable'; reason: string };

/** 目標差（実績 − 目標値。単位は指標と同じ） */
export function computeTargetGap(input: {
  actualValue: number | null;
  targetValue: number;
  direction: KpiDirection;
  comparable: boolean;
}): TargetGapResult {
  if (!input.comparable) return { status: 'unavailable', reason: '比較条件の確認が必要' };
  if (input.actualValue === null)
    return { status: 'unavailable', reason: '確定した実績がありません' };
  const gap = input.actualValue - input.targetValue;
  const achieved = input.direction === 'reduce' ? gap <= 0 : gap >= 0;
  return {
    status: 'ok',
    gap,
    text: achieved ? '目標値に達しています' : '目標値まで差があります',
  };
}

/** 原単位（分母で割った値）の指標か。単位に「/」を含むものを原単位とみなす */
function isIntensityMetric(metric: Pick<MetricDefinition, 'unit'>): boolean {
  return metric.unit.includes('/');
}

/**
 * 目標と実績を同じ条件で比べられるか（A33: 境界・総量／原単位・算定方法。指示書 §6.11）。
 * 算定方法は、目標に登録した「前提にした実績の算定方法」（actualMethodology）と、
 * 実績に入った承認済みの行の算定方法（Data Point の methodology）をそのまま比べる。
 * どちらかが未記載・拠点ごとに違う・一致しないなら達成率を出さない（推測で同じとみなさない）。
 */
export function targetComparability(
  target: Pick<KpiTarget, 'boundary' | 'targetType' | 'actualMethodology'>,
  actual: {
    boundary: string | null;
    metric: Pick<MetricDefinition, 'unit'>;
    /** 実績に入った行の算定方法（未記載は null）。実績が無ければ空配列 */
    methodologies: ReadonlyArray<string | null>;
  },
): { comparable: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const targetBoundary = target.boundary.trim();
  if (actual.boundary === null) {
    reasons.push('実績の範囲（境界）が確定していません。');
  } else if (targetBoundary !== actual.boundary.trim()) {
    reasons.push(`目標の範囲「${targetBoundary}」と実績の範囲「${actual.boundary}」が異なります。`);
  }
  const intensity = isIntensityMetric(actual.metric);
  if (target.targetType === 'intensity' && !intensity) {
    reasons.push('目標は原単位ですが、実績は総量の指標です。');
  } else if (target.targetType === 'absolute' && intensity) {
    reasons.push('目標は総量ですが、実績は原単位の指標です。');
  }
  const targetMethod = target.actualMethodology?.trim() || null;
  if (targetMethod === null) {
    reasons.push('目標の前提にした実績の算定方法が登録されていません。');
  } else if (actual.methodologies.length > 0) {
    const methods = [...new Set(actual.methodologies.map((m) => m?.trim() || null))];
    if (methods.includes(null)) {
      reasons.push('実績の算定方法が記載されていない拠点があります。');
    } else if (methods.length > 1) {
      reasons.push(`拠点ごとに実績の算定方法が異なります（${methods.join('／')}）。`);
    } else if (methods[0] !== targetMethod) {
      reasons.push(
        `目標の算定方法「${targetMethod}」と実績の算定方法「${methods[0]}」が異なります。`,
      );
    }
  }
  return { comparable: reasons.length === 0, reasons };
}

/**
 * 実績に入った（承認済み・連結対象・内部取引の明細以外の）行の算定方法。
 * 目標の比較可否（targetComparability）に渡す。財務影響分析の目標シナリオも同じ規則で選ぶため公開する
 */
export function actualMethodologiesOf(state: MetricPeriodState | null): Array<string | null> {
  if (!state) return [];
  return state.contributions
    .filter((c) => c.status === 'approved' && c.factor > 0 && c.boundary !== '内部取引')
    .filter((c) => c.availabilityStatus === 'value_present')
    .map((c) => c.methodology);
}

// ======================================================================
// 年度ごとの集計状態
// ======================================================================

export interface UnitContribution {
  dataPointId: Uuid;
  unitId: Uuid;
  unitName: string;
  boundary: string;
  status: DataPointStatus;
  value: number | null;
  unitOfMeasure: string;
  availabilityStatus: AvailabilityStatus;
  absenceReason: string | null;
  methodology: string | null;
  /** 連結係数（持分法・除外は 0） */
  factor: number;
  consolidationLabel: string;
  versionNo: number | null;
  /** 承認後に直して未承認に戻った値（実績に含めない） */
  unapprovedCorrection: boolean;
}

export interface MetricPeriodState {
  metric: MetricDefinition;
  period: ReportingPeriod;
  /** Data Point が 1 件でもあるか（無ければ「未入力」） */
  hasData: boolean;
  /** 全社値を算定できる指標か（比率の分子・分母が無い指標は算定しない） */
  computable: boolean;
  nonComputableReason: string | null;
  /** 承認済みだけで計算した全社値（GHG 画面の連結値と同じ）。値が無ければ null（0 にしない） */
  approvedValue: number | null;
  /** 対象の全拠点が承認済み（または対象外と判断済み） */
  complete: boolean;
  expectedUnitCount: number;
  approvedUnits: string[];
  pendingUnits: Array<{ unitName: string; status: DataPointStatus }>;
  missingUnits: string[];
  notApplicableUnits: string[];
  /** 承認済みだが値が推計（value_kind = estimate）の拠点。確定した実績には数えない */
  estimateUnits: string[];
  /** 承認済みだが値が目標値だけの拠点（実績が無い） */
  targetOnlyUnits: string[];
  /** 推計の件数（実績には含めない）。出所ごとに分けて説明する */
  estimateCount: number;
  /** うち当年に推計値として承認された拠点 */
  currentEstimateCount: number;
  /** うち前年の承認済み実績で補完した拠点 */
  priorYearFillCount: number;
  unapprovedCorrectionCount: number;
  /** 承認済みで集計に入った行の境界（例: 連結） */
  boundary: string | null;
  contributions: UnitContribution[];
}

function consolidationLabelOf(unit: OrganizationUnit | undefined): string {
  if (!unit) return '—';
  switch (unit.consolidationMethod) {
    case 'full':
      return '連結（全部）';
    case 'proportionate':
      return `比例連結（${unit.ownershipPercent}%）`;
    case 'equity':
      return `持分法（${unit.ownershipPercent}%・合計に含めない）`;
    case 'excluded':
      return '対象外';
  }
}

interface KpiData {
  periods: ReportingPeriod[];
  metrics: MetricDefinition[];
  units: OrganizationUnit[];
  /** 読み込んだ指標のコード（Data Point と連結集計はこの指標だけ） */
  metricCodes: readonly string[];
  dataPoints: DataPoint[];
  versions: DataPointVersion[];
  approvedVersionIds: Set<Uuid>;
  aggregations: Map<Uuid, Promise<ConsolidatedAggregation>>;
}

/**
 * KPI・経年比較の計算に要る行をまとめて読む（書かない）。指標は metricCodes に絞る
 * （既定は ESG経営の KPI の指標。自社経年比較は数値指標すべてを渡す。docs/disclosure-first.md §10.2）
 */
async function loadKpiData(
  db: DbClient,
  ctx: AuthorizationContext,
  metricCodes: readonly string[] = ALL_KPI_METRIC_CODES,
): Promise<KpiData> {
  const organizationId = ctx.workspace.organizationId;
  const [periods, metrics, units] = await Promise.all([
    db.select('periods', { where: { organizationId } }),
    db.select('metrics', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('units', { where: { organizationId, deletedAt: { isNull: true } } }),
  ]);
  const kpiMetricIds = metrics.filter((m) => metricCodes.includes(m.code)).map((m) => m.id);
  const dataPoints =
    kpiMetricIds.length === 0
      ? []
      : await db.select('dataPoints', {
          where: { organizationId, metricId: { in: kpiMetricIds }, deletedAt: { isNull: true } },
        });
  const dpIds = dataPoints.map((d) => d.id);
  const [versions, approvals] =
    dpIds.length === 0
      ? [[], []]
      : await Promise.all([
          db.select('dataPointVersions', { where: { organizationId, dataPointId: { in: dpIds } } }),
          db.select('approvals', {
            where: {
              organizationId,
              targetType: 'data_point',
              targetId: { in: dpIds },
              decision: 'approved',
            },
          }),
        ]);
  return {
    periods: [...periods].sort((a, b) => (a.startDate < b.startDate ? -1 : 1)),
    metrics,
    units,
    metricCodes,
    dataPoints,
    versions,
    approvedVersionIds: new Set(
      approvals.map((a) => a.targetVersionId).filter((id): id is Uuid => id !== null),
    ),
    aggregations: new Map(),
  };
}

function aggregationFor(
  db: DbClient,
  ctx: AuthorizationContext,
  data: KpiData,
  period: ReportingPeriod,
): Promise<ConsolidatedAggregation> {
  let pending = data.aggregations.get(period.id);
  if (!pending) {
    pending = computeConsolidatedAggregation(db, ctx, period, data.periods, [...data.metricCodes]);
    data.aggregations.set(period.id, pending);
  }
  return pending;
}

/** 承認後に値を直し、まだ承認されていない行か（承認済みの以前の版がある未承認の行） */
function isUnapprovedCorrection(dp: DataPoint, data: KpiData): boolean {
  if (dp.status === 'approved') return false;
  return (
    dp.changedAfterApproval ||
    data.versions.some(
      (v) =>
        v.dataPointId === dp.id &&
        v.id !== dp.currentVersionId &&
        (data.approvedVersionIds.has(v.id) || v.status === 'approved'),
    )
  );
}

async function metricPeriodState(
  db: DbClient,
  ctx: AuthorizationContext,
  data: KpiData,
  metric: MetricDefinition,
  period: ReportingPeriod,
): Promise<MetricPeriodState> {
  const unitById = new Map(data.units.map((u) => [u.id, u]));
  const rows = data.dataPoints.filter(
    (d) => d.metricId === metric.id && d.reportingPeriodId === period.id,
  );
  const counted = rows.filter(isCountedInTotals);

  const expectedUnits = data.units.filter(
    (u) =>
      u.unitType !== 'supplier' &&
      consolidationFactor(u) > 0 &&
      (!metric.hqOnly || u.unitType === 'headquarters'),
  );

  const approvedUnits: string[] = [];
  const pendingUnits: Array<{ unitName: string; status: DataPointStatus }> = [];
  const missingUnits: string[] = [];
  const notApplicableUnits: string[] = [];
  const estimateUnits: string[] = [];
  const targetOnlyUnits: string[] = [];
  for (const unit of expectedUnits) {
    const unitRows = counted.filter((d) => d.unitId === unit.id);
    if (unitRows.length === 0) {
      missingUnits.push(unit.name);
      continue;
    }
    const notApproved = unitRows.find((d) => d.status !== 'approved');
    if (notApproved) {
      pendingUnits.push({ unitName: unit.name, status: notApproved.status });
      continue;
    }
    if (unitRows.every((d) => d.availabilityStatus === 'not_applicable')) {
      notApplicableUnits.push(unit.name);
      continue;
    }
    // 実績の拠点に数えるのは、値のある行（対象外・目標値を除く）がすべて実績のときだけ。
    // 承認済みでも推計・目標値は実績ではない（「承認済みだから実測扱い」にしない: 指示書 §10.4）
    const valueRows = unitRows.filter(
      (d) => d.availabilityStatus !== 'not_applicable' && valueKindOf(d) !== 'target',
    );
    if (valueRows.length > 0 && valueRows.every(isActualValue)) {
      approvedUnits.push(unit.name);
    } else if (valueRows.some((d) => hasUsableValue(d) && valueKindOf(d) === 'estimate')) {
      estimateUnits.push(unit.name);
    } else if (
      valueRows.length === 0 &&
      unitRows.some((d) => d.availabilityStatus === 'value_present' && valueKindOf(d) === 'target')
    ) {
      targetOnlyUnits.push(unit.name);
    } else {
      // 承認済みでも値が無い（未取得・未算定）行は、確定した実績として数えない
      pendingUnits.push({ unitName: unit.name, status: 'approved' });
    }
  }

  const approvedWithValue = counted.filter(
    (d) =>
      d.status === 'approved' &&
      isActualValue(d) &&
      consolidationFactor(
        unitById.get(d.unitId) ?? { consolidationMethod: 'full', ownershipPercent: 100 },
      ) > 0,
  );

  // 全社値の算定方法は指標定義に従う
  let computable = true;
  let nonComputableReason: string | null = null;
  let approvedValue: number | null = null;
  const aggregation = await aggregationFor(db, ctx, data, period);
  const aggregate = aggregation.metrics.find((m) => m.metric.id === metric.id);
  const hasRatioInputs = Boolean(metric.numeratorMetricCode && metric.denominatorMetricCode);
  if (metric.aggregationMethod === 'sum') {
    const consolidated = aggregate?.consolidated;
    // 足した実績の行が 1 件も無ければ値なし（集計は実績だけを足し、無い分を 0 にするため、
    // 推計・目標だけの年度が「0」として確定値に見えてしまう）
    approvedValue =
      approvedWithValue.length > 0 &&
      (aggregate?.consolidatedValueCount ?? 0) > 0 &&
      typeof consolidated === 'number'
        ? consolidated
        : null;
  } else if (hasRatioInputs) {
    const weighted = aggregate?.weightedAverage;
    approvedValue = typeof weighted === 'number' ? weighted : null;
  } else {
    computable = false;
    nonComputableReason =
      metric.aggregationMethod === 'weighted_average' || metric.aggregationMethod === 'ratio'
        ? '全社値は分子・分母の指標から再計算します。分子・分母が登録されていないため算定できません（拠点値の単純平均は使いません）。'
        : `全社値の集計方法（${metric.aggregationMethod}）では合計できないため、拠点ごとの値だけを示します。`;
  }

  const boundaries = [...new Set(approvedWithValue.map((d) => d.boundary))].sort();

  const contributions: UnitContribution[] = rows
    .map((d) => {
      const unit = unitById.get(d.unitId);
      const current = data.versions.find((v) => v.id === d.currentVersionId);
      return {
        dataPointId: d.id,
        unitId: d.unitId,
        unitName: unit?.name ?? '（組織不明）',
        boundary: d.boundary,
        status: d.status,
        value: d.value,
        unitOfMeasure: d.unitOfMeasure,
        availabilityStatus: d.availabilityStatus,
        absenceReason: d.absenceReason,
        methodology: d.methodology,
        factor: unit ? consolidationFactor(unit) : 0,
        consolidationLabel: consolidationLabelOf(unit),
        versionNo: current?.versionNo ?? null,
        unapprovedCorrection: isUnapprovedCorrection(d, data),
      };
    })
    .sort((a, b) => {
      const ua = unitById.get(a.unitId)?.sortOrder ?? 0;
      const ub = unitById.get(b.unitId)?.sortOrder ?? 0;
      return ua === ub ? (a.boundary < b.boundary ? -1 : 1) : ua - ub;
    });

  return {
    metric,
    period,
    hasData: rows.length > 0,
    computable,
    nonComputableReason,
    approvedValue,
    complete:
      expectedUnits.length > 0 &&
      pendingUnits.length === 0 &&
      missingUnits.length === 0 &&
      estimateUnits.length === 0 &&
      targetOnlyUnits.length === 0 &&
      approvedUnits.length + notApplicableUnits.length === expectedUnits.length,
    expectedUnitCount: expectedUnits.length,
    approvedUnits,
    pendingUnits,
    missingUnits,
    notApplicableUnits,
    estimateUnits,
    targetOnlyUnits,
    // 推計（当年の推計値・前年値での補完）は合計の指標だけの話（比率に拠点値を足す補完はしない）
    estimateCount: metric.aggregationMethod === 'sum' ? (aggregate?.estimates.length ?? 0) : 0,
    currentEstimateCount:
      metric.aggregationMethod === 'sum'
        ? (aggregate?.estimates.filter((e) => e.source === 'current_estimate').length ?? 0)
        : 0,
    priorYearFillCount:
      metric.aggregationMethod === 'sum'
        ? (aggregate?.estimates.filter((e) => e.source === 'prior_year').length ?? 0)
        : 0,
    unapprovedCorrectionCount: contributions.filter((c) => c.unapprovedCorrection).length,
    boundary: boundaries.length === 0 ? null : boundaries.join('・'),
    contributions,
  };
}

// ======================================================================
// 前年同条件との比較（A34）
// ======================================================================

export type YoyResult =
  | {
      status: 'ok';
      previousPeriod: ReportingPeriod;
      previousValue: number;
      diff: number;
      /** 前年比（%）。前年値が 0 のときは null（割らない） */
      diffRate: number | null;
      notes: string[];
    }
  | { status: 'needs_check'; previousPeriod: ReportingPeriod; reasons: string[]; notes: string[] }
  | { status: 'unavailable'; reason: string };

function approvedContributionsByUnit(state: MetricPeriodState): Map<Uuid, UnitContribution[]> {
  const map = new Map<Uuid, UnitContribution[]>();
  for (const c of state.contributions) {
    if (c.status !== 'approved' || c.factor === 0 || c.boundary === '内部取引') continue;
    map.set(c.unitId, [...(map.get(c.unitId) ?? []), c]);
  }
  return map;
}

/** 前年と比べられない理由（対象拠点・境界・算定方法の変更）。空なら同条件 */
export function comparisonConditionChanges(
  current: MetricPeriodState,
  previous: MetricPeriodState,
): string[] {
  const reasons: string[] = [];
  const cur = approvedContributionsByUnit(current);
  const prev = approvedContributionsByUnit(previous);
  const nameOf = (id: Uuid) =>
    cur.get(id)?.[0]?.unitName ?? prev.get(id)?.[0]?.unitName ?? '（組織不明）';

  const onlyCurrent = [...cur.keys()].filter((id) => !prev.has(id)).map(nameOf);
  const onlyPrevious = [...prev.keys()].filter((id) => !cur.has(id)).map(nameOf);
  if (onlyCurrent.length > 0 || onlyPrevious.length > 0) {
    reasons.push(
      `対象の組織・拠点が前年と異なります（当年のみ: ${onlyCurrent.join('、') || 'なし'}／前年のみ: ${onlyPrevious.join('、') || 'なし'}）。`,
    );
  }
  for (const [unitId, rows] of cur) {
    const before = prev.get(unitId);
    if (!before) continue;
    const boundaryNow = [...new Set(rows.map((r) => r.boundary))].sort().join('・');
    const boundaryBefore = [...new Set(before.map((r) => r.boundary))].sort().join('・');
    if (boundaryNow !== boundaryBefore) {
      reasons.push(
        `${nameOf(unitId)}: 境界が変わっています（前年「${boundaryBefore}」→ 当年「${boundaryNow}」）。`,
      );
    }
    const methodNow = [...new Set(rows.map((r) => r.methodology ?? '（未記載）'))]
      .sort()
      .join('・');
    const methodBefore = [...new Set(before.map((r) => r.methodology ?? '（未記載）'))]
      .sort()
      .join('・');
    if (methodNow !== methodBefore) {
      reasons.push(
        `${nameOf(unitId)}: 算定方法が変わっています（前年「${methodBefore}」→ 当年「${methodNow}」）。`,
      );
    }
  }
  return reasons;
}

/** 前年の値に承認後の訂正（遡及修正）があったか。比較はできるが、確認できるよう注記する */
function retroactiveNotes(state: MetricPeriodState, data: KpiData): string[] {
  const notes: string[] = [];
  for (const c of state.contributions) {
    if (c.status !== 'approved') continue;
    const versions = data.versions
      .filter((v) => v.dataPointId === c.dataPointId && v.versionNo > 1)
      .sort((a, b) => a.versionNo - b.versionNo);
    for (const v of versions) {
      notes.push(
        `${state.period.code} ${c.unitName}: 版 ${v.versionNo} で訂正${v.changeReason ? `（${v.changeReason}）` : ''}`,
      );
    }
  }
  return notes;
}

/**
 * 隣り合う 2 年度の比較（A34）。ESG経営の前年比（buildCard）と自社経年比較（loadMetricYearStates）が
 * 同じ規則を使う: 両年度とも確定（全拠点が承認済み）で値があり、対象拠点・境界・算定方法が同じときだけ差を出す。
 * 違えば needs_check（理由つき）、どちらかが未確定なら unavailable（0 として比べない）
 */
function compareAdjacentYears(
  data: KpiData,
  current: MetricPeriodState,
  previous: MetricPeriodState,
): YoyResult {
  if (!current.computable) {
    return {
      status: 'unavailable',
      reason: current.nonComputableReason ?? '全社値は算定できません。',
    };
  }
  if (!current.complete || current.approvedValue === null) {
    return { status: 'unavailable', reason: `${current.period.code} の確定値がありません。` };
  }
  const notes = retroactiveNotes(previous, data);
  if (!previous.complete || previous.approvedValue === null) {
    return {
      status: 'unavailable',
      reason: `前年（${previous.period.code}）の確定値がありません。`,
    };
  }
  const reasons = comparisonConditionChanges(current, previous);
  if (reasons.length > 0) {
    return { status: 'needs_check', previousPeriod: previous.period, reasons, notes };
  }
  const diff = current.approvedValue - previous.approvedValue;
  return {
    status: 'ok',
    previousPeriod: previous.period,
    previousValue: previous.approvedValue,
    diff,
    diffRate: previous.approvedValue === 0 ? null : (diff / previous.approvedValue) * 100,
    notes,
  };
}

// ======================================================================
// カード
// ======================================================================

export interface KpiTargetView {
  target: KpiTarget;
  versionCount: number;
  ownerName: string | null;
  comparable: boolean;
  comparabilityReasons: string[];
}

export interface KpiSubRow {
  metric: MetricDefinition | null;
  code: string;
  label: string;
  state: MetricPeriodState | null;
  /** 画面の表示（値・未算定・算定できない等） */
  display: string;
  statusLabel: string;
}

export interface KpiDataState {
  label: string;
  tone: 'success' | 'warning' | 'neutral' | 'danger';
  details: string[];
}

export interface KpiCardView {
  spec: KpiSpec;
  metric: MetricDefinition | null;
  /** 指標の定義（説明・式） */
  definition: string;
  selectedPeriod: ReportingPeriod;
  /** 選択した年度の集計状態 */
  current: MetricPeriodState | null;
  /** 実績に使った年度の状態（最新の確定年度）。確定年度が無ければ null */
  confirmed: MetricPeriodState | null;
  actualValue: number | null;
  target: KpiTargetView | null;
  otherTargetCount: number;
  targetGap: TargetGapResult;
  progress: ProgressResult;
  yoy: YoyResult;
  dataState: KpiDataState;
  subRows: KpiSubRow[];
}

function metricByCode(data: KpiData, code: string): MetricDefinition | null {
  return data.metrics.find((m) => m.code === code) ?? null;
}

function definitionOf(metric: MetricDefinition | null, spec: KpiSpec): string {
  if (!metric) return '指標が登録されていません。';
  const formula = metric.formula ? `式: ${metric.formula}` : null;
  const ratio =
    metric.numeratorMetricCode && metric.denominatorMetricCode
      ? `分子: ${metric.numeratorMetricCode} ／ 分母: ${metric.denominatorMetricCode}`
      : spec.kind === 'ratio' || metric.aggregationMethod === 'weighted_average'
        ? '分子・分母の指標: 未登録'
        : null;
  return [`${metric.name}（${metric.unit}）: ${metric.description}`, formula, ratio]
    .filter((s): s is string => Boolean(s))
    .join(' ／ ');
}

function describeState(state: MetricPeriodState | null): KpiDataState {
  if (!state || !state.hasData) {
    return {
      label: '未入力',
      tone: 'neutral',
      details: ['この年度のデータは登録されていません（0 としては扱いません）。'],
    };
  }
  const details: string[] = [];
  if (state.pendingUnits.length > 0) {
    details.push(
      `未承認: ${state.pendingUnits.map((p) => `${p.unitName}（${STATUS_TEXT[p.status]}）`).join('、')}（実績に含めていません）`,
    );
  }
  if (state.missingUnits.length > 0) {
    details.push(`未入力: ${state.missingUnits.join('、')}`);
  }
  if (state.notApplicableUnits.length > 0) {
    details.push(`対象外と判断: ${state.notApplicableUnits.join('、')}`);
  }
  if (state.unapprovedCorrectionCount > 0) {
    details.push(
      `承認後の訂正で未承認の値 ${state.unapprovedCorrectionCount} 件は含めていません。`,
    );
  }
  if (state.currentEstimateCount > 0) {
    details.push(
      `当年の推計値 ${state.currentEstimateCount} 拠点（${state.estimateUnits.join('、') || '—'}）は実績に含めていません。`,
    );
  }
  if (state.priorYearFillCount > 0) {
    details.push(`前年値での補完（推計）${state.priorYearFillCount} 拠点は実績に含めていません。`);
  }
  if (state.targetOnlyUnits.length > 0) {
    details.push(
      `目標値だけで実績の無い拠点: ${state.targetOnlyUnits.join('、')}（実績に含めていません）`,
    );
  }
  if (!state.computable) {
    return {
      label: '全社値は算定できません',
      tone: 'warning',
      details: [state.nonComputableReason ?? '', ...details].filter(Boolean),
    };
  }
  if (state.complete) {
    return { label: '確定（全拠点承認済み）', tone: 'success', details };
  }
  if (
    state.estimateUnits.length > 0 &&
    state.pendingUnits.length === 0 &&
    state.missingUnits.length === 0 &&
    state.targetOnlyUnits.length === 0
  ) {
    return {
      label: `推計を含む（実績 ${state.approvedUnits.length + state.notApplicableUnits.length}/${state.expectedUnitCount} 拠点）`,
      tone: 'warning',
      details,
    };
  }
  return {
    label: `集計中（承認済み ${state.approvedUnits.length + state.notApplicableUnits.length}/${state.expectedUnitCount} 拠点）`,
    tone: 'warning',
    details,
  };
}

const STATUS_TEXT: Record<DataPointStatus, string> = {
  not_started: '未着手',
  draft: '入力中',
  submitted: '提出済み',
  in_review: 'レビュー中',
  returned: '差戻し',
  approved: '承認済み・値なし',
};

async function buildCard(
  db: DbClient,
  ctx: AuthorizationContext,
  data: KpiData,
  spec: KpiSpec,
  selectedPeriod: ReportingPeriod,
  targets: KpiTarget[],
  ownerNames: Map<Uuid, string>,
): Promise<KpiCardView> {
  const metric = metricByCode(data, spec.metricCode);
  const current = metric ? await metricPeriodState(db, ctx, data, metric, selectedPeriod) : null;

  // 実績: 選択年度以前で、対象の全拠点が承認済みの最新の年度
  let confirmed: MetricPeriodState | null = null;
  if (metric && current?.computable) {
    const candidates = data.periods
      .filter((p) => p.startDate <= selectedPeriod.startDate)
      .sort((a, b) => (a.startDate < b.startDate ? 1 : -1));
    for (const period of candidates) {
      const state =
        period.id === selectedPeriod.id && current
          ? current
          : await metricPeriodState(db, ctx, data, metric, period);
      if (state.complete && state.approvedValue !== null) {
        confirmed = state;
        break;
      }
    }
  }
  const actualValue = confirmed?.approvedValue ?? null;

  // 目標（同じ指標の最新版）
  const latestByKey = new Map<string, KpiTarget>();
  const versionCount = new Map<string, number>();
  for (const t of targets.filter((t) => metric && t.metricId === metric.id)) {
    versionCount.set(t.targetKey, (versionCount.get(t.targetKey) ?? 0) + 1);
    const existing = latestByKey.get(t.targetKey);
    if (!existing || existing.versionNo < t.versionNo) latestByKey.set(t.targetKey, t);
  }
  const latestTargets = [...latestByKey.values()].sort((a, b) =>
    a.targetYear === b.targetYear
      ? a.targetKey < b.targetKey
        ? -1
        : 1
      : a.targetYear - b.targetYear,
  );
  const primary = latestTargets[0] ?? null;
  let target: KpiTargetView | null = null;
  if (primary && metric) {
    const comparability = targetComparability(primary, {
      boundary: confirmed?.boundary ?? current?.boundary ?? null,
      metric,
      methodologies: actualMethodologiesOf(confirmed ?? current),
    });
    target = {
      target: primary,
      versionCount: versionCount.get(primary.targetKey) ?? 1,
      ownerName: primary.ownerUserId ? (ownerNames.get(primary.ownerUserId) ?? null) : null,
      comparable: comparability.comparable,
      comparabilityReasons: comparability.reasons,
    };
  }

  const progress: ProgressResult = target
    ? computeTargetProgress({
        baseValue: target.target.baseValue,
        targetValue: target.target.targetValue,
        actualValue,
        direction: target.target.direction,
        comparable: target.comparable,
        comparabilityReasons: target.comparabilityReasons,
      })
    : { status: 'unavailable', code: 'no_base', reason: '目標が登録されていません。' };
  const targetGap: TargetGapResult = target
    ? computeTargetGap({
        actualValue,
        targetValue: target.target.targetValue,
        direction: target.target.direction,
        comparable: target.comparable,
      })
    : { status: 'unavailable', reason: '目標が登録されていません' };

  // 前年同条件との差（確定年度とその前年）
  let yoy: YoyResult = {
    status: 'unavailable',
    reason: confirmed ? '前年の年度がありません。' : '確定した実績がありません。',
  };
  if (metric && confirmed && actualValue !== null) {
    const previousPeriod =
      [...data.periods]
        .filter((p) => p.endDate < confirmed.period.startDate)
        .sort((a, b) => (a.startDate < b.startDate ? 1 : -1))[0] ?? null;
    if (previousPeriod) {
      const previous = await metricPeriodState(db, ctx, data, metric, previousPeriod);
      // confirmed は全拠点承認済みで値がある（actualValue = confirmed.approvedValue）ため、
      // 結果は前年側の確定・比較条件だけで決まる
      yoy = compareAdjacentYears(data, confirmed, previous);
    }
  }

  // 副指標（Scope3 のカテゴリ、労災の死亡者数・度数率）
  const subRows: KpiSubRow[] = [];
  for (const code of spec.subMetricCodes) {
    const subMetric = metricByCode(data, code);
    const state = subMetric
      ? await metricPeriodState(db, ctx, data, subMetric, selectedPeriod)
      : null;
    subRows.push({
      metric: subMetric,
      code,
      label: subMetric?.name ?? code,
      state,
      display: subDisplay(state),
      statusLabel: describeState(state).label,
    });
  }

  return {
    spec,
    metric,
    definition: definitionOf(metric, spec),
    selectedPeriod,
    current,
    confirmed,
    actualValue,
    target,
    otherTargetCount: Math.max(0, latestTargets.length - 1),
    targetGap,
    progress,
    yoy,
    dataState: describeState(current),
    subRows,
  };
}

function subDisplay(state: MetricPeriodState | null): string {
  if (!state || !state.hasData) return '未算定（データなし）';
  if (!state.computable) return '全社値は算定できません（拠点値のみ）';
  if (state.approvedValue === null) return '承認済みの値なし';
  const value = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 3 }).format(
    state.approvedValue,
  );
  return `${value} ${state.metric.unit}${state.complete ? '' : '（承認済み分のみ・集計中）'}`;
}

// ======================================================================
// ダッシュボード（最新承認値モード）
// ======================================================================

export interface EsgDashboard {
  periods: ReportingPeriod[];
  selectedPeriod: ReportingPeriod;
  cards: KpiCardView[];
}

async function loadTargetsAndOwners(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<{ targets: KpiTarget[]; ownerNames: Map<Uuid, string> }> {
  const targets = await db.select('kpiTargets', {
    where: { organizationId: ctx.workspace.organizationId },
  });
  const ownerIds = [
    ...new Set(
      targets.flatMap((t) => [t.ownerUserId, t.createdBy]).filter((id): id is Uuid => id !== null),
    ),
  ];
  const profiles =
    ownerIds.length === 0 ? [] : await db.select('profiles', { where: { id: { in: ownerIds } } });
  return { targets, ownerNames: new Map(profiles.map((p) => [p.id, p.displayName])) };
}

function pickPeriod(
  periods: ReportingPeriod[],
  periodId: Uuid | null | undefined,
): ReportingPeriod {
  const selected =
    periods.find((p) => p.id === periodId) ??
    periods.find((p) => p.status === 'collecting') ??
    [...periods].sort((a, b) => (a.startDate < b.startDate ? 1 : -1))[0];
  if (!selected) throw new ValidationError('報告期間が登録されていません。');
  return selected;
}

export async function loadEsgDashboard(
  db: DbClient,
  ctx: AuthorizationContext,
  options: { periodId?: Uuid | null } = {},
): Promise<EsgDashboard> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.read');
  const data = await loadKpiData(db, ctx);
  const selectedPeriod = pickPeriod(data.periods, options.periodId);
  const { targets, ownerNames } = await loadTargetsAndOwners(db, ctx);
  const cards: KpiCardView[] = [];
  for (const key of KPI_KEYS) {
    cards.push(await buildCard(db, ctx, data, KPI_SPECS[key], selectedPeriod, targets, ownerNames));
  }
  return { periods: data.periods, selectedPeriod, cards };
}

// ======================================================================
// 指標 × 年度の集計状態（自社経年比較・財務影響分析の値の源。docs/disclosure-first.md §10.2・§10.3）
// ======================================================================

export interface MetricYearState {
  period: ReportingPeriod;
  /** ESG経営と同じ集計状態（承認済みの連結値・確定かどうか・拠点ごとの内訳） */
  state: MetricPeriodState;
  /** ESG経営と同じ状態の表示（「確定（全拠点承認済み）」「集計中（承認済み n/N 拠点）」等） */
  display: KpiDataState;
  /**
   * 参考: 推計込みの連結値（合計の指標で推計〔当年の推計値・前年値での補完〕があるときだけ）。
   * 値の欄・前年比・試算の起点には使わない
   */
  referenceWithEstimates: number | null;
}

export interface MetricYearRow {
  metric: MetricDefinition;
  /** periods と同じ順（startDate 昇順） */
  years: MetricYearState[];
  /** 隣り合う年度の比較。changes[i] は years[i] → years[i+1]（古 → 新）。長さは years − 1 */
  changes: YoyResult[];
}

export interface MetricYearStates {
  /** 求めた期間のうちこの組織のもの（startDate 昇順） */
  periods: ReportingPeriod[];
  /** 求めた指標コードの順（この組織に無い・削除済みの指標は除く） */
  rows: MetricYearRow[];
}

/**
 * 指標ごと・年度ごとの集計状態を、ESG経営の KPI と同じ規則でまとめて返す（読むだけ。書かない）。
 *
 * 全社値は ESG経営・他社比較と同じ: 合計は承認済みの連結値（持分調整・内部取引控除後）、比率は分子・分母の
 * 加重平均、それ以外の集計方法は「全社値は算定不可」（computable = false）。推計・前年値補完・目標・途中合計は
 * state.approvedValue に入らない（途中合計は complete = false で区別する）。
 * changes は隣り合う年度の比較で、ESG経営の前年比と同じ補助関数（両年度とも確定・同条件のときだけ差）を使う。
 * periodIds は連続した期間を渡す前提（間の年度を飛ばすと、離れた年度どうしを「前年比」として比べる）。
 */
export async function loadMetricYearStates(
  db: DbClient,
  ctx: AuthorizationContext,
  { metricCodes, periodIds }: { metricCodes: readonly string[]; periodIds: readonly Uuid[] },
): Promise<MetricYearStates> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.read');
  const codes = [...new Set(metricCodes)];
  const data = await loadKpiData(db, ctx, codes);
  // 他組織の期間 ID を渡されても、この組織の期間だけを使う（data.periods は組織で絞ってある）
  const periods = data.periods.filter((p) => periodIds.includes(p.id));
  const rows: MetricYearRow[] = [];
  for (const code of codes) {
    const metric = metricByCode(data, code);
    if (!metric) continue;
    const years: MetricYearState[] = [];
    for (const period of periods) {
      const state = await metricPeriodState(db, ctx, data, metric, period);
      years.push({
        period,
        state,
        display: describeState(state),
        referenceWithEstimates: await referenceWithEstimates(db, ctx, data, state),
      });
    }
    const changes: YoyResult[] = [];
    for (let i = 1; i < years.length; i += 1) {
      changes.push(compareAdjacentYears(data, years[i]!.state, years[i - 1]!.state));
    }
    rows.push({ metric, years, changes });
  }
  return { periods, rows };
}

/** 推計込みの連結値（参考）。合計の指標で推計（当年の推計値・前年値での補完）があるときだけ */
async function referenceWithEstimates(
  db: DbClient,
  ctx: AuthorizationContext,
  data: KpiData,
  state: MetricPeriodState,
): Promise<number | null> {
  if (state.metric.aggregationMethod !== 'sum' || state.estimateCount === 0) return null;
  const aggregation = await aggregationFor(db, ctx, data, state.period);
  const aggregate = aggregation.metrics.find((m) => m.metric.id === state.metric.id);
  return aggregate ? aggregate.consolidatedWithEstimates : null;
}

// ======================================================================
// KPI の詳細
// ======================================================================

export interface KpiTrendRow {
  period: ReportingPeriod;
  state: MetricPeriodState;
  /** 前の年度と同条件で比べられるか。比べられない理由があれば非連続として示す */
  discontinuityReasons: string[];
  retroactiveNotes: string[];
}

export interface KpiFactorComment {
  source: 'comment' | 'version';
  unitName: string;
  periodCode: string;
  body: string;
  at: IsoDateTime;
  authorName: string | null;
}

export interface KpiEvidence {
  unitName: string;
  fileName: string;
  confidentiality: string;
  locator: string | null;
}

export interface KpiDetail {
  card: KpiCardView;
  trend: KpiTrendRow[];
  narratives: NarrativeRecord[];
  factorComments: KpiFactorComment[];
  evidence: KpiEvidence[];
  targets: KpiTargetView[];
}

export async function loadKpiDetail(
  db: DbClient,
  ctx: AuthorizationContext,
  key: KpiKey,
  options: { periodId?: Uuid | null } = {},
): Promise<KpiDetail> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.read');
  const organizationId = ctx.workspace.organizationId;
  const spec = KPI_SPECS[key];
  const data = await loadKpiData(db, ctx);
  const selectedPeriod = pickPeriod(data.periods, options.periodId);
  const { targets, ownerNames } = await loadTargetsAndOwners(db, ctx);
  const card = await buildCard(db, ctx, data, spec, selectedPeriod, targets, ownerNames);

  // 年次推移（データのある年度だけ。前年と条件が違う年は非連続として示す）
  const trend: KpiTrendRow[] = [];
  if (card.metric) {
    let previous: MetricPeriodState | null = null;
    for (const period of data.periods) {
      const state = await metricPeriodState(db, ctx, data, card.metric, period);
      if (!state.hasData) continue;
      trend.push({
        period,
        state,
        discontinuityReasons:
          previous && previous.complete && state.complete
            ? comparisonConditionChanges(state, previous)
            : [],
        retroactiveNotes: retroactiveNotes(state, data),
      });
      previous = state;
    }
  }

  // 関連する定性情報（リスク・機会／戦略・対応策／財務的影響のうち、タグが重なるもの）
  const narratives = (
    await db.select('narrativeRecords', {
      where: { organizationId, deletedAt: { isNull: true } },
    })
  )
    .filter(
      (r) =>
        (r.theme === 'risk_opportunity' ||
          r.theme === 'strategy' ||
          r.theme === 'financial_impact') &&
        r.tags.some((tag) => spec.narrativeTags.includes(tag)),
    )
    .sort((a, b) => (a.title < b.title ? -1 : 1));

  // 要因コメント（選択年度の Data Point に付いたコメントと、訂正の理由）
  const kpiMetric = card.metric;
  const periodDps = kpiMetric
    ? data.dataPoints.filter(
        (d) => d.metricId === kpiMetric.id && d.reportingPeriodId === selectedPeriod.id,
      )
    : [];
  const dpIds = periodDps.map((d) => d.id);
  const unitName = (dp: DataPoint) =>
    data.units.find((u) => u.id === dp.unitId)?.name ?? '（組織不明）';
  const [comments, links] =
    dpIds.length === 0
      ? [[], []]
      : await Promise.all([
          db.select('comments', {
            where: { organizationId, targetType: 'data_point', targetId: { in: dpIds } },
          }),
          db.select('evidenceLinks', {
            where: { organizationId, targetType: 'data_point', targetId: { in: dpIds } },
          }),
        ]);
  const commentAuthors =
    comments.length === 0
      ? []
      : await db.select('profiles', {
          where: { id: { in: [...new Set(comments.map((c) => c.authorUserId))] } },
        });
  const factorComments: KpiFactorComment[] = [
    ...comments.map((c) => {
      const dp = periodDps.find((d) => d.id === c.targetId);
      return {
        source: 'comment' as const,
        unitName: dp ? unitName(dp) : '—',
        periodCode: selectedPeriod.code,
        body: c.body,
        at: c.createdAt,
        authorName: commentAuthors.find((p) => p.id === c.authorUserId)?.displayName ?? null,
      };
    }),
    ...data.versions
      .filter((v) => dpIds.includes(v.dataPointId) && v.versionNo > 1 && v.changeReason)
      .map((v) => {
        const dp = periodDps.find((d) => d.id === v.dataPointId);
        return {
          source: 'version' as const,
          unitName: dp ? unitName(dp) : '—',
          periodCode: selectedPeriod.code,
          body: `版 ${v.versionNo} の変更理由: ${v.changeReason}`,
          at: v.createdAt,
          authorName: null,
        };
      }),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));

  // 根拠（Data Point に紐付いた Evidence）
  const fileVersions =
    links.length === 0
      ? []
      : await db.select('fileVersions', {
          where: { organizationId, id: { in: [...new Set(links.map((l) => l.fileVersionId))] } },
        });
  const files =
    fileVersions.length === 0
      ? []
      : await db.select('files', {
          where: { organizationId, id: { in: [...new Set(fileVersions.map((v) => v.fileId))] } },
        });
  const evidence: KpiEvidence[] = links.map((link) => {
    const dp = periodDps.find((d) => d.id === link.targetId);
    const fv = fileVersions.find((v) => v.id === link.fileVersionId);
    const file = fv ? files.find((f) => f.id === fv.fileId) : undefined;
    return {
      unitName: dp ? unitName(dp) : '—',
      fileName: file?.originalName ?? '（ファイル不明）',
      confidentiality: file?.confidentiality ?? 'confidential',
      locator: link.page !== null ? `p.${link.page}` : link.cellRef,
    };
  });

  // 目標（同じ指標の全目標の最新版）
  const targetViews: KpiTargetView[] = [];
  if (kpiMetric) {
    const byKey = new Map<string, KpiTarget[]>();
    for (const t of targets.filter((t) => t.metricId === kpiMetric.id)) {
      byKey.set(t.targetKey, [...(byKey.get(t.targetKey) ?? []), t]);
    }
    for (const versions of byKey.values()) {
      const latest = versions.reduce((a, b) => (a.versionNo >= b.versionNo ? a : b));
      const comparability = targetComparability(latest, {
        boundary: card.confirmed?.boundary ?? card.current?.boundary ?? null,
        metric: kpiMetric,
        methodologies: actualMethodologiesOf(card.confirmed ?? card.current),
      });
      targetViews.push({
        target: latest,
        versionCount: versions.length,
        ownerName: latest.ownerUserId ? (ownerNames.get(latest.ownerUserId) ?? null) : null,
        comparable: comparability.comparable,
        comparabilityReasons: comparability.reasons,
      });
    }
  }

  return { card, trend, narratives, factorComments, evidence, targets: targetViews };
}

// ======================================================================
// スナップショット照合モード
// ======================================================================

export interface KpiSnapshotRow {
  dataPointId: Uuid;
  metricCode: string;
  metricName: string;
  unitName: string;
  periodCode: string;
  snapshotVersionNo: number;
  snapshotValue: number | null;
  unitOfMeasure: string;
  latestApproved: { versionNo: number; value: number | null; unitOfMeasure: string } | null;
  differs: boolean;
  /**
   * 最新承認値 − スナップショットの値（単位が同じときだけ）。単位が違えば差を出さない
   * （例: t-CO2e と千t-CO2e を引き算しない）
   */
  diff: number | null;
  /** 差の単位（差を出したときだけ） */
  diffUnit: string | null;
  /** スナップショットの値と最新承認値の単位が違う */
  unitMismatch: boolean;
  /** 固定した版の後に承認された版の変更理由 */
  reasons: string[];
}

export interface KpiSnapshotComparison {
  snapshot: {
    id: Uuid;
    projectName: string;
    snapshotKind: ReportSnapshotKind;
    kindLabel: string;
    snapshotNo: number;
    createdAt: IsoDateTime;
    contentHash: string;
  };
  rows: Record<KpiKey, KpiSnapshotRow[]>;
}

/** Data Point の最新の承認済みの版（未承認の訂正は飛ばす） */
function latestApprovedVersion(dp: DataPoint, data: KpiData): DataPointVersion | null {
  const versions = data.versions
    .filter((v) => v.dataPointId === dp.id)
    .sort((a, b) => b.versionNo - a.versionNo);
  if (dp.status === 'approved') {
    return versions.find((v) => v.id === dp.currentVersionId) ?? null;
  }
  return versions.find((v) => data.approvedVersionIds.has(v.id) || v.status === 'approved') ?? null;
}

export async function loadKpiSnapshotComparison(
  db: DbClient,
  ctx: AuthorizationContext,
  snapshotId: Uuid,
): Promise<KpiSnapshotComparison> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.read');
  // スナップショット（開示プロジェクト名・内容ハッシュ）は開示の情報。出力タブと同じ権限を求める
  assertCan(ctx, 'enterprise.disclosure.read');
  const snapshot = await loadOwnedSnapshot(db, ctx, snapshotId);
  const data = await loadKpiData(db, ctx);
  const project = await db.findById('disclosureProjects', snapshot.projectId);

  const rows = Object.fromEntries(KPI_KEYS.map((key) => [key, [] as KpiSnapshotRow[]])) as Record<
    KpiKey,
    KpiSnapshotRow[]
  >;
  for (const key of KPI_KEYS) {
    const spec = KPI_SPECS[key];
    const codes = [spec.metricCode, ...spec.subMetricCodes];
    for (const mv of snapshot.metricValues.filter((m) => codes.includes(m.metricCode))) {
      const dp = data.dataPoints.find((d) => d.id === mv.dataPointId);
      const latest = dp ? latestApprovedVersion(dp, data) : null;
      const reasons =
        dp && latest && latest.versionNo > mv.versionNo
          ? data.versions
              .filter(
                (v) =>
                  v.dataPointId === dp.id &&
                  v.versionNo > mv.versionNo &&
                  v.versionNo <= latest.versionNo &&
                  v.changeReason,
              )
              .sort((a, b) => a.versionNo - b.versionNo)
              .map((v) => `版 ${v.versionNo}: ${v.changeReason}`)
          : [];
      const sameUnit = latest !== null && latest.unitOfMeasure.trim() === mv.unitOfMeasure.trim();
      rows[key].push({
        diff:
          sameUnit && latest.value !== null && mv.value !== null ? latest.value - mv.value : null,
        diffUnit: sameUnit ? mv.unitOfMeasure : null,
        unitMismatch: latest !== null && !sameUnit,
        dataPointId: mv.dataPointId,
        metricCode: mv.metricCode,
        metricName: mv.metricName,
        unitName: mv.unitName,
        periodCode: mv.periodCode,
        snapshotVersionNo: mv.versionNo,
        snapshotValue: mv.value,
        unitOfMeasure: mv.unitOfMeasure,
        latestApproved: latest
          ? {
              versionNo: latest.versionNo,
              value: latest.value,
              unitOfMeasure: latest.unitOfMeasure,
            }
          : null,
        differs: latest === null || latest.id !== mv.dataPointVersionId,
        reasons,
      });
    }
  }

  return {
    snapshot: {
      id: snapshot.id,
      projectName: project?.name ?? '（プロジェクト不明）',
      snapshotKind: snapshot.snapshotKind,
      kindLabel: SNAPSHOT_KIND_DISPLAY[snapshot.snapshotKind],
      snapshotNo: snapshot.snapshotNo,
      createdAt: snapshot.createdAt,
      contentHash: snapshot.contentHash,
    },
    rows,
  };
}

// ======================================================================
// 目標の登録（追記専用の版）
// ======================================================================

export interface KpiTargetInput {
  /** 既存の目標を改訂するときの識別子。新規は null */
  targetKey: string | null;
  metricId: Uuid;
  boundary: string;
  scopeNote: string;
  baseYear: number | null;
  baseValue: number | null;
  targetYear: number;
  targetValue: number;
  targetType: KpiTargetType;
  direction: KpiDirection;
  methodologyNote: string;
  /** 目標が前提にした実績の算定方法（Data Point の算定方法と同じ表記）。未入力は null */
  actualMethodology: string | null;
  ownerUserId: Uuid | null;
  revisionReason: string | null;
}

/** 数値の厳密な解釈（桁区切りは許すが、単位や文字が混じった値を黙って数値にしない） */
function strictNumber(raw: string, label: string, required: boolean): number | null {
  const text = raw.normalize('NFKC').replace(/,/g, '').trim();
  if (text === '') {
    if (required) throw new ValidationError(`${label}を入力してください。`);
    return null;
  }
  if (!/^-?\d+(\.\d+)?$/.test(text))
    throw new ValidationError(`${label}は数値で入力してください。`);
  return Number(text);
}

function strictYear(raw: string, label: string, required: boolean): number | null {
  const value = strictNumber(raw, label, required);
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 1990 || value > 2100) {
    throw new ValidationError(`${label}は 1990〜2100 の西暦（整数）で入力してください。`);
  }
  return value;
}

/** フォームの値を目標の入力へ（形式の検査だけ。内容の検査は registerKpiTarget が行う） */
export function parseKpiTargetForm(get: (key: string) => string): KpiTargetInput {
  const targetType = get('targetType');
  const direction = get('direction');
  if (!KPI_TARGET_TYPES.includes(targetType as KpiTargetType)) {
    throw new ValidationError('総量か原単位かを選んでください。');
  }
  if (!KPI_DIRECTIONS.includes(direction as KpiDirection)) {
    throw new ValidationError('削減か増加かを選んでください。');
  }
  const targetYear = strictYear(get('targetYear'), '目標年', true);
  const targetValue = strictNumber(get('targetValue'), '目標値', true);
  return {
    targetKey: get('targetKey').trim() || null,
    metricId: get('metricId').trim(),
    boundary: get('boundary').trim(),
    scopeNote: get('scopeNote').trim(),
    baseYear: strictYear(get('baseYear'), '基準年', false),
    baseValue: strictNumber(get('baseValue'), '基準値', false),
    targetYear: targetYear ?? 0,
    targetValue: targetValue ?? 0,
    targetType: targetType as KpiTargetType,
    direction: direction as KpiDirection,
    methodologyNote: get('methodologyNote').trim(),
    actualMethodology: get('actualMethodology').trim() || null,
    ownerUserId: get('ownerUserId').trim() || null,
    revisionReason: get('revisionReason').trim() || null,
  };
}

/**
 * KPI 目標を登録する（新規は版 1、改訂は同じ targetKey の次の版）。既存の版は変えない。
 *
 * 権限は enterprise.metric.manage。目標は指標マスターと同じ「経営管理の設定」で、
 * RLS（kpi_targets_insert）も同じ権限を求める。開示の編集権限（enterprise.disclosure.write）は
 * レビュー担当も持つため、経営目標の設定には広すぎる。
 */
export async function registerKpiTarget(
  db: DbClient,
  ctx: AuthorizationContext,
  input: KpiTargetInput,
): Promise<KpiTarget> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.metric.manage');
  const organizationId = ctx.workspace.organizationId;

  const metric = input.metricId ? await db.findById('metrics', input.metricId) : null;
  if (!metric || metric.organizationId !== organizationId || metric.deletedAt) {
    throw new ValidationError('指標を選んでください。');
  }
  if (!input.boundary) throw new ValidationError('対象範囲（境界）を入力してください。');
  if (input.boundary.length > 100)
    throw new ValidationError('対象範囲は 100 文字以内で入力してください。');
  if ((input.baseYear === null) !== (input.baseValue === null)) {
    throw new ValidationError('基準年と基準値は両方入力するか、両方空欄にしてください。');
  }
  if (input.baseYear !== null && input.targetYear <= input.baseYear) {
    throw new ValidationError('目標年は基準年より後にしてください。');
  }
  if (input.baseValue !== null) {
    const ok =
      input.direction === 'reduce'
        ? input.targetValue < input.baseValue
        : input.targetValue > input.baseValue;
    if (!ok) {
      throw new ValidationError(
        input.direction === 'reduce'
          ? '削減目標では、目標値を基準値より小さくしてください。'
          : '増加目標では、目標値を基準値より大きくしてください。',
      );
    }
  }
  if (input.ownerUserId) {
    const membership = await db.select('memberships', {
      where: { organizationId, userId: input.ownerUserId, status: 'active' },
      limit: 1,
    });
    if (membership.length === 0)
      throw new ValidationError('責任者はこの組織のメンバーから選んでください。');
  }

  const existing = await db.select('kpiTargets', { where: { organizationId } });
  let targetKey: string;
  let versionNo: number;
  let revisionReason: string | null = null;
  if (input.targetKey) {
    const versions = existing.filter((t) => t.targetKey === input.targetKey);
    if (versions.length === 0) throw new ValidationError('改訂する目標が見つかりません。');
    if (versions.some((t) => t.metricId !== metric.id)) {
      throw new ValidationError(
        '改訂では指標を変えられません。別の指標は新しい目標として登録してください。',
      );
    }
    if (!input.revisionReason) throw new ValidationError('改訂の理由を入力してください。');
    targetKey = input.targetKey;
    versionNo = Math.max(...versions.map((t) => t.versionNo)) + 1;
    revisionReason = input.revisionReason;
  } else {
    const base = `${metric.code}_${input.direction}_${input.targetYear}`;
    const taken = new Set(existing.map((t) => t.targetKey));
    let candidate = base;
    for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}_${n}`;
    targetKey = candidate;
    versionNo = 1;
  }

  const row: KpiTarget = {
    id: randomUUID(),
    organizationId,
    targetKey,
    versionNo,
    metricId: metric.id,
    boundary: input.boundary,
    scopeNote: input.scopeNote,
    baseYear: input.baseYear,
    baseValue: input.baseValue,
    targetYear: input.targetYear,
    targetValue: input.targetValue,
    targetType: input.targetType,
    direction: input.direction,
    methodologyNote: input.methodologyNote,
    actualMethodology: input.actualMethodology?.slice(0, 200) ?? null,
    ownerUserId: input.ownerUserId,
    revisionReason,
    createdAt: new Date().toISOString(),
    // RLS は created_by = auth.uid() を求める
    createdBy: ctx.userId,
  };
  await db.insert('kpiTargets', [row]);

  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'kpi_target',
    resourceId: row.id,
    afterSummary: `${metric.name} の目標 ${targetKey} 版 ${versionNo}（${input.baseYear ?? '—'} 年 ${input.baseValue ?? '—'} → ${input.targetYear} 年 ${input.targetValue} ${metric.unit}・${input.boundary}）`,
    metadata: { targetKey, versionNo, revisionReason },
  });
  return row;
}

export interface KpiTargetHistory {
  targetKey: string;
  metric: MetricDefinition | null;
  versions: Array<KpiTarget & { ownerName: string | null; createdByName: string | null }>;
}

/** 目標の一覧（目標ごとに版を新しい順で） */
export async function listKpiTargets(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<KpiTargetHistory[]> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.read');
  const organizationId = ctx.workspace.organizationId;
  const [{ targets, ownerNames }, metrics] = await Promise.all([
    loadTargetsAndOwners(db, ctx),
    db.select('metrics', { where: { organizationId } }),
  ]);
  const byKey = new Map<string, KpiTarget[]>();
  for (const t of targets) byKey.set(t.targetKey, [...(byKey.get(t.targetKey) ?? []), t]);
  return [...byKey.entries()]
    .map(([targetKey, versions]) => ({
      targetKey,
      metric: metrics.find((m) => m.id === versions[0]?.metricId) ?? null,
      versions: [...versions]
        .sort((a, b) => b.versionNo - a.versionNo)
        .map((t) => ({
          ...t,
          ownerName: t.ownerUserId ? (ownerNames.get(t.ownerUserId) ?? null) : null,
          createdByName: t.createdBy ? (ownerNames.get(t.createdBy) ?? null) : null,
        })),
    }))
    .sort((a, b) => (a.targetKey < b.targetKey ? -1 : 1));
}

/** 目標登録フォームの選択肢（KPI の指標を先頭に、その他の指標を後ろに） */
export async function loadTargetFormOptions(
  db: DbClient,
  ctx: AuthorizationContext,
): Promise<{
  metrics: MetricDefinition[];
  members: Array<{ userId: Uuid; displayName: string }>;
  /** 実績に登録されている算定方法の表記（目標の「前提にした実績の算定方法」の候補） */
  methodologies: string[];
}> {
  assertEnterpriseWorkspace(ctx);
  const organizationId = ctx.workspace.organizationId;
  const [metrics, memberships, dataPoints] = await Promise.all([
    db.select('metrics', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('memberships', { where: { organizationId, status: 'active' } }),
    db.select('dataPoints', { where: { organizationId, deletedAt: { isNull: true } } }),
  ]);
  const methodologies = [
    ...new Set(dataPoints.map((d) => d.methodology?.trim()).filter((m): m is string => Boolean(m))),
  ].sort((a, b) => a.localeCompare(b, 'ja'));
  const profiles =
    memberships.length === 0
      ? []
      : await db.select('profiles', {
          where: { id: { in: memberships.map((m) => m.userId) } },
        });
  const kpiFirst = [...metrics].sort((a, b) => {
    const ka = ALL_KPI_METRIC_CODES.indexOf(a.code);
    const kb = ALL_KPI_METRIC_CODES.indexOf(b.code);
    if (ka !== kb) return (ka === -1 ? 999 : ka) - (kb === -1 ? 999 : kb);
    return a.code < b.code ? -1 : 1;
  });
  return {
    metrics: kpiFirst,
    methodologies,
    members: profiles
      .map((p) => ({ userId: p.id, displayName: p.displayName }))
      .sort((a, b) => (a.displayName < b.displayName ? -1 : 1)),
  };
}
