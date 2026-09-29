import { AppShell } from '@/components/shared/app-shell';
import { listDemoRoleChoices } from '@/lib/auth/demo-role';
import { demoEditsWereEvicted } from '@/lib/repositories/demo-persistence';
import { loadHeaderProjects } from '@/lib/services/disclosure-home';
import { getFeatureSettings } from '@/lib/services/feature-settings';
import { loadEnterpriseShell, toWorkspaceChoices } from '@/lib/services/shell';

/**
 * Loading 境界を置かない理由は assurance/layout.tsx と同じ
 * （Next.js #86151 ／ docs/known-limitations.md S-11・10 章）。
 */
export default async function EnterpriseLayout({ children }: { children: React.ReactNode }) {
  const shell = await loadEnterpriseShell();
  // 機能設定（開示優先モード）でメニューを切り替える。行が無い組織は従来メニュー（A39）
  const [featureSettings, projects, demoRoleChoices] = await Promise.all([
    getFeatureSettings(shell.db, shell.ctx),
    loadHeaderProjects(shell.db, shell.ctx),
    listDemoRoleChoices(shell.db, shell.ctx),
  ]);
  const demoEditsEvicted = shell.ctx.demo ? await demoEditsWereEvicted() : false;

  return (
    <AppShell
      ctx={shell.ctx}
      workspaces={toWorkspaceChoices(shell.session)}
      periods={shell.periods.map((p) => ({ id: p.id, label: p.label, code: p.code }))}
      currentPeriodId={shell.currentPeriod.id}
      currentPeriodRange={{
        startDate: shell.currentPeriod.startDate,
        endDate: shell.currentPeriod.endDate,
      }}
      disclosureFirst={featureSettings.disclosureFirst}
      projects={projects}
      demoRoleChoices={demoRoleChoices.map((choice) => ({
        email: choice.email,
        displayName: choice.displayName,
        jobTitle: choice.jobTitle,
        demoRole: choice.demoRole,
        roleLabels: choice.roleLabels,
        current: choice.current,
      }))}
      unreadNotifications={shell.unreadNotifications}
      demoEditsEvicted={demoEditsEvicted}
    >
      {children}
    </AppShell>
  );
}
