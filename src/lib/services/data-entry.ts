import 'server-only';

import { recordAuditEvent } from '@/lib/audit/logger';
import { assertCan } from '@/lib/authorization/can';
import { contentHash, fid } from '@/lib/fixtures/ids';
import type { DbClient } from '@/lib/repositories/types';
import { isCountedInTotals } from '@/lib/services/aggregation';
import type {
  AuthorizationContext,
  DataPoint,
  MetricDefinition,
  OrganizationUnit,
  ReportingPeriod,
} from '@/types/domain';

/**
 * データ入力の 4 手段のうち「前年度複製」「Excel テンプレート」（DATA-P0-004）。
 *
 * - 前年度複製: 前年の**承認済み**値を当年の下書き（draft）として複製する。
 *   勝手に確定しない（複製後は通常の 提出 → レビュー → 承認 を通る）。
 * - テンプレート: 標準形（拠点/項目/値/単位/期間）の Excel を配る。
 *   再取込は既存の取込パイプラインがそのまま受ける。
 */

export interface CarryForwardResult {
  created: number;
  skippedExisting: number;
  skippedOutOfScope: number;
}

export async function carryForwardFromPreviousPeriod(
  db: DbClient,
  ctx: AuthorizationContext,
  period: ReportingPeriod,
  periods: ReportingPeriod[],
): Promise<CarryForwardResult> {
  assertCan(ctx, 'enterprise.data.write');
  const organizationId = ctx.workspace.organizationId;
  if (period.organizationId !== organizationId) {
    throw new Error('報告期間が見つかりません。');
  }

  const previous =
    periods
      .filter((p) => p.organizationId === organizationId && p.endDate < period.startDate)
      .sort((a, b) => (a.endDate < b.endDate ? 1 : -1))[0] ?? null;
  if (!previous) throw new Error('複製元となる前年度がありません。');

  const [prevRows, currentRows] = await Promise.all([
    db.select('dataPoints', {
      where: {
        organizationId,
        reportingPeriodId: previous.id,
        status: 'approved',
        deletedAt: { isNull: true },
      },
    }),
    db.select('dataPoints', {
      where: { organizationId, reportingPeriodId: period.id, deletedAt: { isNull: true } },
    }),
  ]);

  const existingKeys = new Set(
    currentRows.map((dp) => `${dp.metricId}/${dp.unitId}/${dp.boundary}`),
  );
  const scopeIds = ctx.workspace.unitScopeIds;
  const inScope = (unitId: string) => scopeIds.length === 0 || scopeIds.includes(unitId);

  const now = new Date().toISOString();
  let created = 0;
  let skippedExisting = 0;
  let skippedOutOfScope = 0;

  for (const prev of prevRows) {
    // 内部取引の明細行は複製しない（連結集計用の控除明細であり、毎年の実測で登録し直す）
    if (!isCountedInTotals(prev)) continue;
    const key = `${prev.metricId}/${prev.unitId}/${prev.boundary}`;
    if (existingKeys.has(key)) {
      skippedExisting += 1;
      continue;
    }
    if (!inScope(prev.unitId)) {
      skippedOutOfScope += 1;
      continue;
    }

    const dpId = fid('data_point', `${organizationId}/${key}/${period.id}/carry`);
    const versionId = fid('data_point_version', `${dpId}/v1`);
    await db.insert('dataPointVersions', [
      {
        id: versionId,
        dataPointId: dpId,
        organizationId,
        versionNo: 1,
        value: prev.value,
        textValue: prev.textValue,
        unitOfMeasure: prev.unitOfMeasure,
        sourceType: 'carry_forward',
        sourceReference: `${previous.code} の承認済み値`,
        status: 'draft',
        changeReason: '前年度から複製（値は要更新）',
        contentHash: contentHash(`${dpId}|1|${prev.value ?? ''}`),
        createdAt: now,
        createdBy: ctx.userId,
      },
    ]);
    const dp: DataPoint = {
      id: dpId,
      organizationId,
      metricId: prev.metricId,
      unitId: prev.unitId,
      reportingPeriodId: period.id,
      boundary: prev.boundary,
      status: 'draft',
      currentVersionId: versionId,
      value: prev.value,
      textValue: prev.textValue,
      unitOfMeasure: prev.unitOfMeasure,
      methodology: prev.methodology,
      ownerUserId: ctx.userId,
      reviewerUserId: prev.reviewerUserId,
      approvedAt: null,
      approvedBy: null,
      changedAfterApproval: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    };
    await db.insert('dataPoints', [dp]);
    existingKeys.add(key);
    created += 1;
  }

  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'data_point',
    resourceId: period.id,
    afterSummary: `前年度複製: ${created} 件を draft として作成（既存 ${skippedExisting} 件はスキップ）`,
  });

  return { created, skippedExisting, skippedOutOfScope };
}

/**
 * 標準テンプレート（Excel）を組み立てる。
 * 列は取込パイプラインの標準形（拠点/項目/値/単位/期間）に一致させ、
 * 記入後はそのまま「データ収集」へドロップすれば再取込できる。
 */
export async function buildTemplateWorkbook(
  metrics: MetricDefinition[],
  units: OrganizationUnit[],
  period: ReportingPeriod,
  unitScopeIds: string[],
): Promise<Uint8Array> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('データ入力');
  ws.addRow(['拠点', '項目', '値', '単位', '期間']);

  const targetUnits = units.filter(
    (u) => u.unitType !== 'supplier' && (unitScopeIds.length === 0 || unitScopeIds.includes(u.id)),
  );
  for (const unit of targetUnits) {
    for (const metric of metrics) {
      // 本社限定の指標（役員数など）は本社行だけ出す。
      // 判定はデータモデル（metric.hqOnly）に従う。カテゴリからの推測は
      // 拠点別に収集する human_capital 指標を落としてしまう。
      if (metric.hqOnly && unit.unitType !== 'headquarters') continue;
      ws.addRow([unit.name, metric.name, '', metric.unit, period.code]);
    }
  }
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((col) => {
    col.width = 24;
  });

  const buffer = await wb.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}
