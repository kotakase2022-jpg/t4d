import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan, NotFoundError } from '@/lib/authorization/can';
import { fid } from '@/lib/fixtures/ids';
import type { DbClient } from '@/lib/repositories/types';
import type {
  ApplicabilityResult,
  AuthorizationContext,
  DisclosureItem,
  DisclosureItemCondition,
  DisclosureResponse,
  FrameworkKey,
  ReportingPeriod,
  Uuid,
} from '@/types/domain';

/**
 * 企業別の適用質問判定（CDP-P0-002）。
 *
 * 質問に付いた適用条件（`disclosure_item_conditions`）を、その企業の回答に対して評価し、
 * 適用 / 非適用 / 要確認 と**判定根拠**を `applicability_results` に保存する。
 *
 * 判定は**規則ベース**にしている。AI に判定させると根拠が再現しないため、
 * 「なぜ非適用なのか」を監査法人へ説明できなくなる（`docs/ai-safety.md`）。
 */

export type Applicability = ApplicabilityResult['applicability'];

export interface ApplicabilityDecision {
  itemId: Uuid;
  itemCode: string;
  applicability: Applicability;
  reason: string;
}

export interface EvaluateApplicabilityResult {
  decisions: ApplicabilityDecision[];
  counts: Record<Applicability, number>;
}

/** 条件 1 件を、依存先の回答に対して評価する。 */
export function evaluateCondition(
  condition: DisclosureItemCondition,
  dependsOnResponse: DisclosureResponse | null,
): { satisfied: boolean | null; reason: string } {
  const dep = condition.dependsOnItemCode;

  // 依存先が未回答なら判定できない（＝要確認）
  const answered =
    dependsOnResponse &&
    dependsOnResponse.status !== 'not_started' &&
    (dependsOnResponse.answerText !== null ||
      dependsOnResponse.answerNumeric !== null ||
      dependsOnResponse.answerChoice.length > 0);
  if (!answered) {
    return { satisfied: null, reason: `${dep} が未回答のため判定できません。` };
  }

  const answers = [
    ...(dependsOnResponse.answerText ? [dependsOnResponse.answerText.trim()] : []),
    ...dependsOnResponse.answerChoice.map((c) => c.trim()),
    ...(dependsOnResponse.answerNumeric !== null ? [String(dependsOnResponse.answerNumeric)] : []),
  ];

  switch (condition.operator) {
    case 'equals': {
      const ok = answers.some((a) => a === condition.value);
      return {
        satisfied: ok,
        reason: ok
          ? `${dep} が「${condition.value}」であるため適用されます。`
          : `${dep} が「${condition.value}」ではないため適用されません。`,
      };
    }
    case 'not_equals': {
      const ok = !answers.some((a) => a === condition.value);
      return {
        satisfied: ok,
        reason: ok
          ? `${dep} が「${condition.value}」以外であるため適用されます。`
          : `${dep} が「${condition.value}」であるため適用されません。`,
      };
    }
    case 'in': {
      const allowed = condition.value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      const ok = answers.some((a) => allowed.includes(a));
      return {
        satisfied: ok,
        reason: ok
          ? `${dep} の回答が対象（${allowed.join('・')}）に含まれるため適用されます。`
          : `${dep} の回答が対象（${allowed.join('・')}）に含まれないため適用されません。`,
      };
    }
    case 'exists': {
      // 依存先に回答がある＝その領域を算定・実施している
      return { satisfied: true, reason: `${dep} に回答があるため適用されます。` };
    }
  }
}

export async function evaluateApplicability(
  db: DbClient,
  ctx: AuthorizationContext,
  frameworkKey: FrameworkKey,
  period: ReportingPeriod,
): Promise<EvaluateApplicabilityResult> {
  assertCan(ctx, 'enterprise.disclosure.write');
  const organizationId = ctx.workspace.organizationId;

  if (period.organizationId !== organizationId) {
    throw new NotFoundError('報告期間が見つかりません。');
  }

  const items = await loadFrameworkItems(db, frameworkKey);
  if (items.length === 0) throw new NotFoundError('開示フレームワークが見つかりません。');

  const responses = await db.select('disclosureResponses', {
    where: { organizationId, reportingPeriodId: period.id },
  });
  const responseByItemId = new Map(responses.map((r) => [r.itemId, r]));
  const itemIdByCode = new Map(items.map((i) => [i.code, i.id]));

  const conditions = await db.select('itemConditions', {
    where: { itemId: { in: items.map((i) => i.id) } },
  });
  const conditionsByItem = new Map<string, DisclosureItemCondition[]>();
  for (const c of conditions) {
    const list = conditionsByItem.get(c.itemId) ?? [];
    list.push(c);
    conditionsByItem.set(c.itemId, list);
  }

  const now = new Date().toISOString();
  const decisions: ApplicabilityDecision[] = [];
  const counts: Record<Applicability, number> = {
    applicable: 0,
    not_applicable: 0,
    needs_check: 0,
  };

  for (const item of items) {
    const itemConditions = conditionsByItem.get(item.id) ?? [];
    let applicability: Applicability;
    let reason: string;

    if (itemConditions.length === 0) {
      applicability = 'applicable';
      reason = '適用条件が設定されていないため、すべての企業に適用されます。';
    } else {
      const evaluated = itemConditions.map((c) => {
        const depItemId = itemIdByCode.get(c.dependsOnItemCode);
        const depResponse = depItemId ? (responseByItemId.get(depItemId) ?? null) : null;
        return evaluateCondition(c, depResponse);
      });

      if (evaluated.some((e) => e.satisfied === false)) {
        // 1 つでも満たさない条件があれば非適用（条件は AND で評価する）
        applicability = 'not_applicable';
        reason = evaluated.find((e) => e.satisfied === false)!.reason;
      } else if (evaluated.some((e) => e.satisfied === null)) {
        applicability = 'needs_check';
        reason = evaluated.find((e) => e.satisfied === null)!.reason;
      } else {
        applicability = 'applicable';
        reason = evaluated.map((e) => e.reason).join(' ');
      }
    }

    counts[applicability] += 1;
    decisions.push({ itemId: item.id, itemCode: item.code, applicability, reason });

    // (organization_id, item_id, reporting_period_id) で一意。既存があれば更新する
    const existing = await db.select('applicabilityResults', {
      where: { organizationId, itemId: item.id, reportingPeriodId: period.id },
      limit: 1,
    });
    if (existing[0]) {
      await db.update('applicabilityResults', existing[0].id, {
        applicability,
        reason,
        evaluatedAt: now,
      });
    } else {
      await db.insert('applicabilityResults', [
        {
          id: fid('applicability_result', `${organizationId}/${item.id}/${period.id}`),
          organizationId,
          itemId: item.id,
          reportingPeriodId: period.id,
          applicability,
          reason,
          evaluatedAt: now,
        },
      ]);
    }
  }

  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'applicability_result',
    resourceId: period.id,
    afterSummary:
      `適用判定を実行: 適用 ${counts.applicable} / ` +
      `非適用 ${counts.not_applicable} / 要確認 ${counts.needs_check}`,
  });

  return { decisions, counts };
}

/** 保存済みの適用判定を itemId で引けるかたちで読み出す。 */
export async function loadApplicability(
  db: DbClient,
  ctx: AuthorizationContext,
  periodId: Uuid,
): Promise<Map<string, ApplicabilityResult>> {
  const results = await db.select('applicabilityResults', {
    where: { organizationId: ctx.workspace.organizationId, reportingPeriodId: periodId },
  });
  return new Map(results.map((r) => [r.itemId, r]));
}

async function loadFrameworkItems(
  db: DbClient,
  frameworkKey: FrameworkKey,
): Promise<DisclosureItem[]> {
  const frameworks = await db.select('frameworks', { where: { key: frameworkKey }, limit: 1 });
  const framework = frameworks[0];
  if (!framework) return [];
  const versions = await db.select('frameworkVersions', {
    where: { frameworkId: framework.id, status: 'published' },
    orderBy: { column: 'year', dir: 'desc' },
    limit: 1,
  });
  const version = versions[0];
  if (!version) return [];
  return db.select('disclosureItems', {
    where: { frameworkVersionId: version.id },
    orderBy: { column: 'sortOrder' },
  });
}
