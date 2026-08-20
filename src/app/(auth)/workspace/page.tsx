import { redirect } from 'next/navigation';
import { Building2, ShieldCheck } from 'lucide-react';
import { BrandLogo } from '@/components/shared/brand-logo';
import { DemoDataBadge } from '@/components/shared/badges';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { selectWorkspaceAction } from '@/lib/auth/actions';
import { getSession } from '@/lib/auth/session';
import { roleLabel } from '@/lib/authorization/roles';

export const metadata = { title: 'ワークスペース選択' };

export default async function WorkspacePage() {
  const session = await getSession();
  if (!session) redirect('/login');

  const { profile, workspaces } = session;

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-muted p-6">
      <div className="w-full max-w-2xl space-y-4">
        <div className="flex flex-col items-center gap-2">
          <BrandLogo href={null} height={36} priority />
          <p className="text-[13px] text-ink-muted">
            {profile.displayName} さん（{profile.email}）
          </p>
          {session.context?.demo && <DemoDataBadge />}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>ワークスペースを選択</CardTitle>
            <span className="text-[12px] text-ink-muted">
              企業と監査法人でホーム・ナビゲーション・用語・主要アクションが切り替わります
            </span>
          </CardHeader>
          <CardContent>
            {workspaces.length === 0 ? (
              <EmptyState
                title="所属しているワークスペースがありません"
                description="管理者から招待を受けてください。招待メールのリンクから参加できます。"
              />
            ) : (
              <ul className="space-y-2">
                {workspaces.map((ws) => {
                  const isEnterprise = ws.organizationType === 'enterprise';
                  return (
                    <li key={ws.organizationId}>
                      <form action={selectWorkspaceAction}>
                        <input type="hidden" name="organizationId" value={ws.organizationId} />
                        <button
                          type="submit"
                          className="flex w-full items-center gap-3 rounded-t4d border border-line bg-surface px-3 py-2.5 text-left transition-colors hover:border-brand-400 hover:bg-brand-50"
                        >
                          <span
                            className={
                              isEnterprise
                                ? 'rounded-t4d bg-brand-100 p-2 text-brand-800'
                                : 'rounded-t4d bg-warning-soft p-2 text-[#8a5d00]'
                            }
                          >
                            {isEnterprise ? (
                              <Building2 className="size-4" aria-hidden="true" />
                            ) : (
                              <ShieldCheck className="size-4" aria-hidden="true" />
                            )}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium text-ink">
                              {ws.organizationName}
                            </span>
                            <span className="block truncate text-[11px] text-ink-muted">
                              {ws.roleKeys.map(roleLabel).join(' / ') || 'ロール未設定'}
                            </span>
                          </span>
                          <Badge tone={isEnterprise ? 'brand' : 'warning'}>
                            {isEnterprise ? '企業ワークスペース' : '監査法人ワークスペース'}
                          </Badge>
                        </button>
                      </form>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
