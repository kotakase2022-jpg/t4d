import 'server-only';

import { getSelectedPeriodId } from '@/lib/auth/preferences';
import {
  requireAssuranceSession,
  requireEnterpriseSession,
  type ResolvedSession,
} from '@/lib/auth/session';
import { getDb } from '@/lib/repositories';
import type { DbClient } from '@/lib/repositories/types';
import type {
  AuthorizationContext,
  Engagement,
  MetricDefinition,
  OrganizationUnit,
  ReportingPeriod,
} from '@/types/domain';

export interface EnterpriseShell {
  db: DbClient;
  session: ResolvedSession;
  ctx: AuthorizationContext;
  periods: ReportingPeriod[];
  currentPeriod: ReportingPeriod;
  units: OrganizationUnit[];
  metrics: MetricDefinition[];
  unreadNotifications: number;
}

/** 企業ワークスペースの共通コンテキスト（Layout / 各ページで再利用）。 */
export async function loadEnterpriseShell(): Promise<EnterpriseShell> {
  const session = await requireEnterpriseSession();
  const ctx = session.context;
  const db = await getDb();
  const organizationId = ctx.workspace.organizationId;

  const periods = await db.select('periods', {
    where: { organizationId },
    orderBy: { column: 'code', dir: 'desc' },
  });
  const selectedId = await getSelectedPeriodId();
  const currentPeriod =
    periods.find((p) => p.id === selectedId) ??
    periods.find((p) => p.status === 'collecting') ??
    periods[0];

  if (!currentPeriod) {
    throw new Error('報告期間が 1 件も登録されていません。設定画面から作成してください。');
  }

  const [units, metrics, unreadNotifications] = await Promise.all([
    db.select('units', {
      where: { organizationId, deletedAt: { isNull: true } },
      orderBy: { column: 'sortOrder' },
    }),
    db.select('metrics', {
      where: { organizationId, deletedAt: { isNull: true } },
      orderBy: { column: 'code' },
    }),
    db.count('notifications', {
      where: { organizationId, userId: ctx.userId, readAt: { isNull: true } },
    }),
  ]);

  return { db, session, ctx, periods, currentPeriod, units, metrics, unreadNotifications };
}

export interface AssuranceShell {
  db: DbClient;
  session: ResolvedSession;
  ctx: AuthorizationContext;
  /** ログインユーザーが Engagement Member である案件だけ。 */
  engagements: Engagement[];
  unreadNotifications: number;
}

/** 監査法人ワークスペースの共通コンテキスト。 */
export async function loadAssuranceShell(): Promise<AssuranceShell> {
  const session = await requireAssuranceSession();
  const ctx = session.context;
  const db = await getDb();

  // Engagement Member である案件のみ。
  // assurance_admin であっても未アサイン案件は含めない（assumptions C-1）。
  const engagements =
    ctx.engagementIds.length === 0
      ? []
      : await db.select('engagements', {
          where: {
            id: { in: ctx.engagementIds },
            assuranceFirmId: ctx.workspace.organizationId,
          },
          orderBy: { column: 'deadlineDate' },
        });

  const unreadNotifications = await db.count('notifications', {
    where: {
      organizationId: ctx.workspace.organizationId,
      userId: ctx.userId,
      readAt: { isNull: true },
    },
  });

  return { db, session, ctx, engagements, unreadNotifications };
}

export function toWorkspaceChoices(session: ResolvedSession) {
  return session.workspaces.map((w) => ({
    organizationId: w.organizationId,
    organizationName: w.organizationName,
    organizationType: w.organizationType,
  }));
}
