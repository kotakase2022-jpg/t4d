'use client';

import * as React from 'react';
import { KeyRound, ShieldCheck, ShieldOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

/**
 * 自分のアカウントの MFA（TOTP）登録（AUTH-P0-001。Supabase Mode 専用）。
 * QR ライブラリは追加しない方針のため、シークレットと otpauth URI を表示して
 * Authenticator アプリへ手動登録してもらう。
 */
export function MfaEnrollCard({ supabaseMode }: { supabaseMode: boolean }) {
  const [factors, setFactors] = React.useState<Array<{ id: string; status: string }>>([]);
  const [enrolling, setEnrolling] = React.useState<{
    factorId: string;
    secret: string;
    uri: string;
  } | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);

  const refresh = React.useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setLoaded(true);
      return;
    }
    const { data } = await supabase.auth.mfa.listFactors();
    setFactors((data?.totp ?? []).map((f) => ({ id: f.id, status: f.status })));
    setLoaded(true);
  }, []);

  React.useEffect(() => {
    if (supabaseMode) void refresh();
    else setLoaded(true);
  }, [supabaseMode, refresh]);

  if (!supabaseMode) {
    return (
      <p className="px-3 pb-3 text-[12px] text-ink-muted">
        Demo Mode はパスワードレス（ボタンログイン）のため、パスワード再設定と MFA は
        <strong> Supabase Mode でのみ有効</strong>です。ローカル Supabase
        スタックで両機能の実動作を検証済みです（tests/e2e-supabase）。
      </p>
    );
  }

  const startEnroll = async () => {
    setMessage(null);
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
    if (error || !data) {
      setMessage('MFA の登録を開始できませんでした。');
      return;
    }
    setEnrolling({ factorId: data.id, secret: data.totp.secret, uri: data.totp.uri });
  };

  const verifyEnroll = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!enrolling) return;
    const code = String(new FormData(e.currentTarget).get('code') ?? '').trim();
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data: challenge } = await supabase.auth.mfa.challenge({
      factorId: enrolling.factorId,
    });
    if (!challenge) {
      setMessage('チャレンジを開始できませんでした。');
      return;
    }
    const { error } = await supabase.auth.mfa.verify({
      factorId: enrolling.factorId,
      challengeId: challenge.id,
      code,
    });
    if (error) {
      setMessage('コードが正しくありません。');
      return;
    }
    setEnrolling(null);
    setMessage('MFA を有効化しました。次回ログインからコード入力が必要になります。');
    await refresh();
  };

  const unenroll = async (factorId: string) => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    await supabase.auth.mfa.unenroll({ factorId });
    setMessage('MFA を解除しました。');
    await refresh();
  };

  const verified = factors.filter((f) => f.status === 'verified');

  return (
    <div className="space-y-2 px-3 pb-3">
      {!loaded ? (
        <p className="text-[12px] text-ink-muted">確認中…</p>
      ) : verified.length > 0 ? (
        <div className="flex items-center gap-2">
          <Badge tone="success">
            <ShieldCheck className="size-3" aria-hidden="true" />
            MFA 有効
          </Badge>
          <Button size="xs" variant="outline" onClick={() => void unenroll(verified[0]!.id)}>
            <ShieldOff aria-hidden="true" />
            解除する
          </Button>
        </div>
      ) : enrolling ? (
        <form onSubmit={verifyEnroll} className="space-y-1.5">
          <p className="text-[12px] text-ink">
            Authenticator アプリ（Google Authenticator 等）へ以下のシークレットを登録し、 表示された
            6 桁コードを入力してください。
          </p>
          <code className="block break-all rounded bg-surface-muted px-2 py-1 font-mono text-[12px]">
            {enrolling.secret}
          </code>
          <details className="text-[11px] text-ink-muted">
            <summary>otpauth URI（対応アプリ用）</summary>
            <code className="break-all">{enrolling.uri}</code>
          </details>
          <div className="flex items-end gap-2">
            <label className="text-[12px] text-ink-muted">
              6 桁コード
              <Input
                name="code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                className="mt-0.5 w-32 tracking-widest"
              />
            </label>
            <Button type="submit" size="sm">
              有効化する
            </Button>
          </div>
        </form>
      ) : (
        <Button size="sm" variant="outline" onClick={() => void startEnroll()}>
          <KeyRound aria-hidden="true" />
          MFA（Authenticator）を登録する
        </Button>
      )}
      {message && <p className="text-[12px] text-brand-900">{message}</p>}
    </div>
  );
}
