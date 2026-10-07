import { redirect } from 'next/navigation';
import { Building2, LogOut, ShieldCheck } from 'lucide-react';
import { BrandLogo } from '@/components/shared/brand-logo';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { Notice } from '@/components/shared/notice';
import { EmptyState } from '@/components/shared/states';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SubmitButton } from '@/components/ui/submit-button';
import { logoutAction, selectWorkspaceAction } from '@/lib/auth/actions';
import { getSession } from '@/lib/auth/session';
import { roleLabel } from '@/lib/authorization/roles';

export const metadata = { title: 'ワークスペース選択' };

export default async function WorkspacePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await getSession();
  if (!session) redirect('/login');

  const { profile, workspaces } = session;
  const error = typeof params.error === 'string' ? params.error : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-muted p-6">
      <div className="w-full max-w-2xl space-y-4">
        <div className="flex flex-col items-center gap-2">
          <BrandLogo href={null} height={36} priority />
          <p className="text-body text-ink-muted">
            {profile.displayName} さん（{profile.email}）
          </p>
          {session.context?.demo && <HonestyBadge kind="demo-data" />}
        </div>

        {/* 選択の失敗は理由を出す（AppShell の外の画面なので、画面が自分で出す） */}
        {error && (
          <Notice tone="danger" role="alert">
            {error}
          </Notice>
        )}

        <Card>
          <CardHeader>
            <CardTitle>ワークスペースを選択</CardTitle>
            <span className="text-small text-ink-muted">
              企業と監査法人でホーム・ナビゲーション・用語・主要アクションが切り替わります
            </span>
          </CardHeader>
          <CardContent>
            {workspaces.length === 0 ? (
              <EmptyState
                kind="no-data"
                title="所属しているワークスペースがありません"
                description="組織の管理者から招待リンクを受け取り、リンクを開いて参加してください。別のアカウントで入る場合はログアウトします。"
                action={
                  <form action={logoutAction}>
                    <SubmitButton
                      size="sm"
                      variant="secondary"
                      icon={<LogOut aria-hidden="true" />}
                    >
                      ログアウト
                    </SubmitButton>
                  </form>
                }
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
                                : 'rounded-t4d bg-warning-soft p-2 text-warning-ink'
                            }
                          >
                            {isEnterprise ? (
                              <Building2 className="size-4" aria-hidden="true" />
                            ) : (
                              <ShieldCheck className="size-4" aria-hidden="true" />
                            )}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-body font-medium text-ink">
                              {ws.organizationName}
                            </span>
                            <span className="block truncate text-caption text-ink-muted">
                              {ws.roleKeys.map(roleLabel).join(' / ') || '役割が未設定'}
                            </span>
                          </span>
                          <span className="shrink-0 text-small text-ink-muted">
                            {isEnterprise ? '企業ワークスペース' : '監査法人ワークスペース'}
                          </span>
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
