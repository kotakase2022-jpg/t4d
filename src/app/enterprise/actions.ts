'use server';

import { safeAppLinkOrNull } from '@/lib/security/safe-link';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { recordAiDecision } from '@/lib/ai';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { assertCan, AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { isUserFacingError, ValidationError, withUserFacingError } from '@/lib/errors/user-facing';
import { contentHash, fid } from '@/lib/fixtures/ids';
import { confirmIngestionJob, createIngestionJob, type RowDecision } from '@/lib/imports/service';
import { getDb } from '@/lib/repositories';
import {
  carryOverSsbjAssessments,
  createActionPlan,
  createDataCollectionItem,
  runSsbjGapAnalysis,
  saveSsbjReview,
  saveSsbjScope,
  updateActionPlan,
} from '@/lib/services/ssbj-gap';
import { confirmSsbjSettings, saveSsbjSettings } from '@/lib/services/ssbj-settings';
import { decideApprovalStep } from '@/lib/services/approval-route';
import { confirmSsbjDraft, generateSsbjDraft, saveSsbjDraftBody } from '@/lib/services/ssbj-draft';
import type { SsbjArea } from '@/lib/domain/ssbj';
import { MAX_FILES_PER_IMPORT, type ImportPreviewPayload } from './imports/preview-types';
import { sha256Hex } from '@/lib/storage';
import {
  bulkTransition,
  linkEvidence,
  transitionDataPoint,
  updateDataPointValue,
} from '@/lib/services/data-point-workflow';
import {
  generateDisclosureDraft,
  saveDisclosureResponse,
  transitionDisclosureResponse,
} from '@/lib/services/disclosure-write';
import {
  createCollectionCampaign,
  createMetricDefinition,
  createOrganizationUnit,
  parseMetricInput,
  parseOrganizationUnitInput,
  updateMetricDefinition,
  updateOrganizationUnit,
} from '@/lib/services/master-data';
import { addComment } from '@/lib/services/comments';
import { askCopilot } from '@/lib/services/copilot';
import {
  createInvitation,
  issuePasswordResetLink,
  revokeInvitation,
} from '@/lib/services/identity';
import { carryForwardFromPreviousPeriod } from '@/lib/services/data-entry';
import { evaluateApplicability } from '@/lib/services/disclosure-applicability';
import { runDisclosureConsistencyCheck } from '@/lib/services/disclosure-check';
import { confirmDisclosureImport } from '@/lib/services/disclosure-import';
import { runInsightDiscovery } from '@/lib/services/insights';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { storeNewFile } from '@/lib/storage';
import { GRANT_SUBJECT_TYPES } from '@/types/domain';
import type {
  GrantSubjectType,
  DataPointStatus,
  FrameworkKey,
  PeriodStatus,
  ResponseStatus,
  RoleKey,
  SsbjValueChainScope,
  Uuid,
} from '@/types/domain';

/** FormData を「文字列を返す getter」に変換する（サービス層のパーサへ渡す）。 */
function formGetter(formData: FormData): (key: string) => string {
  return (key: string) => String(formData.get(key) ?? '');
}

/**
 * 企業ワークスペースの Server Actions。
 * すべて `requireEnterpriseContext()` で認可コンテキストを取得してから実行する。
 */

// ----------------------------------------------------------------------
// 取込
// ----------------------------------------------------------------------

/** 投入の結果。プレビューはブラウザ側で持ち回るため、行の内容ごと返す */
export type UploadResult =
  { ok: true; preview: ImportPreviewPayload } | { ok: false; message: string };

export async function uploadFilesAction(
  _previous: UploadResult | null,
  formData: FormData,
): Promise<UploadResult> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();

  const reportingPeriodId = String(formData.get('reportingPeriodId') ?? '');
  const unitIdRaw = String(formData.get('unitId') ?? '');
  const unitId = unitIdRaw && unitIdRaw !== 'auto' ? unitIdRaw : null;
  const files = formData.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);

  if (files.length === 0) {
    return { ok: false, message: 'ファイルが選択されていません。' };
  }
  if (files.length > MAX_FILES_PER_IMPORT) {
    return {
      ok: false,
      message: `一度に取り込めるのは ${MAX_FILES_PER_IMPORT} ファイルまでです（${files.length} ファイル選択されています）。`,
    };
  }

  const payload = await Promise.all(
    files.map(async (file) => ({
      name: file.name,
      type: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })),
  );

  // 二重送信を防ぐための冪等キー。ファイル名とサイズだけだと、
  // 中身を直して同じサイズになったファイルが「同じ取込」と見なされ、
  // 新しい内容が保存されないまま古いジョブへ戻ってしまう。中身も混ぜる。
  const idempotencyKey = contentHash(
    [
      ctx.userId,
      reportingPeriodId,
      unitId ?? '',
      ...(await Promise.all(
        payload.map(async (f) => `${f.name}:${f.bytes.byteLength}:${await sha256Hex(f.bytes)}`),
      )),
    ].join('|'),
  );

  let job;
  try {
    job = await createIngestionJob(db, ctx, {
      reportingPeriodId,
      unitId,
      files: payload,
      idempotencyKey,
    });
  } catch (error) {
    if (isUserFacingError(error)) return { ok: false, message: error.message };
    throw error;
  }

  // Demo Mode は状態がプロセスのメモリにしか無い（known-limitations D-3）。
  // 別リクエストのポーリングではジョブを見つけられないため、
  // この経路だけは**同じリクエスト内で**解析まで終わらせる。
  // Supabase Mode は DB が共有されるので従来どおり非同期ジョブでよいが、
  // プレビューを同じ形で返すためにこちらも同期実行にしている。
  const { processIngestionJob } = await import('@/lib/imports/service');
  try {
    await processIngestionJob(db, ctx, job.id);
  } catch {
    // 解析に失敗してもプレビューへは進む（ファイル単位の失敗は画面に出す）
  }

  const [rows, jobFiles] = await Promise.all([
    db.select('ingestionRows', { where: { jobId: job.id }, orderBy: { column: 'rowIndex' } }),
    db.select('ingestionJobFiles', { where: { jobId: job.id } }),
  ]);

  revalidatePath('/enterprise/imports');

  return {
    ok: true,
    preview: {
      jobId: job.id,
      reportingPeriodId,
      fileNames: jobFiles.map((f) => f.originalName),
      failedFiles: jobFiles
        .filter((f) => f.parseStatus === 'failed' || f.parseStatus === 'needs_ocr')
        .map((f) => ({
          name: f.originalName,
          message: f.parseMessage ?? '解析できませんでした',
        })),
      rows: rows
        .filter((row) => row.status !== 'confirmed' && row.status !== 'rejected')
        .map((row) => ({
          id: row.id,
          rowIndex: row.rowIndex,
          raw: row.raw,
          sourceLocator: row.sourceLocator,
          metricId: row.metricId,
          unitId: row.unitId,
          value: row.value,
          unitOfMeasure: row.unitOfMeasure,
          confidence: row.confidence,
          warnings: row.warnings,
          status: row.status,
        })),
    },
  };
}

export async function confirmImportAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const jobId = String(formData.get('jobId') ?? '');
  const rowIds = formData.getAll('rowId').map(String);

  const decisions: RowDecision[] = rowIds.map((rowId) => {
    const value = formData.get(`value:${rowId}`);
    const parsed = value === null || value === '' ? null : Number(String(value).replace(/,/g, ''));
    return {
      rowId,
      include: formData.get(`include:${rowId}`) === 'on',
      metricId: (formData.get(`metricId:${rowId}`) as string) || null,
      unitId: (formData.get(`unitId:${rowId}`) as string) || null,
      value: parsed !== null && Number.isFinite(parsed) ? parsed : null,
      unitOfMeasure: (formData.get(`unitOfMeasure:${rowId}`) as string) || null,
    };
  });

  // ジョブが別インスタンスのメモリにしか無い場合に備えて、
  // 画面から一緒に送られてきた期間と元資料の位置を渡す（Demo Mode 対策）。
  const sourceLocatorByRowId: Record<string, string> = {};
  for (const rowId of rowIds) {
    const locator = formData.get(`sourceLocator:${rowId}`);
    if (typeof locator === 'string' && locator) sourceLocatorByRowId[rowId] = locator;
  }
  const reportingPeriodId = String(formData.get('reportingPeriodId') ?? '');

  await confirmIngestionJob(
    db,
    ctx,
    jobId,
    decisions,
    reportingPeriodId ? { reportingPeriodId, sourceLocatorByRowId } : undefined,
  );
  revalidatePath('/enterprise/imports');
  revalidatePath('/enterprise/data');
  redirect('/enterprise/data?flash=imported');
}

// ----------------------------------------------------------------------
// Data Point ワークフロー
// ----------------------------------------------------------------------

export async function transitionDataPointAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  await transitionDataPoint(db, ctx, {
    dataPointId: String(formData.get('dataPointId') ?? ''),
    to: String(formData.get('to') ?? '') as DataPointStatus,
    comment: (formData.get('comment') as string) || null,
  });
  revalidatePath('/enterprise/data');
  revalidatePath(`/enterprise/data/${String(formData.get('dataPointId') ?? '')}`);
  revalidatePath('/enterprise/dashboard');
}

/**
 * 承認の道筋の 1 段階を決める（最大 5 階層）。
 *
 * 最後の段階まで承認されたら、その場でデータを承認済みにする。
 * 段階をすべて通したのに別途もう一度承認操作が要るのは、
 * 使う側から見て二度手間でしかない。
 */
export async function decideApprovalStepAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const dataPointId = String(formData.get('dataPointId') ?? '');
  const decision = formData.get('decision') === 'returned' ? 'returned' : 'approved';
  const comment = String(formData.get('comment') ?? '');

  await withUserFacingError(`/enterprise/data/${dataPointId}`, async () => {
    const result = await decideApprovalStep(db, ctx, { dataPointId, decision, comment });
    if (result.completed) {
      await transitionDataPoint(db, ctx, {
        dataPointId,
        to: 'approved',
        comment: comment || null,
      });
    } else if (decision === 'returned') {
      // 差し戻したら、提出者が直せる状態へ戻す
      await transitionDataPoint(db, ctx, { dataPointId, to: 'returned', comment });
    }
  });

  revalidatePath('/enterprise/data');
  revalidatePath(`/enterprise/data/${dataPointId}`);
  revalidatePath('/enterprise/dashboard');
  revalidatePath('/enterprise/disclosures/ssbj/collection');
}

/** 一括操作の結果。画面へ返して件数と失敗理由を見せる */
export interface BulkTransitionState {
  succeeded: number;
  failures: Array<{ id: string; reason: string }>;
  message: string;
}

export async function bulkTransitionAction(
  _previous: BulkTransitionState | null,
  formData: FormData,
): Promise<BulkTransitionState> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const ids = formData.getAll('selected').map(String);
  const to = String(formData.get('to') ?? '') as DataPointStatus;
  if (ids.length === 0) {
    return { succeeded: 0, failures: [], message: '対象が選択されていません。' };
  }

  // 一括操作は 1 件ずつ権限・状態遷移を検査するため、部分的に失敗する。
  // 結果を捨てると「押しても何も起きない」ように見えるので、必ず画面へ返す。
  const result = await bulkTransition(db, ctx, ids, to);
  revalidatePath('/enterprise/data');
  revalidatePath('/enterprise/dashboard');

  const reasons = [...new Set(result.failures.map((f) => f.reason))];
  const message =
    result.failures.length === 0
      ? `${result.succeeded} 件を更新しました。`
      : `${result.succeeded} 件を更新し、${result.failures.length} 件は変更できませんでした（${reasons.join(' / ')}）。`;
  return { succeeded: result.succeeded, failures: result.failures, message };
}

export async function updateDataPointAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const dataPointId = String(formData.get('dataPointId') ?? '');
  const rawValue = String(formData.get('value') ?? '').replace(/,/g, '');
  const value = rawValue === '' ? null : Number(rawValue);
  if (value !== null && !Number.isFinite(value)) throw new Error('値が数値ではありません。');

  await updateDataPointValue(db, ctx, {
    dataPointId,
    value,
    unitOfMeasure: String(formData.get('unitOfMeasure') ?? ''),
    methodology: (formData.get('methodology') as string) || null,
    changeReason: String(formData.get('changeReason') ?? '画面からの修正'),
  });
  revalidatePath(`/enterprise/data/${dataPointId}`);
  revalidatePath('/enterprise/data');
}

export async function linkEvidenceAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const dataPointId = String(formData.get('dataPointId') ?? '');
  const pageRaw = String(formData.get('page') ?? '').trim();

  await withUserFacingError(`/enterprise/data/${dataPointId}`, async () => {
    // ページは正の整数のみ。数字以外は NaN のまま保存されて黙って消え、
    // 小数は Supabase Mode で型エラーになる。
    let page: number | null = null;
    if (pageRaw !== '') {
      const parsed = Number(pageRaw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new ValidationError('ページは 1 以上の整数で入力してください。');
      }
      page = parsed;
    }

    await linkEvidence(db, ctx, {
      dataPointId,
      fileVersionId: String(formData.get('fileVersionId') ?? ''),
      page,
      cellRef: (formData.get('cellRef') as string) || null,
      note: (formData.get('note') as string) || null,
    });
    revalidatePath(`/enterprise/data/${dataPointId}`);
    revalidatePath('/enterprise/evidence');
  });
}

export async function uploadEvidenceAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  assertCan(ctx, 'enterprise.evidence.write');
  const db = await getDb();

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) throw new Error('ファイルを選択してください。');

  await storeNewFile(db, ctx, {
    bucket: 'evidence-private',
    scope: 'evidence',
    originalName: file.name,
    mimeType: file.type || 'application/octet-stream',
    bytes: new Uint8Array(await file.arrayBuffer()),
    reportingPeriodId: (formData.get('reportingPeriodId') as string) || null,
    documentType: (formData.get('documentType') as string) || null,
  });

  revalidatePath('/enterprise/evidence');
}

// ----------------------------------------------------------------------
// CDP / CSRD（質問詳細ビューを共有するため、両フレームワークの画面を再検証する）
// ----------------------------------------------------------------------

function revalidateDisclosure(itemId: string | null): void {
  for (const base of ['/enterprise/disclosures/cdp', '/enterprise/disclosures/csrd']) {
    if (itemId) revalidatePath(`${base}/${itemId}`);
    revalidatePath(base);
  }
}

export async function generateCdpDraftAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const responseId = String(formData.get('responseId') ?? '');
  const response = await db.findById('disclosureResponses', responseId);

  await generateDisclosureDraft(db, ctx, responseId);

  revalidateDisclosure(response?.itemId ?? null);
}

export async function saveCdpResponseAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const responseId = String(formData.get('responseId') ?? '');
  const numericRaw = String(formData.get('answerNumeric') ?? '').replace(/,/g, '');
  const answerNumeric = numericRaw === '' ? null : Number(numericRaw);
  // 数値として読めない入力を黙って null に落とすと、入力した値が消える。
  // 空欄（未入力）と「数値でない文字列」は区別して、後者は理由を返す。
  if (numericRaw !== '' && !Number.isFinite(answerNumeric)) {
    throw new AuthorizationError('数値欄には数値を入力してください（例: 1234.5）。');
  }

  await saveDisclosureResponse(db, ctx, {
    responseId,
    answerText: (formData.get('answerText') as string) ?? '',
    answerNumeric,
    answerChoice: formData.getAll('answerChoice').map(String).filter(Boolean),
    aiRunId: (formData.get('aiRunId') as string) || null,
    editedFromAi: formData.get('editedFromAi') === 'true',
    carryForwardDecision:
      (formData.get('carryForwardDecision') as 'reuse' | 'update' | 'new') || null,
  });

  const response = await db.findById('disclosureResponses', responseId);
  revalidateDisclosure(response?.itemId ?? null);
}

/**
 * 検証で出た指摘の原因を AI に説明させる（AI-P1 異常値の説明）。
 *
 * AI は指摘するだけで、値の修正も検証結果の解消も行わない。
 * 結果は ai_runs に残るので、`?explain=<runId>` で同じ画面から読み直せる。
 */
export async function explainAnomaliesAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const dataPointId = String(formData.get('dataPointId') ?? '');

  const { explainDataPointAnomalies } = await import('@/lib/services/anomaly-explanation');
  const { run } = await explainDataPointAnomalies(db, ctx, dataPointId);

  revalidatePath(`/enterprise/data/${dataPointId}`);
  redirect(`/enterprise/data/${dataPointId}?explain=${run.id}`);
}

/**
 * 開示質問と指標の対応候補を AI に出させる（AI-P1 CDP 質問マッピング）。
 * 候補を出すだけで、マッピングの確定は人が行う。
 */
export async function runQuestionMappingAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const frameworkKey = String(formData.get('frameworkKey') ?? 'cdp') as FrameworkKey;

  const shell = await loadEnterpriseShell();
  const { runQuestionMapping } = await import('@/lib/services/ai-assist');
  await withUserFacingError(`/enterprise/disclosures/${frameworkKey}`, async () => {
    const { run } = await runQuestionMapping(
      db,
      ctx,
      frameworkKey,
      shell.currentPeriod,
      shell.periods,
    );
    revalidatePath(`/enterprise/disclosures/${frameworkKey}`);
    redirect(`/enterprise/disclosures/${frameworkKey}?mapping=${run.id}`);
  });
}

/**
 * Data Point に紐付けられそうな Evidence を AI に探させる（AI-P1 Evidence 自動マッピング）。
 * 候補を出すだけで、紐付けは人が「紐付ける」を押して確定する。
 */
export async function suggestEvidenceAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const dataPointId = String(formData.get('dataPointId') ?? '');

  const { suggestEvidenceForDataPoint } = await import('@/lib/services/ai-assist');
  await withUserFacingError(`/enterprise/data/${dataPointId}`, async () => {
    const { run } = await suggestEvidenceForDataPoint(db, ctx, dataPointId);
    revalidatePath(`/enterprise/data/${dataPointId}`);
    redirect(`/enterprise/data/${dataPointId}?evidence=${run.id}`);
  });
}

export async function rejectAiDraftAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const aiRunId = String(formData.get('aiRunId') ?? '');
  await recordAiDecision(db, ctx, aiRunId, 'rejected', (formData.get('comment') as string) || null);

  // 質問詳細も再検証する。以前は一覧しか revalidate しておらず、
  // Reject を押した当の画面が更新されないため「押しても何も起きない」ように見えていた。
  const itemId = String(formData.get('itemId') ?? '');
  revalidateDisclosure(itemId || null);
  revalidatePath('/enterprise/ai');
}

export async function transitionCdpResponseAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const responseId = String(formData.get('responseId') ?? '');
  const to = String(formData.get('to') ?? '') as ResponseStatus;

  const response = await transitionDisclosureResponse(db, ctx, responseId, to);

  revalidateDisclosure(response.itemId);
}

// ----------------------------------------------------------------------
// 監査法人への許諾
// ----------------------------------------------------------------------

/**
 * 監査法人へのアクセス許諾を新規に付与する。
 *
 * 企業と監査法人の唯一の接続点は engagements と client_access_grants だけなので、
 * ここが無いと新しい保証契約でデータを一切共有できない（CLAUDE.md §0.2）。
 * 付与できるのは企業側の権限を持つ人だけで、対象が自社のものであることも確認する。
 */
export async function createGrantAction(formData: FormData): Promise<void> {
  await withUserFacingError('/enterprise/settings', async () => {
    const ctx = await requireEnterpriseContext();
    assertCan(ctx, 'enterprise.grant.manage');
    const db = await getDb();

    const engagementId = String(formData.get('engagementId') ?? '');
    const subjectType = String(formData.get('subjectType') ?? '') as GrantSubjectType;
    const subjectId = String(formData.get('subjectId') ?? '');
    const includesEvidence = formData.get('includesEvidence') === 'on';

    if (!engagementId || !subjectType || !subjectId) {
      throw new AuthorizationError('案件・種別・対象をすべて選んでください。');
    }
    if (!GRANT_SUBJECT_TYPES.includes(subjectType)) {
      throw new AuthorizationError('許諾の種別が不正です。');
    }

    // 案件はフォーム由来。**自社がクライアントの案件か**を必ず確認する。
    const engagement = await db.findById('engagements', engagementId);
    if (!engagement || engagement.clientOrganizationId !== ctx.workspace.organizationId) {
      throw new NotFoundError('保証契約が見つかりません。');
    }

    // 対象が「その種別のもので、かつ自社のもの」であることを確認する。
    // 画面は 3 種別をまとめて 1 つのセレクトに並べているため、
    // 種別と対象の組み合わせはここで必ず検証する。
    const organizationId = ctx.workspace.organizationId;
    const subjectExists = async (): Promise<boolean> => {
      if (subjectType === 'metric') {
        const rows = await db.select('metrics', {
          where: { id: subjectId, organizationId },
          limit: 1,
        });
        return rows.length > 0;
      }
      if (subjectType === 'organization_unit') {
        const rows = await db.select('units', {
          where: { id: subjectId, organizationId },
          limit: 1,
        });
        return rows.length > 0;
      }
      if (subjectType === 'reporting_period') {
        const rows = await db.select('periods', {
          where: { id: subjectId, organizationId },
          limit: 1,
        });
        return rows.length > 0;
      }
      return false;
    };
    if (!(await subjectExists())) {
      throw new AuthorizationError('選んだ種別と対象の組み合わせが正しくありません。');
    }

    // 同じ対象の有効な許諾が既にあるなら二重に作らない（二重送信対策も兼ねる）
    const existing = await db.select('grants', {
      where: { engagementId, subjectType, subjectId, revokedAt: { isNull: true } },
      limit: 1,
    });
    if (existing.length > 0) {
      if (existing[0]!.includesEvidence !== includesEvidence) {
        await db.update('grants', existing[0]!.id, {
          includesEvidence,
          updatedAt: new Date().toISOString(),
        });
      }
      revalidatePath('/enterprise/settings');
      return;
    }

    const now = new Date().toISOString();
    const id = fid('client_access_grant', `${engagementId}/${subjectType}/${subjectId}/${now}`);
    await db.insert('grants', [
      {
        id,
        engagementId,
        clientOrganizationId: ctx.workspace.organizationId,
        assuranceFirmId: engagement.assuranceFirmId,
        subjectType,
        subjectId,
        includesEvidence,
        grantedBy: ctx.userId,
        grantedAt: now,
        revokedBy: null,
        revokedAt: null,
        note: null,
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
    ]);

    const { recordAuditEvent } = await import('@/lib/audit/logger');
    await recordAuditEvent(db, ctx, {
      eventType: 'access_grant_created',
      resourceType: 'client_access_grant',
      resourceId: id,
      engagementId,
      afterSummary: `${subjectType} / ${subjectId}${includesEvidence ? '（Evidence 共有あり）' : ''}`,
    });

    revalidatePath('/enterprise/settings');
  });
}

export async function toggleGrantAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  assertCan(ctx, 'enterprise.grant.manage');
  const db = await getDb();

  const grantId = (formData.get('grantId') as string) || null;
  const revoke = formData.get('revoke') === 'true';
  const now = new Date().toISOString();

  // grantId はフォーム由来。**自社が付与した許諾かどうか**を必ず確認する。
  // これが無いと、他社の許諾を取り消して監査法人のアクセスを止められてしまう。
  if (grantId) {
    const grant = await db.findById('grants', grantId);
    if (!grant || grant.clientOrganizationId !== ctx.workspace.organizationId) {
      throw new NotFoundError('許諾が見つかりません。');
    }
  }

  if (grantId && revoke) {
    await db.update('grants', grantId, { revokedAt: now, revokedBy: ctx.userId, updatedAt: now });
    const { recordAuditEvent } = await import('@/lib/audit/logger');
    await recordAuditEvent(db, ctx, {
      eventType: 'access_grant_revoked',
      resourceType: 'client_access_grant',
      resourceId: grantId,
    });
  } else if (grantId) {
    await db.update('grants', grantId, { revokedAt: null, revokedBy: null, updatedAt: now });
    const { recordAuditEvent } = await import('@/lib/audit/logger');
    await recordAuditEvent(db, ctx, {
      eventType: 'access_grant_created',
      resourceType: 'client_access_grant',
      resourceId: grantId,
    });
  }

  revalidatePath('/enterprise/settings');
}

// ----------------------------------------------------------------------
// PBC 回答（企業側）
// ----------------------------------------------------------------------

export async function respondPbcAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  assertCan(ctx, 'enterprise.pbc.respond');
  const db = await getDb();

  const requestId = String(formData.get('requestId') ?? '');
  const request = await db.findById('pbcRequests', requestId);
  if (!request || request.clientOrganizationId !== ctx.workspace.organizationId) {
    throw new Error('資料依頼が見つかりません。');
  }

  const body = String(formData.get('body') ?? '').trim();
  if (!body) throw new Error('回答内容を入力してください。');

  const now = new Date().toISOString();
  const fileVersionIds: Uuid[] = [];

  const file = formData.get('file');
  if (file instanceof File && file.size > 0) {
    const stored = await storeNewFile(db, ctx, {
      bucket: 'evidence-private',
      scope: 'evidence',
      originalName: file.name,
      mimeType: file.type || 'application/octet-stream',
      bytes: new Uint8Array(await file.arrayBuffer()),
      documentType: 'PBC 提出資料',
    });
    fileVersionIds.push(stored.version.id);
  }

  await db.insert('pbcResponses', [
    {
      id: fid('pbc_response', `${requestId}/${now}`),
      requestId,
      engagementId: request.engagementId,
      clientOrganizationId: request.clientOrganizationId,
      body,
      fileVersionIds,
      submittedBy: ctx.userId,
      submittedAt: now,
      decision: null,
      decidedBy: null,
      decidedAt: null,
      rejectReason: null,
    },
  ]);
  await db.update('pbcRequests', requestId, { status: 'submitted', updatedAt: now });

  const { recordAuditEvent } = await import('@/lib/audit/logger');
  await recordAuditEvent(db, ctx, {
    eventType: 'pbc_submitted',
    resourceType: 'pbc_request',
    resourceId: requestId,
    engagementId: request.engagementId,
  });

  revalidatePath('/enterprise/workflows');
}

// ----------------------------------------------------------------------
// マスターデータ（指標・組織）
// ----------------------------------------------------------------------

export async function createMetricAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  await withUserFacingError('/enterprise/organizations', async () => {
    await createMetricDefinition(db, ctx, parseMetricInput(formGetter(formData)));
    revalidatePath('/enterprise/organizations');
    revalidatePath('/enterprise/settings');
  });
}

export async function updateMetricAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const metricId = String(formData.get('metricId') ?? '');
  await withUserFacingError('/enterprise/organizations', async () => {
    await updateMetricDefinition(db, ctx, metricId, parseMetricInput(formGetter(formData)));
    revalidatePath('/enterprise/organizations');
    revalidatePath('/enterprise/settings');
  });
}

/** 報告年度を作る。作れないと翌年度の収集・開示に入れない。 */
export async function createReportingPeriodAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const { createReportingPeriod } = await import('@/lib/services/master-data');

  await withUserFacingError('/enterprise/organizations', async () => {
    await createReportingPeriod(db, ctx, {
      code: String(formData.get('code') ?? ''),
      label: String(formData.get('label') ?? ''),
      startDate: String(formData.get('startDate') ?? ''),
      endDate: String(formData.get('endDate') ?? ''),
      status: String(formData.get('status') ?? 'planning') as PeriodStatus,
      submissionDueDate: (formData.get('submissionDueDate') as string) || null,
    });
    revalidatePath('/enterprise/organizations');
  });
}

export async function createUnitAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  await createOrganizationUnit(db, ctx, parseOrganizationUnitInput(formGetter(formData)));
  revalidatePath('/enterprise/organizations');
}

export async function updateUnitAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const unitId = String(formData.get('unitId') ?? '');
  await updateOrganizationUnit(db, ctx, unitId, parseOrganizationUnitInput(formGetter(formData)));
  revalidatePath('/enterprise/organizations');
}

export async function createCampaignAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  await createCollectionCampaign(db, ctx, {
    name: String(formData.get('name') ?? ''),
    reportingPeriodId: String(formData.get('reportingPeriodId') ?? ''),
    dueDate: String(formData.get('dueDate') ?? ''),
    description: (formData.get('description') as string) || null,
    unitIds: formData.getAll('unitIds').map(String),
    metricIds: formData.getAll('metricIds').map(String),
    ownerUserId: (formData.get('ownerUserId') as string) || null,
  });
  revalidatePath('/enterprise/organizations');
}

// ----------------------------------------------------------------------
// 開示回答の整合チェック（CDP-P0-006）
// ----------------------------------------------------------------------

export async function runConsistencyCheckAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const shell = await loadEnterpriseShell();
  const frameworkKey = String(formData.get('framework') ?? 'cdp') as FrameworkKey;

  const { run } = await runDisclosureConsistencyCheck(
    db,
    ctx,
    frameworkKey,
    shell.currentPeriod,
    shell.periods,
  );

  revalidatePath(`/enterprise/disclosures/${frameworkKey}`);
  revalidatePath('/enterprise/ai');
  // 結果は URL State で持つ（再読込しても同じ結果を読み直せる）
  redirect(`/enterprise/disclosures/${frameworkKey}?check=${run.id}`);
}

// ----------------------------------------------------------------------
// 適用質問判定（CDP-P0-002）
// ----------------------------------------------------------------------

export async function evaluateApplicabilityAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const shell = await loadEnterpriseShell();
  const frameworkKey = String(formData.get('framework') ?? 'cdp') as FrameworkKey;

  await evaluateApplicability(db, ctx, frameworkKey, shell.currentPeriod);

  revalidatePath(`/enterprise/disclosures/${frameworkKey}`);
  redirect(`/enterprise/disclosures/${frameworkKey}?applicability=1`);
}

// ----------------------------------------------------------------------
// 過去回答の Import（CDP-P0-003）
// ----------------------------------------------------------------------

/**
 * アップロードされたファイルを保存し、プレビュー画面へ送る。
 *
 * 解析結果をセッションへ持たず、**保存した原本を毎回読み直して解析する**。
 * こうすると再読込・共有・監査法人への説明のいずれでも同じ結果になり、
 * 取り込み元の原本も残る（保証手続で「何を取り込んだか」を示せる）。
 */
export async function previewDisclosureImportAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  assertCan(ctx, 'enterprise.disclosure.write');
  const db = await getDb();

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    throw new Error('ファイルを選択してください。');
  }
  const targetPeriodId = String(formData.get('targetPeriodId') ?? '');

  const stored = await storeNewFile(db, ctx, {
    bucket: 'evidence-private',
    scope: 'enterprise-original',
    originalName: file.name,
    mimeType: file.type || 'application/octet-stream',
    bytes: new Uint8Array(await file.arrayBuffer()),
    reportingPeriodId: targetPeriodId || null,
    documentType: 'past_disclosure_answers',
  });

  const params = new URLSearchParams({ file: stored.version.id, targetPeriodId });
  redirect(`/enterprise/disclosures/cdp/import?${params.toString()}`);
}

export async function confirmDisclosureImportAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();

  const targetPeriodId = String(formData.get('targetPeriodId') ?? '');
  const currentPeriodId = String(formData.get('currentPeriodId') ?? '');
  const selections = formData
    .getAll('selected')
    .map(String)
    .map((itemId) => ({
      itemId,
      answerText: String(formData.get(`answer:${itemId}`) ?? ''),
    }))
    .filter((s) => s.itemId && s.answerText);

  if (selections.length === 0) throw new Error('取り込む行を 1 つ以上選んでください。');

  const result = await confirmDisclosureImport(db, ctx, {
    targetPeriodId,
    currentPeriodId,
    selections,
  });

  revalidatePath('/enterprise/disclosures/cdp');
  redirect(
    `/enterprise/disclosures/cdp?imported=${result.created + result.updated}&linked=${result.linkedToCurrent}`,
  );
}

// ----------------------------------------------------------------------
// AI インサイト（機能追加要望 ④）
// ----------------------------------------------------------------------

export async function runInsightDiscoveryAction(): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const shell = await loadEnterpriseShell();

  const { run } = await runInsightDiscovery(db, ctx, shell.currentPeriod, shell.periods);

  revalidatePath('/enterprise/ai');
  redirect(`/enterprise/ai?insight=${run.id}`);
}

// ----------------------------------------------------------------------
// コメント・メンション（WF-P0-002）
// ----------------------------------------------------------------------

export async function addCommentAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const targetType = String(formData.get('targetType') ?? '') as
    'data_point' | 'disclosure_response';
  const targetId = String(formData.get('targetId') ?? '');
  const href = String(formData.get('href') ?? '');

  await addComment(db, ctx, {
    targetType,
    targetId,
    body: String(formData.get('body') ?? ''),
    // 通知の遷移先はサーバー側で組み立て直す（フォーム値をそのまま信じない）
    href:
      targetType === 'data_point'
        ? `/enterprise/data/${targetId}`
        : (safeAppLinkOrNull(href) ?? '/enterprise/disclosures/cdp'),
  });

  if (targetType === 'data_point') {
    revalidatePath(`/enterprise/data/${targetId}`);
  } else {
    revalidateDisclosure(null);
  }
}

// ----------------------------------------------------------------------
// データ入力の 4 手段（DATA-P0-004）: 前年度複製・コピペ表入力
// ----------------------------------------------------------------------

export async function carryForwardAction(): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const shell = await loadEnterpriseShell();

  const result = await carryForwardFromPreviousPeriod(db, ctx, shell.currentPeriod, shell.periods);

  revalidatePath('/enterprise/data');
  revalidatePath('/enterprise/dashboard');
  redirect(`/enterprise/data?flash=carried&count=${result.created}`);
}

export async function pasteImportAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const shell = await loadEnterpriseShell();

  const pasted = String(formData.get('pasted') ?? '').trim();
  if (!pasted) throw new Error('貼り付ける表データを入力してください。');
  if (pasted.length > 500_000) throw new Error('貼り付けデータが大きすぎます（500KB まで）。');

  // Excel からのコピーはタブ区切りで入る。既存の取込パイプラインへ
  // 仮想ファイルとして渡し、AI 仕分け・プレビュー・確定を同じ経路で通す
  const job = await createIngestionJob(db, ctx, {
    reportingPeriodId: shell.currentPeriod.id,
    unitId: null,
    idempotencyKey: contentHash(`paste|${ctx.userId}|${pasted}`),
    files: [
      {
        name: 'クリップボード貼り付け.tsv',
        type: 'text/tab-separated-values',
        bytes: new TextEncoder().encode(pasted),
      },
    ],
  });

  revalidatePath('/enterprise/imports');
  redirect(`/enterprise/imports/${job.id}`);
}

// ----------------------------------------------------------------------
// AI Copilot 対話（AI-P0-001）
// ----------------------------------------------------------------------

/**
 * Copilot への質問。**回答をそのまま返す**（リダイレクトしない）。
 *
 * Demo Mode の状態はプロセスのメモリにしか無いため（known-limitations D-3）、
 * `?chat=<id>` へリダイレクトして読み直す方式だと、Vercel で別インスタンスに
 * 当たったときに回答が表示されないまま終わってしまう。
 * 呼び出し側（クライアント）が戻り値を保持して描画する。
 */
export async function askCopilotAction(formData: FormData): Promise<{
  conversationId: string;
  turn: {
    runId: string;
    question: string;
    answer: string;
    confidence: number;
    provider: 'openai' | 'mock';
    references: Array<{ label: string; link: string | null }>;
  };
}> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const shell = await loadEnterpriseShell();

  const { conversationId, turn } = await askCopilot(
    db,
    ctx,
    {
      question: String(formData.get('question') ?? ''),
      conversationId: (formData.get('conversationId') as string) || null,
    },
    shell.currentPeriod,
    shell.periods,
  );

  // Provenance 一覧（同じ画面の下部）を更新する
  revalidatePath('/enterprise/ai');
  return {
    conversationId,
    turn: {
      runId: turn.runId,
      question: turn.question,
      answer: turn.answer,
      confidence: turn.confidence,
      provider: turn.provider,
      references: turn.references,
    },
  };
}

// ----------------------------------------------------------------------
// メンバー招待（AUTH-P0-001。外部メール送信なし＝アプリ内リンク発行）
// ----------------------------------------------------------------------

export async function createInvitationAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  await createInvitation(db, ctx, {
    email: String(formData.get('email') ?? ''),
    roleKeys: formData.getAll('roleKeys').map(String) as RoleKey[],
  });
  revalidatePath('/enterprise/settings');
}

export async function revokeInvitationAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  await revokeInvitation(db, ctx, String(formData.get('invitationId') ?? ''));
  revalidatePath('/enterprise/settings');
}

export async function issueResetLinkAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const email = String(formData.get('email') ?? '');
  const { headers } = await import('next/headers');
  const host = (await headers()).get('host') ?? 'localhost:3000';
  const origin = `${host.includes('localhost') || host.startsWith('127.') ? 'http' : 'https'}://${host}`;
  const link = await issuePasswordResetLink(db, ctx, email, origin);
  // リンクは URL パラメータではなく一時 Cookie で受け渡す（履歴・ログへ残さない）
  const { cookies } = await import('next/headers');
  (await cookies()).set('t4d.reset-link', link, {
    // 対象アカウントのパスワードを変更できる資格情報そのもの。JS からは読ませない
    // （管理者は DevTools か画面の表示からコピーする）。
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/enterprise/settings',
    maxAge: 120,
  });
  revalidatePath('/enterprise/settings');
  redirect('/enterprise/settings?reset=issued');
}

/**
 * マテリアリティ評価の登録・更新（SSBJ 開示の起点）。
 * 重要と評価する場合は理由を必須にしている（後から根拠を問われるため）。
 */
/**
 * マテリアリティ操作の結果。
 *
 * 入力の誤り（理由未入力など）は ?error= のリダイレクトで画面トップに出すのではなく、
 * この戻り値で**操作したフォームのすぐそば**に出す。どの行のどの入力が悪いのかを、
 * 手を動かした場所で伝えるため。
 */
export type MaterialityActionState = { ok: true } | { ok: false; message: string } | null;

function revalidateMateriality(): void {
  revalidatePath('/enterprise/disclosures/ssbj');
  revalidatePath('/enterprise/disclosures/ssbj/settings');
}

/** 例外を「フォームのそばに出す文言」へ変換する共通処理 */
async function runMaterialityAction(run: () => Promise<void>): Promise<MaterialityActionState> {
  try {
    await run();
    revalidateMateriality();
    return { ok: true };
  } catch (error) {
    if (isUserFacingError(error)) return { ok: false, message: error.message };
    throw error;
  }
}

/** 課題の追加（自由記述 → 区分の選択を経て登録） */
export async function addMaterialityTopicAction(
  _prev: MaterialityActionState,
  formData: FormData,
): Promise<MaterialityActionState> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const shell = await loadEnterpriseShell();
  const { addMaterialityTopic } = await import('@/lib/services/materiality');
  return runMaterialityAction(async () => {
    await addMaterialityTopic(db, ctx, shell.metrics, {
      reportingPeriodId: String(formData.get('reportingPeriodId') ?? ''),
      title: String(formData.get('title') ?? ''),
      description: String(formData.get('description') ?? ''),
      category: String(formData.get('category') ?? ''),
      metricCodes: formData.getAll('metricCodes').map(String),
    });
  });
}

/** 課題の編集（名前・区分） */
export async function updateMaterialityTopicAction(
  _prev: MaterialityActionState,
  formData: FormData,
): Promise<MaterialityActionState> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const { updateMaterialityTopic } = await import('@/lib/services/materiality');
  return runMaterialityAction(async () => {
    await updateMaterialityTopic(db, ctx, {
      topicId: String(formData.get('topicId') ?? ''),
      title: String(formData.get('title') ?? ''),
      description: String(formData.get('description') ?? ''),
      category: String(formData.get('category') ?? ''),
    });
  });
}

/** 課題の削除（論理削除） */
export async function deleteMaterialityTopicAction(
  _prev: MaterialityActionState,
  formData: FormData,
): Promise<MaterialityActionState> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const { deleteMaterialityTopic } = await import('@/lib/services/materiality');
  return runMaterialityAction(async () => {
    await deleteMaterialityTopic(db, ctx, String(formData.get('topicId') ?? ''));
  });
}

/** 課題のリスク・機会の記入（SSBJ 一般-12(1)・一般-14 の識別。戦略開示の材料） */
export async function saveMaterialityRiskOppAction(
  _prev: MaterialityActionState,
  formData: FormData,
): Promise<MaterialityActionState> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const shell = await loadEnterpriseShell();
  const { saveTopicRiskOpportunity } = await import('@/lib/services/materiality');
  return runMaterialityAction(async () => {
    await saveTopicRiskOpportunity(db, ctx, shell.metrics, {
      topicId: String(formData.get('topicId') ?? ''),
      risks: String(formData.get('risks') ?? ''),
      opportunities: String(formData.get('opportunities') ?? ''),
    });
  });
}

/** 課題の評価（評価理由は必須） */
export async function assessMaterialityTopicAction(
  _prev: MaterialityActionState,
  formData: FormData,
): Promise<MaterialityActionState> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const { assessMaterialityTopic } = await import('@/lib/services/materiality');
  return runMaterialityAction(async () => {
    await assessMaterialityTopic(db, ctx, {
      topicId: String(formData.get('topicId') ?? ''),
      materiality: String(formData.get('materiality') ?? 'not_assessed'),
      rationale: String(formData.get('rationale') ?? ''),
    });
  });
}

// ----------------------------------------------------------------------
// SSBJ ギャップ分析
// ----------------------------------------------------------------------

/** SSBJ の各画面を再検証する（詳細を更新したら一覧と全体状況にも効かせる） */
function revalidateSsbj(itemId: string | null): void {
  revalidatePath('/enterprise/disclosures/ssbj');
  revalidatePath('/enterprise/disclosures/ssbj/settings');
  revalidatePath('/enterprise/disclosures/ssbj/requirements');
  revalidatePath('/enterprise/disclosures/ssbj/plans');
  revalidatePath('/enterprise/disclosures/ssbj/collection');
  if (itemId) revalidatePath(`/enterprise/disclosures/ssbj/requirements/${itemId}`);
}

/** 手順 1: マテリアリティ・分析条件の設定（保存） */
export async function saveSsbjSettingsAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const back = '/enterprise/disclosures/ssbj/settings';
  await withUserFacingError(back, async () => {
    await saveSsbjSettings(db, ctx, {
      reportingPeriodId: String(formData.get('reportingPeriodId') ?? ''),
      applyGeneral: formData.get('applyGeneral') === 'on',
      applyClimate: formData.get('applyClimate') === 'on',
      applyPractical: formData.get('applyPractical') === 'on',
      firstTimeAdoption: formData.get('firstTimeAdoption') === 'on',
      consolidationScope:
        formData.get('consolidationScope') === 'custom' ? 'custom' : 'same_as_financial',
      consolidationNote: String(formData.get('consolidationNote') ?? ''),
      // 未指定は空配列＝全社。個別に選んだときだけ絞り込む
      includedUnitIds: formData.getAll('includedUnitIds').map((v) => String(v)),
      valueChainScope: String(
        formData.get('valueChainScope') ?? 'not_decided',
      ) as SsbjValueChainScope,
      valueChainNote: String(formData.get('valueChainNote') ?? ''),
    });
  });
  revalidateSsbj(null);
  redirect(`${back}?saved=1`);
}

/** 開示ドラフト: 人工知能に節の草案を書かせる */
export async function generateSsbjDraftAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const shell = await loadEnterpriseShell();
  const back = '/enterprise/disclosures/ssbj/draft';
  const area = String(formData.get('area') ?? 'governance') as SsbjArea;

  await withUserFacingError(back, async () => {
    await generateSsbjDraft(db, ctx, shell.currentPeriod, area);
  });
  revalidatePath(back);
  redirect(`${back}?generated=${area}`);
}

/** 開示ドラフト: 草案の本文を人が直す */
export async function saveSsbjDraftAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const back = '/enterprise/disclosures/ssbj/draft';

  await withUserFacingError(back, async () => {
    await saveSsbjDraftBody(
      db,
      ctx,
      String(formData.get('draftId') ?? ''),
      String(formData.get('body') ?? ''),
    );
  });
  revalidatePath(back);
  redirect(`${back}?saved=1`);
}

/** 開示ドラフト: 草案を確定する（人の操作でのみ確定する） */
export async function confirmSsbjDraftAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const back = '/enterprise/disclosures/ssbj/draft';

  await withUserFacingError(back, async () => {
    await confirmSsbjDraft(db, ctx, String(formData.get('draftId') ?? ''));
  });
  revalidatePath(back);
  redirect(`${back}?confirmed=1`);
}

/** 手順 1: 分析条件の確定（人の操作でのみ確定する） */
export async function confirmSsbjSettingsAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const shell = await loadEnterpriseShell();
  const back = '/enterprise/disclosures/ssbj/settings';
  await withUserFacingError(back, async () => {
    await confirmSsbjSettings(
      db,
      ctx,
      String(formData.get('reportingPeriodId') ?? ''),
      shell.metrics,
    );
  });
  revalidateSsbj(null);
  redirect('/enterprise/disclosures/ssbj?confirmed=1');
}

/** 手順 3: 対象判定・重要性判断 */
export async function saveSsbjScopeAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const itemId = String(formData.get('itemId') ?? '');
  await withUserFacingError(`/enterprise/disclosures/ssbj/requirements/${itemId}`, async () => {
    await saveSsbjScope(db, ctx, {
      assessmentId: String(formData.get('assessmentId') ?? ''),
      applicability:
        formData.get('applicability') === 'not_applicable' ? 'not_applicable' : 'applicable',
      applicabilityReason: String(formData.get('applicabilityReason') ?? ''),
      materiality: String(formData.get('materiality') ?? 'not_assessed') as
        'material' | 'not_material' | 'not_assessed',
      materialityReason: String(formData.get('materialityReason') ?? ''),
      ownerDepartment: String(formData.get('ownerDepartment') ?? ''),
    });
  });
  revalidateSsbj(itemId);
}

/** 手順 4: 人工知能によるギャップ分析 */
export async function runSsbjGapAnalysisAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const itemId = String(formData.get('itemId') ?? '');
  await withUserFacingError(`/enterprise/disclosures/ssbj/requirements/${itemId}`, async () => {
    await runSsbjGapAnalysis(db, ctx, String(formData.get('assessmentId') ?? ''));
  });
  revalidateSsbj(itemId);
}

/** 手順 5: 担当者による確認（ここで最終判定が入る） */
export async function saveSsbjReviewAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const itemId = String(formData.get('itemId') ?? '');
  const coverage = (name: string) =>
    String(formData.get(name) ?? 'unconfirmed') as
      'covered' | 'mostly_covered' | 'partial' | 'not_covered' | 'unconfirmed';
  await withUserFacingError(`/enterprise/disclosures/ssbj/requirements/${itemId}`, async () => {
    await saveSsbjReview(db, ctx, {
      assessmentId: String(formData.get('assessmentId') ?? ''),
      decision: formData.get('decision') === 'approve_ai' ? 'approve_ai' : 'modify',
      disclosureStatus: coverage('disclosureStatus'),
      dataStatus: coverage('dataStatus'),
      processStatus: coverage('processStatus'),
      comment: String(formData.get('comment') ?? ''),
    });
  });
  revalidateSsbj(itemId);
}

/** 手順 7: 対応計画に追加 */
export async function createSsbjActionPlanAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const itemId = String(formData.get('itemId') ?? '');
  const dueDate = String(formData.get('dueDate') ?? '');
  await withUserFacingError(`/enterprise/disclosures/ssbj/requirements/${itemId}`, async () => {
    await createActionPlan(db, ctx, {
      assessmentId: String(formData.get('assessmentId') ?? ''),
      gapKind: String(formData.get('gapKind') ?? 'disclosure') as 'disclosure' | 'data' | 'process',
      title: String(formData.get('title') ?? ''),
      detail: String(formData.get('detail') ?? ''),
      actionType: String(formData.get('actionType') ?? 'disclosure_addition') as
        | 'data_collection'
        | 'disclosure_addition'
        | 'governance'
        | 'policy'
        | 'internal_control'
        | 'system'
        | 'calculation_method',
      department: String(formData.get('department') ?? ''),
      assigneeUserId: (formData.get('assigneeUserId') as string) || null,
      dueDate: dueDate === '' ? null : dueDate,
      priority: String(formData.get('priority') ?? 'medium') as 'high' | 'medium' | 'low',
    });
  });
  revalidateSsbj(itemId);
}

/** 対応計画の更新（担当・期限・対応状況） */
export async function updateSsbjActionPlanAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const dueDate = String(formData.get('dueDate') ?? '');
  await withUserFacingError('/enterprise/disclosures/ssbj/plans', async () => {
    await updateActionPlan(db, ctx, {
      planId: String(formData.get('planId') ?? ''),
      status: String(formData.get('status') ?? 'not_started') as
        'not_started' | 'in_progress' | 'in_review' | 'done',
      department: String(formData.get('department') ?? ''),
      assigneeUserId: (formData.get('assigneeUserId') as string) || null,
      dueDate: dueDate === '' ? null : dueDate,
      priority: String(formData.get('priority') ?? 'medium') as 'high' | 'medium' | 'low',
    });
  });
  revalidateSsbj(null);
}

/** 手順 8: データ収集項目を作成 */
export async function createSsbjDataCollectionAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  await withUserFacingError('/enterprise/disclosures/ssbj/plans', async () => {
    await createDataCollectionItem(db, ctx, {
      planId: String(formData.get('planId') ?? ''),
      metricCode: String(formData.get('metricCode') ?? ''),
      metricName: String(formData.get('metricName') ?? ''),
      unit: String(formData.get('unit') ?? ''),
      unitId: String(formData.get('unitId') ?? ''),
      ownerUserId: (formData.get('ownerUserId') as string) || null,
      dueDate: String(formData.get('dueDate') ?? ''),
      requiresEvidence: formData.get('requiresEvidence') === 'on',
      department: String(formData.get('department') ?? ''),
    });
  });
  revalidateSsbj(null);
}

/**
 * 前年度評価の引き継ぎ。
 * 毎年ゼロから評価し直さず、前年の判断を持ち越したうえで
 * 「今年度に再評価が必要な要求事項」に理由を付ける。
 */
export async function carryOverSsbjAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const periodId = String(formData.get('reportingPeriodId') ?? '');

  await withUserFacingError('/enterprise/disclosures/ssbj', async () => {
    const periods = await db.select('periods', {
      where: { organizationId: ctx.workspace.organizationId },
    });
    const current = periods.find((p) => p.id === periodId);
    if (!current) throw new NotFoundError('報告期間が見つかりません。');
    const previous = periods
      .filter((p) => p.startDate < current.startDate)
      .sort((a, b) => (a.startDate < b.startDate ? 1 : -1))[0];
    if (!previous) {
      throw new ValidationError('前年度の報告期間がないため、引き継ぐ評価がありません。');
    }
    await carryOverSsbjAssessments(db, ctx, current, previous);
  });
  revalidateSsbj(null);
}
