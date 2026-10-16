'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { runPreservingAction } from '@/lib/errors/form-action';
import type { FormActionState } from '@/lib/errors/form-action-state';
import { withUserFacingError } from '@/lib/errors/user-facing';
import { getDb } from '@/lib/repositories';
import { approveRule, proposeRule, withdrawRule } from '@/lib/services/ghg/classification-rules';
import { saveCalculationPolicy } from '@/lib/services/ghg/policy';
import {
  CARRIER_KINDS,
  ROUNDING_STAGES,
  type CarrierKind,
  type RoundingMethod,
  type RoundingRule,
  type TonKmPolicy,
  type UnitConversionRule,
} from '@/types/domain';

/**
 * 算定ルールの画面（P93）の Server Actions。入力の取り出しと再検証・遷移だけを行う。
 * 権限（方針・提案は enterprise.metric.manage、承認は提案者以外の enterprise.data.approve）・入力の検査・
 * 監査ログはサービスが行う。断られたときは入力を残して理由を示す（PreservingForm）。
 */

const BASE = '/enterprise/ghg/calculation/rules';

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/** 数の欄（空は null。数でなければ NaN をそのまま渡し、サービスが理由を付けて断る） */
function numberOrNull(formData: FormData, name: string): number | null {
  const raw = field(formData, name).normalize('NFKC').trim().replace(/,/g, '');
  if (raw === '') return null;
  return Number(raw);
}

function rulesHref(periodId: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ ...(periodId ? { period: periodId } : {}), ...extra });
  const query = params.toString();
  return query ? `${BASE}?${query}` : BASE;
}

function revalidateCalculation(): void {
  revalidatePath('/enterprise/ghg/calculation', 'layout');
  revalidatePath('/enterprise/ghg');
  revalidatePath('/enterprise/trial');
}

/** 算定方針の新しい版を保存する */
export async function savePolicyAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const periodId = field(formData, 'periodId');
  let version = '';
  const failure = await runPreservingAction(formData, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const rounding: RoundingRule[] = ROUNDING_STAGES.filter(
      (stage) => field(formData, `round:${stage}`) === 'on',
    ).map((stage) => ({
      stage,
      digits: numberOrNull(formData, `round:${stage}:digits`) ?? Number.NaN,
      unit: field(formData, `round:${stage}:unit`) === 'kg' ? 'kg' : 't',
      method: field(formData, `round:${stage}:method`) as RoundingMethod,
    }));
    const count = Math.min(Number(field(formData, 'conv:count')) || 0, 50);
    const conversions: UnitConversionRule[] = [];
    for (let i = 0; i < count; i += 1) {
      const from = field(formData, `conv:${i}:from`).trim();
      const to = field(formData, `conv:${i}:to`).trim();
      const multiplier = field(formData, `conv:${i}:multiplier`).trim();
      const source = field(formData, `conv:${i}:source`).trim();
      if (from === '' && to === '' && multiplier === '' && source === '') continue;
      conversions.push({
        from,
        to,
        multiplier: numberOrNull(formData, `conv:${i}:multiplier`) ?? Number.NaN,
        source,
      });
    }
    const significant = numberOrNull(formData, 'tonkm:intensitySignificant');
    const tonkm: TonKmPolicy = {
      shape: field(formData, 'tonkm:shape') === 'log' ? 'log' : 'kokuji',
      minLoadPct: numberOrNull(formData, 'tonkm:minLoadPct') ?? Number.NaN,
      over100: field(formData, 'tonkm:over100') as TonKmPolicy['over100'],
      payloadRangeKg: {
        min: numberOrNull(formData, 'tonkm:payloadMinKg'),
        max: numberOrNull(formData, 'tonkm:payloadMaxKg'),
      },
      payloadOutOfRange: field(
        formData,
        'tonkm:payloadOutOfRange',
      ) as TonKmPolicy['payloadOutOfRange'],
      overseas: field(formData, 'tonkm:overseas') as TonKmPolicy['overseas'],
      intensityRounding:
        significant === null
          ? null
          : {
              significant,
              method: field(formData, 'tonkm:intensityMethod') as RoundingMethod,
            },
    };
    const baseText = field(formData, 'baseVersionNo');
    const saved = await saveCalculationPolicy(db, ctx, {
      periodId,
      baseVersionNo: baseText === '' ? null : Number(baseText),
      rounding,
      conversions,
      tonkm,
      notes: field(formData, 'notes'),
    });
    version = String(saved.versionNo);
  });
  if (failure) return failure;
  revalidateCalculation();
  redirect(rulesHref(periodId, { flash: 'ghgPolicySaved', version }));
}

/** 区分規則を提案する（本人名義・承認待ち） */
export async function proposeRuleAction(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const periodId = field(formData, 'periodId');
  let code = '';
  const failure = await runPreservingAction(formData, async () => {
    const ctx = await requireEnterpriseContext();
    const db = await getDb();
    const carrier = field(formData, 'carrierKind');
    const carrierKinds = (CARRIER_KINDS as readonly string[]).includes(carrier)
      ? [carrier as CarrierKind]
      : [];
    const cargoKinds = field(formData, 'cargoKinds')
      .split(/[、,，\n]/)
      .map((v) => v.trim())
      .filter((v) => v !== '');
    const unitIds = formData.getAll('unitIds').filter((v): v is string => typeof v === 'string');
    const rule = await proposeRule(db, ctx, {
      code: field(formData, 'code'),
      name: field(formData, 'name'),
      match: {
        activityKinds: ['transport'],
        carrierKinds,
        cargoKinds,
        unitIds,
      },
      reportedScope: field(formData, 'reportedScope'),
      rationale: field(formData, 'rationale'),
      disclosureNote: field(formData, 'disclosureNote'),
      effectiveFromPeriodId: field(formData, 'effectiveFromPeriodId') || null,
      effectiveToPeriodId: field(formData, 'effectiveToPeriodId') || null,
    });
    code = rule.code;
  });
  if (failure) return failure;
  revalidateCalculation();
  redirect(rulesHref(periodId, { flash: 'ghgRuleProposed', code }));
}

/** 区分規則を承認する（確認ダイアログから。提案者本人は承認できない） */
export async function approveRuleAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const periodId = field(formData, 'periodId');
  let code = '';
  await withUserFacingError(rulesHref(periodId), async () => {
    const rule = await approveRule(db, ctx, field(formData, 'ruleId'));
    code = rule.code;
  });
  revalidateCalculation();
  redirect(rulesHref(periodId, { flash: 'ghgRuleApproved', code }));
}

/** 区分規則を取り下げる（確認ダイアログから） */
export async function withdrawRuleAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const periodId = field(formData, 'periodId');
  let code = '';
  await withUserFacingError(rulesHref(periodId), async () => {
    const rule = await withdrawRule(db, ctx, field(formData, 'ruleId'), {
      reason: field(formData, 'reason'),
    });
    code = rule.code;
  });
  revalidateCalculation();
  redirect(rulesHref(periodId, { flash: 'ghgRuleWithdrawn', code }));
}
