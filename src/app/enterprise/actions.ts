'use server';

import { safeAppLinkOrNull } from '@/lib/security/safe-link';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { recordAiDecision } from '@/lib/ai';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { assertCan, NotFoundError } from '@/lib/authorization/can';
import { getAppMode } from '@/lib/config';
import { contentHash, fid } from '@/lib/fixtures/ids';
import { confirmIngestionJob, createIngestionJob, type RowDecision } from '@/lib/imports/service';
import { getDb } from '@/lib/repositories';
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
import type {
  DataPointStatus,
  FrameworkKey,
  MaterialityLevel,
  ResponseStatus,
  RoleKey,
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

export async function uploadFilesAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();

  const reportingPeriodId = String(formData.get('reportingPeriodId') ?? '');
  const unitIdRaw = String(formData.get('unitId') ?? '');
  const unitId = unitIdRaw && unitIdRaw !== 'auto' ? unitIdRaw : null;
  const files = formData.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);

  if (files.length === 0) {
    throw new Error('ファイルが選択されていません。');
  }

  const payload = await Promise.all(
    files.map(async (file) => ({
      name: file.name,
      type: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })),
  );

  const idempotencyKey = contentHash(
    `${ctx.userId}|${reportingPeriodId}|${payload.map((f) => `${f.name}:${f.bytes.byteLength}`).join('|')}`,
  );

  const job = await createIngestionJob(db, ctx, {
    reportingPeriodId,
    unitId,
    files: payload,
    idempotencyKey,
  });

  // Demo Mode は状態がプロセスのメモリにしか無い（known-limitations D-3）。
  // Vercel のようにリクエストごとにインスタンスが変わる環境では、
  // 別リクエストのポーリング（GET /api/jobs/[jobId]）がジョブを見つけられず
  // 404 のまま解析が始まらない。この経路だけは**同じリクエスト内で**処理を終わらせる。
  // Supabase Mode は DB が共有されるため、従来どおり非同期ジョブのままにする。
  if (getAppMode() === 'demo') {
    const { processIngestionJob } = await import('@/lib/imports/service');
    try {
      await processIngestionJob(db, ctx, job.id);
    } catch {
      // 解析に失敗してもジョブ画面へは遷移させる（画面側がファイル単位の失敗を表示する）
    }
  }

  revalidatePath('/enterprise/imports');
  redirect(`/enterprise/imports/${job.id}?created=1`);
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

  await confirmIngestionJob(db, ctx, jobId, decisions);
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

export async function bulkTransitionAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const ids = formData.getAll('selected').map(String);
  const to = String(formData.get('to') ?? '') as DataPointStatus;
  if (ids.length === 0) return;
  await bulkTransition(db, ctx, ids, to);
  revalidatePath('/enterprise/data');
  revalidatePath('/enterprise/dashboard');
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
  const pageRaw = String(formData.get('page') ?? '');
  await linkEvidence(db, ctx, {
    dataPointId,
    fileVersionId: String(formData.get('fileVersionId') ?? ''),
    page: pageRaw ? Number(pageRaw) : null,
    cellRef: (formData.get('cellRef') as string) || null,
    note: (formData.get('note') as string) || null,
  });
  revalidatePath(`/enterprise/data/${dataPointId}`);
  revalidatePath('/enterprise/evidence');
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

  await saveDisclosureResponse(db, ctx, {
    responseId,
    answerText: (formData.get('answerText') as string) ?? '',
    answerNumeric: answerNumeric !== null && Number.isFinite(answerNumeric) ? answerNumeric : null,
    answerChoice: formData.getAll('answerChoice').map(String).filter(Boolean),
    aiRunId: (formData.get('aiRunId') as string) || null,
    editedFromAi: formData.get('editedFromAi') === 'true',
    carryForwardDecision:
      (formData.get('carryForwardDecision') as 'reuse' | 'update' | 'new') || null,
  });

  const response = await db.findById('disclosureResponses', responseId);
  revalidateDisclosure(response?.itemId ?? null);
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
  await createMetricDefinition(db, ctx, parseMetricInput(formGetter(formData)));
  revalidatePath('/enterprise/organizations');
  revalidatePath('/enterprise/settings');
}

export async function updateMetricAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const metricId = String(formData.get('metricId') ?? '');
  await updateMetricDefinition(db, ctx, metricId, parseMetricInput(formGetter(formData)));
  revalidatePath('/enterprise/organizations');
  revalidatePath('/enterprise/settings');
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
export async function saveMaterialityTopicAction(formData: FormData): Promise<void> {
  const ctx = await requireEnterpriseContext();
  const db = await getDb();
  const { saveMaterialityTopic } = await import('@/lib/services/materiality');
  await saveMaterialityTopic(db, ctx, {
    reportingPeriodId: String(formData.get('reportingPeriodId') ?? ''),
    topicKey: String(formData.get('topicKey') ?? ''),
    materiality: String(formData.get('materiality') ?? 'not_assessed') as MaterialityLevel,
    rationale: String(formData.get('rationale') ?? ''),
  });
  revalidatePath('/enterprise/disclosures/ssbj');
}
