'use client';

import * as React from 'react';
import { AtSign, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { addCommentAction } from '@/app/enterprise/actions';

/**
 * コメント投稿フォーム（WF-P0-002: メンション対応）。
 *
 * メンバー名のチップを押すと本文へ `@名前` が挿入される。
 * 解決・通知はサーバー側（`resolveMentions`）で行い、ここは入力補助だけを持つ。
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
        await addCommentAction(formData);
        formRef.current?.reset();
      }}
      className="space-y-1.5 p-3"
    >
      <input type="hidden" name="targetType" value={targetType} />
      <input type="hidden" name="targetId" value={targetId} />
      <input type="hidden" name="href" value={href} />
      <Textarea
        ref={textareaRef}
        name="body"
        rows={2}
        required
        placeholder="コメントを入力。@名前 でメンションすると本人に通知されます。"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="flex items-center gap-0.5 text-[11px] text-ink-muted">
          <AtSign className="size-3" aria-hidden="true" />
          メンション:
        </span>
        {members.map((m) => (
          <button
            key={m.userId}
            type="button"
            onClick={() => insertMention(m.displayName)}
            className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink hover:bg-brand-50"
          >
            @{m.displayName.replace(/\s+/g, '')}
          </button>
        ))}
        <span className="grow" />
        <Button type="submit" size="xs">
          <Send aria-hidden="true" />
          コメントする
        </Button>
      </div>
    </form>
  );
}
