'use client';

import * as React from 'react';
import { AtSign, Clock, Send } from 'lucide-react';
import { Textarea } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import { addCommentAction } from '@/app/enterprise/actions';

/**
 * コメント投稿フォーム（WF-P0-002: メンション対応）。
 *
 * メンバー名のチップを押すと本文へ `@名前` が挿入される。
 * 解決・通知はサーバー側（`resolveMentions`）で行い、ここは入力補助だけを持つ。
 *
 * 送信中は、送った本文を「送信中」の行としてすぐに出す（useOptimistic。plan §1.18 Optimistic UI）。
 * 保存されたコメントは画面の再検証で一覧に入り、この行は消える。失敗したときは入力欄を消さない
 * （エラーの通知を読んでから書き直せるように。消すのは保存に成功したあとだけ）。
 *
 * 送信ボタンは secondary。コメントはデータの詳細・回答の画面の「仕事」（提出・承認など）ではなく、
 * primary にすると状態の主操作と並んで 1 画面に 2 つになる（plan §1.6・S7）。
 */
export function CommentBox({
  targetType,
  targetId,
  href,
  members,
}: {
  targetType: 'data_point' | 'disclosure_response';
  targetId: string;
  href: string;
  members: Array<{ userId: string; displayName: string }>;
}) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const formRef = React.useRef<HTMLFormElement>(null);
  const [sending, addSending] = React.useOptimistic<string[], string>([], (state, body) => [
    ...state,
    body,
  ]);

  const insertMention = (name: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const mention = `@${name.replace(/\s+/g, '')} `;
    const start = el.selectionStart ?? el.value.length;
    el.value = el.value.slice(0, start) + mention + el.value.slice(el.selectionEnd ?? start);
    el.focus();
    el.selectionStart = el.selectionEnd = start + mention.length;
  };

  return (
    <form
      ref={formRef}
      action={async (formData) => {
        const body = String(formData.get('body') ?? '').trim();
        if (body) addSending(body);
        await addCommentAction(formData);
        formRef.current?.reset();
      }}
      className="space-y-1.5 p-3"
    >
      <input type="hidden" name="targetType" value={targetType} />
      <input type="hidden" name="targetId" value={targetId} />
      <input type="hidden" name="href" value={href} />
      {sending.length > 0 && (
        <ul aria-live="polite" className="space-y-1" data-t4d-comment-sending="">
          {sending.map((body, index) => (
            <li
              key={index}
              className="rounded-t4d border border-dashed border-line bg-surface-muted px-2 py-1 text-small text-ink-muted"
            >
              <span className="mr-1.5 inline-flex items-center gap-0.5 text-caption font-medium">
                <Clock className="size-3" aria-hidden="true" />
                送信中
              </span>
              <span className="whitespace-pre-wrap break-words">{body}</span>
            </li>
          ))}
        </ul>
      )}
      <Textarea
        ref={textareaRef}
        // ショートカット「c」の飛び先。名前ではなくこの印で特定する
        data-t4d-shortcut="comment"
        name="body"
        rows={2}
        required
        placeholder="コメントを入力。@名前 でメンションすると本人に通知されます。"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="flex items-center gap-0.5 text-caption text-ink-muted">
          <AtSign className="size-3" aria-hidden="true" />
          メンション:
        </span>
        {members.map((m) => (
          <button
            key={m.userId}
            type="button"
            onClick={() => insertMention(m.displayName)}
            className="rounded-full border border-line px-2 py-0.5 text-caption text-ink hover:bg-brand-50"
          >
            @{m.displayName.replace(/\s+/g, '')}
          </button>
        ))}
        <span className="grow" />
        <SubmitButton
          variant="secondary"
          size="xs"
          pendingLabel="送信中…"
          icon={<Send aria-hidden="true" />}
        >
          コメントする
        </SubmitButton>
      </div>
    </form>
  );
}
