import type {
  CarrierKind,
  GhgActivityKind,
  GhgClassificationRule,
  GhgMethod,
  GhgScope,
  ReportingPeriod,
} from '@/types/domain';

/**
 * 区分（plan §2.2 classification.ts・CR-07・K7）。純関数。
 *
 *  - 既定区分（GHG プロトコル）: 燃料・ガス・自社便＝scope1、購入した電力・熱＝scope2_location（ロケーション基準）／
 *    scope2（マーケット基準）、委託（自社が荷主の外部業者の輸送）＝scope3_cat4
 *  - 報告区分: 承認済みかつ適用期間内で条件が一致する区分規則だけが変える（提案中・取り下げは効かない）。
 *    同じ行に 2 つ以上の規則が当てはまれば変えずに conflict を返す（どちらかを黙って選ばない）
 *  - 二重表示の不変条件: Σ(報告の scope1＋scope3) ＝ Σ(既定の scope1＋scope3)（再分類は移動だけ）。
 *    Scope2 の 2 基準は決して足さない
 * 当否（組織の方針が GHG プロトコルの標準と異なること）は判断しない。根拠・承認者・二重表示で透明にする。
 */

export interface ClassifiableLine {
  unitId: string;
  activityKind: GhgActivityKind;
  method: GhgMethod;
  carrierKind: CarrierKind | null;
  cargoKind: string | null;
}

export function protocolScopeOf(line: ClassifiableLine): GhgScope {
  switch (line.activityKind) {
    case 'electricity':
    case 'heat':
      return line.method === 'electricity_market' || line.method === 'heat_market'
        ? 'scope2'
        : 'scope2_location';
    case 'transport':
      return line.carrierKind === 'contracted' ? 'scope3_cat4' : 'scope1';
    case 'fuel':
    case 'gas':
      return 'scope1';
  }
}

/** 規則の適用期間に期間が入るか（開始の期間の開始日以後・終了の期間の終了日以前） */
export function ruleEffectiveIn(
  rule: Pick<GhgClassificationRule, 'effectiveFromPeriodId' | 'effectiveToPeriodId'>,
  period: Pick<ReportingPeriod, 'id' | 'startDate' | 'endDate'>,
  periods: ReadonlyArray<Pick<ReportingPeriod, 'id' | 'startDate' | 'endDate'>>,
): boolean {
  if (rule.effectiveFromPeriodId) {
    const from = periods.find((p) => p.id === rule.effectiveFromPeriodId);
    if (!from || period.startDate < from.startDate) return false;
  }
  if (rule.effectiveToPeriodId) {
    const to = periods.find((p) => p.id === rule.effectiveToPeriodId);
    if (!to || period.endDate > to.endDate) return false;
  }
  return true;
}

function matches(rule: GhgClassificationRule, line: ClassifiableLine): boolean {
  const m = rule.match;
  if (
    m.activityKinds &&
    m.activityKinds.length > 0 &&
    !m.activityKinds.includes(line.activityKind)
  ) {
    return false;
  }
  if (m.carrierKinds && m.carrierKinds.length > 0) {
    if (!line.carrierKind || !m.carrierKinds.includes(line.carrierKind)) return false;
  }
  if (m.cargoKinds && m.cargoKinds.length > 0) {
    if (!line.cargoKind || !m.cargoKinds.includes(line.cargoKind)) return false;
  }
  if (m.unitIds && m.unitIds.length > 0 && !m.unitIds.includes(line.unitId)) return false;
  return true;
}

export interface ClassificationResult {
  protocolScope: GhgScope;
  reportedScope: GhgScope;
  ruleId: string | null;
  /** 2 つ以上の規則が当てはまった（報告区分は既定区分のまま） */
  conflict?: string[];
}

export function classify(
  line: ClassifiableLine,
  rules: readonly GhgClassificationRule[],
  period: Pick<ReportingPeriod, 'id' | 'startDate' | 'endDate'>,
  periods: ReadonlyArray<Pick<ReportingPeriod, 'id' | 'startDate' | 'endDate'>>,
): ClassificationResult {
  const protocolScope = protocolScopeOf(line);
  const applicable = rules.filter(
    (rule) =>
      rule.status === 'approved' &&
      rule.protocolScope === protocolScope &&
      ruleEffectiveIn(rule, period, periods) &&
      matches(rule, line),
  );
  if (applicable.length === 0) return { protocolScope, reportedScope: protocolScope, ruleId: null };
  if (applicable.length > 1) {
    return {
      protocolScope,
      reportedScope: protocolScope,
      ruleId: null,
      conflict: applicable.map((r) => r.id).sort(),
    };
  }
  const rule = applicable[0]!;
  return { protocolScope, reportedScope: rule.reportedScope, ruleId: rule.id };
}

const ZERO = (): Record<GhgScope, number> => ({
  scope1: 0,
  scope2: 0,
  scope2_location: 0,
  scope3_cat4: 0,
});

export interface DualViewLine {
  protocolScope: GhgScope;
  reportedScope: GhgScope;
  classificationRuleId: string | null;
  emissions: number;
}

export interface DualView {
  reported: Record<GhgScope, number>;
  protocol: Record<GhgScope, number>;
  reclassified: Array<{ ruleId: string; from: GhgScope; to: GhgScope; amount: number }>;
}

/** 報告区分と既定区分の合計を並べる（再分類は移動だけ。Scope2 の 2 基準は別々） */
export function dualView(lines: readonly DualViewLine[]): DualView {
  const reported = ZERO();
  const protocol = ZERO();
  const moved = new Map<string, { ruleId: string; from: GhgScope; to: GhgScope; amount: number }>();
  for (const line of lines) {
    reported[line.reportedScope] += line.emissions;
    protocol[line.protocolScope] += line.emissions;
    if (line.reportedScope !== line.protocolScope && line.classificationRuleId) {
      const key = `${line.classificationRuleId}|${line.protocolScope}|${line.reportedScope}`;
      const entry = moved.get(key) ?? {
        ruleId: line.classificationRuleId,
        from: line.protocolScope,
        to: line.reportedScope,
        amount: 0,
      };
      entry.amount += line.emissions;
      moved.set(key, entry);
    }
  }
  return { reported, protocol, reclassified: [...moved.values()] };
}

/** Scope3 の内訳（Cat.1 の算定の入力など）で、物流の購入を数えていそうな語 */
const LOGISTICS_WORDS = [
  '物流',
  '輸送',
  '配送',
  '運送',
  '運賃',
  'logistics',
  'transport',
  'freight',
];

export interface DoubleCountWarning {
  ruleId: string;
  inputLabel: string;
  message: string;
}

/**
 * 二重計上の警告（規則ベース）。報告区分を Scope1 へ移した委託物流があるのに、Scope3 の内訳に物流の購入を
 * 数えた入力があれば警告する（同じ輸送を Scope1 と Scope3 の両方に計上していないかを人が確かめる）
 */
export function doubleCountWarnings(
  lines: ReadonlyArray<
    Pick<ClassifiableLine, 'activityKind'> & {
      reportedScope: GhgScope;
      protocolScope: GhgScope;
      classificationRuleId: string | null;
    }
  >,
  scope3Inputs: ReadonlyArray<{ label: string }>,
): DoubleCountWarning[] {
  const ruleIds = [
    ...new Set(
      lines
        .filter(
          (l) =>
            l.activityKind === 'transport' &&
            l.classificationRuleId &&
            l.protocolScope === 'scope3_cat4' &&
            l.reportedScope !== 'scope3_cat4',
        )
        .map((l) => l.classificationRuleId as string),
    ),
  ];
  if (ruleIds.length === 0) return [];
  const suspicious = scope3Inputs.filter((input) =>
    LOGISTICS_WORDS.some((w) => input.label.toLowerCase().includes(w.toLowerCase())),
  );
  return ruleIds.flatMap((ruleId) =>
    suspicious.map((input) => ({
      ruleId,
      inputLabel: input.label,
      message: `報告区分を移した委託物流と同じ輸送を、Scope3 の内訳「${input.label}」でも数えていないか確認してください。`,
    })),
  );
}
