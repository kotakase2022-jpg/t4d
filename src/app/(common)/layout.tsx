import { AppShell } from '@/components/shared/app-shell';
import { listDemoRoleChoices } from '@/lib/auth/demo-role';
import { requireSession } from '@/lib/auth/session';
import { getSelectedPeriodId } from '@/lib/auth/selected-period';
import { getDb } from '@/lib/repositories';
import { loadHeaderProjects } from '@/lib/services/disclosure-home';
import { getFeatureSettings } from '@/lib/services/feature-settings';
import { toWorkspaceChoices } from '@/lib/services/shell';

/**
 * 共通ルート（/notifications, /profile）。
 * 企業／監査法人どちらのワークスペースでも同じ Shell で表示する。
 * メニュー（開示優先モード）・ヘッダーのプロジェクト・役割切替は、企業・監査法人のレイアウトと同じものを
 * 渡す（通知を開いた途端にメニューが従来の形に戻る・役割切替が消える食い違いを無くす。plan §1.4 N-14）
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

  const [unreadNotifications, featureSettings, projects, demoRoleChoices] = await Promise.all([
    db.count('notifications', {
      where: { organizationId, userId: ctx.userId, readAt: { isNull: true } },
    }),
    getFeatureSettings(db, ctx),
    loadHeaderProjects(db, ctx),
    listDemoRoleChoices(db, ctx),
  ]);

  return (
    <AppShell
      ctx={ctx}
      workspaces={toWorkspaceChoices(session)}
      periods={periods.map((p) => ({ id: p.id, label: p.label, code: p.code }))}
      currentPeriodId={periods.find((p) => p.id === selectedPeriodId)?.id ?? periods[0]?.id}
      disclosureFirst={isEnterprise && featureSettings.disclosureFirst}
      projects={projects}
      demoRoleChoices={demoRoleChoices.map((choice) => ({
        email: choice.email,
        displayName: choice.displayName,
        jobTitle: choice.jobTitle,
        demoRole: choice.demoRole,
        roleLabels: choice.roleLabels,
        current: choice.current,
      }))}
      engagements={engagements.map((e) => ({ id: e.id, code: e.code, name: e.name }))}
      unreadNotifications={unreadNotifications}
    >
      {children}
    </AppShell>
  );
}
