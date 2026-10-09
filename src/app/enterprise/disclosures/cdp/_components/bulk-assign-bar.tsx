'use client';

import * as React from 'react';
import { UserCheck } from 'lucide-react';
import { BulkActionBar, type BulkActionSpec } from '@/components/shared/bulk-action-bar';
import { Notice } from '@/components/shared/notice';
import { Field } from '@/components/ui/field';
import { NativeSelect } from '@/components/ui/native-select';
import { bulkAssignResponsesAction, type BulkAssignState } from '../actions';

interface Option {
  userId: string;
  displayName: string;
}

/**
 * CDP の質問の担当の一括割当（トライアル対応 NF-39 C-01。plan §1.7・§1.16 区分 2）。
 *
 * - 行を選んだときだけ表の下端に出る（BulkActionBar）
 * - 割当は件数と状態の内訳を確認してから送る（ConfirmDialog の中で担当を選ぶ）。「変更しない」を既定にし、
 *   選ばなかった側の担当を黙って消さない
 * - 結果（割り当てた件数・断った理由）をバーの下に出す（useActionState）
 */
export function CdpBulkAssignBar({
  formId,
  periodId,
  owners,
  reviewers,
}: {
  formId: string;
  periodId: string;
  owners: readonly Option[];
  reviewers: readonly Option[];
}) {
  const [state, formAction, pending] = React.useActionState<BulkAssignState | null, FormData>(
    bulkAssignResponsesAction,
    null,
  );

  const actions: BulkActionSpec[] = [
    {
      id: 'bulk-assign',
      label: '担当を割り当てる…',
      icon: <UserCheck aria-hidden="true" />,
      confirm: {
        tier: 'bulk',
        title: '選択した質問の担当を割り当てますか',
        scope: (count, breakdown) => `選択した ${count} 件（${breakdown}）の担当を変更します。`,
        consequences: [
          '「変更しない」を選んだ担当はそのままです。「担当なし」を選ぶと担当を外します。',
          '作成担当とレビュー担当は別の人にしてください（同じ人の組み合わせは割り当てません）。',
          '回答がまだ無い質問は、回答を開始した状態（未着手）にしてから割り当てます。',
        ],
        extraFields: (
          <div className="grid gap-2 sm:grid-cols-2">
            <input type="hidden" name="periodId" value={periodId} form={formId} />
            <Field label="作成担当" id={`${formId}-owner`} hint="開示を編集できる人">
              {(control) => (
                <NativeSelect {...control} name="ownerUserId" form={formId} defaultValue="">
                  <option value="">変更しない</option>
                  <option value="none">担当なし（外す）</option>
                  {owners.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.displayName}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label="レビュー担当" id={`${formId}-reviewer`} hint="開示を編集・承認できる人">
              {(control) => (
                <NativeSelect {...control} name="reviewerUserId" form={formId} defaultValue="">
                  <option value="">変更しない</option>
                  <option value="none">担当なし（外す）</option>
                  {reviewers.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.displayName}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
          </div>
        ),
        confirmLabel: '割り当てる',
      },
    },
  ];

  return (
    <BulkActionBar formId={formId} action={formAction} actions={actions} pending={pending}>
      {state && (
        <Notice tone={state.ok ? 'success' : 'warning'} role="status" className="mt-1.5">
          {state.message}
        </Notice>
      )}
    </BulkActionBar>
  );
}
