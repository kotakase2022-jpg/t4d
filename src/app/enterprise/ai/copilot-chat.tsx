'use client';

import * as React from 'react';
import Link from 'next/link';
import { Bot } from 'lucide-react';
import { AiGeneratedBadge } from '@/components/shared/badges';
import { Button } from '@/components/ui/button';
import { askCopilotAction } from '../actions';

/**
 * Copilot の対話カード。
 *
 * サーバー側の会話（Provenance）を初期値として受け取りつつ、
 * **送信結果はクライアント側でも保持する**。
 *
 * Demo Mode の状態はプロセスのメモリにしか無く（docs/known-limitations.md D-3）、
 * Vercel のようにリクエストごとにインスタンスが変わる環境では、
 * Server Action で作った会話を次のリクエストが読めないことがある。
 * 以前は `?chat=<id>` へリダイレクトして読み直していたため、
 * その場合に**回答が表示されないまま**になっていた。
 * ここでは回答を戻り値で受け取り、画面上で必ず見えるようにする。
 */

export interface CopilotTurnView {
  runId: string;
  question: string;
  answer: string;
  confidence: number;
  provider: 'openai' | 'mock';
  references: Array<{ label: string; link: string | null }>;
}

export function CopilotChat({
  initialTurns,
  initialConversationId,
  canRunAi,
}: {
  initialTurns: CopilotTurnView[];
  initialConversationId: string | null;
  canRunAi: boolean;
}) {
  const [turns, setTurns] = React.useState<CopilotTurnView[]>(initialTurns);
  const [conversationId, setConversationId] = React.useState<string | null>(initialConversationId);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const formRef = React.useRef<HTMLFormElement>(null);

  // サーバー側で会話が読めた場合（Supabase Mode や同一インスタンス）はそちらを優先する
  React.useEffect(() => {
    if (initialTurns.length > 0) {
      setTurns(initialTurns);
      setConversationId(initialConversationId);
    }
  }, [initialTurns, initialConversationId]);

  const onSubmit = async (formData: FormData) => {
    setError(null);
    setPending(true);
    try {
      if (conversationId) formData.set('conversationId', conversationId);
      const result = await askCopilotAction(formData);
      setConversationId(result.conversationId);
      setTurns((prev) => [...prev, result.turn]);
      formRef.current?.reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : '回答を取得できませんでした。');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-2 p-3">
      {turns.length > 0 && (
        <ul className="space-y-2">
          {turns.map((turn) => (
            <li key={turn.runId} className="space-y-1.5">
              <div className="ml-auto w-fit max-w-[80%] rounded-t4d bg-brand-100 px-2.5 py-1.5 text-[13px] text-brand-900">
                {turn.question}
              </div>
              <div className="w-fit max-w-[85%] rounded-t4d border border-line bg-surface px-2.5 py-1.5">
                <p className="text-[13px] whitespace-pre-wrap text-ink">{turn.answer}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <AiGeneratedBadge provider={turn.provider} />
                  <span className="text-[11px] text-ink-muted">
                    確信度 {Math.round(turn.confidence * 100)}%
                  </span>
                  {turn.references.map((ref) =>
                    ref.link ? (
                      <Link
                        key={ref.label}
                        href={ref.link}
                        className="text-[11px] text-brand-800 underline"
                      >
                        {ref.label}
                      </Link>
                    ) : (
                      <span key={ref.label} className="text-[11px] text-ink-muted">
                        {ref.label}
                      </span>
                    ),
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="rounded-t4d bg-danger-soft px-2 py-1.5 text-[12px] text-danger">
          {error}
        </p>
      )}

      {canRunAi ? (
        <form ref={formRef} action={onSubmit} className="flex items-end gap-2">
          <label className="grow text-[12px] text-ink-muted">
            質問
            <input
              name="question"
              required
              disabled={pending}
              placeholder="例: Scope1 の当年値と前年比は？ ／ 収集の進捗は？ ／ CDP の必須未回答は？"
              className="mt-0.5 block h-8 w-full rounded-t4d border border-line bg-surface px-2 text-[13px] text-ink disabled:opacity-60"
            />
          </label>
          <Button type="submit" size="sm" disabled={pending}>
            <Bot aria-hidden="true" />
            {pending ? '確認中…' : '質問する'}
          </Button>
        </form>
      ) : (
        <p className="text-[12px] text-ink-muted">AI を実行する権限がありません。</p>
      )}

      <p className="text-[11px] leading-relaxed text-ink-muted">
        回答はこの組織の承認済みデータ・収集状況・開示状況のみを根拠にします。AI
        は操作や確定を行いません。全ターンが AI 実行履歴（Provenance）に記録されます。
      </p>
    </div>
  );
}
