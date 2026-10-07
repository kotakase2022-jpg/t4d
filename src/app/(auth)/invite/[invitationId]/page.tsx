import { UserPlus } from 'lucide-react';
import { Notice } from '@/components/shared/notice';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import { acceptInvitationAction } from '@/lib/auth/actions';
import { getInvitationAcceptDb } from '@/lib/repositories';
import { getAppMode } from '@/lib/config';
import { formatJstDate } from '@/lib/format/datetime';

export const metadata = { title: '招待の受諾' };

/**
 * 招待リンクの受け口（AUTH-P0-001）。
 * 管理者が発行したアプリ内リンクを本人が開き、氏名を入力して参加する。
 * 未ログインで開ける（認証前の入口。招待 ID を知っている本人のみが到達できる）。
 */
export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ invitationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { invitationId } = await params;
  const query = await searchParams;
  // 招待を開くのは「まだメンバーではない人」なので RLS 下では読めない。
  // 招待 ID（CSPRNG）を知っていることを資格として、サーバー側でのみ読む。
  const db = await getInvitationAcceptDb();
  const invitation = await db.findById('invitations', invitationId);
  const organization = invitation
    ? await db.findById('organizations', invitation.organizationId)
    : null;

  const supabaseMode = getAppMode() === 'supabase';
  const usable =
    invitation &&
    invitation.status === 'pending' &&
    invitation.expiresAt >= new Date().toISOString();
  const error = typeof query.error === 'string' ? query.error : null;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-4 p-6">
      <Card className="p-5">
        <h1 className="text-title-lg font-semibold text-ink">TERRAST for Disclosure への招待</h1>
        {!invitation || !usable ? (
          <p className="mt-2 text-body text-ink">
            この招待は使用できません（無効・受諾済み・失効・期限切れのいずれか）。
            招待した管理者に再発行を依頼してください。
          </p>
        ) : (
          <>
            <p className="mt-2 text-body text-ink">
              <span className="font-medium">{organization?.name}</span> のワークスペースへ
              <span className="font-mono text-small"> {invitation.email} </span>
              として招待されています（期限: {formatJstDate(invitation.expiresAt)}）。
            </p>
            {/* 参加の失敗は理由を出す（AppShell の外の画面なので、画面が自分で出す） */}
            {error && (
              <Notice tone="danger" role="alert" className="mt-2">
                {error}
              </Notice>
            )}
            <form action={acceptInvitationAction} className="mt-3 space-y-2">
              <input type="hidden" name="invitationId" value={invitation.id} />
              <Field label="氏名（表示名）" name="displayName" required>
                {(p) => <Input {...p} name="displayName" placeholder="例: 新戸 参" />}
              </Field>
              {supabaseMode && (
                <Field label="パスワード（8 文字以上）" name="password" required>
                  {(p) => <Input {...p} name="password" type="password" minLength={8} />}
                </Field>
              )}
              <SubmitButton
                variant="primary"
                size="sm"
                className="w-full"
                icon={<UserPlus aria-hidden="true" />}
                pendingLabel="参加中…"
              >
                参加する
              </SubmitButton>
            </form>
          </>
        )}
      </Card>
    </main>
  );
}
