import { roundEmission, cleanFloat, ruleFor } from './rounding';
import { convert, emissionToTonnes, parseUnit, splitFactorUnit } from './units';
import type {
  AttributionStep,
  BaselineRow,
  GhgActivityKind,
  GhgAttributionCause,
  GhgActivityLine,
  GhgCalculationLine,
  GhgReconciliation,
  GhgReconciliationNote,
  GhgReconciliationResult,
  GhgReconVerdict,
  GhgScope,
  ReconciliationItem,
  ReconciliationTolerance,
  RoundingRule,
  RoundingStage,
} from '@/types/domain';

/**
 * 照合と差異の原因の分解（plan §2.2 attribution.ts・CR-12）。純関数（AI を使わない）。
 *
 * 突き合わせの鍵: 拠点 × 報告区分 × 活動（既存側に月があれば × 月、出荷番号があれば × 出荷番号）。
 * 順序つき置き換え: T4D の値 R0 から、原因 k の前提を既存の算定の前提に揃えて作り直した Rk との差
 * Δk = Rk − R(k−1) を原因 k の寄与とする。既定の順: 区分 → 対象範囲 → 活動量 → 単位換算 → 係数 →
 * 算定方法 → 丸め。既存側に情報が無い原因は「適用できない」（applicable=false・Δ=0）として飛ばし、残差へ入る。
 * 残差 ＝ 既存 − Rn。構成上 **Σ寄与 ＋ 残差 ＝ 既存 − T4D** が常に成り立つ。
 * 単独差: R0 から原因 k だけを揃えた差（相互作用があるため、単独差の和は総差と等しくならないことがある）。
 *
 * 行の値は「T4D の未丸めの値 × 置き換えた前提の比」で作り直す（R0 は T4D の値そのものになり、作り直しの
 * 浮動小数の誤差で原因の無い差を作らない）。判定の語に「一致」を使わない（plan K8）。
 */

/** 照合の規則の版（2: 購入した熱の行を基準〔区分〕の同じ既存の行とだけ対応させる） */
export const RECONCILIATION_CHECKER_VERSION = 'ghg-reconcile/2';

/** 既定の順序（plan §2.2） */
export const DEFAULT_ATTRIBUTION_ORDER: readonly GhgAttributionCause[] = [
  'classification',
  'coverage',
  'activity',
  'conversion',
  'factor',
  'method',
  'rounding',
];

/** 寄与・残差を 0 とみなす幅（t-CO2e）。浮動小数の誤差を原因と見なさない */
const EPSILON = 1e-9;

export type AttributionLine = Pick<
  GhgCalculationLine,
  | 'id'
  | 'unitId'
  | 'month'
  | 'activityKind'
  | 'activityCode'
  | 'reportedScope'
  | 'method'
  | 'activityAmount'
  | 'activityUnit'
  | 'convertedAmount'
  | 'convertedUnit'
  | 'emissionsUnrounded'
  | 'methodDetail'
> & { shipmentRef: string | null };

export interface AttributionOptions {
  order?: readonly GhgAttributionCause[];
  /** T4D の算定方針の丸め（R0 の値に効く段だけを使う） */
  t4dRounding: readonly RoundingRule[];
  tolerance: ReconciliationTolerance;
}

// ----------------------------------------------------------------------
// 鍵
// ----------------------------------------------------------------------

export function activityKeyOf(kind: GhgActivityKind, code: string): string {
  return `${kind}:${code}`;
}

/** 既存の行が細かさを持つか（活動・月・出荷番号） */
function rowLevel(row: BaselineRow): 'scope' | 'activity' | 'month' | 'shipment' {
  if (!row.activityKind || !row.activityCode) return 'scope';
  if (row.shipmentRef) return 'shipment';
  if (row.month) return 'month';
  return 'activity';
}

function subKeyOfRow(row: BaselineRow): string {
  const level = rowLevel(row);
  if (level === 'scope') return '';
  const activity = activityKeyOf(row.activityKind!, row.activityCode!);
  if (level === 'shipment') return `${activity}|${row.month ?? ''}|${row.shipmentRef}`;
  if (level === 'month') return `${activity}|${row.month}`;
  return activity;
}

function itemKey(unitId: string, scope: GhgScope, subKey: string): string {
  return `${unitId}|${scope}|${subKey}`;
}

/** 既存の値を t-CO2e に揃える */
function baselineTonnes(row: BaselineRow): number {
  const unit = parseUnit(row.emissionsUnit);
  const factor = unit && unit.dimension === 'emission' ? emissionToTonnes(unit) : 1;
  return row.emissions * factor;
}

function stageOfSubKey(subKey: string): RoundingStage {
  if (subKey === '') return 'site_scope';
  const parts = subKey.split('|');
  if (parts.length >= 3) return 'line';
  if (parts.length === 2) return 'month';
  return 'site_activity';
}

const STAGE_ORDER: Record<RoundingStage, number> = {
  line: 0,
  month: 1,
  site_activity: 2,
  site_scope: 3,
  total: 4,
};

// ----------------------------------------------------------------------
// 状態（行ごとの前提）
// ----------------------------------------------------------------------

interface LineState {
  scope: GhgScope;
  included: boolean;
  activityRatio: number;
  convRatio: number;
  factorRatio: number;
  methodRatio: number;
}

interface State {
  lines: Map<string, LineState>;
  /** 既存の側にしか無い行（対象範囲を揃えたときに足す。既存の値のまま） */
  fixed: Array<{ key: string; value: number }>;
  /** 既存の丸めの規則に揃えた項目（鍵 → 規則） */
  rounding: Map<string, RoundingRule[]>;
}

function cloneState(s: State): State {
  return {
    lines: new Map([...s.lines].map(([k, v]) => [k, { ...v }])),
    fixed: [...s.fixed],
    rounding: new Map(s.rounding),
  };
}

interface Match {
  line: AttributionLine;
  /** この行に対応する既存の行（活動の粒度以上で対応したもの） */
  rows: BaselineRow[];
  /** 活動の粒度の対応で決まる既存の区分（ひとつに決まらなければ null） */
  baselineScope: GhgScope | null;
  subKey: string;
}

function lineValue(line: AttributionLine, s: LineState): number {
  return line.emissionsUnrounded * s.activityRatio * s.convRatio * s.factorRatio * s.methodRatio;
}

/** 項目の値（含まれる行の値の和を、項目の粒度までの段で丸める） */
function itemValues(
  matches: ReadonlyMap<string, Match>,
  state: State,
  t4dRounding: readonly RoundingRule[],
): Map<string, number> {
  const groups = new Map<string, Array<{ month: string; activity: string; value: number }>>();
  for (const [lineId, match] of matches) {
    const s = state.lines.get(lineId)!;
    if (!s.included) continue;
    const key = itemKey(match.line.unitId, s.scope, match.subKey);
    const list = groups.get(key) ?? [];
    // 丸めの段の鍵は算定のエンジンと同じ（月・拠点×活動の段は活動の種類でまとめる。rounding.ts）
    list.push({
      month: match.line.month,
      activity: match.line.activityKind,
      value: lineValue(match.line, s),
    });
    groups.set(key, list);
  }
  for (const f of state.fixed) {
    const list = groups.get(f.key) ?? [];
    list.push({ month: '', activity: '', value: f.value });
    groups.set(f.key, list);
  }
  const out = new Map<string, number>();
  for (const [key, parts] of groups) {
    const subKey = key.split('|').slice(2).join('|');
    const stage = stageOfSubKey(subKey);
    const rules = state.rounding.get(key) ?? t4dRounding;
    out.set(key, roundUpTo(parts, rules, stage));
  }
  return out;
}

/** 行 → 月 → 拠点×活動 → 拠点×区分 の段を、項目の粒度まで当てる（その段の丸め後を次の段で足す） */
function roundUpTo(
  parts: ReadonlyArray<{ month: string; activity: string; value: number }>,
  rules: readonly RoundingRule[],
  stage: RoundingStage,
): number {
  const apply = (value: number, s: RoundingStage) => {
    const rule = ruleFor(rules, s);
    const clean = cleanFloat(value);
    return rule && STAGE_ORDER[s] <= STAGE_ORDER[stage] ? roundEmission(clean, rule) : clean;
  };
  const lines = parts.map((p) => ({ ...p, value: apply(p.value, 'line') }));
  if (stage === 'line') return cleanFloat(lines.reduce((a, b) => a + b.value, 0));
  const byMonth = new Map<string, { activity: string; value: number }>();
  for (const l of lines) {
    const k = `${l.activity}|${l.month}`;
    const e = byMonth.get(k) ?? { activity: l.activity, value: 0 };
    e.value += l.value;
    byMonth.set(k, e);
  }
  const months = [...byMonth.values()].map((m) => ({ ...m, value: apply(m.value, 'month') }));
  if (stage === 'month') return cleanFloat(months.reduce((a, b) => a + b.value, 0));
  const byActivity = new Map<string, number>();
  for (const m of months) byActivity.set(m.activity, (byActivity.get(m.activity) ?? 0) + m.value);
  const activities = [...byActivity.values()].map((v) => apply(v, 'site_activity'));
  if (stage === 'site_activity') return cleanFloat(activities.reduce((a, b) => a + b, 0));
  return apply(
    activities.reduce((a, b) => a + b, 0),
    'site_scope',
  );
}

// ----------------------------------------------------------------------
// 対応付け
// ----------------------------------------------------------------------

function buildMatches(
  lines: readonly AttributionLine[],
  rows: readonly BaselineRow[],
): { matches: Map<string, Match>; unitsWithActivityRows: Set<string>; unitsWithRows: Set<string> } {
  const activityRows = rows.filter((r) => r.unitId && rowLevel(r) !== 'scope');
  const unitsWithActivityRows = new Set(activityRows.map((r) => r.unitId!));
  const unitsWithRows = new Set(rows.filter((r) => r.unitId).map((r) => r.unitId!));
  const matches = new Map<string, Match>();
  for (const line of lines) {
    const activity = activityKeyOf(line.activityKind, line.activityCode);
    const candidates = activityRows.filter(
      (r) =>
        r.unitId === line.unitId &&
        activityKeyOf(r.activityKind!, r.activityCode!) === activity &&
        // 購入した電力・熱は区分が基準（ロケーション・マーケット）を表す。区分の付け替えは無く、基準の違う行と対応させない
        ((line.activityKind !== 'electricity' && line.activityKind !== 'heat') ||
          r.scope === line.reportedScope) &&
        (r.month === null || r.month === line.month) &&
        (r.shipmentRef === null || r.shipmentRef === line.shipmentRef),
    );
    // いちばん細かい粒度の行に対応させる
    const finest =
      (['shipment', 'month', 'activity'] as const)
        .map((level) => candidates.filter((r) => rowLevel(r) === level))
        .find((list) => list.length > 0) ?? [];
    let subKey: string;
    if (finest.length > 0) {
      subKey = subKeyOfRow(finest[0]!);
    } else if (unitsWithActivityRows.has(line.unitId)) {
      // 既存の側に無い行（対象範囲の差）。行の粒度に合わせて月の項目にする
      subKey = line.shipmentRef
        ? `${activity}|${line.month}|${line.shipmentRef}`
        : `${activity}|${line.month}`;
    } else if (unitsWithRows.has(line.unitId)) {
      subKey = '';
    } else {
      subKey = activity;
    }
    const scopes = [...new Set(finest.map((r) => r.scope))];
    matches.set(line.id, {
      line,
      rows: finest,
      baselineScope: scopes.length === 1 ? scopes[0]! : null,
      subKey,
    });
  }
  return { matches, unitsWithActivityRows, unitsWithRows };
}

// ----------------------------------------------------------------------
// 原因ごとの揃え方（状態を書き換える。どの順で当てても同じ列だけを書く）
// ----------------------------------------------------------------------

interface Context {
  matches: Map<string, Match>;
  rows: readonly BaselineRow[];
  unitsWithRows: Set<string>;
  /** 既存の行 → それに対応した T4D の行 */
  linesByRow: Map<BaselineRow, AttributionLine[]>;
}

function applyCause(cause: GhgAttributionCause, state: State, ctx: Context): void {
  switch (cause) {
    case 'classification':
      for (const [id, match] of ctx.matches) {
        if (match.baselineScope) state.lines.get(id)!.scope = match.baselineScope;
      }
      return;
    case 'coverage': {
      for (const [id, match] of ctx.matches) {
        // 既存の側に行が 1 つも無い拠点も、拠点ごと対象範囲の差（T4D の側だけ）
        const scopeRowExists = ctx.rows.some(
          (r) =>
            r.unitId === match.line.unitId &&
            rowLevel(r) === 'scope' &&
            r.scope === state.lines.get(id)!.scope,
        );
        if (match.rows.length === 0 && !scopeRowExists) state.lines.get(id)!.included = false;
      }
      for (const row of ctx.rows) {
        if (!row.unitId) continue;
        const matched = ctx.linesByRow.get(row) ?? [];
        if (rowLevel(row) === 'scope') {
          const anyLine = [...ctx.matches.values()].some(
            (m) => m.line.unitId === row.unitId && m.line.reportedScope === row.scope,
          );
          if (!anyLine) {
            state.fixed.push({
              key: itemKey(row.unitId, row.scope, ''),
              value: baselineTonnes(row),
            });
          }
          continue;
        }
        if (matched.length === 0) {
          state.fixed.push({
            key: itemKey(row.unitId, row.scope, subKeyOfRow(row)),
            value: baselineTonnes(row),
          });
        }
      }
      return;
    }
    case 'activity':
      for (const [row, lines] of ctx.linesByRow) {
        if (row.activityAmount === null || !row.activityUnit || lines.length === 0) continue;
        const target = lines[0]!.activityUnit;
        const converted = convert(row.activityAmount, row.activityUnit, target, []);
        if (!('value' in converted)) continue;
        const total = lines.reduce((a, l) => a + l.activityAmount, 0);
        if (!(total > 0)) continue;
        const ratio = converted.value / total;
        for (const l of lines) state.lines.get(l.id)!.activityRatio = ratio;
      }
      return;
    case 'conversion':
      for (const [row, lines] of ctx.linesByRow) {
        if (
          row.activityAmount === null ||
          !row.activityUnit ||
          row.convertedAmount === null ||
          !row.convertedUnit ||
          lines.length === 0
        ) {
          continue;
        }
        const first = lines[0]!;
        // 既存の換算の倍率を T4D の単位で表す（活動量・換算後とも内蔵の換算で単位だけ揃える）
        const act = convert(row.activityAmount, row.activityUnit, first.activityUnit, []);
        const conv = convert(row.convertedAmount, row.convertedUnit, first.convertedUnit, []);
        if (!('value' in act) || !('value' in conv) || !(act.value > 0)) continue;
        const baselineMultiplier = conv.value / act.value;
        for (const l of lines) {
          const t4dMultiplier = l.convertedAmount / l.activityAmount;
          if (t4dMultiplier > 0)
            state.lines.get(l.id)!.convRatio = baselineMultiplier / t4dMultiplier;
        }
      }
      return;
    case 'factor':
      for (const [row, lines] of ctx.linesByRow) {
        if (row.factorValue === null || !row.factorUnit || lines.length === 0) continue;
        const split = splitFactorUnit(row.factorUnit);
        if (!split) continue;
        for (const l of lines) {
          const t4dFactor = Number(l.methodDetail.effectiveFactorT);
          const per = convert(1, l.convertedUnit, split.activity.code, []);
          if (!('value' in per) || !(t4dFactor > 0)) continue;
          // 既存の係数（t / T4D の換算後の単位 1 あたり）
          const baselineFactor = row.factorValue * emissionToTonnes(split.emission) * per.value;
          state.lines.get(l.id)!.factorRatio = baselineFactor / t4dFactor;
        }
      }
      return;
    case 'method':
      for (const [row, lines] of ctx.linesByRow) {
        if (!row.method) continue;
        for (const l of lines) {
          const logRatio = Number(l.methodDetail.logRatio);
          if (row.method === 'tonkm_log' && l.method === 'tonkm_improved' && logRatio > 0) {
            state.lines.get(l.id)!.methodRatio = logRatio;
          }
        }
      }
      return;
    case 'rounding':
      for (const row of ctx.rows) {
        if (!row.unitId || !row.rounding) continue;
        const key = itemKey(
          row.unitId,
          row.scope,
          rowLevel(row) === 'scope' ? '' : subKeyOfRow(row),
        );
        state.rounding.set(key, [
          {
            stage: row.rounding.stage,
            digits: row.rounding.digits,
            unit: row.rounding.unit,
            method: row.rounding.method,
          },
        ]);
      }
      return;
  }
}

/** その原因の情報が既存の側にあるか（項目ごと） */
function causeApplicable(
  cause: GhgAttributionCause,
  key: string,
  rowsOfItem: readonly BaselineRow[],
  linesOfItem: readonly Match[],
  ctx: Context,
): boolean {
  const unitId = key.split('|')[0]!;
  switch (cause) {
    case 'classification':
      return (
        linesOfItem.some((m) => m.baselineScope !== null) ||
        rowsOfItem.some((r) => rowLevel(r) !== 'scope')
      );
    case 'coverage':
      return ctx.unitsWithRows.has(unitId) || linesOfItem.length > 0;
    case 'activity':
      return rowsOfItem.some((r) => r.activityAmount !== null && !!r.activityUnit);
    case 'conversion':
      return rowsOfItem.some((r) => r.convertedAmount !== null && !!r.convertedUnit);
    case 'factor':
      return rowsOfItem.some((r) => r.factorValue !== null && !!r.factorUnit);
    case 'method':
      return rowsOfItem.some((r) => !!r.method);
    case 'rounding':
      return rowsOfItem.some((r) => r.rounding !== null);
  }
}

// ----------------------------------------------------------------------
// 入口
// ----------------------------------------------------------------------

function withinTolerance(
  scope: GhgScope,
  base: number,
  diff: number,
  tolerance: ReconciliationTolerance,
): boolean {
  const t = tolerance[scope];
  if (!t) return false;
  const abs = Math.abs(diff);
  if (abs <= EPSILON) return true;
  if (t.absoluteT !== null && abs <= t.absoluteT + EPSILON) return true;
  if (
    t.relativePct !== null &&
    base !== 0 &&
    (abs / Math.abs(base)) * 100 <= t.relativePct + EPSILON
  ) {
    return true;
  }
  return false;
}

/**
 * 照合する。T4D の算定行（報告区分）と既存の算定結果の行（拠点の対応付け済み）を突き合わせ、項目ごとに
 * 差・原因別の寄与・単独差・残差・片側だけかを返す
 */
export function attribute(
  lines: readonly AttributionLine[],
  baselineRows: readonly BaselineRow[],
  options: AttributionOptions,
): GhgReconciliationResult {
  const order = options.order ?? DEFAULT_ATTRIBUTION_ORDER;
  const rows = baselineRows.filter((r) => r.unitId !== null);
  const { matches, unitsWithRows } = buildMatches(lines, rows);
  const linesByRow = new Map<BaselineRow, AttributionLine[]>();
  for (const m of matches.values()) {
    for (const r of m.rows) {
      const list = linesByRow.get(r) ?? [];
      list.push(m.line);
      linesByRow.set(r, list);
    }
  }
  const ctx: Context = { matches, rows, unitsWithRows, linesByRow };

  const initial: State = {
    lines: new Map(
      [...matches.keys()].map((id) => [
        id,
        {
          scope: matches.get(id)!.line.reportedScope,
          included: true,
          activityRatio: 1,
          convRatio: 1,
          factorRatio: 1,
          methodRatio: 1,
        },
      ]),
    ),
    fixed: [],
    rounding: new Map(),
  };

  // 順に揃えた状態の列と、原因ごとに単独で揃えた状態
  const sequence: State[] = [initial];
  for (const cause of order) {
    const next = cloneState(sequence[sequence.length - 1]!);
    applyCause(cause, next, ctx);
    sequence.push(next);
  }
  const values = sequence.map((s) => itemValues(matches, s, options.t4dRounding));
  const singles = order.map((cause) => {
    const s = cloneState(initial);
    applyCause(cause, s, ctx);
    return itemValues(matches, s, options.t4dRounding);
  });

  // 既存の値（項目ごと）
  const baselineByKey = new Map<string, number>();
  const rowsByKey = new Map<string, BaselineRow[]>();
  for (const row of rows) {
    const key = itemKey(row.unitId!, row.scope, rowLevel(row) === 'scope' ? '' : subKeyOfRow(row));
    baselineByKey.set(key, (baselineByKey.get(key) ?? 0) + baselineTonnes(row));
    rowsByKey.set(key, [...(rowsByKey.get(key) ?? []), row]);
  }
  // 既存・T4D の側にある「区分を除いた鍵」（片側だけかの判定）
  const baselineSubKeys = new Set(
    rows.map((r) => `${r.unitId}|${rowLevel(r) === 'scope' ? `scope:${r.scope}` : subKeyOfRow(r)}`),
  );
  const t4dSubKeys = new Set(
    [...matches.values()].map(
      (m) => `${m.line.unitId}|${m.subKey === '' ? `scope:${m.line.reportedScope}` : m.subKey}`,
    ),
  );

  const keys = new Set<string>();
  for (const v of values) for (const k of v.keys()) keys.add(k);
  for (const v of singles) for (const k of v.keys()) keys.add(k);
  for (const k of baselineByKey.keys()) keys.add(k);

  const items: ReconciliationItem[] = [];
  for (const key of [...keys].sort()) {
    const [unitId, scope, ...rest] = key.split('|') as [string, GhgScope, ...string[]];
    const subKey = rest.join('|');
    const get = (m: Map<string, number>) => m.get(key) ?? 0;
    const r0 = get(values[0]!);
    const baseline = cleanFloat(baselineByKey.get(key) ?? 0);
    const steps: AttributionStep[] = [];
    const rowsOfItem = rowsByKey.get(key) ?? [];
    const linesOfItem = [...matches.values()].filter((m) => {
      const k0 = itemKey(m.line.unitId, m.line.reportedScope, m.subKey);
      const kb = m.baselineScope ? itemKey(m.line.unitId, m.baselineScope, m.subKey) : null;
      return k0 === key || kb === key;
    });
    order.forEach((cause, i) => {
      const delta = cleanFloat(get(values[i + 1]!) - get(values[i]!));
      steps.push({
        cause,
        delta: Math.abs(delta) <= EPSILON ? 0 : delta,
        applicable: causeApplicable(cause, key, rowsOfItem, linesOfItem, ctx),
      });
    });
    const rn = get(values[values.length - 1]!);
    const residualRaw = cleanFloat(baseline - rn);
    const residual = Math.abs(residualRaw) <= EPSILON ? 0 : residualRaw;
    const single = order.map((cause, i) => {
      const d = cleanFloat(get(singles[i]!) - r0);
      return { cause, delta: Math.abs(d) <= EPSILON ? 0 : d };
    });
    const subForSided = subKey === '' ? `scope:${scope}` : subKey;
    const inBaseline = baselineSubKeys.has(`${unitId}|${subForSided}`);
    const inT4d = t4dSubKeys.has(`${unitId}|${subForSided}`);
    const oneSided: ReconciliationItem['oneSided'] = !inBaseline
      ? 't4d_only'
      : !inT4d
        ? 'baseline_only'
        : null;
    const diffRaw = cleanFloat(baseline - r0);
    const diff = Math.abs(diffRaw) <= EPSILON ? 0 : diffRaw;
    const parts = subKey.split('|');
    const [kind, code] = (parts[0] ?? '').split(':') as [GhgActivityKind | '', string | undefined];
    const top = steps.reduce<AttributionStep | null>(
      (best, s) => (Math.abs(s.delta) > (best ? Math.abs(best.delta) : 0) ? s : best),
      null,
    );
    const mainCause = top && Math.abs(top.delta) > Math.abs(residual) ? top.cause : null;
    items.push({
      key,
      unitId,
      scope,
      activityKind: kind === '' ? null : kind,
      activityCode: code ?? null,
      month: parts.length >= 2 && parts[1] ? parts[1] : null,
      shipmentRef: parts.length >= 3 && parts[2] ? parts[2] : null,
      t4d: oneSided === 'baseline_only' ? null : r0,
      baseline: oneSided === 't4d_only' ? null : baseline,
      diff,
      diffPct: r0 !== 0 ? cleanFloat((diff / r0) * 100) : null,
      steps,
      single,
      residual,
      oneSided,
      withinTolerance: oneSided === null && withinTolerance(scope, r0, diff, options.tolerance),
      mainCause,
    });
  }

  const totals = new Map<GhgScope, { t4d: number; baseline: number; diff: number }>();
  for (const item of items) {
    const t = totals.get(item.scope) ?? { t4d: 0, baseline: 0, diff: 0 };
    t.t4d = cleanFloat(t.t4d + (item.t4d ?? 0));
    t.baseline = cleanFloat(t.baseline + (item.baseline ?? 0));
    t.diff = cleanFloat(t.diff + item.diff);
    totals.set(item.scope, t);
  }
  return {
    items,
    totals: [...totals.entries()].map(([scope, t]) => ({ scope, ...t })),
  };
}

/**
 * 項目の判定（確認の記録を反映する）。人が原因を記録した項目は「原因を確認済み」。記録は最新のもの
 * （差し替えられた記録は数えない）
 */
export function itemVerdict(
  item: Pick<
    ReconciliationItem,
    'key' | 'withinTolerance' | 'oneSided' | 'mainCause' | 'residual' | 'diff'
  >,
  notes: readonly Pick<GhgReconciliationNote, 'id' | 'itemKey' | 'supersedesId'>[],
): GhgReconVerdict {
  const superseded = new Set(notes.map((n) => n.supersedesId).filter(Boolean));
  if (notes.some((n) => n.itemKey === item.key && !superseded.has(n.id))) return 'cause_confirmed';
  if (item.oneSided) return 'one_sided';
  if (item.withinTolerance) return 'within_tolerance';
  if (item.mainCause === null && Math.abs(item.residual) > EPSILON) return 'unexplained';
  return 'needs_review';
}

/** 項目の表示名（拠点名は呼び出し側で引く） */
export function itemSubjectLabel(item: Pick<ReconciliationItem, 'month' | 'shipmentRef'>): string {
  const parts: string[] = [];
  if (item.month) parts.push(item.month.slice(0, 7));
  if (item.shipmentRef) parts.push(`出荷 ${item.shipmentRef}`);
  return parts.join('・');
}

/** T4D の算定行を照合の入力に変える（出荷番号は活動量の行から写す） */
export function attributionLinesFrom(
  lines: readonly GhgCalculationLine[],
  shipmentRefOf: (activityLineId: string) => string | null,
): AttributionLine[] {
  return lines.map((l) => ({
    id: l.id,
    unitId: l.unitId,
    month: l.month,
    activityKind: l.activityKind,
    activityCode: l.activityCode,
    reportedScope: l.reportedScope,
    method: l.method,
    activityAmount: l.activityAmount,
    activityUnit: l.activityUnit,
    convertedAmount: l.convertedAmount,
    convertedUnit: l.convertedUnit,
    emissionsUnrounded: l.emissionsUnrounded,
    methodDetail: l.methodDetail,
    shipmentRef: shipmentRefOf(l.activityLineId),
  }));
}

/**
 * 記録した照合の結果を作り直す（記録の算定行・既存結果の行・記録の許容差と原因の順序から同じ純関数で）。
 * 照合の規則の版が違えば null。Demo Mode の Cookie からの戻しと、Supabase Mode の記録の照合（利用者の JWT で
 * 書かれた結果を信じない）が同じ関数を使う。形の壊れた許容差・順序（書き換えられた行）でも例外にせず null
 */
export function rebuildReconciliationResult(
  recon: Pick<GhgReconciliation, 'tolerance' | 'attributionOrder' | 'checkerVersion'>,
  lines: readonly GhgCalculationLine[],
  activityLines: ReadonlyArray<Pick<GhgActivityLine, 'id' | 'shipmentRef'>>,
  baselineRows: readonly BaselineRow[],
  rounding: readonly RoundingRule[],
): GhgReconciliationResult | null {
  if (recon.checkerVersion !== RECONCILIATION_CHECKER_VERSION) return null;
  const known = new Set<string>(DEFAULT_ATTRIBUTION_ORDER);
  if (
    !Array.isArray(recon.attributionOrder) ||
    !recon.attributionOrder.every((c) => known.has(c)) ||
    !recon.tolerance ||
    typeof recon.tolerance !== 'object'
  ) {
    return null;
  }
  const shipmentOf = new Map(activityLines.map((l) => [l.id, l.shipmentRef]));
  try {
    return attribute(
      attributionLinesFrom(lines, (id) => shipmentOf.get(id) ?? null),
      baselineRows,
      {
        t4dRounding: rounding,
        tolerance: recon.tolerance,
        order: recon.attributionOrder,
      },
    );
  } catch {
    return null;
  }
}
