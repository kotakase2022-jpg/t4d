import 'server-only';

import { runAi } from '@/lib/ai';
import type { AnomalyExplanationOutput } from '@/lib/ai/schemas';
import { assertCan, NotFoundError } from '@/lib/authorization/can';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AiRun,
  AiSourceReference,
  AuthorizationContext,
  DataPoint,
  Uuid,
} from '@/types/domain';

/**
 * 異常値の説明（AI-P1）。
 *
 * 検証（Validation）で出た指摘に対して、**考えられる原因と次の一手**を AI に述べさせる。
 * AI は指摘を出すだけで、値の修正も検証結果の解消も行わない（`docs/ai-safety.md`）。
 * 結果は `ai_runs.output_json` に残るので、同じ画面で読み直せる。
 *
 * 画面から実行できないと、`AiFeature` に定義だけあって誰も使えない機能になる。
 */

export type AnomalyFinding = AnomalyExplanationOutput['findings'][number];

export interface AnomalyExplanationResult {
  run: AiRun;
  findings: AnomalyFinding[];
}

export async function explainDataPointAnomalies(
  db: DbClient,
  ctx: AuthorizationContext,
  dataPointId: Uuid,
): Promise<AnomalyExplanationResult> {
  assertCan(ctx, 'enterprise.ai.run');

  const dataPoint = await db.findById('dataPoints', dataPointId);
  // 他組織の Data Point を ID 指定で説明させられないようにする
  if (!dataPoint || dataPoint.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('Data Point が見つかりません。');
  }

  const results = await db.select('validations', { where: { dataPointId } });
  const open = results.filter((r) => r.resolvedAt === null);
  if (open.length === 0) {
    throw new Error('説明が必要な検証結果がありません。');
  }

  const [metric, unit] = await Promise.all([
    db.findById('metrics', dataPoint.metricId),
    db.findById('units', dataPoint.unitId),
  ]);

  const sources: AiSourceReference[] = [
    {
      kind: 'data_point',
      id: dataPoint.id,
      label: `${metric?.name ?? '指標'} / ${unit?.name ?? '組織'}`,
      locator: null,
      periodLabel: null,
    },
  ];

  const { run, output } = await runAi({
    db,
    ctx,
    // 二重送信は 1 実行へ合流させる
    idempotencyKey: `anomalyExplanation:${dataPointId}:${open.map((r) => r.id).join(',')}`,
    sources,
    invocation: {
      feature: 'anomalyExplanation',
      context: {
        organizationName: ctx.workspace.organizationName,
        reportingPeriodLabel: '',
      },
      inputReferenceIds: [dataPointId],
      input: {
        anomalies: open.map((result) => ({
          dataPointId,
          ruleKey: result.ruleKey,
          severity: result.severity,
          message: result.message,
          value: dataPoint.value,
          unitOfMeasure: dataPoint.unitOfMeasure,
          metricName: metric?.name ?? '',
          unitName: unit?.name ?? '',
        })),
      },
    },
  });

  return { run, findings: output.findings };
}

/** 過去に実行した説明を読み直す。 */
export async function loadAnomalyExplanation(
  db: DbClient,
  ctx: AuthorizationContext,
  runId: Uuid,
  dataPoint: DataPoint,
): Promise<AnomalyExplanationResult | null> {
  const run = await db.findById('aiRuns', runId);
  if (
    !run ||
    run.organizationId !== ctx.workspace.organizationId ||
    run.featureType !== 'anomalyExplanation' ||
    !run.inputReferenceIds.includes(dataPoint.id)
  ) {
    return null;
  }
  return { run, findings: (run.outputJson.findings ?? []) as AnomalyFinding[] };
}
