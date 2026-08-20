'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

/**
 * パスワード再設定（AUTH-P0-001。Supabase Mode 専用）。
 *
 * 管理者が発行した回復リンク（メール送信なし・アプリ内で手渡し）を開くと、
 * Supabase が URL 経由で回復セッションを張る。ここで新しいパスワードを設定する。
 */
export function ResetPasswordForm() {
  const router = useRouter();
  const [ready, setReady] = React.useState<'checking' | 'ok' | 'invalid'>('checking');
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);

  React.useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setReady('invalid');
      return;
    }
    const run = async () => {
      // 回復リンクは URL フラグメントにトークンを載せて戻ってくる。
      // クライアントの flowType（PKCE）に依存せず、ここで明示的にセッションを張る。
      const hash = new URLSearchParams(window.location.hash.slice(1));
      const accessToken = hash.get('access_token');
      const refreshToken = hash.get('refresh_token');
      if (accessToken && refreshToken && hash.get('type') === 'recovery') {
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        // トークンを履歴・アドレスバーへ残さない
        window.history.replaceState(null, '', window.location.pathname);
        setReady(error ? 'invalid' : 'ok');
        return;
      }
      const { data } = await supabase.auth.getSession();
      setReady(data.session ? 'ok' : 'invalid');
    };
    void run();
  }, []);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const password = String(form.get('password') ?? '');
    const confirm = String(form.get('confirm') ?? '');
    if (password.length < 8) {
      setError('パスワードは 8 文字以上にしてください。');
      return;
    }
    if (password !== confirm) {
      setError('確認用パスワードが一致しません。');
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setError('パスワードを更新できませんでした。リンクの有効期限を確認してください。');
      return;
    }
    setDone(true);
    // 再設定後は明示的にログインし直させる（回復セッションを残さない）
    await supabase.auth.signOut();
    router.push('/login?reset=done');
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-4 p-6">
      <Card className="p-5">
        <h1 className="flex items-center gap-1.5 text-[16px] font-semibold text-ink">
          <KeyRound className="size-4" aria-hidden="true" />
          パスワードの再設定
        </h1>
        {ready === 'checking' && <p className="mt-2 text-[13px] text-ink-muted">確認中…</p>}
        {ready === 'invalid' && (
          <p className="mt-2 text-[13px] text-ink">
            このページは再設定リンクからのみ利用できます（Supabase Mode 専用）。
            リンクの有効期限が切れている場合は、管理者へ再発行を依頼してください。
          </p>
        )}
        {ready === 'ok' && !done && (
          <form onSubmit={onSubmit} className="mt-3 space-y-2">
            <label className="block text-[12px] text-ink-muted">
              新しいパスワード（8 文字以上）
              <Input name="password" type="password" required minLength={8} className="mt-0.5" />
            </label>
            <label className="block text-[12px] text-ink-muted">
              新しいパスワード（確認）
              <Input name="confirm" type="password" required minLength={8} className="mt-0.5" />
            </label>
            {error && <p className="text-[12px] text-danger">{error}</p>}
            <Button type="submit" size="sm" className="w-full">
              パスワードを更新する
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}
