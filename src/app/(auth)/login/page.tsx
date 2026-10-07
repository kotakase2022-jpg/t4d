import { redirect } from 'next/navigation';
import { FlaskConical, Info, LogIn } from 'lucide-react';
import { BrandLogo } from '@/components/shared/brand-logo';
import { Notice } from '@/components/shared/notice';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { MoreInfo } from '@/components/ui/more-info';
import { SubmitButton } from '@/components/ui/submit-button';
import { demoLoginAction, supabaseLoginAction } from '@/lib/auth/actions';
import { getSession } from '@/lib/auth/session';
import { roleLabel } from '@/lib/authorization/roles';
import { getAppMode } from '@/lib/config';
import { DEMO_USERS } from '@/lib/fixtures/dataset';
import { Collapsible } from '@/components/ui/collapsible';

export const metadata = { title: 'ログイン' };

/**
 * 開発者向けの説明（環境変数・ローカルの DB 操作・ドキュメントのパス）は本番では出さない
 * （plan §1.17 規則 3。利用者に関係が無く、内部の構成を見せるだけになるため）。
 * 開発時だけ、既定で閉じた「開発者向けの情報」に入れる。
 */
const SHOW_DEVELOPER_NOTES = process.env.NODE_ENV !== 'production';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await getSession();
  if (session) redirect('/workspace');

  const mode = getAppMode();
  const demoUsers = DEMO_USERS.filter((u) => u.featured);
  const otherUsers = DEMO_USERS.filter((u) => !u.featured);
  const error = typeof params.error === 'string' ? params.error : null;
  const resetDone = params.reset === 'done';

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-muted p-6">
      <div className="w-full max-w-3xl space-y-4">
        <div className="flex flex-col items-center gap-2">
          <BrandLogo href={null} height={40} priority />
          <p className="text-body text-ink-muted">
            非財務情報・開示・第三者保証対応プラットフォーム
          </p>
        </div>

        {/* ログインの失敗は理由を出す（認証の入口は AppShell の外なので、画面が自分で出す） */}
        {error && (
          <Notice tone="danger" role="alert" className="mx-auto max-w-md">
            {error}
          </Notice>
        )}
        {resetDone && (
          <Notice tone="success" role="status" className="mx-auto max-w-md">
            パスワードを更新しました。新しいパスワードでログインしてください。
          </Notice>
        )}

        {mode === 'demo' ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FlaskConical className="size-4 text-warning" aria-hidden="true" />
                デモログイン
              </CardTitle>
              <Badge tone="warning">
                <FlaskConical className="size-3" aria-hidden="true" />
                Supabase 未接続 / 架空データ
              </Badge>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* 架空データ・本番認証と別経路であることは誠実さの注記（折りたたまない） */}
              <p className="flex items-start gap-1.5 rounded-t4d bg-brand-50 p-2 text-small text-brand-900">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>
                  これは本番認証とは<strong>完全に別経路</strong>
                  のデモ用ログインです。パスワードは不要です。表示されるデータはすべて架空です。
                </span>
              </p>
              {SHOW_DEVELOPER_NOTES && (
                <MoreInfo label="開発者向けの情報">
                  <p>
                    デモログインは
                    <code className="mx-1 rounded-t4d-sm bg-surface px-1">
                      NEXT_PUBLIC_APP_MODE=demo
                    </code>
                    のときのみ有効になります。
                  </p>
                </MoreInfo>
              )}

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
                          <span className="text-body font-medium text-ink">{user.displayName}</span>
                          <span className="text-caption text-ink-muted">
                            {user.roleKeys.map(roleLabel).join(' / ')}
                          </span>
                        </span>
                        <span className="text-caption text-ink-muted">{user.jobTitle}</span>
                        <span className="text-caption text-ink-muted">{user.email}</span>
                      </button>
                    </form>
                  </li>
                ))}
              </ul>

              <Collapsible
                variant="plain"
                summary={`越権テスト用の別テナントアカウント（${otherUsers.length} 件）`}
                className="rounded-t4d border border-line p-2"
              >
                <ul className="mt-2 space-y-1.5">
                  {otherUsers.map((user) => (
                    <li key={user.email}>
                      <form action={demoLoginAction} className="flex items-center gap-2">
                        <input type="hidden" name="email" value={user.email} />
                        <SubmitButton
                          variant="secondary"
                          size="xs"
                          icon={<LogIn aria-hidden="true" />}
                        >
                          ログイン
                        </SubmitButton>
                        <span className="text-small text-ink">{user.displayName}</span>
                        <span className="text-caption text-ink-muted">{user.email}</span>
                      </form>
                    </li>
                  ))}
                </ul>
              </Collapsible>
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
                <Field label="メールアドレス" name="email" required>
                  {(p) => (
                    <Input
                      {...p}
                      name="email"
                      type="email"
                      autoComplete="username"
                      placeholder="you@example.com"
                    />
                  )}
                </Field>
                <Field label="パスワード" name="password" required>
                  {(p) => (
                    <Input {...p} name="password" type="password" autoComplete="current-password" />
                  )}
                </Field>
                <SubmitButton
                  variant="primary"
                  size="md"
                  className="w-full"
                  icon={<LogIn aria-hidden="true" />}
                  pendingLabel="ログイン中…"
                >
                  ログイン
                </SubmitButton>
              </form>
              <p className="mt-3 text-caption text-ink-muted">
                パスワードを忘れたときは、組織の管理者に再設定リンクの発行を依頼してください。
              </p>
              {SHOW_DEVELOPER_NOTES && (
                <MoreInfo label="開発者向けの情報" className="mt-2">
                  <p>
                    本番 SSO とパスワード再設定メールは Phase 1
                    の実装対象外です（docs/known-limitations.md）。ローカル検証では{' '}
                    <code className="rounded-t4d-sm bg-surface-muted px-1">supabase db reset</code>{' '}
                    で作成される架空アカウントを使用できます。
                  </p>
                </MoreInfo>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
