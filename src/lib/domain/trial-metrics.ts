import type {
  CostClass,
  FeedbackChannel,
  FeedbackKind,
  FeedbackSeverity,
  FeedbackStatus,
  TrialAgreementKey,
  TrialCompletion,
  TrialDecision,
  TrialEndDisposition,
  TrialFeedbackItem,
  TrialJudgement,
  TrialPhase,
  TrialTaskKey,
  TrialTaskTiming,
  TrialTheme,
  TrialScopeKind,
  TrialTimingMethod,
  TrialTimingMode,
} from '@/types/domain';
import { TRIAL_TASK_KEYS } from '@/types/domain';

/**
 * トライアルの評価の数え方（トライアル対応 NF-33・NF-34・NF-35）。DB にも画面にも依存しない純粋関数だけ。
 *
 * 誠実さの規則（plan K10）:
 *  - 率は必ず件数（n）と一緒に返す。件数が足りない（n < 3）ときは率を出さず「件数不足（n=2）」にする
 *    （1 件の成功を 100% と見せない）。分母が 0 のときも 0% と出さない（記録なし）
 *  - 訂正された記録（新しい記録の supersedes が指すもの）は数えない（追記専用の表で訂正を表すため）
 *  - 作業時間の短縮率は現行・T4D の両方が n ≥ 3 のときだけ。目標は結果と混ぜずに別に返す
 *  - 利用者の操作は自動で追跡しない。数えるのは人が記録した実施・判定・作業時間と、既存の業務記録だけ
 */

/** 率を出すのに要る最小の件数 */
export const TRIAL_MIN_SAMPLE = 3;

// ----------------------------------------------------------------------
// 表示の語（生の enum を画面・出力に出さない）
// ----------------------------------------------------------------------

export const TRIAL_THEME_LABELS: Readonly<Record<TrialTheme, string>> = {
  traceability: 'トレーサビリティ',
  gap_distinction: '対象外と未対応の区別',
  approval_change: '承認と変更管理',
  output_reuse: '出力と突合',
  usability: '使いやすさ',
  work_time: '作業時間',
  operations: '運用',
  calculation_reconciliation: '算定の再現と整合性の確認',
};

export const TRIAL_PHASE_LABELS: Readonly<Record<TrialPhase, string>> = {
  setup: '準備',
  started: '開始（適合性の確認）',
  tuning: '改善',
  reverification: '再検証',
  decision: '導入判断',
  closed: '終了',
};

export const TRIAL_END_DISPOSITION_LABELS: Readonly<Record<TrialEndDisposition, string>> = {
  continue: '継続して本導入へ移行',
  return: 'データを返却',
  delete: 'データを削除',
  undecided: '未決定',
};

export const TRIAL_DECISION_LABELS: Readonly<Record<TrialDecision, string>> = {
  adopt: '導入',
  conditional: '条件付き導入',
  decline: '見送り',
  undecided: '未判断',
};

export const TRIAL_AGREEMENT_LABELS: Readonly<Record<TrialAgreementKey, string>> = {
  scope: '対象範囲',
  decider: '判断者',
  schedule: 'スケジュール',
  freeScope: '無償の範囲',
};

export const TRIAL_TASK_LABELS: Readonly<Record<TrialTaskKey, string>> = {
  transcription: 'データ収集・転記',
  check_reconcile: '確認・突合',
  drafting: '原稿作成',
  approval: '承認',
  assurance_response: '保証対応',
  handover: '引継ぎ',
};

export const TRIAL_TIMING_MODE_LABELS: Readonly<Record<TrialTimingMode, string>> = {
  baseline: '現行',
  t4d: 'T4D',
};

export const TRIAL_TIMING_METHOD_LABELS: Readonly<Record<TrialTimingMethod, string>> = {
  self_report: '自己申告',
  observed: '同席観察',
  log_estimate: '記録からの推定（参考値）',
};

export const FEEDBACK_CHANNEL_LABELS: Readonly<Record<FeedbackChannel, string>> = {
  in_app: 'アプリ内',
  meeting: '定例会',
  email: 'メール',
  phone: '電話',
  other: 'その他',
};

/** 再検証の結果（trial_feedback_items.verification_result に入れる値） */
export const VERIFICATION_RESULTS = ['pass', 'fail'] as const;
export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];

export const VERIFICATION_RESULT_LABELS: Readonly<Record<VerificationResult, string>> = {
  pass: '再検証で解消を確認',
  fail: '再検証で解消せず',
};

export function verificationLabel(value: string): string {
  return (VERIFICATION_RESULTS as readonly string[]).includes(value)
    ? VERIFICATION_RESULT_LABELS[value as VerificationResult]
    : value === ''
      ? '未実施'
      : '記録あり';
}

// ----------------------------------------------------------------------
// 率・件数
// ----------------------------------------------------------------------

export interface RateResult {
  /** 0〜1。件数不足・分母 0 は null（0% と出さない） */
  rate: number | null;
  numerator: number;
  /** 分母（件数） */
  n: number;
  insufficient: boolean;
  /** 例: 「67%（2 / 3）」「件数不足（n=2）」「記録なし」 */
  label: string;
}

/** 件数が足りないときの語 */
export function insufficientLabel(n: number): string {
  return n === 0 ? '記録なし' : `件数不足（n=${n}）`;
}

/** 0〜1 の率を「66.7%」のように（小数 1 桁。整数なら小数なし） */
export function formatRatePercent(rate: number): string {
  const percent = Math.round(rate * 1000) / 10;
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

/** 分子 / 分母の率（分母が minSample 未満なら率を出さない） */
export function rateOf(numerator: number, n: number, minSample = TRIAL_MIN_SAMPLE): RateResult {
  if (n <= 0) return { rate: null, numerator, n: 0, insufficient: true, label: '記録なし' };
  if (n < minSample) {
    return { rate: null, numerator, n, insufficient: true, label: insufficientLabel(n) };
  }
  const rate = numerator / n;
  return {
    rate,
    numerator,
    n,
    insufficient: false,
    label: `${formatRatePercent(rate)}（${numerator} / ${n}）`,
  };
}

/** 訂正された実施（新しい実施の supersedesRunId が指すもの）を除く */
export function effectiveRuns<T extends { id: string; supersedesRunId: string | null }>(
  runs: readonly T[],
): T[] {
  const superseded = new Set(runs.map((r) => r.supersedesRunId).filter((id) => id !== null));
  return runs.filter((r) => !superseded.has(r.id));
}

/** 訂正された作業時間の記録を除く */
export function effectiveTimings<T extends { id: string; supersedesId: string | null }>(
  rows: readonly T[],
): T[] {
  const superseded = new Set(rows.map((r) => r.supersedesId).filter((id) => id !== null));
  return rows.filter((r) => !superseded.has(r.id));
}

/** 自力で完了した割合（自力完遂率）。支援を受けて完了は自力に数えない */
export function completionRate(runs: ReadonlyArray<{ completion: TrialCompletion }>): RateResult {
  const self = runs.filter((r) => r.completion === 'self').length;
  return rateOf(self, runs.length);
}

export interface InquiryResult {
  /** 問い合わせの合計回数 */
  total: number;
  n: number;
  /** 1 実施あたりの回数（件数不足は null） */
  perRun: number | null;
  insufficient: boolean;
  /** 例: 「0.5 回（計 3 回・n=6）」「件数不足（n=2）」 */
  label: string;
}

/** 問い合わせ回数（1 実施あたり） */
export function inquiryCount(runs: ReadonlyArray<{ helpCount: number }>): InquiryResult {
  const total = runs.reduce((sum, r) => sum + Math.max(0, r.helpCount), 0);
  const n = runs.length;
  if (n < TRIAL_MIN_SAMPLE) {
    return { total, n, perRun: null, insufficient: true, label: insufficientLabel(n) };
  }
  const perRun = total / n;
  const shown = Math.round(perRun * 10) / 10;
  return {
    total,
    n,
    perRun,
    insufficient: false,
    label: `${shown.toFixed(1)} 回（計 ${total} 回・n=${n}）`,
  };
}

/** シナリオの最新の判定（追記専用。後の判定が前の判定に代わる） */
export function latestJudgement<T extends { scenarioId: string; judgedAt: string }>(
  judgements: readonly T[],
  scenarioId: string,
): T | null {
  let latest: T | null = null;
  for (const j of judgements) {
    if (j.scenarioId !== scenarioId) continue;
    if (!latest || j.judgedAt > latest.judgedAt) latest = j;
  }
  return latest;
}

export type JudgementStateValue = TrialJudgement | 'not_judged';

export function judgementStateOf(
  latest: { judgement: TrialJudgement } | null,
): JudgementStateValue {
  return latest ? latest.judgement : 'not_judged';
}

export interface PassRateResult extends RateResult {
  /** 判定の記録が無いシナリオの数（分母に入れない） */
  notJudged: number;
}

/**
 * 合格率（必須制御の合格率など）。分母は判定済み（合格・不合格・保留）のシナリオ。保留は合格に数えない。
 * 未判定は分母に入れず、件数を別に返す
 */
export function passRate(states: readonly JudgementStateValue[]): PassRateResult {
  const judged = states.filter((s) => s !== 'not_judged');
  const pass = judged.filter((s) => s === 'pass').length;
  return { ...rateOf(pass, judged.length), notJudged: states.length - judged.length };
}

// ----------------------------------------------------------------------
// 作業時間（現行 vs T4D）
// ----------------------------------------------------------------------

export function median(values: readonly number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** 1 単位あたりの分 */
export function perUnitMinutes(row: { minutes: number; quantity: number }): number {
  return row.quantity > 0 ? row.minutes / row.quantity : row.minutes;
}

export interface TimingSide {
  /** 1 単位あたりの分の中央値 */
  median: number | null;
  n: number;
  methods: TrialTimingMethod[];
  /** 記録からの推定（待ち時間を含む参考値）を含むか */
  includesLogEstimate: boolean;
}

export interface ReductionResult {
  baseline: TimingSide;
  t4d: TimingSide;
  /** 短縮率（0〜1。負は増加）。両方 n ≥ 3 でなければ null */
  rate: number | null;
  /** 1 単位あたりの短縮分（中央値の差。両方 n ≥ 3 のときだけ） */
  savedMinutesPerUnit: number | null;
  insufficient: boolean;
  /** 例: 「29.2% 短縮」「件数不足（現行 n=2・T4D n=1）」 */
  label: string;
}

function sideOf(rows: ReadonlyArray<Pick<TrialTaskTiming, 'minutes' | 'quantity' | 'method'>>) {
  const methods = [...new Set(rows.map((r) => r.method))];
  return {
    median: median(rows.map(perUnitMinutes)),
    n: rows.length,
    methods,
    includesLogEstimate: methods.includes('log_estimate'),
  } satisfies TimingSide;
}

/** 現行と T4D の 1 単位あたりの分（中央値）から短縮率を出す。両方 n ≥ 3 のときだけ */
export function reductionRate(
  rows: ReadonlyArray<Pick<TrialTaskTiming, 'mode' | 'minutes' | 'quantity' | 'method'>>,
): ReductionResult {
  const baseline = sideOf(rows.filter((r) => r.mode === 'baseline'));
  const t4d = sideOf(rows.filter((r) => r.mode === 't4d'));
  const enough = baseline.n >= TRIAL_MIN_SAMPLE && t4d.n >= TRIAL_MIN_SAMPLE;
  if (!enough || baseline.median === null || t4d.median === null || baseline.median <= 0) {
    const label =
      baseline.n === 0 && t4d.n === 0
        ? '記録なし'
        : enough
          ? '現行の時間が 0 のため算出しません'
          : `件数不足（現行 n=${baseline.n}・T4D n=${t4d.n}）`;
    return { baseline, t4d, rate: null, savedMinutesPerUnit: null, insufficient: true, label };
  }
  const saved = baseline.median - t4d.median;
  const rate = saved / baseline.median;
  const label =
    rate >= 0
      ? `${formatRatePercent(rate)} 短縮`
      : `${formatRatePercent(-rate)} 増加（短縮していません）`;
  return { baseline, t4d, rate, savedMinutesPerUnit: saved, insufficient: false, label };
}

export interface TaskReduction extends ReductionResult {
  taskKey: TrialTaskKey;
}

/** 作業ごとの短縮率（6 作業すべて。記録が無い作業も「記録なし」として並べる） */
export function summarizeTimingsByTask(rows: readonly TrialTaskTiming[]): TaskReduction[] {
  const effective = effectiveTimings(rows);
  return TRIAL_TASK_KEYS.map((taskKey) => ({
    taskKey,
    ...reductionRate(effective.filter((r) => r.taskKey === taskKey)),
  }));
}

/** 短縮の目標（計画の options.reductionTarget。合意した値を人が入れる。結果と混ぜない） */
export interface ReductionTarget {
  minPercent: number;
  maxPercent: number;
}

export function reductionTargetOf(options: Record<string, unknown>): ReductionTarget | null {
  const raw = options.reductionTarget;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { minPercent, maxPercent } = raw as Record<string, unknown>;
  if (typeof minPercent !== 'number' || typeof maxPercent !== 'number') return null;
  if (!Number.isFinite(minPercent) || !Number.isFinite(maxPercent)) return null;
  if (minPercent < 0 || maxPercent > 100 || minPercent > maxPercent) return null;
  return { minPercent, maxPercent };
}

export function reductionTargetLabel(target: ReductionTarget | null): string {
  if (!target) return '目標は未設定';
  return target.minPercent === target.maxPercent
    ? `目標 ${target.minPercent}% 短縮`
    : `目標 ${target.minPercent}〜${target.maxPercent}% 短縮`;
}

// ----------------------------------------------------------------------
// 改善管理表（本導入の条件: 必須要件に重大な未解決事項がない）
// ----------------------------------------------------------------------

/**
 * 未解決か。対応しない（wont_fix）は合意（agreed）があれば解決扱い（残課題は担当・期限・費用を明記して合意する）。
 * 解決済み・再検証済みは解決
 */
export function isUnresolved(item: Pick<TrialFeedbackItem, 'status' | 'agreed'>): boolean {
  if (item.status === 'resolved' || item.status === 'verified') return false;
  if (item.status === 'wont_fix') return !item.agreed;
  return true;
}

export interface OpenIssueSummary {
  /** 必須要件 × 重大 × 未解決（本導入の条件） */
  mandatoryCriticalOpen: number;
  unresolved: number;
  total: number;
  positive: number;
  byKind: Record<FeedbackKind, number>;
  byStatus: Record<FeedbackStatus, number>;
  byCostClass: Record<CostClass, number>;
  /**
   * 費用区分が別途協議の件数を区分（scope_kind）ごとに。区分の無い別途協議は unclassified
   * （どの区分にも数えない。推測で振り分けない）
   */
  separateByScopeKind: Record<TrialScopeKind | 'unclassified', number>;
}

export function openIssueSummary(
  items: ReadonlyArray<
    Pick<
      TrialFeedbackItem,
      'kind' | 'status' | 'agreed' | 'severity' | 'mandatoryRequirement' | 'costClass' | 'deletedAt'
    > & { scopeKind?: TrialScopeKind | null }
  >,
): OpenIssueSummary {
  const live = items.filter((i) => !i.deletedAt);
  const byKind: Record<FeedbackKind, number> = {
    defect: 0,
    request: 0,
    question: 0,
    positive: 0,
    other: 0,
  };
  const byStatus: Record<FeedbackStatus, number> = {
    open: 0,
    triaged: 0,
    in_progress: 0,
    resolved: 0,
    wont_fix: 0,
    verified: 0,
  };
  const byCostClass: Record<CostClass, number> = {
    maintenance: 0,
    separate_estimate: 0,
    undecided: 0,
  };
  const separateByScopeKind: Record<TrialScopeKind | 'unclassified', number> = {
    site_expansion: 0,
    bulk_primary_data: 0,
    system_integration: 0,
    custom_development: 0,
    unclassified: 0,
  };
  for (const item of live) {
    byKind[item.kind] += 1;
    byStatus[item.status] += 1;
    byCostClass[item.costClass] += 1;
    if (item.costClass === 'separate_estimate') {
      separateByScopeKind[item.scopeKind ?? 'unclassified'] += 1;
    }
  }
  const isCritical = (severity: FeedbackSeverity | null) => severity === 'critical';
  return {
    mandatoryCriticalOpen: live.filter(
      (i) => i.mandatoryRequirement && isCritical(i.severity) && isUnresolved(i),
    ).length,
    unresolved: live.filter((i) => i.kind !== 'positive' && isUnresolved(i)).length,
    total: live.length,
    positive: byKind.positive,
    byKind,
    byStatus,
    byCostClass,
    separateByScopeKind,
  };
}
