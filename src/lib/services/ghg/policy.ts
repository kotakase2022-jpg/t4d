import 'server-only';

import { randomUUID } from 'node:crypto';
import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, assertEnterpriseWorkspace, NotFoundError } from '@/lib/authorization/can';
import { canonicalJson } from '@/lib/domain/disclosure-block';
import { parseUnit } from '@/lib/domain/ghg/units';
import { ValidationError } from '@/lib/errors/user-facing';
import { DEMO_GHG_LIMITS } from '@/lib/repositories/demo-ghg-checks';
import type { DbClient } from '@/lib/repositories/types';
import {
  ROUNDING_METHODS,
  ROUNDING_STAGES,
  type AuthorizationContext,
  type GhgCalculationPolicy,
  type ReportingPeriod,
  type RoundingMethod,
  type RoundingRule,
  type RoundingStage,
  type TonKmPolicy,
  type UnitConversionRule,
  type Uuid,
} from '@/types/domain';

/**
 * 算定方針（plan §2.3 policy.ts・CR-03・CR-04・CR-06 の組織の設定。S1）。
 *
 * 期間ごとに版を積む（追記専用。DB は forbid_mutation）。丸め（段ごとに 桁・kg/t・方式）、組織の単位換算
 * （次元をまたぐ換算だけ。例 m3→Nm3 の温度・圧力補正）、改良トンキロ法の組織の設定を持つ。
 *
 * 既定値（期間に方針がまだ無いとき、画面の入力の初期値）:
 *  - 式の形は告示の形・積載率の下限 10%・原単位は有効数字 3 桁（ガイドラインの記載。research-tonkm.md §2.4・§2.8）
 *  - 公的資料で扱いを確認できなかった項目は組織が決める。既定は止めるか警告（黙って計算しない。plan K5）:
 *    積載率 100% 超＝止める、最大積載量の範囲外＝警告、海外拠点＝警告。最大積載量の範囲は参考表の区分の範囲
 *    （350〜20,500kg）を初期値にする（式の適用範囲としては未確認。組織が決める）
 *  - 丸めは無し（未丸めのまま合計する。組織の丸めの段・桁・方式を入れて保存する）
 * 書けるのは enterprise.metric.manage。締めた期間は変えない。監査ログは settings_changed。
 */

export const DEFAULT_TONKM_POLICY: TonKmPolicy = {
  shape: 'kokuji',
  minLoadPct: 10,
  over100: 'error',
  payloadRangeKg: { min: 350, max: 20500 },
  payloadOutOfRange: 'warn',
  overseas: 'warn',
  intensityRounding: { significant: 3, method: 'half_up' },
};

export const ROUNDING_STAGE_LABELS: Record<RoundingStage, string> = {
  line: '行ごと',
  month: '月ごと（拠点×活動×月）',
  site_activity: '拠点×活動',
  site_scope: '拠点×区分',
  total: '合計（区分ごと）',
};

export const ROUNDING_METHOD_LABELS: Record<RoundingMethod, string> = {
  half_up: '四捨五入',
  half_even: '偶数丸め（銀行丸め）',
  floor: '切り捨て（小さい側）',
  ceil: '切り上げ（大きい側）',
  truncate: '切り捨て（0 の側）',
};

export interface PolicyDraft {
  rounding: RoundingRule[];
  conversions: UnitConversionRule[];
  tonkm: TonKmPolicy;
  notes: string;
}

export interface PolicyOverview {
  period: ReportingPeriod;
  /** 期間の最新の版（無ければ null） */
  current: GhgCalculationPolicy | null;
  /** 期間の版（新しい順） */
  versions: GhgCalculationPolicy[];
  /** 画面の入力の初期値（最新の版か既定値） */
  draft: PolicyDraft;
  /** 版を作った人の名前 */
  names: Map<Uuid, string>;
}

export function defaultPolicyDraft(): PolicyDraft {
  return {
    rounding: [],
    conversions: [],
    tonkm: {
      ...DEFAULT_TONKM_POLICY,
      payloadRangeKg: { ...DEFAULT_TONKM_POLICY.payloadRangeKg },
      intensityRounding: DEFAULT_TONKM_POLICY.intensityRounding
        ? { ...DEFAULT_TONKM_POLICY.intensityRounding }
        : null,
    },
    notes: '',
  };
}

async function loadPeriod(
  db: DbClient,
  ctx: AuthorizationContext,
  periodId: Uuid,
): Promise<ReportingPeriod> {
  const period = await db.findById('periods', periodId);
  if (!period || period.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('報告期間が見つかりません。');
  }
  return period;
}

export async function loadCalculationPolicy(
  db: DbClient,
  ctx: AuthorizationContext,
  periodId: Uuid,
): Promise<PolicyOverview> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.data.read');
  const period = await loadPeriod(db, ctx, periodId);
  const versions = (
    await db.select('ghgCalculationPolicies', {
      where: { organizationId: period.organizationId, reportingPeriodId: period.id },
    })
  ).sort((a, b) => b.versionNo - a.versionNo);
  const current = versions[0] ?? null;
  const ids = [...new Set(versions.map((v) => v.createdBy).filter((id): id is Uuid => !!id))];
  const profiles =
    ids.length > 0 ? await db.select('profiles', { where: { id: { in: ids } } }) : [];
  return {
    period,
    current,
    versions,
    draft: current
      ? {
          rounding: current.rounding,
          conversions: current.conversions,
          tonkm: current.tonkm,
          notes: current.notes,
        }
      : defaultPolicyDraft(),
    names: new Map(profiles.map((p) => [p.id, p.displayName])),
  };
}

// ----------------------------------------------------------------------
// 入力の検査（純関数に近い。DB は上限の判定にだけ使う）
// ----------------------------------------------------------------------

function validateRounding(rules: readonly RoundingRule[]): RoundingRule[] {
  const seen = new Set<RoundingStage>();
  const out: RoundingRule[] = [];
  for (const rule of rules) {
    if (!(ROUNDING_STAGES as readonly string[]).includes(rule.stage)) {
      throw new ValidationError('丸めの段を読めません。');
    }
    const stage = ROUNDING_STAGE_LABELS[rule.stage];
    if (seen.has(rule.stage)) throw new ValidationError(`丸めの段「${stage}」が 2 つあります。`);
    seen.add(rule.stage);
    if (!Number.isInteger(rule.digits) || rule.digits < 0 || rule.digits > 12) {
      throw new ValidationError(
        `丸めの段「${stage}」の桁は 0〜12 の整数です（0 は整数に丸める）。`,
      );
    }
    if (rule.unit !== 'kg' && rule.unit !== 't') {
      throw new ValidationError(`丸めの段「${stage}」の単位は kg か t です。`);
    }
    if (!(ROUNDING_METHODS as readonly string[]).includes(rule.method)) {
      throw new ValidationError(`丸めの段「${stage}」の方式を選んでください。`);
    }
    out.push({ stage: rule.stage, digits: rule.digits, unit: rule.unit, method: rule.method });
  }
  return out.sort((a, b) => ROUNDING_STAGES.indexOf(a.stage) - ROUNDING_STAGES.indexOf(b.stage));
}

function validateConversions(
  rules: readonly UnitConversionRule[],
  max: number,
): UnitConversionRule[] {
  if (rules.length > max) throw new ValidationError(`組織の単位換算は ${max} 件までです。`);
  const pairs = new Map<string, string>();
  return rules.map((rule, index) => {
    const at = `単位換算 ${index + 1} 行目`;
    const from = parseUnit(rule.from);
    const to = parseUnit(rule.to);
    if (!from) throw new ValidationError(`${at}: 換算前の単位「${rule.from}」を読めません。`);
    if (!to) throw new ValidationError(`${at}: 換算後の単位「${rule.to}」を読めません。`);
    if (from.dimension === to.dimension) {
      throw new ValidationError(
        `${at}: ${from.code} → ${to.code} は同じ種類の単位です（内蔵の換算を使います。組織の換算は m3→Nm3 のような種類をまたぐ換算だけ）。`,
      );
    }
    if (!Number.isFinite(rule.multiplier) || !(rule.multiplier > 0)) {
      throw new ValidationError(`${at}: 倍率は 0 より大きい数です。`);
    }
    const source = rule.source.trim();
    if (source === '') throw new ValidationError(`${at}: 出典（換算の根拠）を入力してください。`);
    if (source.length > 100) throw new ValidationError(`${at}: 出典は 100 文字までです。`);
    // 同じ次元の組の換算が 2 つあると、算定はどちらを使うか決められずエラーになる（先に止める）
    const pair = `${from.dimension}>${to.dimension}`;
    const other = pairs.get(pair);
    if (other) {
      throw new ValidationError(
        `${at}: ${other} と同じ種類の組の換算です（算定がどちらを使うか決まりません）。`,
      );
    }
    pairs.set(pair, `${from.code} → ${to.code}`);
    return { from: from.code, to: to.code, multiplier: rule.multiplier, source };
  });
}

function validateTonKm(policy: TonKmPolicy): TonKmPolicy {
  if (policy.shape !== 'kokuji' && policy.shape !== 'log') {
    throw new ValidationError('改良トンキロ法の式の形を選んでください。');
  }
  if (!Number.isFinite(policy.minLoadPct) || policy.minLoadPct < 0 || policy.minLoadPct > 100) {
    throw new ValidationError('積載率の下限は 0〜100 の % です。');
  }
  if (policy.over100 !== 'error' && policy.over100 !== 'cap') {
    throw new ValidationError('積載率 100% 超の扱いを選んでください。');
  }
  const { min, max } = policy.payloadRangeKg;
  for (const v of [min, max]) {
    if (v !== null && (!Number.isFinite(v) || v < 0)) {
      throw new ValidationError('最大積載量の範囲は 0 以上の kg です。');
    }
  }
  if (min !== null && max !== null && !(min < max)) {
    throw new ValidationError('最大積載量の範囲の下限は上限より小さい値です。');
  }
  if (policy.payloadOutOfRange !== 'warn' && policy.payloadOutOfRange !== 'error') {
    throw new ValidationError('最大積載量が範囲外のときの扱いを選んでください。');
  }
  if (policy.overseas !== 'warn' && policy.overseas !== 'block') {
    throw new ValidationError('海外拠点の輸送の扱いを選んでください。');
  }
  const rounding = policy.intensityRounding;
  if (rounding !== null) {
    if (
      !Number.isInteger(rounding.significant) ||
      rounding.significant < 1 ||
      rounding.significant > 10
    ) {
      throw new ValidationError('原単位の丸めの有効数字は 1〜10 桁です。');
    }
    if (!(ROUNDING_METHODS as readonly string[]).includes(rounding.method)) {
      throw new ValidationError('原単位の丸めの方式を選んでください。');
    }
  }
  return {
    shape: policy.shape,
    minLoadPct: policy.minLoadPct,
    over100: policy.over100,
    payloadRangeKg: { min, max },
    payloadOutOfRange: policy.payloadOutOfRange,
    overseas: policy.overseas,
    intensityRounding: rounding
      ? { significant: rounding.significant, method: rounding.method }
      : null,
  };
}

export interface SavePolicyInput extends PolicyDraft {
  periodId: Uuid;
  /** 画面を開いたときの最新の版（null は版が無かった）。違えば別の操作で更新されたとして断る */
  baseVersionNo: number | null;
}

/** 方針の新しい版を作る（前の版は残る） */
export async function saveCalculationPolicy(
  db: DbClient,
  ctx: AuthorizationContext,
  input: SavePolicyInput,
): Promise<GhgCalculationPolicy> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.metric.manage');
  const period = await loadPeriod(db, ctx, input.periodId);
  if (period.status === 'closed') {
    throw new ValidationError('締めた期間の算定方針は変更できません。');
  }
  const demo = db.mode === 'demo';
  const rounding = validateRounding(input.rounding);
  const conversions = validateConversions(input.conversions, demo ? 20 : 50);
  const tonkm = validateTonKm(input.tonkm);
  const notes = input.notes.trim();
  const notesMax = demo ? 300 : 2000;
  if (notes.length > notesMax) throw new ValidationError(`メモは ${notesMax} 文字までです。`);

  const versions = await db.select('ghgCalculationPolicies', {
    where: { organizationId: period.organizationId, reportingPeriodId: period.id },
  });
  const latest = versions.reduce<GhgCalculationPolicy | null>(
    (acc, v) => (acc === null || v.versionNo > acc.versionNo ? v : acc),
    null,
  );
  if ((latest?.versionNo ?? null) !== input.baseVersionNo) {
    throw new ValidationError(
      `別の操作で算定方針が更新されました（いまは版 ${latest?.versionNo ?? 'なし'}）。画面を開き直してから保存してください。`,
    );
  }
  if (
    latest &&
    canonicalJson([latest.rounding, latest.conversions, latest.tonkm, latest.notes]) ===
      canonicalJson([rounding, conversions, tonkm, notes])
  ) {
    throw new ValidationError('前の版と同じ内容です（新しい版は作りません）。');
  }
  if (demo) {
    if (versions.length >= DEMO_GHG_LIMITS.policyVersions) {
      throw new ValidationError(
        `デモでは算定方針の版は 1 つの期間に ${DEMO_GHG_LIMITS.policyVersions} つまでです。開示デモを初期状態に戻してから保存してください。`,
      );
    }
    if (JSON.stringify([rounding, conversions, tonkm]).length > DEMO_GHG_LIMITS.policyJsonChars) {
      throw new ValidationError(
        'デモでは丸め・換算・改良トンキロ法の設定が大きすぎます（換算の行を減らしてください）。',
      );
    }
  }
  const policy: GhgCalculationPolicy = {
    id: randomUUID(),
    organizationId: period.organizationId,
    reportingPeriodId: period.id,
    versionNo: (latest?.versionNo ?? 0) + 1,
    rounding,
    conversions,
    tonkm,
    notes,
    createdAt: new Date().toISOString(),
    createdBy: ctx.userId,
  };
  const [inserted] = await db.insert('ghgCalculationPolicies', [policy]);
  await recordAuditEvent(db, ctx, {
    eventType: 'settings_changed',
    resourceType: 'ghg_calculation_policy',
    resourceId: policy.id,
    beforeSummary: latest ? `版 ${latest.versionNo}` : null,
    afterSummary: `${period.label} の算定方針の版 ${policy.versionNo} を保存（丸め ${rounding.length} 段・組織の換算 ${conversions.length} 件・改良トンキロ法 ${tonkm.shape === 'kokuji' ? '告示の形' : '対数式'}）`,
    metadata: { versionNo: policy.versionNo, periodId: period.id },
  });
  return inserted ?? policy;
}
