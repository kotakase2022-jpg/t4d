import { AppShell } from '@/components/shared/app-shell';
import { loadEnterpriseShell, toWorkspaceChoices } from '@/lib/services/shell';

/**
 * Loading 境界を置かない理由は assurance/layout.tsx と同じ
 * （Next.js #86151 ／ docs/known-limitations.md S-11・10 章）。
 */
export default async function EnterpriseLayout({ children }: { children: React.ReactNode }) {
  const shell = await loadEnterpriseShell();

  return (
    <AppShell
      ctx={shell.ctx}
      workspaces={toWorkspaceChoices(shell.session)}
      periods={shell.periods.map((p) => ({ id: p.id, label: p.label, code: p.code }))}
      currentPeriodId={shell.currentPeriod.id}
      unreadNotifications={shell.unreadNotifications}
    >
      {children}
    </AppShell>
  );
}
