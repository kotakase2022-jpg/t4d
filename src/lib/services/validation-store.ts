import 'server-only';

import { fid } from '@/lib/fixtures/ids';
import { validateDataPoints } from '@/lib/validation/data-point-rules';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  DataPointValidationResult,
  ReportingPeriod,
  Uuid,
} from '@/types/domain';

/**
 * 検証結果の永続化。
 *
 * 検証ルールは「前年比」「単位の混在」「分子分母」など**行をまたぐ**判定を含むため、
 * 1 行ずつ評価できない。そこで書き込み時に対象期間分をまとめて再計算し、
 * `data_point_validation_results` へ materialize する。
 *
 * これにより一覧側は
 *   「検証エラーのある Data Point の ID を DB から引く → その ID でページングする」
 * という形にでき、全件をアプリへ読み込まずに済む（docs/known-limitations.md S-1 の解消）。
 *
 * 解決済みの結果は削除せず `resolved_at` を立てる（DELETE は authenticated から REVOKE 済み。
 * いつ検出され、いつ解消されたかの履歴が残る）。
 */

/** 同一性の判定キー。同じ Data Point に同じルールが複数出る場合もメッセージで区別する。 */
function resultKey(result: Pick<DataPointValidationResult, 'dataPointId' | 'ruleKey' | 'message'>) {
  return `${result.dataPointId}|${result.ruleKey}|${result.message}`;
}

export interface RecomputeResult {
  inserted: number;
  resolved: number;
  active: number;
}

export async function recomputePeriodValidations(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
): Promise<RecomputeResult> {
  const organizationId = ctx.workspace.organizationId;
  const now = new Date().toISOString();

  const [metrics, units, periods] = await Promise.all([
    db.select('metrics', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('units', { where: { organizationId, deletedAt: { isNull: true } } }),
    db.select('periods', { where: { organizationId } }),
  ]);

  const dataPoints = await db.select('dataPoints', {
    where: { organizationId, reportingPeriodId: period.id, deletedAt: { isNull: true } },
  });

  const previous = periods
    .filter((p) => p.startDate < period.startDate)
    .sort((a, b) => (a.startDate < b.startDate ? 1 : -1))[0];
  const previousPeriodDataPoints = previous
    ? await db.select('dataPoints', {
        where: { organizationId, reportingPeriodId: previous.id, deletedAt: { isNull: true } },
      })
    : [];

  const evidenceLinks = await db.select('evidenceLinks', {
    where: { organizationId, targetType: 'data_point' },
  });
  const evidenceCountByDataPoint = new Map<Uuid, number>();
  for (const link of evidenceLinks) {
    evidenceCountByDataPoint.set(
      link.targetId,
      (evidenceCountByDataPoint.get(link.targetId) ?? 0) + 1,
    );
  }

  const computed = validateDataPoints({
    dataPoints,
    metrics,
    units,
    periods,
    evidenceCountByDataPoint,
    previousPeriodDataPoints,
    detectedAt: now,
  });

  const dataPointIds = dataPoints.map((dp) => dp.id);
  const existing =
    dataPointIds.length === 0
      ? []
      : await db.select('validations', {
          where: {
            organizationId,
            dataPointId: { in: dataPointIds },
            resolvedAt: { isNull: true },
          },
        });

  const existingByKey = new Map(existing.map((r) => [resultKey(r), r]));
  const computedKeys = new Set(computed.map(resultKey));

  // 1. 解消されたものに resolved_at を立てる
  let resolved = 0;
  for (const row of existing) {
    if (computedKeys.has(resultKey(row))) continue;
    await db.update('validations', row.id, { resolvedAt: now });
    resolved += 1;
  }

  // 2. 新たに検出されたものを追記する
  const toInsert: DataPointValidationResult[] = [];
  for (const result of computed) {
    const key = resultKey(result);
    if (existingByKey.has(key)) continue;
    toInsert.push({
      ...result,
      // 一度解消したものが再発した場合に主キーが衝突しないよう、検出時刻を含める
      id: fid('validation', `${key}|${now}`),
      organizationId,
      detectedAt: now,
      resolvedAt: null,
    });
  }
  if (toInsert.length > 0) await db.insert('validations', toInsert);

  return { inserted: toInsert.length, resolved, active: computed.length };
}

/** 指定 Data Point 群の未解消の検証結果を取得する。 */
export async function loadActiveValidations(
  db: DbClient,
  organizationId: Uuid,
  dataPointIds: Uuid[],
): Promise<DataPointValidationResult[]> {
  if (dataPointIds.length === 0) return [];
  return db.select('validations', {
    where: { organizationId, dataPointId: { in: dataPointIds }, resolvedAt: { isNull: true } },
  });
}

/** 未解消の検証結果を持つ Data Point の ID を返す（一覧の絞り込みに使う）。 */
export async function findDataPointIdsWithValidation(
  db: DbClient,
  organizationId: Uuid,
  options: { severity?: 'error' | 'warning'; ruleKey?: string },
): Promise<Uuid[]> {
  const rows = await db.select('validations', {
    where: {
      organizationId,
      resolvedAt: { isNull: true },
      ...(options.severity ? { severity: options.severity } : {}),
      ...(options.ruleKey ? { ruleKey: options.ruleKey } : {}),
    },
  });
  return [...new Set(rows.map((r) => r.dataPointId))];
}
