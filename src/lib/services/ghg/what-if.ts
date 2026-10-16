import 'server-only';

import { assertCan, assertEnterpriseWorkspace, NotFoundError } from '@/lib/authorization/can';
import { attribute, attributionLinesFrom } from '@/lib/domain/ghg/attribution';
import type { GhgSubstitutions } from '@/lib/domain/ghg/calculate';
import { ValidationError } from '@/lib/errors/user-facing';
import type { DbClient } from '@/lib/repositories/types';
import { isUuid } from '@/lib/validation/uuid';
import type {
  AuthorizationContext,
  GhgScope,
  ReconciliationItem,
  RoundingMethod,
  RoundingRule,
  RoundingStage,
  Uuid,
} from '@/types/domain';
import { computeWhatIf } from './calculation';
import { loadReconciliation } from './reconciliation';

/**
 * 仮説の再計算（plan §2.3 what-if.ts・CR-14）。読むだけ（書き込み 0）。
 *
 * 照合した算定の記録の入力に置き換え（別の係数セット・丸めの候補・区分規則なし・式の形・換算なし）を当てて
 * 算定し直し（calculation.ts の computeWhatIf）、同じ既存の算定結果・許容差・原因の順序で照合し直して、
 * 項目ごとの差がどう変わるかを返す。既存の算定結果が合計だけの拠点でも、原因を絞り込む手掛かりになる。
 * 差が許容差内になっても原因の確定にはならない（原因は確認者が記録する。固定文 N8）。
 * 置き換えは画面が出した候補だけを受け付ける（任意の値で算定し直さない）。
 */

export const WHAT_IF_KINDS = ['set', 'rounding', 'no-rules', 'shape', 'no-conversions'] as const;
export type WhatIfKind = (typeof WHAT_IF_KINDS)[number];

export interface WhatIfAlternative {
  /** URL の ?whatif= の値 */
  key: string;
  kind: WhatIfKind;
  label: string;
  substitutions: GhgSubstitutions;
}

const STAGE_WORDS: Record<RoundingStage, string> = {
  line: '行ごと',
  month: '月ごと',
  site_activity: '拠点×活動ごと',
  site_scope: '拠点×区分ごと',
  total: '合計',
};

const METHOD_WORDS: Record<RoundingMethod, string> = {
  half_up: '四捨五入',
  half_even: '偶数丸め',
  floor: '小さい側へ',
  ceil: '大きい側へ',
  truncate: '切り捨て',
};

function roundingLabel(rule: RoundingRule): string {
  return `${STAGE_WORDS[rule.stage]}・${rule.unit}・小数 ${rule.digits} 桁・${METHOD_WORDS[rule.method]}`;
}

function roundingKey(rule: RoundingRule): string {
  return `rounding:${rule.stage}:${rule.unit}:${rule.digits}:${rule.method}`;
}

async function loadBase(db: DbClient, ctx: AuthorizationContext, reconciliationId: Uuid) {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.read');
  if (!isUuid(reconciliationId)) throw new NotFoundError('照合の記録が見つかりません。');
  const loaded = await loadReconciliation(db, ctx, reconciliationId);
  const policy = await db.findById('ghgCalculationPolicies', loaded.run.policyId);
  if (!policy) throw new NotFoundError('算定方針が見つかりません。');
  return { loaded, policy };
}

/**
 * 仮説の候補（照合の画面に出す。実行した算定と違いが出うるものだけ）:
 *  - 有効・取り下げ済みの係数のセットのうち、記録に使っていないもの
 *  - 丸め: 丸めなし、既存の算定結果の丸めの記述（読めたもの）
 *  - 区分規則なし（記録に効いた規則があるときだけ）
 *  - 改良トンキロ法の式の形の切り替え（輸送の算定行があるときだけ）
 *  - 組織の単位換算を使わない（方針に換算があるときだけ）
 */
export async function listWhatIfAlternatives(
  db: DbClient,
  ctx: AuthorizationContext,
  reconciliationId: Uuid,
): Promise<WhatIfAlternative[]> {
  return buildAlternatives(db, await loadBase(db, ctx, reconciliationId));
}

async function buildAlternatives(
  db: DbClient,
  { loaded, policy }: Awaited<ReturnType<typeof loadBase>>,
): Promise<WhatIfAlternative[]> {
  const { run, baseline } = loaded;
  const out: WhatIfAlternative[] = [];
  const sets = await db.select('emissionFactorSets', {
    where: { organizationId: run.organizationId },
    orderBy: [{ column: 'code' }],
  });
  for (const set of sets) {
    if (set.status === 'draft' || run.factorSetIds.includes(set.id)) continue;
    out.push({
      key: `set:${set.id}`,
      kind: 'set',
      label: `係数セットを「${set.name}」（${set.versionLabel}）に置き換える`,
      substitutions: { factorSetId: set.id },
    });
  }
  out.push({
    key: 'rounding:none',
    kind: 'rounding',
    label: '丸めなし（未丸めの値で比べる）',
    substitutions: { rounding: [] },
  });
  const seen = new Set<string>();
  for (const row of baseline.rows) {
    if (!row.rounding) continue;
    const rule: RoundingRule = {
      stage: row.rounding.stage,
      digits: row.rounding.digits,
      unit: row.rounding.unit,
      method: row.rounding.method,
    };
    const key = roundingKey(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      kind: 'rounding',
      label: `丸めを既存の算定結果の記述（${roundingLabel(rule)}）にする`,
      substitutions: { rounding: [rule] },
    });
  }
  if (run.ruleIds.length > 0) {
    out.push({
      key: 'no-rules',
      kind: 'no-rules',
      label: '区分規則を使わない（既定区分のまま）',
      substitutions: { noClassificationRules: true },
    });
  }
  const transportLines = await db.count('ghgCalculationLines', {
    where: { organizationId: run.organizationId, runId: run.id, method: 'tonkm_improved' },
  });
  if (transportLines > 0) {
    const shape = policy.tonkm.shape === 'log' ? 'kokuji' : 'log';
    out.push({
      key: `shape:${shape}`,
      kind: 'shape',
      label:
        shape === 'log' ? '改良トンキロ法の式を対数式にする' : '改良トンキロ法の式を告示の形にする',
      substitutions: { shape },
    });
  }
  if (policy.conversions.length > 0) {
    out.push({
      key: 'no-conversions',
      kind: 'no-conversions',
      label: '組織の単位換算を使わない（換算なし）',
      substitutions: { noConversions: true },
    });
  }
  return out;
}

export interface WhatIfItemResult {
  key: string;
  unitId: Uuid | null;
  scope: GhgScope;
  activityKind: ReconciliationItem['activityKind'];
  activityCode: string | null;
  month: string | null;
  shipmentRef: string | null;
  baseline: number | null;
  before: { t4d: number | null; diff: number; withinTolerance: boolean };
  /** 仮説で照合し直した値（仮説で項目が無くなったときは null） */
  after: { t4d: number | null; diff: number; withinTolerance: boolean } | null;
  /** 仮説で差が変わったか */
  changed: boolean;
  /** 記録では許容差の外で、仮説では許容差内になる */
  closes: boolean;
}

export interface WhatIfResult {
  alternative: Pick<WhatIfAlternative, 'key' | 'kind' | 'label'>;
  items: WhatIfItemResult[];
  /** 差が変わった項目の数・許容差内になる項目の数 */
  changedCount: number;
  closedCount: number;
  /** 区分ごとの合計（記録・仮説） */
  totals: Array<{
    scope: GhgScope;
    before: { t4d: number; diff: number };
    after: { t4d: number; diff: number } | null;
  }>;
}

/** 差を 0 とみなす幅（attribution.ts と同じ。浮動小数の誤差を変化と見なさない） */
const EPSILON = 1e-9;

/** 照合の全項目で仮説の再計算をする（保存しない） */
export async function whatIfForReconciliation(
  db: DbClient,
  ctx: AuthorizationContext,
  reconciliationId: Uuid,
  alternativeKey: string,
): Promise<WhatIfResult> {
  const base = await loadBase(db, ctx, reconciliationId);
  const alternative = (await buildAlternatives(db, base)).find((a) => a.key === alternativeKey);
  if (!alternative) {
    throw new ValidationError('仮説の候補から選んでください（この照合で選べない置き換えです）。');
  }
  const { loaded, policy } = base;
  const { reconciliation, run } = loaded;
  if (!reconciliation.result) {
    throw new ValidationError(
      'この照合は結果を作り直せないため（入力が変わった・照合の規則の版が違う）、仮説の再計算をできません。',
    );
  }
  const output = await computeWhatIf(db, ctx, run.id, alternative.substitutions);
  if (output.errors.length > 0) {
    throw new ValidationError(
      `仮説では算定できない行があります（${output.errors.length} 件。例: ${output.errors[0]!.message}）。`,
    );
  }
  const activityLines =
    run.activityBatchIds.length > 0
      ? await db.select('ghgActivityLines', {
          where: { organizationId: run.organizationId, batchId: { in: run.activityBatchIds } },
        })
      : [];
  const shipmentOf = new Map(activityLines.map((l) => [l.id, l.shipmentRef]));
  const after = attribute(
    attributionLinesFrom(output.lines, (id) => shipmentOf.get(id) ?? null),
    loaded.baseline.rows,
    {
      t4dRounding: alternative.substitutions.rounding ?? policy.rounding,
      tolerance: reconciliation.tolerance,
      order: reconciliation.attributionOrder,
    },
  );
  const afterByKey = new Map(after.items.map((i) => [i.key, i]));
  const beforeKeys = new Set(reconciliation.result.items.map((i) => i.key));
  const pick = (i: ReconciliationItem) => ({
    t4d: i.t4d,
    diff: i.diff,
    withinTolerance: i.withinTolerance,
  });
  const items: WhatIfItemResult[] = [];
  for (const before of reconciliation.result.items) {
    const next = afterByKey.get(before.key) ?? null;
    const changed =
      next === null ||
      Math.abs((next.t4d ?? 0) - (before.t4d ?? 0)) > EPSILON ||
      Math.abs(next.diff - before.diff) > EPSILON;
    items.push({
      key: before.key,
      unitId: before.unitId,
      scope: before.scope,
      activityKind: before.activityKind,
      activityCode: before.activityCode,
      month: before.month,
      shipmentRef: before.shipmentRef,
      baseline: before.baseline,
      before: pick(before),
      after: next ? pick(next) : null,
      changed,
      closes: !before.withinTolerance && next !== null && next.withinTolerance,
    });
  }
  // 仮説で新しくできた項目（区分の付け替えで鍵が変わったものなど）
  for (const next of after.items) {
    if (beforeKeys.has(next.key)) continue;
    items.push({
      key: next.key,
      unitId: next.unitId,
      scope: next.scope,
      activityKind: next.activityKind,
      activityCode: next.activityCode,
      month: next.month,
      shipmentRef: next.shipmentRef,
      baseline: next.baseline,
      before: { t4d: null, diff: 0, withinTolerance: false },
      after: pick(next),
      changed: true,
      closes: false,
    });
  }
  const scopes = new Set<GhgScope>([
    ...reconciliation.result.totals.map((t) => t.scope),
    ...after.totals.map((t) => t.scope),
  ]);
  const totals = [...scopes].map((scope) => {
    const b = reconciliation.result!.totals.find((t) => t.scope === scope);
    const a = after.totals.find((t) => t.scope === scope);
    return {
      scope,
      before: { t4d: b?.t4d ?? 0, diff: b?.diff ?? 0 },
      after: a ? { t4d: a.t4d, diff: a.diff } : null,
    };
  });
  return {
    alternative: { key: alternative.key, kind: alternative.kind, label: alternative.label },
    items,
    changedCount: items.filter((i) => i.changed).length,
    closedCount: items.filter((i) => i.closes).length,
    totals,
  };
}

/** 1 項目の仮説の再計算（保存しない）。仮説で区分が変わった項目は、同じ拠点・活動の項目も返す */
export async function whatIfForItem(
  db: DbClient,
  ctx: AuthorizationContext,
  reconciliationId: Uuid,
  itemKey: string,
  alternativeKey: string,
): Promise<{ alternative: WhatIfResult['alternative']; items: WhatIfItemResult[] }> {
  const result = await whatIfForReconciliation(db, ctx, reconciliationId, alternativeKey);
  const target = result.items.find((i) => i.key === itemKey);
  if (!target) throw new NotFoundError('照合の項目が見つかりません。');
  const subKey = (key: string) => key.split('|').slice(2).join('|');
  const related = result.items.filter(
    (i) => i.key !== itemKey && i.unitId === target.unitId && subKey(i.key) === subKey(itemKey),
  );
  return { alternative: result.alternative, items: [target, ...related] };
}
