import 'server-only';

import { assertEnterpriseWorkspace, can } from '@/lib/authorization/can';
import { daysUntilJst } from '@/lib/format/datetime';
import { homeProfileOf } from '@/lib/ui/home-profile';
import {
  orderMyWork,
  type MyWorkAttention,
  type MyWorkItem,
  type MyWorkKind,
  type MyWorkModel,
} from '@/lib/ui/my-work';
import type { DbClient, Where } from '@/lib/repositories/types';
import {
  loadDisclosureHome,
  type DisclosureHome,
  type MyTaskKind,
} from '@/lib/services/disclosure-home';
import type {
  AuthorizationContext,
  DataPoint,
  IsoDate,
  PbcStatus,
  ReportingPeriod,
} from '@/types/domain';

/**
 * 役割別ホームの「自分の作業」（plan §1.3・§1.14・§4 B1）。読み取りだけ（書かない）。
 *
 * 同じ事実が絞り込み・ワークフロー・アラート・通知に散らばっていたため、利用者ごとのキューを作る関数が
 * 無かった。既存の読み取り（データの件数・開示ホームの myTasks・資料依頼・取込ジョブ）を組み合わせ、
 * 担当範囲（unitScopeIds）と権限（can）で絞る。他の組織の行は数えない（organizationId で絞る）。
 * 行の CTA の文言とリンク先は、開示ホームの「自分が次に行う作業」と同じものを保つ。
 */

export interface MyWorkInput {
  period: ReportingPeriod;
  /** 業務上の今日（src/lib/clock.ts の businessToday） */
  today: IsoDate;
  /** 同じ画面で読み込み済みの開示ホーム（二重に読まない） */
  disclosureHome?: DisclosureHome;
}

/** 資料依頼のうち、企業が回答する番のもの */
const PBC_AWAITING_CLIENT: readonly PbcStatus[] = ['sent', 'acknowledged', 'rejected', 'overdue'];

/** 期限が近いとみなす日数 */
const DUE_SOON_DAYS = 7;

const MANUSCRIPT_KIND: Record<MyTaskKind, { kind: MyWorkKind; verb: string }> = {
  returned: { kind: 'manuscript-returned', verb: '直す' },
  recheck: { kind: 'manuscript-recheck', verb: '再確認する' },
  missing_info: { kind: 'manuscript-write', verb: '補う' },
  ready_for_review: { kind: 'manuscript-write', verb: 'レビューを依頼する' },
  review: { kind: 'manuscript-review', verb: 'レビューする' },
  final_approval: { kind: 'manuscript-final', verb: '最終承認する' },
};

function withUnits(base: string, unitScopeIds: readonly string[]): string {
  if (unitScopeIds.length === 0) return base;
  return `${base}&${unitScopeIds.map((id) => `unit=${encodeURIComponent(id)}`).join('&')}`;
}

export async function loadMyWork(
  db: DbClient,
  ctx: AuthorizationContext,
  input: MyWorkInput,
): Promise<MyWorkModel> {
  assertEnterpriseWorkspace(ctx);
  const profile = homeProfileOf(ctx);
  const organizationId = ctx.workspace.organizationId;
  const scope = ctx.workspace.unitScopeIds;
  const attention: MyWorkAttention[] = [];
  const items: MyWorkItem[] = [];

  // ---- データ（担当範囲で絞る） ------------------------------------------
  const dataWhere = (extra: Where<DataPoint>): Where<DataPoint> => ({
    organizationId,
    reportingPeriodId: input.period.id,
    deletedAt: { isNull: true },
    ...(scope.length > 0 ? { unitId: { in: [...scope] } } : {}),
    ...extra,
  });
  const canWrite = can(ctx, 'enterprise.data.write');
  const canReview = can(ctx, 'enterprise.data.review');
  const canApprove = can(ctx, 'enterprise.data.approve');
  const [returned, toEnter, toReview, toApprove, changedAfterApproval] = await Promise.all([
    canWrite ? db.count('dataPoints', { where: dataWhere({ status: 'returned' }) }) : 0,
    canWrite
      ? db.count('dataPoints', { where: dataWhere({ status: { in: ['not_started', 'draft'] } }) })
      : 0,
    canReview ? db.count('dataPoints', { where: dataWhere({ status: 'submitted' }) }) : 0,
    canApprove ? db.count('dataPoints', { where: dataWhere({ status: 'in_review' }) }) : 0,
    canReview || canApprove
      ? db.count('dataPoints', { where: dataWhere({ changedAfterApproval: true }) })
      : 0,
  ]);

  if (returned > 0) {
    const href = withUnits('/enterprise/data?status=returned', scope);
    attention.push({
      key: 'data-returned',
      label: '差し戻されたデータ',
      count: returned,
      href,
      semantic: 'returned',
    });
    items.push({
      key: 'data-returned',
      kind: 'data-returned',
      verb: '直す',
      target: `差し戻されたデータ ${returned} 件`,
      dueDate: input.period.submissionDueDate,
      daysUntilDue: daysUntilJst(input.period.submissionDueDate, input.today),
      reason: '差戻しの理由はデータの詳細のコメントにあります。',
      cta: { label: '差戻しを直す', href },
    });
  }
  if (toEnter > 0) {
    items.push({
      key: 'data-enter',
      kind: 'data-enter',
      verb: '入力する',
      target: `未着手・入力中のデータ ${toEnter} 件`,
      dueDate: input.period.submissionDueDate,
      daysUntilDue: daysUntilJst(input.period.submissionDueDate, input.today),
      reason: null,
      cta: {
        label: 'データを入力する',
        href: withUnits('/enterprise/data?status=not_started&status=draft', scope),
      },
    });
  }
  if (toReview > 0) {
    items.push({
      key: 'data-review',
      kind: 'data-review',
      verb: '確認する',
      target: `提出済みのデータ ${toReview} 件`,
      dueDate: null,
      daysUntilDue: null,
      reason: null,
      cta: { label: 'データを確認する', href: '/enterprise/data?status=submitted' },
    });
  }
  if (toApprove > 0) {
    items.push({
      key: 'data-approve',
      kind: 'data-approve',
      verb: '承認する',
      target: `レビュー中のデータ ${toApprove} 件`,
      dueDate: null,
      daysUntilDue: null,
      // 承認は一覧・詳細で人が押す（ここからは実行しない）
      reason: null,
      cta: { label: 'データを承認する', href: '/enterprise/data?status=in_review' },
    });
  }
  if (changedAfterApproval > 0) {
    attention.push({
      key: 'data-changed-after-approval',
      label: '承認後に変更されたデータ',
      count: changedAfterApproval,
      href: '/enterprise/data?flag=changed_after_approval',
      semantic: 'blocked',
    });
  }

  // ---- 取込 ----------------------------------------------------------------
  if (can(ctx, 'enterprise.import.run')) {
    const jobs = await db.count('ingestionJobs', {
      where: {
        organizationId,
        reportingPeriodId: input.period.id,
        status: 'needs_review',
        ...(scope.length > 0 ? { unitId: { in: [...scope] } } : {}),
      },
    });
    if (jobs > 0) {
      const href = '/enterprise/imports?job=needs_review';
      attention.push({
        key: 'import-needs-review',
        label: '確認待ちの取込',
        count: jobs,
        href,
        semantic: 'pending',
      });
      items.push({
        key: 'import-check',
        kind: 'import-check',
        verb: '確認する',
        target: `確認待ちの取込 ${jobs} 件`,
        dueDate: null,
        daysUntilDue: null,
        reason: '取込の内容を確認して確定すると、非財務データへ反映されます。',
        cta: { label: '取込を確認する', href },
      });
    }
  }

  // ---- 資料依頼（PBC） -------------------------------------------------------
  if (can(ctx, 'enterprise.pbc.respond')) {
    const requests = await db.select('pbcRequests', {
      where: { clientOrganizationId: organizationId, status: { in: [...PBC_AWAITING_CLIENT] } },
      orderBy: { column: 'dueDate' },
    });
    const overdue = requests.filter((r) => r.status === 'overdue').length;
    const dueSoon = requests.filter((r) => {
      const days = daysUntilJst(r.dueDate, input.today);
      return r.status !== 'overdue' && days !== null && days >= 0 && days <= DUE_SOON_DAYS;
    }).length;
    if (overdue > 0) {
      attention.push({
        key: 'pbc-overdue',
        label: '期限を過ぎた資料依頼',
        count: overdue,
        href: '/enterprise/workflows#pbc',
        semantic: 'error',
      });
    }
    if (dueSoon > 0) {
      attention.push({
        key: 'pbc-due-soon',
        label: `期限が ${DUE_SOON_DAYS} 日以内の資料依頼`,
        count: dueSoon,
        href: '/enterprise/workflows#pbc',
        semantic: 'pending',
      });
    }
    for (const request of requests) {
      items.push({
        key: `pbc-${request.id}`,
        kind: 'pbc-respond',
        verb: '回答する',
        target: `${request.code} ${request.title}`,
        context: '監査法人からの資料依頼（PBC）',
        dueDate: request.dueDate,
        daysUntilDue: daysUntilJst(request.dueDate, input.today),
        reason:
          request.status === 'rejected' ? '差し戻されました。回答を直して提出してください。' : null,
        cta: { label: '資料依頼に回答する', href: '/enterprise/workflows#pbc' },
      });
    }
  }

  // ---- 開示（原稿） ----------------------------------------------------------
  if (can(ctx, 'enterprise.disclosure.read')) {
    const home =
      input.disclosureHome ??
      (await loadDisclosureHome(db, ctx, { period: input.period, today: input.today }));
    for (const task of home.myTasks) {
      const mapped = MANUSCRIPT_KIND[task.kind];
      items.push({
        key: `manuscript-${task.key}`,
        kind: mapped.kind,
        verb: mapped.verb,
        target: task.itemName,
        context: [task.frameworkLabel, task.frameworkNote].filter(Boolean).join(' ・ ') || null,
        dueDate: task.dueDate,
        daysUntilDue: task.daysUntilDue,
        reason: task.blockerReason,
        cta: task.cta,
      });
    }
    if (home.cards && home.cards.changedAfterApproval.count > 0) {
      attention.push({
        key: 'manuscript-changed-after-approval',
        label: '承認後に引用先が更新された原稿',
        count: home.cards.changedAfterApproval.count,
        href: home.cards.changedAfterApproval.href,
        semantic: 'blocked',
      });
    }
    if (home.project && home.progress && home.progress.notAssessedCount > 0) {
      attention.push({
        key: 'applicability-not-assessed',
        label: '適用判断が未確定の基準',
        count: home.progress.notAssessedCount,
        href: `${home.project.href}?tab=settings`,
        semantic: 'pending',
      });
    }
  }

  // ---- 管理者の準備（招待の期限） ---------------------------------------------
  if (can(ctx, 'enterprise.member.manage')) {
    const invitations = await db.select('invitations', {
      where: { organizationId, status: 'pending' },
    });
    const expiring = invitations.filter((inv) => {
      const days = daysUntilJst(inv.expiresAt.slice(0, 10), input.today);
      return days !== null && days >= 0 && days <= DUE_SOON_DAYS;
    }).length;
    if (expiring > 0) {
      items.push({
        key: 'admin-invitations',
        kind: 'admin-prepare',
        verb: '確認する',
        target: `期限が近い招待 ${expiring} 件`,
        dueDate: null,
        daysUntilDue: null,
        reason: `期限が ${DUE_SOON_DAYS} 日以内です。必要なら再発行してください。`,
        cta: { label: '招待を確認する', href: '/enterprise/settings?tab=invitations' },
      });
    }
  }

  return { profile, attention, items: orderMyWork(profile, items) };
}
