import 'server-only';

import { can } from '@/lib/authorization/can';
import { fid } from '@/lib/fixtures/ids';
import { recomputePeriodValidations } from '@/lib/services/validation-store';
import type { DbClient } from '@/lib/repositories/types';
import type { AuthorizationContext, MetricFrameworkKey, Uuid } from '@/types/domain';

/**
 * 対応計画からデータ収集項目（指標 × 拠点 × 期間の担当・期限）を作る共通処理。
 *
 * SSBJ の createDataCollectionItem（ssbj-gap.ts）から挙動を変えずに取り出した
 * （docs/disclosure-first.md §9.4）。CSRD の対応計画からも同じ手順で作る。
 * 権限（disclosure.write ＋ metric.manage）・計画の存在・入力の検査は呼び出し側で行う。
 *
 * 指標マスターに無ければ新規作成し、`metric_assignments` に担当と期限を入れる。
 * 同じ指標 × 拠点 × 期間の割当が既にあれば作り直さない。
 */
export interface EnsureMetricAssignmentInput {
  /** 新規に作る指標の出所（SSBJ の計画は ['ssbj']、CSRD の計画は ['csrd']） */
  frameworks: MetricFrameworkKey[];
  /** 新規に作る指標の説明（例: 「SSBJ 対応計画「…」から作成したデータ項目」） */
  description: string;
  reportingPeriodId: Uuid;
  metricCode: string;
  metricName: string;
  unit: string;
  unitId: Uuid;
  ownerUserId: Uuid | null;
  dueDate: string;
  requiresEvidence: boolean;
  department: string;
}

export interface EnsureMetricAssignmentResult {
  metricId: Uuid;
  metricCode: string;
  /** 指標マスターへ新規に作ったか */
  metricCreated: boolean;
  /** 割当を新規に作ったか（既にあれば false） */
  assignmentCreated: boolean;
}

export async function ensureMetricAssignment(
  db: DbClient,
  ctx: AuthorizationContext,
  input: EnsureMetricAssignmentInput,
): Promise<EnsureMetricAssignmentResult> {
  const organizationId = ctx.workspace.organizationId;
  const code = input.metricCode.trim();
  const existing = await db.select('metrics', { where: { organizationId, code }, limit: 1 });
  const now = new Date().toISOString();

  let metricId = existing[0]?.id ?? null;
  const metricCreated = !metricId;
  if (!metricId) {
    metricId = fid('metric_definition', `${organizationId}/${code}`);
    await db.insert('metrics', [
      {
        id: metricId,
        organizationId,
        code,
        name: input.metricName.trim(),
        description: input.description,
        category: 'ghg',
        unit: input.unit.trim() || '—',
        baseUnit: input.unit.trim() || '—',
        dataType: 'number',
        aggregationMethod: 'sum',
        numeratorMetricCode: null,
        denominatorMetricCode: null,
        formula: null,
        requiresEvidence: input.requiresEvidence,
        hqOnly: false,
        // 対応計画から作られた指標なので、出所はその計画の基準
        frameworks: input.frameworks,
        materiality: 'high',
        reportingFrequency: 'annual',
        responsibleDepartment: input.department.trim() || null,
        yoyWarningRatio: null,
        minValue: null,
        maxValue: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
    ]);
  } else {
    // 指標マスターは SSBJ・CDP・CSRD の要求から作ってあるため、対応計画で
    // 集めようとする指標は既に定義済みのことが多い。同じコードで作り直すと
    // 重複してしまうので、既存の定義を使い、まだ埋まっていない運用項目だけ補う。
    const current = existing[0]!;
    const patch: Partial<typeof current> = {};
    // 担当部署は、対応計画で人が明示的に指定したものを優先する。
    // マスター側の値はカテゴリーからの初期値でしかなく、実際に誰が集めるかは
    // 計画を立てた人のほうが分かっている（例: Scope3 の輸送は物流部）
    const department = input.department.trim();
    if (department !== '' && department !== current.responsibleDepartment) {
      patch.responsibleDepartment = department;
    }
    // 根拠資料が要ると計画側で判断したなら、それを弱めない
    if (input.requiresEvidence && !current.requiresEvidence) patch.requiresEvidence = true;
    if (Object.keys(patch).length > 0) {
      await db.update('metrics', metricId, { ...patch, updatedAt: now, updatedBy: ctx.userId });
    }
    // 証跡必須にしたら、その期間の検証をやり直す。承認済みで証跡の無い行が
    // 「承認済み・要再確認」として見えるようにするため（W0 O3: 後発の証跡不足）。
    // 検証結果の書き込みは enterprise.data.write の RLS なので、権限が無ければ次のデータ更新時に回す
    if (patch.requiresEvidence && can(ctx, 'enterprise.data.write')) {
      const period = await db.findById('periods', input.reportingPeriodId);
      if (period && period.organizationId === organizationId) {
        await recomputePeriodValidations(db, ctx, period);
      }
    }
  }

  // 同じ指標 × 拠点 × 期間の割当が既にあれば作り直さない
  const assignments = await db.select('metricAssignments', {
    where: {
      organizationId,
      metricId,
      unitId: input.unitId,
      reportingPeriodId: input.reportingPeriodId,
    },
    limit: 1,
  });
  const assignmentCreated = assignments.length === 0;
  if (assignmentCreated) {
    await db.insert('metricAssignments', [
      {
        id: fid('metric_assignment', `${metricId}/${input.unitId}/${input.reportingPeriodId}`),
        organizationId,
        metricId,
        unitId: input.unitId,
        reportingPeriodId: input.reportingPeriodId,
        ownerUserId: input.ownerUserId,
        reviewerUserId: null,
        dueDate: input.dueDate,
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
    ]);
  }

  return { metricId, metricCode: code, metricCreated, assignmentCreated };
}
