import { GHG_SCOPE_LABELS } from '@/lib/domain/ghg/calculate';
import { cleanFloat } from '@/lib/domain/ghg/rounding';
import type { GhgSiteStatus } from '@/lib/domain/ghg/verification-status';
import { formatNumber } from '@/lib/format/datetime';
import type { StatusSemantic } from '@/lib/ui/status/registry';
import {
  ROUNDING_STAGES,
  type GhgRunSummary,
  type GhgScope,
  type OrganizationUnit,
  type RoundingMethod,
  type RoundingRule,
  type RoundingStage,
  type Uuid,
} from '@/types/domain';

/**
 * Scope1・2 の算定の結果の見せ方（P90 概要・P96 算定明細・GHG サマリー・算定明細 CSV で同じ規則）。純関数。
 *
 *  - 値は算定方針の丸めの段の値をそのまま出す（表示で丸め直さない。桁はその段までに効いた規則の桁）
 *  - 未丸めの値は桁を落とさずに出す（小数 10 桁まで）
 *  - 報告区分（組織の算定ルール）と既定区分（GHG プロトコル）を並べ、Scope2 の 2 基準は足さない（plan K7）
 *  - 値の無い区分は null（「—」。0 と書かない＝排出ゼロと未算定を混ぜない）
 */

/**
 * 未丸めの値を出す桁。値は 2 進の誤差を落とした有効 15 桁（cleanFloat）にしてから出すので、小数 15 桁まで出せば
 * 桁を落とさない（0.30000000000000004 のような誤差の桁は出さない）
 */
export const UNROUNDED_FRACTION = 15;

export const ROUNDING_METHOD_LABELS: Readonly<Record<RoundingMethod, string>> = {
  half_up: '四捨五入',
  half_even: '偶数丸め',
  floor: '切り下げ（小さい側）',
  ceil: '切り上げ（大きい側）',
  truncate: '切り捨て（0 の側）',
};

export const ROUNDING_STAGE_LABELS: Readonly<Record<RoundingStage, string>> = {
  line: '行',
  month: '月',
  site_activity: '拠点×活動',
  site_scope: '拠点×区分',
  total: '合計',
};

/** その段までに効いた丸めの規則（段に規則が無ければ前の段の規則。どの段にも無ければ null＝未丸め） */
export function effectiveRoundingRule(
  rules: readonly RoundingRule[],
  stage: RoundingStage,
): RoundingRule | null {
  const index = ROUNDING_STAGES.indexOf(stage);
  for (let i = index; i >= 0; i -= 1) {
    const rule = rules.find((r) => r.stage === ROUNDING_STAGES[i]);
    if (rule) return rule;
  }
  return null;
}

/** 規則の桁を t の小数の桁へ（kg の小数 d 桁は t の小数 d+3 桁） */
export function digitsInTonnes(rule: Pick<RoundingRule, 'digits' | 'unit'>): number {
  return Math.max(0, rule.unit === 'kg' ? rule.digits + 3 : rule.digits);
}

/** 丸めの規則の文（例「t・小数 1 桁・四捨五入」「kg・整数・切り捨て（0 の側）」） */
export function roundingRuleText(rule: Pick<RoundingRule, 'digits' | 'unit' | 'method'>): string {
  const digits = rule.digits === 0 ? '整数' : `小数 ${rule.digits} 桁`;
  return `${rule.unit}・${digits}・${ROUNDING_METHOD_LABELS[rule.method]}`;
}

/** 算定方針の丸めの段の一覧（例「拠点×活動: t・小数 3 桁・四捨五入 ／ 拠点×区分: t・小数 1 桁・四捨五入」） */
export function roundingPolicyText(rules: readonly RoundingRule[]): string {
  const parts = ROUNDING_STAGES.flatMap((stage) => {
    const rule = rules.find((r) => r.stage === stage);
    return rule ? [`${ROUNDING_STAGE_LABELS[stage]}: ${roundingRuleText(rule)}`] : [];
  });
  return parts.length > 0 ? parts.join(' ／ ') : '丸めの段なし（未丸めの値）';
}

export function formatUnrounded(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return formatNumber(value);
  return formatNumber(cleanFloat(value), { fraction: UNROUNDED_FRACTION });
}

/** 段の値の表示（その段までに効いた規則の桁で、末尾の 0 も出す。規則が無ければ未丸めの桁） */
export function formatStageValue(
  value: number | null | undefined,
  rules: readonly RoundingRule[],
  stage: RoundingStage,
): string {
  const rule = effectiveRoundingRule(rules, stage);
  if (!rule) return formatUnrounded(value);
  const digits = digitsInTonnes(rule);
  return formatNumber(value, { fraction: digits, minimumFraction: digits });
}

// ----------------------------------------------------------------------
// 報告区分と既定区分（二重表示）
// ----------------------------------------------------------------------

export type DualViewRowKey = GhgScope | 'scope1_scope3_total';

export interface DualViewRow {
  key: DualViewRowKey;
  label: string;
  /** 報告区分（組織の算定ルール）の値（合計の段の丸め後）。値が無ければ null */
  reported: number | null;
  /** 既定区分（GHG プロトコル。参考）の値 */
  protocol: number | null;
  /** 報告 − 既定（丸め後の値の差。再分類で移った分）。どちらも無ければ null */
  difference: number | null;
  /** 未丸めの差（再分類は移動だけなので、Scope1＋Scope3 の計では 0） */
  unroundedDifference: number | null;
}

function totalOf(
  summary: GhgRunSummary,
  view: 'reported' | 'protocol',
  scope: GhgScope,
): { rounded: number; unrounded: number } | null {
  const row = summary[view].totals.find((t) => t.scope === scope);
  return row ? { rounded: row.rounded, unrounded: row.unrounded } : null;
}

function sumOf(
  values: ReadonlyArray<{ rounded: number; unrounded: number } | null>,
): { rounded: number; unrounded: number } | null {
  const present = values.filter((v): v is { rounded: number; unrounded: number } => v !== null);
  if (present.length === 0) return null;
  return {
    rounded: cleanFloat(present.reduce((s, v) => s + v.rounded, 0)),
    unrounded: cleanFloat(present.reduce((s, v) => s + v.unrounded, 0)),
  };
}

function diff(
  a: { rounded: number; unrounded: number } | null,
  b: { rounded: number; unrounded: number } | null,
): { rounded: number | null; unrounded: number | null } {
  if (!a && !b) return { rounded: null, unrounded: null };
  return {
    rounded: cleanFloat((a?.rounded ?? 0) - (b?.rounded ?? 0)),
    unrounded: cleanFloat((a?.unrounded ?? 0) - (b?.unrounded ?? 0)),
  };
}

export const DUAL_VIEW_ROW_LABELS: Readonly<Record<DualViewRowKey, string>> = {
  scope1: GHG_SCOPE_LABELS.scope1,
  scope3_cat4: GHG_SCOPE_LABELS.scope3_cat4,
  scope1_scope3_total: 'Scope1＋Scope3 カテゴリ4 の計',
  scope2_location: GHG_SCOPE_LABELS.scope2_location,
  scope2: GHG_SCOPE_LABELS.scope2,
};

/**
 * 二重表示の行: Scope1・Scope3 カテゴリ4・その計（再分類は移動だけで計は変わらない）・Scope2 の 2 基準（別々。足さない）
 */
export function dualViewRows(summary: GhgRunSummary): DualViewRow[] {
  const row = (key: GhgScope): DualViewRow => {
    const reported = totalOf(summary, 'reported', key);
    const protocol = totalOf(summary, 'protocol', key);
    const d = diff(reported, protocol);
    return {
      key,
      label: DUAL_VIEW_ROW_LABELS[key],
      reported: reported?.rounded ?? null,
      protocol: protocol?.rounded ?? null,
      difference: d.rounded,
      unroundedDifference: d.unrounded,
    };
  };
  const reportedTotal = sumOf([
    totalOf(summary, 'reported', 'scope1'),
    totalOf(summary, 'reported', 'scope3_cat4'),
  ]);
  const protocolTotal = sumOf([
    totalOf(summary, 'protocol', 'scope1'),
    totalOf(summary, 'protocol', 'scope3_cat4'),
  ]);
  const totalDiff = diff(reportedTotal, protocolTotal);
  return [
    row('scope1'),
    row('scope3_cat4'),
    {
      key: 'scope1_scope3_total',
      label: DUAL_VIEW_ROW_LABELS.scope1_scope3_total,
      reported: reportedTotal?.rounded ?? null,
      protocol: protocolTotal?.rounded ?? null,
      difference: totalDiff.rounded,
      unroundedDifference: totalDiff.unrounded,
    },
    row('scope2_location'),
    row('scope2'),
  ];
}

/** 規則ごとの再分類（未丸めの合計・拠点の数） */
export interface ReclassifiedByRule {
  ruleId: Uuid;
  from: GhgScope;
  to: GhgScope;
  unrounded: number;
  unitIds: Uuid[];
}

export function reclassifiedByRule(summary: GhgRunSummary): ReclassifiedByRule[] {
  const map = new Map<string, ReclassifiedByRule>();
  for (const r of summary.reclassified) {
    const key = `${r.ruleId}|${r.from}|${r.to}`;
    const entry = map.get(key) ?? {
      ruleId: r.ruleId,
      from: r.from,
      to: r.to,
      unrounded: 0,
      unitIds: [],
    };
    entry.unrounded = cleanFloat(entry.unrounded + r.unrounded);
    if (!entry.unitIds.includes(r.unitId)) entry.unitIds.push(r.unitId);
    map.set(key, entry);
  }
  return [...map.values()];
}

// ----------------------------------------------------------------------
// 拠点別の結果
// ----------------------------------------------------------------------

export interface SiteResultRow {
  unitId: Uuid;
  unitName: string;
  unitCode: string;
  countryCode: string;
  /** 組織の国と同じか（国内・海外の別。改良トンキロ法は国内の方法） */
  domestic: boolean;
  /** 報告区分の Scope1（拠点×区分の段の丸め後） */
  scope1: number | null;
  /** うち再分類分（報告区分の Scope1 − 既定区分の Scope1。再分類が無い拠点は null） */
  reclassifiedToScope1: number | null;
  scope2Location: number | null;
  scope2Market: number | null;
  /** 既定区分の Scope3 カテゴリ4（参考） */
  scope3Cat4Protocol: number | null;
  /** 警告の付いた算定行の数 */
  warningLines: number;
  status: GhgSiteStatus | null;
}

function siteValue(
  summary: GhgRunSummary,
  view: 'reported' | 'protocol',
  unitId: Uuid,
  scope: GhgScope,
): number | null {
  return summary[view].sites.find((s) => s.unitId === unitId && s.scope === scope)?.rounded ?? null;
}

/**
 * 拠点別の結果の行（拠点の並びは渡した順）。summary が無い（記録が無い・入力が変わった）拠点は値を null
 */
export function siteResultRows(
  summary: GhgRunSummary | null,
  units: ReadonlyArray<Pick<OrganizationUnit, 'id' | 'name' | 'code' | 'countryCode'>>,
  options: {
    organizationCountryCode: string;
    statuses?: ReadonlyMap<Uuid, GhgSiteStatus>;
  },
): SiteResultRow[] {
  return units.map((unit) => {
    const reported1 = summary ? siteValue(summary, 'reported', unit.id, 'scope1') : null;
    const protocol1 = summary ? siteValue(summary, 'protocol', unit.id, 'scope1') : null;
    const moved =
      summary?.reclassified.some((r) => r.unitId === unit.id && r.to === 'scope1') ?? false;
    return {
      unitId: unit.id,
      unitName: unit.name,
      unitCode: unit.code,
      countryCode: unit.countryCode,
      domestic: unit.countryCode === options.organizationCountryCode,
      scope1: reported1,
      reclassifiedToScope1: moved ? cleanFloat((reported1 ?? 0) - (protocol1 ?? 0)) : null,
      scope2Location: summary ? siteValue(summary, 'reported', unit.id, 'scope2_location') : null,
      scope2Market: summary ? siteValue(summary, 'reported', unit.id, 'scope2') : null,
      scope3Cat4Protocol: summary ? siteValue(summary, 'protocol', unit.id, 'scope3_cat4') : null,
      warningLines: summary?.warningCounts[unit.id] ?? 0,
      status: options.statuses?.get(unit.id) ?? null,
    };
  });
}

// ----------------------------------------------------------------------
// 算定の記録の入力の状態
// ----------------------------------------------------------------------

export type RunInputStateKey = 'current' | 'stale' | 'input_changed';

/**
 * 記録の入力の状態の語（登録簿に無い、画面で計算した状態。SemanticBadge で色＋アイコン＋語）。
 * input_changed は Demo の作り直しで入力ハッシュが合わなかった記録（数値を出さない。plan K11）
 */
export const RUN_INPUT_STATE_VIEW: Readonly<
  Record<RunInputStateKey, { label: string; semantic: StatusSemantic; detail: string }>
> = {
  current: {
    label: '最新の入力',
    semantic: 'done',
    detail: 'いまの係数・算定ルール・活動量で算定した記録です。',
  },
  stale: {
    label: '入力が変わった',
    semantic: 'returned',
    detail: 'この記録の後に入力（係数・算定ルール・活動量）が変わりました。再算定が必要です。',
  },
  input_changed: {
    label: '入力が変わった（数値を表示できません）',
    semantic: 'blocked',
    detail: '記録した入力で作り直せないため、数値を表示しません。算定をやり直してください。',
  },
};
