import { UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
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
}: {
  params: Promise<{ invitationId: string }>;
}) {
  const { invitationId } = await params;
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

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-4 p-6">
      <Card className="p-5">
        <h1 className="text-[16px] font-semibold text-ink">TERRAST for Disclosure への招待</h1>
        {!invitation || !usable ? (
          <p className="mt-2 text-[13px] text-ink">
            この招待は使用できません（無効・受諾済み・失効・期限切れのいずれか）。
            管理者へ再発行を依頼してください。
          </p>
        ) : (
          <>
            <p className="mt-2 text-[13px] text-ink">
              <span className="font-medium">{organization?.name}</span> のワークスペースへ
              <span className="font-mono text-[12px]"> {invitation.email} </span>
              として招待されています（期限: {formatJstDate(invitation.expiresAt)}）。
            </p>
            <form action={acceptInvitationAction} className="mt-3 space-y-2">
              <input type="hidden" name="invitationId" value={invitation.id} />
              <label className="block text-[12px] text-ink-muted">
                氏名（表示名）
                <Input name="displayName" required placeholder="例: 新戸 参" className="mt-0.5" />
              </label>
              {supabaseMode && (
                <label className="block text-[12px] text-ink-muted">
                  パスワード（8 文字以上）
                  <Input
                    name="password"
                    type="password"
                    required
                    minLength={8}
                    className="mt-0.5"
                  />
                </label>
              )}
              <Button type="submit" size="sm" className="w-full">
                <UserPlus aria-hidden="true" />
                参加する
              </Button>
            </form>
          </>
        )}
      </Card>
    </main>
  );
}
