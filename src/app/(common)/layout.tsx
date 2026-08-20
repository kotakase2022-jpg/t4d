import { AppShell } from '@/components/shared/app-shell';
import { requireSession } from '@/lib/auth/session';
import { getSelectedPeriodId } from '@/lib/auth/preferences';
import { getDb } from '@/lib/repositories';
import { toWorkspaceChoices } from '@/lib/services/shell';

/**
 * 共通ルート（/notifications, /profile）。
 * 企業／監査法人どちらのワークスペースでも同じ Shell で表示する。
 */
export default async function CommonLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const ctx = session.context;
  const db = await getDb();
  const organizationId = ctx.workspace.organizationId;
  const isEnterprise = ctx.workspace.organizationType === 'enterprise';

  const periods = isEnterprise
    ? await db.select('periods', {
        where: { organizationId },
        orderBy: { column: 'code', dir: 'desc' },
      })
    : [];
  const selectedPeriodId = await getSelectedPeriodId();

  const engagements =
    !isEnterprise && ctx.engagementIds.length > 0
      ? await db.select('engagements', {
          where: { id: { in: ctx.engagementIds }, assuranceFirmId: organizationId },
          orderBy: { column: 'deadlineDate' },
        })
      : [];

  const unreadNotifications = await db.count('notifications', {
    where: { organizationId, userId: ctx.userId, readAt: { isNull: true } },
  });

  return (
    <AppShell
      ctx={ctx}
      workspaces={toWorkspaceChoices(session)}
      periods={periods.map((p) => ({ id: p.id, label: p.label, code: p.code }))}
      currentPeriodId={periods.find((p) => p.id === selectedPeriodId)?.id ?? periods[0]?.id}
      engagements={engagements.map((e) => ({ id: e.id, code: e.code, name: e.name }))}
      unreadNotifications={unreadNotifications}
    >
      {children}
    </AppShell>
  );
}
