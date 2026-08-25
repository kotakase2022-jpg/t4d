import 'server-only';

import { runAi } from '@/lib/ai';
import { recordAuditEvent } from '@/lib/audit/logger';
import {
  assertCan,
  assertUnitInScope,
  AuthorizationError,
  can,
  NotFoundError,
} from '@/lib/authorization/can';
import { contentHash, fid } from '@/lib/fixtures/ids';
import { recomputePeriodValidations } from '@/lib/services/validation-store';
import { storeNewFile } from '@/lib/storage';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  DataPoint,
  DataPointVersion,
  IngestionJob,
  IngestionJobFile,
  IngestionRow,
  MetricDefinition,
  OrganizationUnit,
  ReportingPeriod,
  Uuid,
} from '@/types/domain';
import { buildLearnedExamples } from './learning';
import { parseUploadedFile, validateUpload } from './parsers';

/**
 * 取込ジョブ（指示書 13 章）。
 *
 * Upload Request を長時間ブロックしない:
 *   1. Server Action がファイルを保存し、ジョブを `queued` で作成して即座に返す
 *   2. ジョブ詳細画面のポーリング（GET /api/jobs/[jobId]）がワーカーとして処理を進める
 *   3. 進捗は progress_percent で表示する
 */

/**
 * 1 ファイルあたり AI 仕分けへ渡す最大行数。
 * importMapping の Rate Limit を緩和した代わりに、入力サイズでコストを抑える。
 * 超過行は AI を通さず「要確認」として残す（勝手に捨てない）。
 */
export const AI_MAPPING_MAX_ROWS_PER_FILE = 500;

export interface UploadedFileInput {
  name: string;
  type: string;
  bytes: Uint8Array;
}

export interface CreateJobInput {
  reportingPeriodId: Uuid;
  unitId: Uuid | null;
  files: UploadedFileInput[];
  /** 重複実行防止 */
  idempotencyKey: string;
}

export async function createIngestionJob(
  db: DbClient,
  ctx: AuthorizationContext,
  input: CreateJobInput,
): Promise<IngestionJob> {
  assertCan(ctx, 'enterprise.import.run');
  if (input.unitId) assertUnitInScope(ctx, input.unitId);
  if (input.files.length === 0) throw new Error('ファイルが選択されていません。');

  const organizationId = ctx.workspace.organizationId;

  // 期間も自組織のものであることを確認する（他社の periodId を差し込ませない）
  const period = await db.findById('periods', input.reportingPeriodId);
  if (!period || period.organizationId !== organizationId) {
    throw new NotFoundError('報告期間が見つかりません。');
  }

  // 冪等性: 同一キーの既存ジョブがあればそれを返す
  const existing = await db.select('ingestionJobs', {
    where: { organizationId, idempotencyKey: input.idempotencyKey },
    limit: 1,
  });
  const found = existing[0];
  if (found) return found;

  const now = new Date().toISOString();
  const jobId = fid('ingestion_job', `${organizationId}/${input.idempotencyKey}`);

  const job: IngestionJob = {
    id: jobId,
    organizationId,
    reportingPeriodId: input.reportingPeriodId,
    unitId: input.unitId,
    status: 'queued',
    progressPercent: 0,
    errorCode: null,
    errorMessage: null,
    retryCount: 0,
    idempotencyKey: input.idempotencyKey,
    startedAt: null,
    finishedAt: null,
    totalRows: 0,
    mappedRows: 0,
    warningRows: 0,
    errorRows: 0,
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
  };
  await db.insert('ingestionJobs', [job]);

  const jobFiles: IngestionJobFile[] = [];
  for (const file of input.files) {
    const validation = validateUpload(file.name, file.type, file.bytes.byteLength);
    if (!validation.ok) {
      await db.update('ingestionJobs', jobId, {
        status: 'failed',
        errorCode: 'UPLOAD_REJECTED',
        errorMessage: validation.message ?? 'アップロードが拒否されました。',
        finishedAt: new Date().toISOString(),
      });
      throw new Error(validation.message ?? 'アップロードが拒否されました。');
    }

    const stored = await storeNewFile(db, ctx, {
      bucket: 'enterprise-originals-private',
      scope: 'enterprise-original',
      originalName: validation.safeName,
      mimeType: file.type || 'application/octet-stream',
      bytes: file.bytes,
      reportingPeriodId: input.reportingPeriodId,
      documentType: '取込ファイル',
    });

    jobFiles.push({
      id: fid('ingestion_job_file', `${jobId}/${validation.safeName}`),
      jobId,
      organizationId,
      fileVersionId: stored.version.id,
      originalName: validation.safeName,
      mimeType: file.type || 'application/octet-stream',
      parseStatus: 'pending',
      parseMessage: null,
      sheetName: null,
      detectedEncoding: null,
      createdAt: now,
    });
  }
  await db.insert('ingestionJobFiles', jobFiles);

  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'ingestion_job',
    resourceId: jobId,
    afterSummary: `取込ジョブを作成（${jobFiles.length} ファイル）`,
  });

  return job;
}

// ----------------------------------------------------------------------
// 処理（ワーカー）
// ----------------------------------------------------------------------

export async function processIngestionJob(
  db: DbClient,
  ctx: AuthorizationContext,
  jobId: Uuid,
): Promise<IngestionJob> {
  const job = await db.findById('ingestionJobs', jobId);
  if (!job) throw new NotFoundError('取込ジョブが見つかりません。');
  if (job.organizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('取込ジョブが見つかりません。');
  }
  if (job.status !== 'queued') return job;

  await db.update('ingestionJobs', jobId, {
    status: 'processing',
    progressPercent: 5,
    startedAt: new Date().toISOString(),
  });

  const [metrics, units, periods, jobFiles] = await Promise.all([
    db.select('metrics', {
      where: { organizationId: job.organizationId, deletedAt: { isNull: true } },
    }),
    db.select('units', {
      where: { organizationId: job.organizationId, deletedAt: { isNull: true } },
    }),
    db.select('periods', { where: { organizationId: job.organizationId } }),
    db.select('ingestionJobFiles', { where: { jobId } }),
  ]);

  const period = periods.find((p) => p.id === job.reportingPeriodId);
  const metricByCode = new Map(metrics.map((m) => [m.code, m]));
  const unitByCode = new Map(units.map((u) => [u.code, u]));

  const allRows: IngestionRow[] = [];
  let warningRows = 0;

  // 事前学習はジョブ単位で 1 回だけ構築する（ファイルごとに確定行を全走査しない）
  const learnedExamples = await buildLearnedExamples(db, ctx);

  try {
    for (let fileIndex = 0; fileIndex < jobFiles.length; fileIndex += 1) {
      const jobFile = jobFiles[fileIndex];
      if (!jobFile) continue;

      const version = await db.findById('fileVersions', jobFile.fileVersionId);
      if (!version) continue;

      const { getStorageAdapter } = await import('@/lib/storage');
      const bytes = await getStorageAdapter().get(
        'enterprise-originals-private',
        version.storageKey,
      );
      if (!bytes) {
        await db.update('ingestionJobFiles', jobFile.id, {
          parseStatus: 'failed',
          parseMessage: 'アップロードされたファイル本体を取得できませんでした。',
        });
        continue;
      }

      const parsed = await parseUploadedFile(jobFile.originalName, jobFile.mimeType, bytes);

      if (parsed.kind === 'unsupported') {
        await db.update('ingestionJobFiles', jobFile.id, {
          parseStatus: 'failed',
          parseMessage: parsed.message,
        });
        continue;
      }

      if (parsed.kind === 'pdf') {
        // PDF は「無理に成功扱いしない」（指示書 13 章）
        await db.update('ingestionJobFiles', jobFile.id, {
          parseStatus: parsed.pdf.status === 'parsed' ? 'parsed' : 'needs_ocr',
          parseMessage: parsed.pdf.message,
        });
        // 抽出できたページは Fragment として保存し、Evidence 紐付けに使えるようにする
        if (parsed.pdf.pages.length > 0) {
          await db.insert(
            'fragments',
            parsed.pdf.pages.map((p) => ({
              id: fid('fragment', `${version.id}/p${p.page}`),
              fileVersionId: version.id,
              organizationId: job.organizationId,
              page: p.page,
              kind: 'text' as const,
              text: p.text.slice(0, 4000),
              locator: `p.${p.page}`,
              createdAt: new Date().toISOString(),
            })),
          );
        }
        continue;
      }

      if (parsed.kind === 'docx') {
        // Word は非財務データの取込（表形式）には使わない。
        // 過去回答 Import（CDP-P0-003）専用なので、ここでは対象外として明示する。
        await db.update('ingestionJobFiles', jobFile.id, {
          parseStatus: 'failed',
          parseMessage:
            'Word ファイルは非財務データの取込では扱えません。CDP の「過去回答 Import」を使用してください。',
        });
        continue;
      }

      const table = parsed.table;
      await db.update('ingestionJobFiles', jobFile.id, {
        parseStatus: 'parsed',
        parseMessage: table.warnings.length > 0 ? table.warnings.join(' / ') : null,
        sheetName: table.sheetName,
        detectedEncoding: table.detectedEncoding,
      });

      await db.update('ingestionJobs', jobId, {
        progressPercent: Math.round(10 + (60 * (fileIndex + 0.5)) / jobFiles.length),
      });

      // AI（または Mock）で構造化。過去に人が確定した対応（事前学習）を few-shot で渡す。
      // 1 ファイルあたりの AI 入力行数は上限を設ける（実 Provider でのトークンコスト暴走防止）。
      const aiRows = table.rows.slice(0, AI_MAPPING_MAX_ROWS_PER_FILE);
      const overflowCount = table.rows.length - aiRows.length;
      const defaultUnit = job.unitId ? units.find((u) => u.id === job.unitId) : undefined;
      const { run, output } = await runAi({
        db,
        ctx,
        idempotencyKey: `importMapping:${jobFile.id}`,
        sources: [],
        invocation: {
          feature: 'importMapping',
          context: {
            organizationName: ctx.workspace.organizationName,
            reportingPeriodLabel: period?.label ?? '不明',
          },
          inputReferenceIds: [jobFile.id],
          input: {
            fileName: jobFile.originalName,
            headers: table.headers,
            periodCode: period?.code ?? null,
            defaultUnitCode: defaultUnit?.code ?? null,
            availableMetricCodes: metrics.map((m) => ({
              code: m.code,
              name: m.name,
              unit: m.unit,
            })),
            availableUnitCodes: units.map((u) => ({ code: u.code, name: u.name })),
            rows: aiRows.map((raw, index) => ({ rowIndex: index, raw })),
            learnedExamples,
          },
        },
      });

      const parseNotes = [
        ...(table.warnings.length > 0 ? table.warnings : []),
        ...(learnedExamples.length > 0
          ? [`事前学習: 確定済み実績 ${learnedExamples.length} 件を参照`]
          : []),
        ...(overflowCount > 0
          ? [
              `行数が多いため AI 仕分けは先頭 ${AI_MAPPING_MAX_ROWS_PER_FILE} 行まで（残り ${overflowCount} 行は要確認）`,
            ]
          : []),
      ];
      if (parseNotes.length > 0) {
        await db.update('ingestionJobFiles', jobFile.id, { parseMessage: parseNotes.join(' / ') });
      }

      const now = new Date().toISOString();
      table.rows.forEach((raw, index) => {
        const mapped = output.rows.find((r) => r.rowIndex === index);
        const metric = mapped?.metricCode ? metricByCode.get(mapped.metricCode) : undefined;
        const unit = mapped?.unitCode
          ? unitByCode.get(mapped.unitCode)
          : job.unitId
            ? units.find((u) => u.id === job.unitId)
            : undefined;

        const warnings = [...(mapped?.warnings ?? [])];
        if (!metric) warnings.push('指標を特定できませんでした。手動で選択してください。');
        if (!unit) warnings.push('組織・拠点を特定できませんでした。');
        if (mapped?.value === null || mapped?.value === undefined) {
          warnings.push('数値を検出できませんでした。');
        }
        if (metric && mapped?.unitOfMeasure && mapped.unitOfMeasure !== metric.unit) {
          warnings.push(
            `単位が指標定義（${metric.unit}）と異なります（検出: ${mapped.unitOfMeasure}）。`,
          );
        }

        const status: IngestionRow['status'] =
          metric &&
          unit &&
          mapped?.value !== null &&
          mapped?.value !== undefined &&
          warnings.length === 0
            ? 'mapped'
            : 'needs_review';
        if (status === 'needs_review') warningRows += 1;

        allRows.push({
          id: fid('ingestion_row', `${jobFile.id}/${index}`),
          jobId,
          jobFileId: jobFile.id,
          organizationId: job.organizationId,
          rowIndex: table.rowNumbers[index] ?? index + 1,
          raw,
          metricId: metric?.id ?? null,
          unitId: unit?.id ?? null,
          reportingPeriodId: job.reportingPeriodId,
          value: mapped?.value ?? null,
          unitOfMeasure: mapped?.unitOfMeasure ?? metric?.unit ?? null,
          confidence: mapped?.confidence ?? 0,
          warnings,
          status,
          sourceLocator:
            mapped?.sourceLocator ??
            `${table.sheetName ? `${table.sheetName}!` : ''}行 ${table.rowNumbers[index] ?? index + 1}`,
          duplicateOfDataPointId: null,
          aiRunId: run.id,
          createdAt: now,
          updatedAt: now,
        });
      });
    }

    // 重複検出（既存 Data Point と業務キーが一致するもの）
    const existingDataPoints = await db.select('dataPoints', {
      where: {
        organizationId: job.organizationId,
        reportingPeriodId: job.reportingPeriodId,
        deletedAt: { isNull: true },
      },
    });
    for (const row of allRows) {
      if (!row.metricId || !row.unitId) continue;
      const dup = existingDataPoints.find(
        (dp) => dp.metricId === row.metricId && dp.unitId === row.unitId,
      );
      if (dup) {
        row.duplicateOfDataPointId = dup.id;
        row.status = 'duplicate';
        row.warnings = [
          ...row.warnings,
          `既存データ（${dup.value ?? '—'} ${dup.unitOfMeasure}・${dup.status}）と重複しています。確定すると新しい Version が追加されます。`,
        ];
      }
    }

    if (allRows.length > 0) await db.insert('ingestionRows', allRows);

    const mappedRows = allRows.filter((r) => r.status === 'mapped').length;
    const needsReview = allRows.filter(
      (r) => r.status === 'needs_review' || r.status === 'duplicate',
    ).length;
    const pdfNeedsOcr = (
      await db.select('ingestionJobFiles', { where: { jobId, parseStatus: 'needs_ocr' } })
    ).length;

    const updated = await db.update('ingestionJobs', jobId, {
      status: needsReview > 0 || pdfNeedsOcr > 0 ? 'needs_review' : 'completed',
      progressPercent: 100,
      totalRows: allRows.length,
      mappedRows,
      warningRows,
      errorRows: 0,
      finishedAt: new Date().toISOString(),
    });

    await recordAuditEvent(db, ctx, {
      eventType: 'data_updated',
      resourceType: 'ingestion_job',
      resourceId: jobId,
      afterSummary: `解析完了: ${allRows.length} 行（要確認 ${needsReview} 行）`,
    });

    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : '不明なエラー';
    return db.update('ingestionJobs', jobId, {
      status: 'failed',
      errorCode: 'PROCESSING_FAILED',
      errorMessage: message.slice(0, 500),
      progressPercent: 100,
      finishedAt: new Date().toISOString(),
      retryCount: job.retryCount + 1,
    });
  }
}

// ----------------------------------------------------------------------
// 確定（Data Point 台帳へ反映）
// ----------------------------------------------------------------------

export interface RowDecision {
  rowId: Uuid;
  include: boolean;
  metricId: Uuid | null;
  unitId: Uuid | null;
  value: number | null;
  unitOfMeasure: string | null;
}

export interface ConfirmResult {
  created: number;
  updated: number;
  skipped: number;
}

export async function confirmIngestionJob(
  db: DbClient,
  ctx: AuthorizationContext,
  jobId: Uuid,
  decisions: RowDecision[],
  /**
   * ジョブがこのインスタンスのメモリに無い場合の補い。
   *
   * Demo Mode の取込結果はプロセスのメモリにしか無く、確定のリクエストが
   * 別インスタンスへ届くとジョブも行も見つからない（known-limitations D-3）。
   * 画面から一緒に送られてくる「対象期間」と「元資料の位置」で補えば、
   * 台帳への反映は同じようにできる。
   */
  fallback?: { reportingPeriodId: Uuid; sourceLocatorByRowId: Record<string, string> },
): Promise<ConfirmResult> {
  assertCan(ctx, 'enterprise.data.write');

  const organizationId = ctx.workspace.organizationId;
  const job = await db.findById('ingestionJobs', jobId);
  if (job && job.organizationId !== organizationId) {
    throw new NotFoundError('取込ジョブが見つかりません。');
  }
  if (!job && !fallback) {
    throw new NotFoundError('取込ジョブが見つかりません。');
  }

  const rows = job ? await db.select('ingestionRows', { where: { jobId } }) : [];
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const [metrics, units, periods] = await Promise.all([
    db.select('metrics', { where: { organizationId } }),
    db.select('units', { where: { organizationId } }),
    db.select('periods', { where: { organizationId } }),
  ]);
  const periodId = job?.reportingPeriodId ?? fallback!.reportingPeriodId;
  const period = periods.find((p) => p.id === periodId);
  if (!period) throw new NotFoundError('報告期間が見つかりません。');

  // 1 行ずつ書きながら途中で権限エラーを投げると、
  // 「半分だけ台帳に入った状態で全画面エラー」になる。書く前にまとめて確かめる。
  for (const decision of decisions) {
    if (decision.include && decision.unitId) assertUnitInScope(ctx, decision.unitId);
  }

  const result: ConfirmResult = { created: 0, updated: 0, skipped: 0 };

  for (const decision of decisions) {
    const row = rowById.get(decision.rowId);
    // 行がこのインスタンスに無い場合は、画面から送られてきた情報で補う
    const sourceLocator =
      row?.sourceLocator ?? fallback?.sourceLocatorByRowId[decision.rowId] ?? null;

    if (!decision.include || !decision.metricId || !decision.unitId || decision.value === null) {
      if (row) {
        await db.update('ingestionRows', row.id, {
          status: 'rejected',
          updatedAt: new Date().toISOString(),
        });
      }
      result.skipped += 1;
      continue;
    }

    assertUnitInScope(ctx, decision.unitId);

    const metric = metrics.find((m) => m.id === decision.metricId);
    const unit = units.find((u) => u.id === decision.unitId);
    if (!metric || !unit) {
      result.skipped += 1;
      continue;
    }

    const outcome = await upsertDataPointFromImport(db, ctx, {
      metric,
      unit,
      period,
      value: decision.value,
      unitOfMeasure: decision.unitOfMeasure ?? metric.unit,
      sourceReference: `${sourceLocator ?? '取込'}（ジョブ ${jobId.slice(0, 8)}）`,
    });

    if (outcome === 'created') result.created += 1;
    else result.updated += 1;

    if (row) {
      await db.update('ingestionRows', row.id, {
        status: 'confirmed',
        metricId: decision.metricId,
        unitId: decision.unitId,
        value: decision.value,
        unitOfMeasure: decision.unitOfMeasure,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  if (job) {
    await db.update('ingestionJobs', jobId, {
      status: 'completed',
      finishedAt: new Date().toISOString(),
    });
  }

  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'ingestion_job',
    resourceId: jobId,
    afterSummary: `取込確定: 新規 ${result.created} 件 / 更新 ${result.updated} 件 / 除外 ${result.skipped} 件`,
  });

  // 取込は複数行をまとめて更新するため、確定後に 1 回だけ検証を再計算する
  await recomputePeriodValidations(db, ctx, period);

  return result;
}

async function upsertDataPointFromImport(
  db: DbClient,
  ctx: AuthorizationContext,
  input: {
    metric: MetricDefinition;
    unit: OrganizationUnit;
    period: ReportingPeriod;
    value: number;
    unitOfMeasure: string;
    sourceReference: string;
  },
): Promise<'created' | 'updated'> {
  const organizationId = ctx.workspace.organizationId;
  const boundary = input.unit.consolidationMethod === 'full' ? '連結' : '単体';
  const now = new Date().toISOString();

  const existingRows = await db.select('dataPoints', {
    where: {
      organizationId,
      metricId: input.metric.id,
      unitId: input.unit.id,
      reportingPeriodId: input.period.id,
      boundary,
    },
    limit: 1,
  });
  const existing = existingRows[0];

  if (existing) {
    if (existing.status === 'approved' && !ctxCanEditApproved(ctx)) {
      throw new AuthorizationError(
        '承認済みデータの変更にはレビュー権限が必要です。レビュー担当へ差戻しを依頼してください。',
      );
    }
    const versions = await db.select('dataPointVersions', {
      where: { dataPointId: existing.id },
      orderBy: { column: 'versionNo', dir: 'desc' },
      limit: 1,
    });
    const nextVersionNo = (versions[0]?.versionNo ?? 0) + 1;
    const version: DataPointVersion = {
      id: fid('data_point_version', `${existing.id}/v${nextVersionNo}`),
      dataPointId: existing.id,
      organizationId,
      versionNo: nextVersionNo,
      value: input.value,
      textValue: null,
      unitOfMeasure: input.unitOfMeasure,
      status: 'draft',
      sourceType: 'import',
      sourceReference: input.sourceReference,
      changeReason: '取込ファイルからの更新',
      contentHash: contentHash(
        `${existing.id}|${nextVersionNo}|${input.value}|${input.unitOfMeasure}`,
      ),
      createdAt: now,
      createdBy: ctx.userId,
    };
    await db.insert('dataPointVersions', [version]);
    await db.update('dataPoints', existing.id, {
      value: input.value,
      unitOfMeasure: input.unitOfMeasure,
      currentVersionId: version.id,
      status: existing.status === 'approved' ? 'draft' : existing.status,
      changedAfterApproval: existing.status === 'approved' ? true : existing.changedAfterApproval,
      updatedAt: now,
      updatedBy: ctx.userId,
    });
    return 'updated';
  }

  const dataPointIdValue = fid(
    'data_point',
    `${organizationId}/${input.period.code}/${input.unit.code}/${input.metric.code}`,
  );
  const versionId = fid('data_point_version', `${dataPointIdValue}/v1`);

  const version: DataPointVersion = {
    id: versionId,
    dataPointId: dataPointIdValue,
    organizationId,
    versionNo: 1,
    value: input.value,
    textValue: null,
    unitOfMeasure: input.unitOfMeasure,
    status: 'draft',
    sourceType: 'import',
    sourceReference: input.sourceReference,
    changeReason: null,
    contentHash: contentHash(`${dataPointIdValue}|1|${input.value}|${input.unitOfMeasure}`),
    createdAt: now,
    createdBy: ctx.userId,
  };

  const dataPoint: DataPoint = {
    id: dataPointIdValue,
    organizationId,
    metricId: input.metric.id,
    unitId: input.unit.id,
    reportingPeriodId: input.period.id,
    boundary,
    status: 'draft',
    currentVersionId: versionId,
    value: input.value,
    textValue: null,
    unitOfMeasure: input.unitOfMeasure,
    methodology: '取込ファイルより登録',
    ownerUserId: ctx.userId,
    reviewerUserId: null,
    approvedAt: null,
    approvedBy: null,
    changedAfterApproval: false,
    createdAt: now,
    updatedAt: now,
    createdBy: ctx.userId,
    updatedBy: ctx.userId,
    deletedAt: null,
  };

  await db.insert('dataPoints', [dataPoint]);
  await db.insert('dataPointVersions', [version]);
  return 'created';
}

/**
 * 承認済みデータを変更できるか。
 * DB 側トリガ（t4d.enforce_data_point_transition）と同じく、
 * ロール名ではなく権限で判定する。
 */
function ctxCanEditApproved(ctx: AuthorizationContext): boolean {
  return can(ctx, 'enterprise.data.review') || can(ctx, 'enterprise.data.approve');
}
