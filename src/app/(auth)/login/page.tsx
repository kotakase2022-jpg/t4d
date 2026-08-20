import { redirect } from 'next/navigation';
import { FlaskConical, Info, LogIn } from 'lucide-react';
import { BrandLogo } from '@/components/shared/brand-logo';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { demoLoginAction, supabaseLoginAction } from '@/lib/auth/actions';
import { getSession } from '@/lib/auth/session';
import { roleLabel } from '@/lib/authorization/roles';
import { getAppMode } from '@/lib/config';
import { DEMO_USERS } from '@/lib/fixtures/dataset';

export const metadata = { title: 'ログイン' };

export default async function LoginPage() {
  const session = await getSession();
  if (session) redirect('/workspace');

  const mode = getAppMode();
  const demoUsers = DEMO_USERS.filter((u) => u.featured);
  const otherUsers = DEMO_USERS.filter((u) => !u.featured);

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-muted p-6">
      <div className="w-full max-w-3xl space-y-4">
        <div className="flex flex-col items-center gap-2">
          <BrandLogo href={null} height={40} priority />
          <p className="text-[13px] text-ink-muted">
            非財務情報・開示・第三者保証対応プラットフォーム
          </p>
        </div>

        {mode === 'demo' ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FlaskConical className="size-4 text-warning" aria-hidden="true" />
                デモログイン
              </CardTitle>
              <Badge tone="warning">Supabase 未接続 / 架空データ</Badge>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="flex items-start gap-1.5 rounded-t4d bg-brand-50 p-2 text-[12px] text-brand-900">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>
                  これは本番認証とは<strong>完全に別経路</strong>
                  のデモ用ログインです。パスワードは不要で、
                  <code className="mx-1 rounded bg-surface px-1">NEXT_PUBLIC_APP_MODE=demo</code>
                  のときのみ有効になります。表示されるデータはすべて架空です。
                </span>
              </p>

              <ul className="grid grid-cols-2 gap-2">
                {demoUsers.map((user) => (
                  <li key={user.email}>
                    <form action={demoLoginAction}>
                      <input type="hidden" name="email" value={user.email} />
                      <button
                        type="submit"
                        className="flex w-full flex-col items-start gap-0.5 rounded-t4d border border-line bg-surface px-3 py-2 text-left transition-colors hover:border-brand-400 hover:bg-brand-50"
                      >
                        <span className="flex w-full items-center justify-between gap-2">
                          <span className="text-[13px] font-medium text-ink">
                            {user.displayName}
                          </span>
                          <Badge tone={user.organizationId.length % 2 === 0 ? 'brand' : 'neutral'}>
                            {user.roleKeys.map(roleLabel).join(' / ')}
                          </Badge>
                        </span>
                        <span className="text-[11px] text-ink-muted">{user.jobTitle}</span>
                        <span className="text-[11px] text-ink-muted">{user.email}</span>
                      </button>
                    </form>
                  </li>
                ))}
              </ul>

              <details className="rounded-t4d border border-line p-2">
                <summary className="cursor-pointer text-[12px] text-ink-muted">
                  越権テスト用の別テナントアカウント（{otherUsers.length} 件）
                </summary>
                <ul className="mt-2 space-y-1.5">
                  {otherUsers.map((user) => (
                    <li key={user.email}>
                      <form action={demoLoginAction} className="flex items-center gap-2">
                        <input type="hidden" name="email" value={user.email} />
                        <Button type="submit" variant="outline" size="xs">
                          <LogIn aria-hidden="true" />
                          ログイン
                        </Button>
                        <span className="text-[12px] text-ink">{user.displayName}</span>
                        <span className="text-[11px] text-ink-muted">{user.email}</span>
                      </form>
                    </li>
                  ))}
                </ul>
              </details>
            </CardContent>
          </Card>
        ) : (
          <Card className="mx-auto w-full max-w-md">
            <CardHeader>
              <CardTitle>ログイン</CardTitle>
              <Badge tone="brand">Supabase Auth</Badge>
            </CardHeader>
            <CardContent>
              <form action={supabaseLoginAction} className="space-y-3">
                <label className="block text-[12px] text-ink-muted">
                  メールアドレス
                  <Input
                    name="email"
                    type="email"
                    autoComplete="username"
                    required
                    placeholder="you@example.com"
                    className="mt-0.5"
                  />
                </label>
                <label className="block text-[12px] text-ink-muted">
                  パスワード
                  <Input
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    className="mt-0.5"
                  />
                </label>
                <Button type="submit" size="md" className="w-full">
                  <LogIn aria-hidden="true" />
                  ログイン
                </Button>
              </form>
              <p className="mt-3 text-[11px] text-ink-muted">
                本番 SSO とパスワード再設定メールは Phase 1
                の実装対象外です（docs/known-limitations.md）。ローカル検証では{' '}
                <code className="rounded bg-surface-muted px-1">supabase db reset</code>{' '}
                で作成される架空アカウントを使用できます。
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
