import 'server-only';

import { randomUUID } from 'node:crypto';
import { recordAuditEvent } from '@/lib/audit/logger';
import {
  NotFoundError,
  assertAssuranceWorkspace,
  assertCan,
  assertEngagementMember,
  assertEnterpriseWorkspace,
  canAny,
} from '@/lib/authorization/can';
import {
  buildSharedReportCopy,
  parseSharedReportCopy,
  sharedReportCopyHash,
  type SharedReportCopyContent,
} from '@/lib/domain/report-copy';
import { ValidationError } from '@/lib/errors/user-facing';
import { loadOwnedSnapshot, verifySnapshotIntegrity } from '@/lib/services/report-snapshot';
import { sharedReportCopyWriter } from '@/lib/repositories/privileged';
import type { DbClient } from '@/lib/repositories/types';
import { isUuid } from '@/lib/validation/uuid';
import type { AuthorizationContext, Engagement, SharedReportCopy, Uuid } from '@/types/domain';

/**
 * 承認済みレポートの保証側への共有（トライアル対応 NF-20 の中核）。
 *
 *  - 共有は企業側の行為（enterprise.grant.manage）。社内承認済み（approved）のスナップショットだけを、
 *    自社がクライアントで有効な許諾のある案件へ共有する。同じ案件へ同じスナップショットを二重に共有しない
 *  - 共有のときに保証側用の写し（社内コメント・社内向け確認事項を除き、対外用と同じ伏せ字）を作る
 *    （domain/report-copy.ts）。report_snapshots に監査法人の SELECT を足さない
 *  - 写しはサーバーが承認版から作る。利用者の JWT には写しの INSERT を許さず（0059）、Supabase Mode は
 *    Service Role で書く（利用者が自分で書いた内容・ハッシュの写しを「社内承認済み版」として見せない）
 *  - 取り下げると保証側から見えなくなる（写しは消さない。追記専用・取り下げの日時だけを入れる。
 *    DB の SELECT ポリシーも案件のメンバーには共有中の写しだけを返す）
 *  - 保証側は案件のメンバーだけが読める（assurance.engagement.read＋メンバー）。取り下げた写しは「見つからない」
 *  - 社内承認であり第三者保証ではない（画面は internal-approval の注記を常に出す）
 *
 * 権限は ID の検索より先に確かめる（権限の無い人に ID の有無で応答を変えない）。
 * Demo Mode は RLS が無いため、DB の RLS・トリガ（0050）と同じ条件をここでも判定する。
 */

export interface SharedReportListEntry {
  copy: SharedReportCopy;
  /** 取り下げ済みか */
  withdrawn: boolean;
}

async function loadOwnEngagement(
  db: DbClient,
  ctx: AuthorizationContext,
  engagementId: Uuid,
): Promise<Engagement> {
  const engagement = isUuid(engagementId) ? await db.findById('engagements', engagementId) : null;
  if (!engagement || engagement.clientOrganizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('案件が見つかりません。');
  }
  return engagement;
}

async function hasActiveGrant(db: DbClient, engagementId: Uuid): Promise<boolean> {
  const grants = await db.select('grants', {
    where: { engagementId, revokedAt: { isNull: true } },
  });
  return grants.length > 0;
}

/** 承認済みスナップショットを案件へ共有し、保証側用の写しを作る */
export async function shareReportSnapshot(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { snapshotId: Uuid; engagementId: Uuid },
): Promise<SharedReportCopy> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.grant.manage');
  const snapshot = await loadOwnedSnapshot(db, ctx, input.snapshotId);
  if (snapshot.snapshotKind !== 'approved') {
    throw new ValidationError('社内承認済みのスナップショットだけを保証側へ共有できます。');
  }
  if (!verifySnapshotIntegrity(snapshot)) {
    throw new ValidationError(
      'スナップショットの内容ハッシュが一致しないため共有できません（内容が変わった可能性があります）。',
    );
  }
  const engagement = await loadOwnEngagement(db, ctx, input.engagementId);
  if (!(await hasActiveGrant(db, engagement.id))) {
    throw new ValidationError(
      'この案件には有効なアクセス許諾がありません。許諾を付与してから共有してください。',
    );
  }
  const existing = await db.select('sharedReportCopies', {
    where: { engagementId: engagement.id, snapshotId: snapshot.id, withdrawnAt: { isNull: true } },
  });
  if (existing.length > 0) {
    throw new ValidationError('このスナップショットは既にこの案件へ共有しています。');
  }

  const content = buildSharedReportCopy(snapshot);
  const now = new Date().toISOString();
  const row: SharedReportCopy = {
    id: randomUUID(),
    engagementId: engagement.id,
    assuranceFirmId: engagement.assuranceFirmId,
    clientOrganizationId: ctx.workspace.organizationId,
    snapshotId: snapshot.id,
    snapshotContentHash: snapshot.contentHash,
    copy: content as unknown as Record<string, unknown>,
    copyHash: sharedReportCopyHash(content),
    // 共有した人は本人（クライアントから受け取らない。DB は許諾の管理の権限を確かめる）
    sharedBy: ctx.userId,
    sharedAt: now,
    withdrawnAt: null,
    withdrawnBy: null,
  };
  // 権限・許諾・承認版の整合を確かめ、写しを承認版から作った後にだけ書く
  const writer = await sharedReportCopyWriter(db);
  const [inserted] = await writer.insert('sharedReportCopies', [row]);
  await recordAuditEvent(db, ctx, {
    eventType: 'report_shared',
    resourceType: 'shared_report_copy',
    resourceId: row.id,
    engagementId: engagement.id,
    afterSummary: `${snapshot.label} No.${snapshot.snapshotNo} を案件 ${engagement.code} へ共有`,
    metadata: {
      snapshotId: snapshot.id,
      snapshotContentHash: snapshot.contentHash,
      copyHash: row.copyHash,
    },
  });
  return inserted ?? row;
}

/** 共有を取り下げる（写しは消さない。保証側から見えなくなる） */
export async function withdrawSharedReport(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { copyId: Uuid },
): Promise<SharedReportCopy> {
  assertEnterpriseWorkspace(ctx);
  assertCan(ctx, 'enterprise.grant.manage');
  const copy = isUuid(input.copyId) ? await db.findById('sharedReportCopies', input.copyId) : null;
  if (!copy || copy.clientOrganizationId !== ctx.workspace.organizationId) {
    throw new NotFoundError('共有したレポートが見つかりません。');
  }
  if (copy.withdrawnAt !== null) {
    throw new ValidationError('この共有は既に取り下げています。');
  }
  const now = new Date().toISOString();
  const updated = await db.update('sharedReportCopies', copy.id, {
    withdrawnAt: now,
    withdrawnBy: ctx.userId,
  });
  await recordAuditEvent(db, ctx, {
    eventType: 'report_share_withdrawn',
    resourceType: 'shared_report_copy',
    resourceId: copy.id,
    engagementId: copy.engagementId,
    afterSummary: '開示レポートの共有を取り下げ',
    metadata: { snapshotId: copy.snapshotId, copyHash: copy.copyHash },
  });
  return updated;
}

/**
 * 企業側の一覧（自社が共有した写し。取り下げ済みも含む）。snapshotId で絞れる。
 * 閲覧は開示の閲覧か許諾の管理のどちらかの権限
 */
export async function listSharedReportsForClient(
  db: DbClient,
  ctx: AuthorizationContext,
  options: { snapshotId?: Uuid | null; engagementId?: Uuid | null } = {},
): Promise<SharedReportListEntry[]> {
  assertEnterpriseWorkspace(ctx);
  if (!canAny(ctx, ['enterprise.disclosure.read', 'enterprise.grant.manage'])) {
    assertCan(ctx, 'enterprise.disclosure.read');
  }
  const rows = await db.select('sharedReportCopies', {
    where: {
      clientOrganizationId: ctx.workspace.organizationId,
      ...(options.snapshotId ? { snapshotId: options.snapshotId } : {}),
      ...(options.engagementId ? { engagementId: options.engagementId } : {}),
    },
    orderBy: [
      { column: 'sharedAt', dir: 'desc' },
      { column: 'id', dir: 'desc' },
    ],
  });
  return rows.map((copy) => ({ copy, withdrawn: copy.withdrawnAt !== null }));
}

/** 保証側の一覧（案件のメンバーだけ。取り下げた写しは出さない） */
export async function listSharedReports(
  db: DbClient,
  ctx: AuthorizationContext,
  engagementId: Uuid,
): Promise<SharedReportCopy[]> {
  assertAssuranceWorkspace(ctx);
  assertCan(ctx, 'assurance.engagement.read');
  assertEngagementMember(ctx, engagementId);
  return db.select('sharedReportCopies', {
    where: { engagementId, withdrawnAt: { isNull: true } },
    orderBy: [
      { column: 'sharedAt', dir: 'desc' },
      { column: 'id', dir: 'desc' },
    ],
  });
}

export interface LoadedSharedReport {
  copy: SharedReportCopy;
  content: SharedReportCopyContent;
  /** 保存された写しが作成時のハッシュと一致するか（一致しなければ画面は内容を出さない） */
  integrityOk: boolean;
}

/** 保証側が写しを開く（案件のメンバーだけ。他の案件・取り下げ済みは「見つからない」） */
export async function loadSharedReport(
  db: DbClient,
  ctx: AuthorizationContext,
  input: { engagementId: Uuid; copyId: Uuid },
): Promise<LoadedSharedReport> {
  assertAssuranceWorkspace(ctx);
  assertCan(ctx, 'assurance.engagement.read');
  assertEngagementMember(ctx, input.engagementId);
  const copy = isUuid(input.copyId) ? await db.findById('sharedReportCopies', input.copyId) : null;
  if (!copy || copy.engagementId !== input.engagementId || copy.withdrawnAt !== null) {
    throw new NotFoundError('開示レポートが見つかりません。');
  }
  const content = parseSharedReportCopy(copy.copy);
  if (!content) throw new NotFoundError('開示レポートが見つかりません。');
  return { copy, content, integrityOk: sharedReportCopyHash(content) === copy.copyHash };
}
