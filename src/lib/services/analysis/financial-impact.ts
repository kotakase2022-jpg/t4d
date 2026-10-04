import 'server-only';

import { assertCan, assertEnterpriseWorkspace, can, NotFoundError } from '@/lib/authorization/can';
import { ESRS_TOPIC_LABEL, DMA_OUTCOME_LABEL } from '@/lib/domain/csrd';
import { IRO_TYPE_LABEL, TIME_HORIZON_LABEL } from '@/lib/domain/dma';
import {
  DRIVER_KEYS,
  DRIVERS,
  PATHWAY_IDS,
  PATHWAYS,
  compareWithBau,
  parseImpactParams,
  referenceYearOf,
  sensitivity,
  simulateFinancialImpact,
  targetAlreadyAchieved,
  type AssumptionValues,
  type DriverKey,
  type DriverSpec,
  type ParsedImpactParams,
  type PathwayId,
  type ScenarioComparison,
  type ScenarioKey,
  type SearchParamsInput,
  type SensitivityResult,
  type SimulationInput,
  type SimulationResult,
  type TargetPath,
} from '@/lib/domain/financial-impact';
import { assessNarrativeFields, notQuantifiedNote } from '@/lib/domain/narrative-template';
import { formatNumber } from '@/lib/format/datetime';
import {
  assumptionDefaultsFor,
  financialBaselineFor,
  type AssumptionSource,
  type DemoFinancialBaseline,
} from '@/lib/financial-impact/demo-assumptions';
import { loadCsrdSettings } from '@/lib/services/csrd/settings';
import {
  actualMethodologiesOf,
  listKpiTargets,
  loadMetricYearStates,
  targetComparability,
  type MetricPeriodState,
  type MetricYearRow,
} from '@/lib/services/kpi';
import { MATERIALITY_LABEL } from '@/lib/services/materiality';
import { listNarratives } from '@/lib/services/narrative';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  EsrsTopic,
  IroType,
  KpiDirection,
  MetricDefinition,
  ReportingPeriod,
  TimeHorizon,
  Uuid,
} from '@/types/domain';

/**
 * 財務影響分析（docs/disclosure-first.md §10.3）。閲覧専用（書かない）。
 *
 * 承認済みの非財務データ（基準年度 B の確定連結値）× 画面に示した仮定（URL）による決定論的な試算。
 *  - 基準年度 B ＝ ヘッダー年度以前で status `closed` の最新の期間。起点は loadMetricYearStates の B 年度で
 *    complete かつ値ありのものだけ（当年度の途中値・前年値補完・推計は使わない）。ESG経営・他社比較と同じ値
 *  - 仮定の既定値・財務ベースラインは Demo Mode（source='demo'）のときだけの架空の値。Supabase モード
 *    （source='none'）は既定値もベースラインも持たない（入力が揃った経路だけを計算する）
 *  - 定性情報・IRO・SSBJ マテリアリティは enterprise.disclosure.read のときだけ読み、経路との関連を示すだけ
 *    （円に換算しない）。権限が無ければ読まずに「閲覧権限が無い領域は表示していません」と示す
 *  - DB 表・Cookie・AI は使わない。他テナントの値は使わない（期間・指標・目標はすべて自組織だけ）
 */

export const FINANCIAL_IMPACT_HIDDEN_NOTE = '閲覧権限が無い領域は表示していません';

export type FinancialImpactSource = AssumptionSource;

export interface FinancialImpactInput {
  /** ヘッダーの報告期間（Cookie） */
  period: ReportingPeriod;
  source: FinancialImpactSource;
  /** URL のクエリ（sc・a_・r_・p_） */
  params: SearchParamsInput;
}

export type OriginStatus =
  | 'confirmed'
  | 'incomplete'
  | 'not_entered'
  | 'not_computable'
  | 'unit_mismatch'
  | 'not_registered';

export interface ImpactOrigin {
  driver: DriverKey;
  spec: DriverSpec;
  /** 指標マスターの行（この組織に無い・削除済みなら null） */
  metric: MetricDefinition | null;
  /** 起点（基準年度の確定連結値）。確定していなければ null（0 にしない） */
  value: number | null;
  status: OriginStatus;
  /** 状態の表示（ESG経営と同じ文言） */
  label: string;
  /** 値が無い理由（確定値なら null） */
  reason: string | null;
  periodCode: string;
  boundary: string | null;
  /** 出所（全指標の一覧。年度はヘッダーで決まるため、リンク文言に年度を書く） */
  href: string | null;
}

export type TargetStatus =
  'applied' | 'not_comparable' | 'achieved' | 'no_target' | 'expired' | 'no_origin';

export interface DriverTargetView {
  driver: DriverKey;
  status: TargetStatus;
  targetKey: string | null;
  targetYear: number | null;
  targetValue: number | null;
  boundary: string | null;
  /** 目標の向き（比較可の目標だけ。シミュレーションにも渡し、達成済みの目標で起点を動かさない） */
  direction: KpiDirection | null;
  /** 使わない理由（比較不可・期限切れ・起点なし）。使うときは空 */
  reasons: string[];
}

export interface IroView {
  id: Uuid;
  topic: EsrsTopic;
  topicLabel: string;
  type: IroType;
  typeLabel: string;
  subTopic: string;
  description: string;
  /** 発生可能性・財務影響の大きさ（1〜5）。円にしない */
  likelihood: number | null;
  magnitude: number | null;
  horizon: TimeHorizon | null;
  horizonLabel: string | null;
  /** 事項の結果（人の判断） */
  outcomeLabel: string;
  /** 関連する経路（無ければ空。点数を円にしない） */
  pathways: PathwayId[];
  note: string;
  href: string;
}

export interface NarrativeImpactView {
  id: Uuid;
  title: string;
  themeLabel: string;
  statusLabel: string;
  pathways: PathwayId[];
  /** 財務的影響の定性情報: 記録された影響額の扱い・示さない理由（それ以外は null） */
  amountNote: string | null;
  href: string;
}

export interface SsbjTopicImpactView {
  id: Uuid;
  topicKey: string;
  title: string;
  materialityLabel: string;
  rationale: string;
  pathways: PathwayId[];
  href: string;
}

export interface QualitativeImpactView {
  /** CSRD の DMA を読んだ期間（ヘッダー年度） */
  csrdPeriod: ReportingPeriod;
  iros: IroView[];
  narratives: NarrativeImpactView[];
  /** SSBJ マテリアリティを評価した期間（ヘッダー年度以前で評価のある最新。無ければ null） */
  ssbjPeriod: ReportingPeriod | null;
  ssbjTopics: SsbjTopicImpactView[];
}

export type RelatedKind = 'iro' | 'narrative' | 'ssbj';

export interface RelatedItem {
  kind: RelatedKind;
  label: string;
  href: string;
  note: string | null;
}

interface FinancialImpactCommon {
  period: ReportingPeriod;
  source: FinancialImpactSource;
  /** 仮定の既定値（Demo Mode は架空の既定値、Supabase モードは時間差だけ） */
  defaults: AssumptionValues;
  params: ParsedImpactParams;
  /** 架空の財務ベースライン（Demo Mode だけ。営業利益比の参考表示だけ） */
  baseline: DemoFinancialBaseline | null;
}

export interface FinancialImpactNoBase extends FinancialImpactCommon {
  status: 'no_base';
}

export interface FinancialImpactReady extends FinancialImpactCommon {
  status: 'ready';
  basePeriod: ReportingPeriod;
  baseYear: number;
  /** 要約・経路図に使う年（デモは FY2030） */
  referenceYear: number;
  origins: ImpactOrigin[];
  targets: DriverTargetView[];
  /** 確定データ（基準年度以前で全拠点承認済み・値あり）の最長の年数 */
  dataDepthYears: number;
  /** 労働災害の経路（P7）が件数の入力だけを使う理由 */
  injuryDataNote: string;
  /** 参考: 直接排出の規模（GX-ETS の義務対象かの参考表示） */
  scope1Reference: number | null;
  /** 選んだシナリオの入力と結果 */
  currentInput: SimulationInput;
  current: SimulationResult;
  /** 累計の線（現状維持・目標達成。カスタムのときはカスタムも） */
  scenarios: Array<{ scenario: ScenarioKey; result: SimulationResult }>;
  /** 回避コスト（比べるシナリオ − 現状維持）と削減費用（別枠） */
  comparison: ScenarioComparison;
  sensitivity: SensitivityResult;
  qualitative: QualitativeImpactView | null;
  hiddenNote: string | null;
  relatedByPathway: Record<PathwayId, RelatedItem[]>;
}

export type FinancialImpactView = FinancialImpactNoBase | FinancialImpactReady;

const startYearOf = (period: ReportingPeriod) => Number(period.startDate.slice(0, 4));

const byStartDate = (a: ReportingPeriod, b: ReportingPeriod) =>
  a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0;

function metricHref(metric: MetricDefinition): string {
  return `/enterprise/data?metric=${metric.id}`;
}

/**
 * 起点に入れる承認済みの行の単位（kpi.ts の actualMethodologiesOf と同じ行の選び方: 承認済み・連結対象・
 * 内部取引の明細以外・値あり）。指標の単位と違う行があれば起点にしない（単位を換算しない）
 */
function contributionUnits(state: MetricPeriodState): string[] {
  return [
    ...new Set(
      state.contributions
        .filter(
          (c) =>
            c.status === 'approved' &&
            c.factor > 0 &&
            c.boundary !== '内部取引' &&
            c.availabilityStatus === 'value_present',
        )
        .map((c) => c.unitOfMeasure),
    ),
  ];
}

function originOf(
  driver: DriverKey,
  row: MetricYearRow | undefined,
  basePeriod: ReportingPeriod,
): { origin: ImpactOrigin; state: MetricPeriodState | null } {
  const spec = DRIVERS[driver];
  const common = { driver, spec, periodCode: basePeriod.code };
  if (!row) {
    return {
      state: null,
      origin: {
        ...common,
        metric: null,
        value: null,
        status: 'not_registered',
        label: '指標が登録されていません',
        reason: `指標「${spec.label}」が指標マスターにありません。`,
        boundary: null,
        href: null,
      },
    };
  }
  const year = row.years.find((y) => y.period.id === basePeriod.id);
  const state = year?.state ?? null;
  const base = { ...common, metric: row.metric, href: metricHref(row.metric) };
  if (!year || !state || !state.hasData) {
    return {
      state,
      origin: {
        ...base,
        value: null,
        status: 'not_entered',
        label: '未入力',
        reason: `${basePeriod.code} のデータは登録されていません（0 としては扱いません）。`,
        boundary: null,
      },
    };
  }
  if (!state.computable) {
    return {
      state,
      origin: {
        ...base,
        value: null,
        status: 'not_computable',
        label: '全社値は算定できません',
        reason: state.nonComputableReason,
        boundary: state.boundary,
      },
    };
  }
  if (!state.complete || state.approvedValue === null) {
    return {
      state,
      origin: {
        ...base,
        value: null,
        status: 'incomplete',
        label: year.display.label,
        reason: `${basePeriod.code} の確定値がありません（${year.display.label}）。途中の値は使いません。`,
        boundary: state.boundary,
      },
    };
  }
  const units = contributionUnits(state);
  const mismatched = units.filter((u) => u !== row.metric.unit);
  if (row.metric.unit !== spec.unit || mismatched.length > 0) {
    return {
      state,
      origin: {
        ...base,
        value: null,
        status: 'unit_mismatch',
        label: '単位の確認が必要',
        reason: `試算の単位（${spec.unit}）と、指標・承認済みの値の単位（${[row.metric.unit, ...mismatched].join('・')}）が一致しません。換算しません。`,
        boundary: state.boundary,
      },
    };
  }
  return {
    state,
    origin: {
      ...base,
      value: state.approvedValue,
      status: 'confirmed',
      label: year.display.label,
      reason: null,
      boundary: state.boundary,
    },
  };
}

function targetsOf(
  origins: ImpactOrigin[],
  states: Map<DriverKey, MetricPeriodState | null>,
  histories: Awaited<ReturnType<typeof listKpiTargets>>,
  basePeriod: ReportingPeriod,
): DriverTargetView[] {
  const baseYear = startYearOf(basePeriod);
  const basePeriodCode = basePeriod.code;
  return origins.map((origin) => {
    const empty: DriverTargetView = {
      driver: origin.driver,
      status: 'no_target',
      targetKey: null,
      targetYear: null,
      targetValue: null,
      boundary: null,
      direction: null,
      reasons: [],
    };
    const metric = origin.metric;
    if (!metric) return empty;
    // 目標ごとの最新版（ESG経営と同じ）
    const latest = histories
      .filter((h) => h.metric?.id === metric.id)
      .map((h) => h.versions[0])
      .filter((t): t is NonNullable<typeof t> => Boolean(t));
    if (latest.length === 0) return empty;
    const future = latest
      .filter((t) => t.targetYear > baseYear)
      .sort((a, b) =>
        a.targetYear === b.targetYear
          ? a.targetKey < b.targetKey
            ? -1
            : 1
          : a.targetYear - b.targetYear,
      );
    const chosen = future[0];
    if (!chosen) {
      const first = latest[0]!;
      return {
        ...empty,
        status: 'expired',
        targetKey: first.targetKey,
        targetYear: first.targetYear,
        targetValue: first.targetValue,
        boundary: first.boundary,
        reasons: [`目標年（${first.targetYear} 年）が基準年度以前のため使いません。`],
      };
    }
    const view = {
      ...empty,
      targetKey: chosen.targetKey,
      targetYear: chosen.targetYear,
      targetValue: chosen.targetValue,
      boundary: chosen.boundary,
    };
    const state = states.get(origin.driver) ?? null;
    if (origin.value === null || !state) {
      return {
        ...view,
        status: 'no_origin',
        reasons: ['基準年度の確定値が無いため、目標への直線を引けません。'],
      };
    }
    const comparability = targetComparability(chosen, {
      boundary: state.boundary,
      metric,
      methodologies: actualMethodologiesOf(state),
    });
    if (!comparability.comparable) {
      return { ...view, status: 'not_comparable', reasons: comparability.reasons };
    }
    // 基準年度の実績が既に目標を超えている（削減なら目標値以下・増加なら以上）目標へ直線を引くと、
    // 「目標達成」が達成済みの値から目標値へ戻す（悪化させる）シナリオになり、回避コストの符号が逆になる
    if (
      targetAlreadyAchieved(origin.value, {
        targetYear: chosen.targetYear,
        targetValue: chosen.targetValue,
        direction: chosen.direction,
      })
    ) {
      const unit = DRIVERS[origin.driver].unit;
      return {
        ...view,
        status: 'achieved',
        direction: chosen.direction,
        reasons: [
          `基準年度（${basePeriodCode}）の実績 ${formatNumber(origin.value)} ${unit} が既に目標（${formatNumber(chosen.targetValue)} ${unit}${chosen.direction === 'reduce' ? ' 以下' : ' 以上'}）を達成しているため、目標値へ戻す直線は引かず一定にします。`,
        ],
      };
    }
    return { ...view, status: 'applied', direction: chosen.direction };
  });
}

/** 確定データ（全拠点承認済み・値あり）が最も多い指標の年数 */
function dataDepthOf(rows: MetricYearRow[]): number {
  return Math.max(
    0,
    ...rows.map(
      (row) =>
        row.years.filter(
          (y) => y.state.computable && y.state.complete && y.state.approvedValue !== null,
        ).length,
    ),
  );
}

function injuryNoteOf(rows: MetricYearRow[], basePeriod: ReportingPeriod): string {
  const parts: string[] = [];
  const injuries = rows.find((r) => r.metric.code === 'work_related_injuries');
  const injuryState = injuries?.years.find((y) => y.period.id === basePeriod.id)?.state ?? null;
  if (!injuries) {
    parts.push('労働災害件数の指標は登録されていません');
  } else if (!injuryState?.hasData) {
    parts.push(`労働災害件数は ${basePeriod.code} に未収集です`);
  } else if (injuryState.complete && injuryState.approvedValue !== null) {
    parts.push(
      `労働災害件数（${basePeriod.code} 確定）は ${injuryState.approvedValue} ${injuries.metric.unit}です（件数の入力の参考。自動では使いません）`,
    );
  } else {
    parts.push(`労働災害件数は ${basePeriod.code} の確定値がありません`);
  }
  const ltifr = rows.find((r) => r.metric.code === 'ltifr');
  const ltifrState = ltifr?.years.find((y) => y.period.id === basePeriod.id)?.state ?? null;
  if (ltifr && ltifrState && !ltifrState.computable) {
    parts.push('LTIFR（度数率）は全社値を算定しないため（拠点値のみ）、件数の推定に使いません');
  } else {
    parts.push('LTIFR（度数率）から件数を推定しません（労働時間の前提が要るため）');
  }
  return `${parts.join('。')}。P7 は入力した件数だけで試算します。`;
}

function pathwaysForIro(topic: EsrsTopic, type: IroType): PathwayId[] {
  return PATHWAY_IDS.filter((id) => {
    const related = PATHWAYS[id].related;
    return related.iroTopic === topic && (related.iroTypes ?? []).includes(type);
  });
}

function iroNoteOf(pathways: PathwayId[]): string {
  if (pathways.length === 0) {
    return '円にしない（1〜5 の点数と期間のまま表示。対応する試算の経路はありません）';
  }
  const notes = pathways
    .map((id) => PATHWAYS[id].related.iroUnquantifiedNote)
    .filter((n): n is string => Boolean(n));
  if (notes.length > 0) return [...new Set(notes)].join('');
  return `関連する経路: ${pathways.join('・')}（IRO の点数は円にしない。経路の試算は指標と仮定による）`;
}

function includesAny(text: string, keywords: readonly string[] | undefined): boolean {
  return (keywords ?? []).some((k) => text.includes(k));
}

function pathwaysForNarrative(title: string, tags: readonly string[]): PathwayId[] {
  const haystack = [title, ...tags].join(' ');
  return PATHWAY_IDS.filter((id) => includesAny(haystack, PATHWAYS[id].related.narrativeKeywords));
}

function pathwaysForSsbj(topicKey: string, title: string): PathwayId[] {
  return PATHWAY_IDS.filter((id) => {
    const related = PATHWAYS[id].related;
    return (
      (related.ssbjTopicKeys ?? []).includes(topicKey) || includesAny(title, related.ssbjKeywords)
    );
  });
}

async function loadQualitative(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  ownPeriods: ReportingPeriod[],
): Promise<QualitativeImpactView> {
  const organizationId = ctx.workspace.organizationId;
  const [narratives, csrd, topicRows] = await Promise.all([
    listNarratives(db, ctx),
    loadCsrdSettings(db, ctx, period),
    db.select('materialityTopics', { where: { organizationId, deletedAt: { isNull: true } } }),
  ]);

  const iros: IroView[] = [];
  for (const matter of csrd?.matters ?? []) {
    for (const iro of matter.iros) {
      // 円の試算と並べるのは財務側（リスク・機会）だけ。インパクトは財務の経路を持たない
      if (iro.iroType === 'impact') continue;
      const pathways = pathwaysForIro(matter.topic, iro.iroType);
      iros.push({
        id: iro.id,
        topic: matter.topic,
        topicLabel: ESRS_TOPIC_LABEL[matter.topic],
        type: iro.iroType,
        typeLabel: IRO_TYPE_LABEL[iro.iroType],
        subTopic: iro.subTopic,
        description: iro.description,
        likelihood: iro.financialLikelihood,
        magnitude: iro.financialMagnitude,
        horizon: iro.timeHorizon,
        horizonLabel: iro.timeHorizon ? TIME_HORIZON_LABEL[iro.timeHorizon] : null,
        outcomeLabel: DMA_OUTCOME_LABEL[matter.outcome],
        pathways,
        note: iroNoteOf(pathways),
        href: `/enterprise/disclosures/csrd/settings/matters/${matter.topic}`,
      });
    }
  }

  const narrativeViews: NarrativeImpactView[] = narratives.map((row) => {
    let amountNote: string | null = null;
    if (row.record.theme === 'financial_impact') {
      const fields = row.currentVersion?.fields ?? {};
      const assessment = assessNarrativeFields('financial_impact', fields);
      const amount = fields.amount?.trim() ?? '';
      amountNote = assessment.notQuantifiedReason
        ? notQuantifiedNote(assessment.notQuantifiedReason)
        : amount
          ? `記録された影響額: ${amount}（この試算には合算しません）`
          : '影響額も示さない理由も記録されていません';
    }
    return {
      id: row.record.id,
      title: row.record.title,
      themeLabel: row.themeLabel,
      statusLabel: row.statusLabel,
      pathways: pathwaysForNarrative(row.record.title, row.record.tags),
      amountNote,
      href: `/enterprise/narratives/${row.record.id}`,
    };
  });

  // SSBJ マテリアリティ: ヘッダー年度以前で評価のある最新の期間（年度ごとに決め直すため、混ぜない）
  const periodsWithTopics = ownPeriods
    .filter((p) => p.startDate <= period.startDate)
    .filter((p) => topicRows.some((t) => t.reportingPeriodId === p.id))
    .sort(byStartDate);
  const ssbjPeriod = periodsWithTopics.at(-1) ?? null;
  const ssbjTopics: SsbjTopicImpactView[] = ssbjPeriod
    ? topicRows
        .filter((t) => t.reportingPeriodId === ssbjPeriod.id)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
        .map((t) => ({
          id: t.id,
          topicKey: t.topicKey,
          title: t.title,
          materialityLabel: MATERIALITY_LABEL[t.materiality],
          rationale: t.rationale,
          pathways: pathwaysForSsbj(t.topicKey, t.title),
          href: '/enterprise/disclosures/ssbj/settings',
        }))
    : [];

  return { csrdPeriod: period, iros, narratives: narrativeViews, ssbjPeriod, ssbjTopics };
}

function relatedByPathwayOf(q: QualitativeImpactView | null): Record<PathwayId, RelatedItem[]> {
  const result = Object.fromEntries(PATHWAY_IDS.map((id) => [id, [] as RelatedItem[]])) as Record<
    PathwayId,
    RelatedItem[]
  >;
  if (!q) return result;
  for (const iro of q.iros) {
    for (const id of iro.pathways) {
      result[id].push({
        kind: 'iro',
        label: `IRO ${iro.topic} ${iro.typeLabel}「${iro.description}」（可能性 ${iro.likelihood ?? '—'} × 大きさ ${iro.magnitude ?? '—'}・${iro.horizonLabel ?? '期間未設定'}）`,
        href: iro.href,
        note: PATHWAYS[id].related.iroUnquantifiedNote ?? null,
      });
    }
  }
  for (const n of q.narratives) {
    for (const id of n.pathways) {
      result[id].push({ kind: 'narrative', label: `定性「${n.title}」`, href: n.href, note: null });
    }
  }
  for (const t of q.ssbjTopics) {
    for (const id of t.pathways) {
      result[id].push({
        kind: 'ssbj',
        label: `SSBJ マテリアリティ「${t.title}」（${q.ssbjPeriod?.code ?? '—'}・${t.materialityLabel}）`,
        href: t.href,
        note: t.rationale || null,
      });
    }
  }
  return result;
}

/**
 * 財務影響分析を読む（書かない）。権限は enterprise.data.read。定性情報・IRO は
 * enterprise.disclosure.read のときだけ含める
 */
export async function loadFinancialImpact(
  db: DbClient,
  ctx: AuthorizationContext,
  input: FinancialImpactInput,
): Promise<FinancialImpactView> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.read');
  const organizationId = ctx.workspace.organizationId;
  // 画面から渡る期間も自組織のものだけを使う（他組織の期間で試算しない）
  if (input.period.organizationId !== organizationId) {
    throw new NotFoundError('報告期間が見つかりません。');
  }

  const defaults = assumptionDefaultsFor(input.source);
  const params = parseImpactParams(input.params, defaults);
  const common: FinancialImpactCommon = {
    period: input.period,
    source: input.source,
    defaults,
    params,
    baseline: financialBaselineFor(input.source),
  };

  const ownPeriods = (await db.select('periods', { where: { organizationId } })).sort(byStartDate);
  const basePeriod =
    ownPeriods
      .filter((p) => p.startDate <= input.period.startDate && p.status === 'closed')
      .at(-1) ?? null;
  if (!basePeriod) return { ...common, status: 'no_base' };
  const baseYear = startYearOf(basePeriod);

  // 起点（基準年度）と、確定データの年数を数えるための過年度（基準年度以前）を 1 回で読む
  const periodIds = ownPeriods.filter((p) => p.startDate <= basePeriod.startDate).map((p) => p.id);
  const driverCodes = DRIVER_KEYS.map((key) => DRIVERS[key].metricCode);
  const states = await loadMetricYearStates(db, ctx, {
    metricCodes: [...driverCodes, 'work_related_injuries', 'ltifr'],
    periodIds,
  });
  const driverRows = states.rows.filter((r) => driverCodes.includes(r.metric.code));

  const originStates = new Map<DriverKey, MetricPeriodState | null>();
  const origins = DRIVER_KEYS.map((driver) => {
    const row = driverRows.find((r) => r.metric.code === DRIVERS[driver].metricCode);
    const { origin, state } = originOf(driver, row, basePeriod);
    originStates.set(driver, state);
    return origin;
  });

  const targets = targetsOf(origins, originStates, await listKpiTargets(db, ctx), basePeriod);
  const appliedTargets: Partial<Record<DriverKey, TargetPath>> = {};
  for (const t of targets) {
    if (t.status === 'applied' && t.targetYear !== null && t.targetValue !== null) {
      appliedTargets[t.driver] = {
        targetYear: t.targetYear,
        targetValue: t.targetValue,
        ...(t.direction ? { direction: t.direction } : {}),
      };
    }
  }

  const inputFor = (scenario: ScenarioKey): SimulationInput => ({
    baseYear,
    origins: Object.fromEntries(origins.map((o) => [o.driver, o.value])) as Record<
      DriverKey,
      number | null
    >,
    targets: appliedTargets,
    scenario,
    assumptions: params.assumptions,
    growthRates: params.growthRates,
    enabled: params.enabled,
  });

  const currentInput = inputFor(params.scenario);
  const current = simulateFinancialImpact(currentInput);
  const bau = params.scenario === 'bau' ? current : simulateFinancialImpact(inputFor('bau'));
  const target =
    params.scenario === 'target' ? current : simulateFinancialImpact(inputFor('target'));
  const scenarios: FinancialImpactReady['scenarios'] = [
    { scenario: 'bau', result: bau },
    { scenario: 'target', result: target },
  ];
  if (params.scenario === 'custom') scenarios.push({ scenario: 'custom', result: current });
  // 回避コストは「比べるシナリオ − 現状維持」。現状維持を選んでいるときは目標達成と比べる
  const comparison =
    params.scenario === 'bau'
      ? compareWithBau(bau, target, inputFor('target'))
      : compareWithBau(bau, current, currentInput);

  const qualitative = can(ctx, 'enterprise.disclosure.read')
    ? await loadQualitative(db, ctx, input.period, ownPeriods)
    : null;

  const scope1 = origins.find((o) => o.driver === 'scope1');
  return {
    ...common,
    status: 'ready',
    basePeriod,
    baseYear,
    referenceYear: referenceYearOf(baseYear),
    origins,
    targets,
    dataDepthYears: dataDepthOf(driverRows),
    injuryDataNote: injuryNoteOf(states.rows, basePeriod),
    scope1Reference: scope1?.value ?? null,
    currentInput,
    current,
    scenarios,
    comparison,
    sensitivity: sensitivity(currentInput),
    qualitative,
    hiddenNote: qualitative ? null : FINANCIAL_IMPACT_HIDDEN_NOTE,
    relatedByPathway: relatedByPathwayOf(qualitative),
  };
}
