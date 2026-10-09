'use client';

import * as React from 'react';
import { BadgeCheck } from 'lucide-react';
import { BulkActionBar, type BulkActionSpec } from '@/components/shared/bulk-action-bar';
import { confirmXbrlMappingsAction } from '../actions';

/**
 * XBRL の対応付けの一括確定（承認権限者の主操作。plan NF-42・§1.7・§1.16 区分 2）。
 * 候補の行を選んだときだけ表の下端に出る。確定できない行（自分が作った・変えた・精度や軸が未設定）は
 * 選べない（サービスも 1 件ずつ検査し、確定できなかった件数を結果に出す）。
 * 戻り先の情報（プロジェクト・表示中のスナップショットと基準）は form 属性で一括のフォームへ束ねる。
 */
export function XbrlConfirmBulkBar({
  formId,
  projectId,
  snapshotId,
  frameworkVersionId,
}: {
  formId: string;
  projectId: string;
  snapshotId: string | null;
  frameworkVersionId: string | null;
}) {
  const actions: BulkActionSpec[] = [
    {
      id: 'xbrl-confirm-selected',
      label: '選択した対応付けを確定',
      icon: <BadgeCheck aria-hidden="true" />,
      variant: 'primary',
      action: confirmXbrlMappingsAction,
      confirm: {
        tier: 'bulk',
        title: '選択した対応付けを確定しますか',
        scope: (count, breakdown) =>
          `選択した ${count} 件（${breakdown}）の XBRL の対応付けを確定にします。`,
        consequences: [
          '確定した対応付けだけが XBRL の事実になります（候補・対象外は事実になりません）。',
          '作った人・最後に内容を変えた人の行は確定できません（職務分離）。理由を結果に表示します。',
          '確定後に内容を変えると候補に戻り、確定し直しが必要です。出力は社内確認用で、提出用ではありません。',
        ],
        confirmLabel: '確定する',
      },
    },
  ];
  return (
    <BulkActionBar formId={formId} actions={actions}>
      <input type="hidden" form={formId} name="projectId" value={projectId} />
      {snapshotId && <input type="hidden" form={formId} name="snapshot" value={snapshotId} />}
      {frameworkVersionId && (
        <input type="hidden" form={formId} name="fw" value={frameworkVersionId} />
      )}
    </BulkActionBar>
  );
}
