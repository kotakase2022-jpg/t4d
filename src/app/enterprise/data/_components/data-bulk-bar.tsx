'use client';

import * as React from 'react';
import { Check, Send, Undo2 } from 'lucide-react';
import { BulkActionBar, type BulkActionSpec } from '@/components/shared/bulk-action-bar';
import { Notice } from '@/components/shared/notice';
import { bulkTransitionAction, type BulkTransitionState } from '../../actions';

/**
 * 非財務データの一括操作（F019。plan §1.7・§1.16 区分 2・S16）。共通の BulkActionBar に、
 * 一括の状態遷移（bulkTransitionAction）の結果表示（useActionState）を足したもの。
 *
 * - 行を選んだときだけ表の下端に出る（選択 0 件では描かない。押せない一括ボタンを常に並べない）
 * - 出す操作は権限で決める: 提出＝データの入力、レビューへ・差戻し＝レビュー、承認＝データの承認
 *   （以前はレビューの権限でも一括承認を出していた。押すと必ず失敗する＝R4）
 * - 差戻し・承認は件数と状態の内訳を確認してから送る（区分 2）
 * - 一括操作は 1 件ずつ状態遷移と権限を検査するため、部分的に失敗する。成功件数と失敗理由を必ず出す
 * - 差戻しは理由を必須にする（単票の差戻しと同じ「差戻し理由」。各行のコメントと承認の記録に残る）
 */
export function DataBulkBar({
  formId,
  canWrite,
  canReview,
  canApprove,
}: {
  formId: string;
  canWrite: boolean;
  canReview: boolean;
  canApprove: boolean;
}) {
  const [state, formAction, pending] = React.useActionState<BulkTransitionState | null, FormData>(
    bulkTransitionAction,
    null,
  );

  const actions: BulkActionSpec[] = [
    {
      id: 'bulk-submit',
      label: '一括提出',
      icon: <Send aria-hidden="true" />,
      submitter: { name: 'to', value: 'submitted' },
      hidden: !canWrite,
    },
    {
      id: 'bulk-review',
      label: 'レビューへ',
      submitter: { name: 'to', value: 'in_review' },
      hidden: !canReview,
    },
    {
      id: 'bulk-return',
      label: '差戻し',
      icon: <Undo2 aria-hidden="true" />,
      submitter: { name: 'to', value: 'returned' },
      hidden: !canReview,
      confirm: {
        tier: 'bulk',
        title: '選択したデータを差し戻しますか',
        scope: (count, breakdown) => `選択した ${count} 件（${breakdown}）を差戻しにします。`,
        consequences: [
          '提出済み・レビュー中の行だけが差戻しになります。それ以外の行は変更できなかった理由を表示します。',
          '理由は差し戻した各行のコメントと承認の記録に残ります。',
        ],
        reason: { name: 'comment', label: '差戻し理由', required: true },
        confirmLabel: '差し戻す',
      },
    },
    {
      id: 'bulk-approve',
      label: '一括承認',
      icon: <Check aria-hidden="true" />,
      variant: 'primary',
      submitter: { name: 'to', value: 'approved' },
      hidden: !canApprove,
      confirm: {
        tier: 'bulk',
        title: '選択したデータを承認しますか',
        scope: (count, breakdown) => `選択した ${count} 件（${breakdown}）を承認済みにします。`,
        consequences: [
          '承認の道筋がある組織では段階を飛ばして承認できません。その行は理由を表示して変更しません。',
          '根拠資料が必須の指標で資料が無い行も承認しません。',
        ],
        confirmLabel: '承認する',
      },
    },
  ];

  return (
    <BulkActionBar formId={formId} action={formAction} actions={actions} pending={pending}>
      {state && (
        <Notice
          tone={state.failures.length > 0 ? 'warning' : 'success'}
          role="status"
          className="mt-1.5"
        >
          {state.message}
        </Notice>
      )}
    </BulkActionBar>
  );
}
