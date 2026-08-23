'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { runAi } from '@/lib/ai';
import { recordAuditEvent } from '@/lib/audit/logger';
import { requireAssuranceContext } from '@/lib/auth/session';
import {
  assertCan,
  assertEngagementMember,
  AuthorizationError,
  NotFoundError,
} from '@/lib/authorization/can';
import { fid } from '@/lib/fixtures/ids';
import { getDb } from '@/lib/repositories';
import {
  createSample,
  createSignoff,
  createSnapshot,
  detectSnapshotChanges,
  loadEngagement,
} from '@/lib/services/assurance';
import { ASSURANCE_ROLES } from '@/types/domain';
import type {
  AssuranceLevel,
  AssuranceRole,
  Engagement,
  SamplingMethod,
  SignoffStage,
} from '@/types/domain';

/** 監査法人ワークスペースの Server Actions。 */

function base(engagementId: string): string {
  return `/assurance/engagements/${engagementId}`;
}

// ----------------------------------------------------------------------
// Snapshot
// ----------------------------------------------------------------------

/**
 * フォームの値を取り出す。
 *
 * `|| 既存値` にすると空文字も falsy なので、消したはずの結論や調書番号が
 * 旧値へ巻き戻る。**項目が送られていない**ときだけ据え置き、
 * 空文字で送られたら「消した」として null にする。
 */
function fieldOr(formData: FormData, name: string, current: string | null): string | null {
  const raw = formData.get(name);
  if (raw === null) return current;
  const text = String(raw).trim();
  return text === '' ? null : text;
}

export async function createSnapshotAction(formData: FormData): Promise<void> {
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const engagementId = String(formData.get('engagementId') ?? '');
  const label = String(formData.get('label') ?? '').trim() || `SNAP-${Date.now()}`;
  await createSnapshot(db, ctx, engagementId, label);
  revalidatePath(`${base(engagementId)}/data-room`);
  revalidatePath(`${base(engagementId)}/overview`);
}

export async function assessSnapshotChangeAction(formData: FormData): Promise<void> {
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const engagementId = String(formData.get('engagementId') ?? '');
  const snapshotItemId = String(formData.get('snapshotItemId') ?? '');
  const assessment = String(formData.get('assessment') ?? '') as
    'no_impact' | 'retest_required' | 'issue_raised';

  assertEngagementMember(ctx, engagementId);
  assertCan(ctx, 'assurance.testing.write');

  const snapshots = await db.select('snapshots', {
    where: { engagementId },
    orderBy: { column: 'frozenAt', dir: 'desc' },
    limit: 1,
  });
  const snapshot = snapshots[0];
  if (!snapshot) throw new NotFoundError('Snapshot が見つかりません。');

  const detected = await detectSnapshotChanges(db, ctx, snapshot.id);
  const change = detected.find((c) => c.snapshotItemId === snapshotItemId);
  if (!change) throw new NotFoundError('変更が見つかりません。');

  const stored = await db.select('snapshotChanges', { where: { snapshotItemId } });
  const now = new Date().toISOString();

  if (stored[0]) {
    await db.update('snapshotChanges', stored[0].id, {
      assessment,
      assessedBy: ctx.userId,
      assessedAt: now,
    });
  } else {
    await db.insert('snapshotChanges', [
      { ...change, assessment, assessedBy: ctx.userId, assessedAt: now },
    ]);
  }

  await recordAuditEvent(db, ctx, {
    eventType: 'snapshot_change_detected',
    resourceType: 'snapshot_change',
    resourceId: change.id,
    engagementId,
    afterSummary: `影響評価: ${assessment}`,
  });

  revalidatePath(`${base(engagementId)}/data-room`);
  revalidatePath(`${base(engagementId)}/signoffs`);
}

// ----------------------------------------------------------------------
// サンプリング
// ----------------------------------------------------------------------

export async function createSampleAction(formData: FormData): Promise<void> {
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const engagementId = String(formData.get('engagementId') ?? '');
  const populationId = String(formData.get('populationId') ?? '');
  const method = String(formData.get('method') ?? 'random') as SamplingMethod;
  const targetSize = Number(formData.get('targetSize') ?? 10) || 10;
  const seed = String(formData.get('seed') ?? '').trim() || `SEED-${engagementId.slice(0, 8)}`;
  const keyItemThreshold = Number(formData.get('keyItemThreshold') ?? 0) || undefined;
  const perStratum = Number(formData.get('perStratum') ?? 0) || undefined;

  await createSample(db, ctx, {
    engagementId,
    populationId,
    name: String(formData.get('name') ?? '').trim() || `SMP-${Date.now()}`,
    method,
    seed,
    parameters: {
      targetSize,
      strataKey: 'unit',
      perStratum,
      keyItemThreshold,
      selectedItemIds: formData.getAll('selectedItemIds').map(String),
    },
    rationale: String(formData.get('rationale') ?? '').trim() || '抽出理由未記入',
  });

  revalidatePath(`${base(engagementId)}/sampling`);
  revalidatePath(`${base(engagementId)}/testing`);
}

// ----------------------------------------------------------------------
// Testing
// ----------------------------------------------------------------------

export async function recordTestResultAction(formData: FormData): Promise<void> {
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const engagementId = String(formData.get('engagementId') ?? '');
  const testId = String(formData.get('testId') ?? '');
  const procedureId = String(formData.get('procedureId') ?? '');
  const result = String(formData.get('result') ?? 'pass') as
    'pass' | 'exception' | 'not_applicable';

  assertEngagementMember(ctx, engagementId);
  assertCan(ctx, 'assurance.testing.write');

  const test = await db.findById('tests', testId);
  if (!test || test.engagementId !== engagementId)
    throw new NotFoundError('調書が見つかりません。');

  const recalcRaw = String(formData.get('recalculationResult') ?? '').replace(/,/g, '');
  const recordedRaw = String(formData.get('recordedValue') ?? '').replace(/,/g, '');
  const recalculationResult = recalcRaw === '' ? null : Number(recalcRaw);
  const recordedValue = recordedRaw === '' ? null : Number(recordedRaw);

  const existing = await db.select('testResults', { where: { testId, procedureId }, limit: 1 });
  const now = new Date().toISOString();
  const payload = {
    result,
    recalculationInput: null,
    recalculationResult,
    recordedValue,
    difference:
      recalculationResult !== null && recordedValue !== null
        ? Math.round((recalculationResult - recordedValue) * 1000) / 1000
        : null,
    note: (formData.get('note') as string) || null,
    completedBy: ctx.userId,
    completedAt: now,
  };

  if (existing[0]) {
    await db.update('testResults', existing[0].id, payload);
  } else {
    await db.insert('testResults', [
      {
        id: fid('test_result', `${testId}/${procedureId}`),
        testId,
        procedureId,
        engagementId,
        assuranceFirmId: test.assuranceFirmId,
        ...payload,
      },
    ]);
  }

  await db.update('tests', testId, {
    status:
      result === 'exception'
        ? 'exception'
        : test.status === 'not_started'
          ? 'in_progress'
          : test.status,
    updatedAt: now,
    updatedBy: ctx.userId,
  });

  await recordAuditEvent(db, ctx, {
    eventType: 'procedure_completed',
    resourceType: 'assurance_test',
    resourceId: testId,
    engagementId,
    afterSummary: `手続結果: ${result}`,
  });

  revalidatePath(`${base(engagementId)}/testing`);
}

export async function updateTestAction(formData: FormData): Promise<void> {
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const engagementId = String(formData.get('engagementId') ?? '');
  const testId = String(formData.get('testId') ?? '');
  const action = String(formData.get('action') ?? 'save');

  assertEngagementMember(ctx, engagementId);
  assertCan(ctx, 'assurance.testing.write');

  const test = await db.findById('tests', testId);
  if (!test || test.engagementId !== engagementId)
    throw new NotFoundError('調書が見つかりません。');

  const now = new Date().toISOString();

  if (action === 'prepare') {
    await db.update('tests', testId, {
      status: 'prepared',
      conclusionDraft: fieldOr(formData, 'conclusionDraft', test.conclusionDraft),
      preparedBy: ctx.userId,
      preparedAt: now,
      workpaperRef: fieldOr(formData, 'workpaperRef', test.workpaperRef),
      updatedAt: now,
      updatedBy: ctx.userId,
    });
  } else if (action === 'review') {
    if (!test.preparedBy) throw new Error('作成（Prepared）が完了していません。');
    if (test.preparedBy === ctx.userId) {
      throw new Error('自身が作成した調書を自身でレビューすることはできません。');
    }
    await db.update('tests', testId, {
      status: 'reviewed',
      reviewedBy: ctx.userId,
      reviewedAt: now,
      updatedAt: now,
      updatedBy: ctx.userId,
    });
  } else {
    await db.update('tests', testId, {
      conclusionDraft: fieldOr(formData, 'conclusionDraft', test.conclusionDraft),
      workpaperRef: fieldOr(formData, 'workpaperRef', test.workpaperRef),
      updatedAt: now,
      updatedBy: ctx.userId,
    });
  }

  revalidatePath(`${base(engagementId)}/testing`);
}

// ----------------------------------------------------------------------
// PBC
// ----------------------------------------------------------------------

export async function createPbcAction(formData: FormData): Promise<void> {
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const engagementId = String(formData.get('engagementId') ?? '');
  assertEngagementMember(ctx, engagementId);
  assertCan(ctx, 'assurance.pbc.manage');

  const { engagement } = await loadEngagement(db, ctx, engagementId);
  const existing = await db.select('pbcRequests', { where: { engagementId } });
  const now = new Date().toISOString();
  const code = `PBC-${String(existing.length + 1).padStart(3, '0')}`;

  await db.insert('pbcRequests', [
    {
      id: fid('pbc_request', `${engagementId}/${code}`),
      engagementId,
      assuranceFirmId: engagement.assuranceFirmId,
      clientOrganizationId: engagement.clientOrganizationId,
      code,
      title: String(formData.get('title') ?? '').trim() || '資料依頼',
      description: String(formData.get('description') ?? ''),
      targetType: null,
      targetId: null,
      dueDate: String(formData.get('dueDate') ?? new Date().toISOString().slice(0, 10)),
      priority: String(formData.get('priority') ?? 'medium') as
        'critical' | 'high' | 'medium' | 'low',
      status: 'sent',
      internalNote: (formData.get('internalNote') as string) || null,
      requestedBy: ctx.userId,
      sentAt: now,
      closedAt: null,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    },
  ]);

  await recordAuditEvent(db, ctx, {
    eventType: 'pbc_created',
    resourceType: 'pbc_request',
    resourceId: code,
    engagementId,
  });

  revalidatePath(`${base(engagementId)}/requests`);
}

export async function decidePbcAction(formData: FormData): Promise<void> {
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const engagementId = String(formData.get('engagementId') ?? '');
  const responseId = String(formData.get('responseId') ?? '');
  const decision = String(formData.get('decision') ?? 'accepted') as 'accepted' | 'rejected';

  assertEngagementMember(ctx, engagementId);
  assertCan(ctx, 'assurance.pbc.manage');

  const response = await db.findById('pbcResponses', responseId);
  if (!response || response.engagementId !== engagementId) {
    throw new NotFoundError('回答が見つかりません。');
  }

  const now = new Date().toISOString();
  await db.update('pbcResponses', responseId, {
    decision,
    decidedBy: ctx.userId,
    decidedAt: now,
    rejectReason: decision === 'rejected' ? String(formData.get('rejectReason') ?? '') : null,
  });
  await db.update('pbcRequests', response.requestId, {
    status: decision === 'accepted' ? 'accepted' : 'rejected',
    closedAt: decision === 'accepted' ? now : null,
    updatedAt: now,
  });

  revalidatePath(`${base(engagementId)}/requests`);
  revalidatePath(`${base(engagementId)}/signoffs`);
}

// ----------------------------------------------------------------------
// Issue
// ----------------------------------------------------------------------

export async function createIssueAction(formData: FormData): Promise<void> {
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const engagementId = String(formData.get('engagementId') ?? '');
  assertEngagementMember(ctx, engagementId);
  assertCan(ctx, 'assurance.issue.manage');

  const { engagement } = await loadEngagement(db, ctx, engagementId);
  const existing = await db.select('issues', { where: { engagementId } });
  const now = new Date().toISOString();
  const code = `ISS-${String(existing.length + 1).padStart(3, '0')}`;
  const impactRaw = String(formData.get('quantitativeImpact') ?? '').replace(/,/g, '');

  await db.insert('issues', [
    {
      id: fid('issue', `${engagementId}/${code}`),
      engagementId,
      assuranceFirmId: engagement.assuranceFirmId,
      clientOrganizationId: engagement.clientOrganizationId,
      code,
      title: String(formData.get('title') ?? '').trim() || '指摘事項',
      description: String(formData.get('description') ?? ''),
      affectedMetricId: (formData.get('affectedMetricId') as string) || null,
      affectedSampleItemId: (formData.get('affectedSampleItemId') as string) || null,
      severity: String(formData.get('severity') ?? 'medium') as 'high' | 'medium' | 'low',
      quantitativeImpact: impactRaw === '' ? null : Number(impactRaw),
      quantitativeImpactUnit: (formData.get('quantitativeImpactUnit') as string) || null,
      rootCause: (formData.get('rootCause') as string) || null,
      status: 'open',
      resolution: null,
      reviewerUserId: ctx.userId,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    },
  ]);

  await recordAuditEvent(db, ctx, {
    eventType: 'issue_created',
    resourceType: 'assurance_issue',
    resourceId: code,
    engagementId,
  });

  revalidatePath(`${base(engagementId)}/issues`);
  revalidatePath(`${base(engagementId)}/signoffs`);
}

export async function resolveIssueAction(formData: FormData): Promise<void> {
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const engagementId = String(formData.get('engagementId') ?? '');
  const issueId = String(formData.get('issueId') ?? '');
  const resolution = String(formData.get('resolution') ?? '').trim();

  assertEngagementMember(ctx, engagementId);
  assertCan(ctx, 'assurance.issue.manage');
  if (!resolution) throw new Error('解消内容を入力してください。');

  // engagementId はフォーム由来なので、対象 Issue が**本当にその案件のものか**を必ず確認する。
  // これが無いと、自法人の案件のメンバーであるだけで、閲覧すらできない他法人の
  // Issue を resolved にできてしまう（Sign-off 抑止条件を外部から解除できる）。
  const issue = await db.findById('issues', issueId);
  if (!issue || issue.engagementId !== engagementId) {
    throw new NotFoundError('指摘が見つかりません。');
  }

  const now = new Date().toISOString();
  await db.update('issues', issueId, {
    status: 'resolved',
    resolution,
    resolvedAt: now,
    updatedAt: now,
    updatedBy: ctx.userId,
  });

  await recordAuditEvent(db, ctx, {
    eventType: 'issue_resolved',
    resourceType: 'assurance_issue',
    resourceId: issueId,
    engagementId,
    afterSummary: resolution.slice(0, 200),
  });

  revalidatePath(`${base(engagementId)}/issues`);
  revalidatePath(`${base(engagementId)}/signoffs`);
}

// ----------------------------------------------------------------------
// Review Note
// ----------------------------------------------------------------------

export async function createReviewNoteAction(formData: FormData): Promise<void> {
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const engagementId = String(formData.get('engagementId') ?? '');
  assertEngagementMember(ctx, engagementId);
  assertCan(ctx, 'assurance.review.write');

  const { engagement } = await loadEngagement(db, ctx, engagementId);
  const now = new Date().toISOString();

  await db.insert('reviewNotes', [
    {
      id: fid('review_note', `${engagementId}/${now}`),
      engagementId,
      assuranceFirmId: engagement.assuranceFirmId,
      targetType: 'engagement',
      targetId: engagementId,
      body: String(formData.get('body') ?? '').trim(),
      raisedBy: ctx.userId,
      assignedTo: (formData.get('assignedTo') as string) || null,
      status: 'open',
      // 既定は法人内部限定
      sharedWithClient: formData.get('sharedWithClient') === 'on',
      resolutionComment: null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    },
  ]);

  await recordAuditEvent(db, ctx, {
    eventType: 'review_note_created',
    resourceType: 'review_note',
    engagementId,
  });

  revalidatePath(`${base(engagementId)}/review-notes`);
}

export async function clearReviewNoteAction(formData: FormData): Promise<void> {
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const engagementId = String(formData.get('engagementId') ?? '');
  const noteId = String(formData.get('noteId') ?? '');
  assertEngagementMember(ctx, engagementId);
  assertCan(ctx, 'assurance.review.write');

  // resolveIssueAction と同じ理由で、対象 Note がその案件のものかを確認する
  const note = await db.findById('reviewNotes', noteId);
  if (!note || note.engagementId !== engagementId) {
    throw new NotFoundError('レビュー Note が見つかりません。');
  }

  const now = new Date().toISOString();
  await db.update('reviewNotes', noteId, {
    status: 'cleared',
    resolutionComment: String(formData.get('resolutionComment') ?? ''),
    resolvedAt: now,
    updatedAt: now,
    updatedBy: ctx.userId,
  });

  revalidatePath(`${base(engagementId)}/review-notes`);
}

// ----------------------------------------------------------------------
// Sign-off
// ----------------------------------------------------------------------

export async function createSignoffAction(formData: FormData): Promise<void> {
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const engagementId = String(formData.get('engagementId') ?? '');
  const stage = String(formData.get('stage') ?? 'prepared') as SignoffStage;
  await createSignoff(db, ctx, engagementId, stage, (formData.get('comment') as string) || null);
  revalidatePath(`${base(engagementId)}/signoffs`);
  revalidatePath('/assurance/dashboard');
}

// ----------------------------------------------------------------------
// AI（監査支援）
// ----------------------------------------------------------------------

export async function summarizeChangesAction(formData: FormData): Promise<void> {
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const engagementId = String(formData.get('engagementId') ?? '');
  assertEngagementMember(ctx, engagementId);
  assertCan(ctx, 'assurance.ai.run');

  const { engagement, clientName, periodLabel } = await loadEngagement(db, ctx, engagementId);
  const snapshots = await db.select('snapshots', {
    where: { engagementId },
    orderBy: { column: 'frozenAt', dir: 'desc' },
    limit: 1,
  });
  const snapshot = snapshots[0];
  if (!snapshot) throw new Error('Snapshot が作成されていません。');

  const changes = await detectSnapshotChanges(db, ctx, snapshot.id);
  if (changes.length === 0) throw new Error('Snapshot 固定後の変更はありません。');

  await runAi({
    db,
    ctx,
    engagementId,
    idempotencyKey: `assuranceChangeSummary:${snapshot.id}:${changes.length}`,
    sources: changes.map((c) => ({
      kind: 'snapshot_item' as const,
      id: c.snapshotItemId,
      label: c.beforeSummary,
      locator: null,
      periodLabel: null,
    })),
    invocation: {
      feature: 'assuranceChangeSummary',
      context: {
        organizationName: ctx.workspace.organizationName,
        reportingPeriodLabel: periodLabel,
        engagementLabel: `${engagement.code} ${clientName}`,
      },
      inputReferenceIds: changes.map((c) => c.snapshotItemId),
      input: {
        changes: changes.map((c) => ({
          subject: c.snapshotItemId,
          before: c.beforeSummary,
          after: c.afterSummary,
        })),
      },
    },
  });

  revalidatePath(`${base(engagementId)}/data-room`);
}

// ----------------------------------------------------------------------
// 保証契約そのものの管理（作成・チーム）
// ----------------------------------------------------------------------

/**
 * 新しい保証契約を起票する。
 *
 * 監査法人が契約を受注しても案件を作れないと、Fixture の 1 件を眺めるだけになる。
 * クライアントは **既に取引のある企業**（自法人の既存案件のクライアント）に限る。
 * 全企業の一覧を監査法人へ見せるとテナント分離が崩れるため、ここは広げない。
 */
export async function createEngagementAction(formData: FormData): Promise<void> {
  const ctx = await requireAssuranceContext();
  assertCan(ctx, 'assurance.engagement.manage');
  const db = await getDb();

  const clientOrganizationId = String(formData.get('clientOrganizationId') ?? '');
  const clientReportingPeriodId = String(formData.get('clientReportingPeriodId') ?? '');
  const code = String(formData.get('code') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const assuranceLevel = String(formData.get('assuranceLevel') ?? 'limited') as AssuranceLevel;
  const frameworkKey = String(formData.get('frameworkKey') ?? 'ssbj') as Engagement['frameworkKey'];
  const plannedStartDate = String(formData.get('plannedStartDate') ?? '');
  const deadlineDate = String(formData.get('deadlineDate') ?? '');

  if (!clientOrganizationId || !clientReportingPeriodId || !code || !name) {
    throw new AuthorizationError('クライアント・期間・案件コード・案件名は必須です。');
  }
  if (plannedStartDate && deadlineDate && deadlineDate < plannedStartDate) {
    throw new AuthorizationError('期限は開始日より後の日付にしてください。');
  }

  // 取引のあるクライアントに限る（アサインされている案件から導く）
  const firmId = ctx.workspace.organizationId;
  const existing = await db.select('engagements', { where: { assuranceFirmId: firmId } });
  const knownClients = new Set(
    existing.filter((e) => ctx.engagementIds.includes(e.id)).map((e) => e.clientOrganizationId),
  );
  if (!knownClients.has(clientOrganizationId)) {
    throw new AuthorizationError('取引のあるクライアントを選んでください。');
  }
  // 期間はそのクライアントのものであること
  const periods = await db.select('periods', {
    where: { id: clientReportingPeriodId, organizationId: clientOrganizationId },
    limit: 1,
  });
  if (periods.length === 0) {
    throw new AuthorizationError('選んだ期間はそのクライアントのものではありません。');
  }
  if (existing.some((e) => e.code === code)) {
    throw new AuthorizationError('同じ案件コードが既にあります。');
  }

  const now = new Date().toISOString();
  const engagementId = fid('engagement', `${firmId}/${code}`);
  await db.insert('engagements', [
    {
      id: engagementId,
      assuranceFirmId: firmId,
      clientOrganizationId,
      clientReportingPeriodId,
      code,
      name,
      assuranceLevel,
      frameworkKey,
      status: 'planning',
      plannedStartDate: plannedStartDate || now.slice(0, 10),
      deadlineDate: deadlineDate || now.slice(0, 10),
      partnerUserId: null,
      managerUserId: null,
      materialityBasis: null,
      materialityValue: null,
      materialityUnit: null,
      createdAt: now,
      updatedAt: now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    },
  ]);

  // 起票した本人をメンバーにしないと、自分で作った案件が見えない
  await db.insert('engagementMembers', [
    {
      id: fid('engagement_member', `${engagementId}/${ctx.userId}`),
      engagementId,
      assuranceFirmId: firmId,
      userId: ctx.userId,
      roleKey: 'assurance_manager',
      assignedAt: now,
      assignedBy: ctx.userId,
      removedAt: null,
    },
  ]);

  await recordAuditEvent(db, ctx, {
    eventType: 'data_created',
    resourceType: 'engagement',
    resourceId: engagementId,
    engagementId,
    afterSummary: `${code} ${name}`,
  });

  revalidatePath('/assurance/engagements');
  redirect(`${base(engagementId)}/overview`);
}

/** 案件のチームを変更する（追加・解除） */
export async function assignEngagementMemberAction(formData: FormData): Promise<void> {
  const ctx = await requireAssuranceContext();
  assertCan(ctx, 'assurance.engagement.manage');
  const db = await getDb();

  const engagementId = String(formData.get('engagementId') ?? '');
  assertEngagementMember(ctx, engagementId);

  const engagement = await db.findById('engagements', engagementId);
  if (!engagement || engagement.assuranceFirmId !== ctx.workspace.organizationId) {
    throw new NotFoundError('案件が見つかりません。');
  }

  const remove = String(formData.get('remove') ?? '') === 'true';
  const memberId = String(formData.get('memberId') ?? '');
  const now = new Date().toISOString();

  if (remove) {
    const member = await db.findById('engagementMembers', memberId);
    if (!member || member.engagementId !== engagementId) {
      throw new NotFoundError('メンバーが見つかりません。');
    }
    if (member.userId === ctx.userId) {
      throw new AuthorizationError('自分自身をチームから外すことはできません。');
    }
    await db.update('engagementMembers', memberId, { removedAt: now });
    await recordAuditEvent(db, ctx, {
      eventType: 'data_updated',
      resourceType: 'engagement_member',
      resourceId: memberId,
      engagementId,
      afterSummary: 'チームから解除',
    });
    revalidatePath(`${base(engagementId)}/overview`);
    return;
  }

  const userId = String(formData.get('userId') ?? '');
  const roleKey = String(formData.get('roleKey') ?? '') as AssuranceRole;
  if (!userId || !ASSURANCE_ROLES.includes(roleKey)) {
    throw new AuthorizationError('担当者と役割を選んでください。');
  }

  // 自法人のメンバーだけをアサインできる
  const memberships = await db.select('memberships', {
    where: { organizationId: ctx.workspace.organizationId, userId },
    limit: 1,
  });
  if (memberships.length === 0) {
    throw new AuthorizationError('自法人のメンバーだけをアサインできます。');
  }

  const already = await db.select('engagementMembers', { where: { engagementId, userId } });
  const active = already.find((m) => m.removedAt === null);
  if (active) {
    await db.update('engagementMembers', active.id, { roleKey });
  } else if (already.length > 0) {
    await db.update('engagementMembers', already[0]!.id, { removedAt: null, roleKey });
  } else {
    await db.insert('engagementMembers', [
      {
        id: fid('engagement_member', `${engagementId}/${userId}`),
        engagementId,
        assuranceFirmId: engagement.assuranceFirmId,
        userId,
        roleKey,
        assignedAt: now,
        assignedBy: ctx.userId,
        removedAt: null,
      },
    ]);
  }

  await recordAuditEvent(db, ctx, {
    eventType: 'data_updated',
    resourceType: 'engagement_member',
    resourceId: engagementId,
    engagementId,
    afterSummary: `${roleKey} をアサイン`,
  });

  revalidatePath(`${base(engagementId)}/overview`);
}
