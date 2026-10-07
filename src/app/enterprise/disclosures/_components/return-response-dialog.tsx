'use client';

import { Undo2 } from 'lucide-react';
import { returnCdpResponseAction } from '@/app/enterprise/actions';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { RETURN_REASON_MAX_LENGTH } from '@/lib/domain/comment-limits';

/**
 * 回答の差戻し（plan §1.15 回答・§1.16 区分 2・F074）。理由は必須。
 *
 * 理由は黙って捨てず、この回答のコメントとして残す（差し戻された担当者がコメント欄で読める）。
 * 状態の遷移と理由のコメントは 1 つの Server Action（returnCdpResponseAction）で行う。
 * 以前は 2 つの Action を順に呼んでおり、2 つ目（コメント）が失敗すると、回答は差戻しなのに
 * 理由がどこにも残らなかった。サービスが理由の長さと権限を状態を書き換える前に確かめる。
 * 理由欄の上限は、コメントの上限から前置き（「差戻し理由: 」）の分を引いた長さ。
 */
export function ReturnResponseDialog({
  responseId,
  scope,
}: {
  responseId: string;
  /** 範囲 1 行（どの回答を戻すか） */
  scope: string;
}) {
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
        maxLength: RETURN_REASON_MAX_LENGTH,
        placeholder: '直してほしい点を具体的に書いてください',
      }}
      confirmLabel="差し戻す"
      action={returnCdpResponseAction}
      fields={{ responseId }}
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
