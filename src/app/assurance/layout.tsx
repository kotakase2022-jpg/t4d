import { AppShell } from '@/components/shared/app-shell';
import { loadAssuranceShell, toWorkspaceChoices } from '@/lib/services/shell';

/**
 * このワークスペースには Loading 境界（`loading.tsx` / `<Suspense>`）を置かない。
 *
 * Next.js 15.5.23 では、Layout と Page の間に Suspense 境界があると
 * Client 側の Soft Navigation が確定せず、RSC Payload を受信済みでも
 * URL が変わらないまま固まる（https://github.com/vercel/next.js/issues/86151）。
 * `/assurance/engagements/[engagementId]/*` への遷移で 100% 再現したため、
 * 境界を置かず「サーバー応答を待ってから遷移確定」とする。
 * 画面ごとの Loading 表示は各 Component が持つ（docs/known-limitations.md S-11 / 10 章）。
 */
export default async function AssuranceLayout({ children }: { children: React.ReactNode }) {
  const shell = await loadAssuranceShell();

  return (
    <AppShell
      ctx={shell.ctx}
      workspaces={toWorkspaceChoices(shell.session)}
      engagements={shell.engagements.map((e) => ({ id: e.id, code: e.code, name: e.name }))}
      unreadNotifications={shell.unreadNotifications}
    >
      {children}
    </AppShell>
  );
}
