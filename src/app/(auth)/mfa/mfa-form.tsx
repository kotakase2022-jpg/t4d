'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

/**
 * ログイン時の MFA チャレンジ（AUTH-P0-001。Supabase Mode 専用）。
 * パスワード認証（AAL1）の後、Authenticator の 6 桁コードで AAL2 へ昇格する。
 * 昇格するまでワークスペースには入れない（session.ts が AAL1 を弾く）。
 */
export function MfaChallengeForm() {
  const router = useRouter();
  const [factorId, setFactorId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [state, setState] = React.useState<'loading' | 'ready' | 'none'>('loading');

  React.useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setState('none');
      return;
    }
    void supabase.auth.mfa.listFactors().then(({ data }) => {
      const totp = data?.totp?.[0];
      if (totp) {
        setFactorId(totp.id);
        setState('ready');
      } else {
        setState('none');
      }
    });
  }, []);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    if (!factorId) return;
    const code = String(new FormData(e.currentTarget).get('code') ?? '').trim();
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
      factorId,
    });
    if (challengeError || !challenge) {
      setError('チャレンジを開始できませんでした。もう一度お試しください。');
      return;
    }
    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.id,
      code,
    });
    if (verifyError) {
      setError('コードが正しくありません。Authenticator の最新のコードを入力してください。');
      return;
    }
    router.push('/workspace');
    router.refresh();
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-4 p-6">
      <Card className="p-5">
        <h1 className="flex items-center gap-1.5 text-[16px] font-semibold text-ink">
          <ShieldCheck className="size-4" aria-hidden="true" />2 段階認証（MFA）
        </h1>
        {state === 'loading' && <p className="mt-2 text-[13px] text-ink-muted">確認中…</p>}
        {state === 'none' && (
          <p className="mt-2 text-[13px] text-ink">
            MFA が未登録、またはセッションがありません。ログインからやり直してください。
          </p>
        )}
        {state === 'ready' && (
          <form onSubmit={onSubmit} className="mt-3 space-y-2">
            <label className="block text-[12px] text-ink-muted">
              Authenticator アプリの 6 桁コード
              <Input
                name="code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                className="mt-0.5 tracking-widest"
              />
            </label>
            {error && <p className="text-[12px] text-danger">{error}</p>}
            <Button type="submit" size="sm" className="w-full">
              確認してログイン
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}
