'use client';

import * as React from 'react';
import { Undo2 } from 'lucide-react';
import { addCommentAction, transitionCdpResponseAction } from '@/app/enterprise/actions';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';

/**
 * 回答の差戻し（plan §1.15 回答・§1.16 区分 2・F074）。理由は必須。
 *
 * 回答の状態遷移（サービス）は理由を受け取らない（サービスは変えない。plan §4）。理由欄を必須にしたまま
 * 黙って捨てると「書いたのにどこにも残らない」入力欄になるため、理由はこの回答のコメントとして残す
 * （差し戻された担当者がコメント欄で読める）。どちらも既存の Server Action を呼ぶだけ。
 * 状態を戻せたときだけコメントを足す（失敗したときは業務エラーの遷移で止まり、理由だけが残ることはない）。
 */
export function ReturnResponseDialog({
  responseId,
  href,
  scope,
}: {
  responseId: string;
  /** コメントの通知・エラーの戻り先（この回答の画面） */
  href: string;
  /** 範囲 1 行（どの回答を戻すか） */
  scope: string;
}) {
  const action = React.useCallback(
    async (formData: FormData) => {
      const reason = String(formData.get('reason') ?? '').trim();
      await transitionCdpResponseAction(formData);
      if (reason === '') return;
      const comment = new FormData();
      comment.set('targetType', 'disclosure_response');
      comment.set('targetId', responseId);
      comment.set('href', href);
      comment.set('body', `差戻し理由: ${reason}`);
      await addCommentAction(comment);
    },
    [responseId, href],
  );

  return (
    <ConfirmDialog
      tier="bulk"
      title="この回答を差し戻しますか"
      scope={scope}
      consequences={[
        '回答は「差戻し」になり、作成した担当者が直して保存し直します。',
        '差戻し理由は、この回答のコメントとして残ります。',
      ]}
      reason={{
        name: 'reason',
        label: '差戻し理由',
        required: true,
        placeholder: '直してほしい点を具体的に書いてください',
      }}
      confirmLabel="差し戻す"
      action={action}
      fields={{ responseId, to: 'returned' }}
      trigger={{
        label: '差戻し…',
        icon: <Undo2 aria-hidden="true" />,
        variant: 'secondary',
        size: 'sm',
        actionId: 'return',
      }}
    />
  );
}
