'use client';

import * as React from 'react';
import { Save } from 'lucide-react';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Button } from '@/components/ui/button';

/**
 * 承認済みの値を修正する保存（トライアル対応 NF-16）。保存の前に、影響する節・承認済みレポート・
 * 保証側へ共有中の件数を確認ダイアログで示す（plan §1.16 区分 2: 上書き）。
 *
 * 確定ボタンは値の編集のフォーム（formId）を送る。入力の不足（変更理由は必須）は、ダイアログを開く前に
 * ブラウザの検証で示す（開いたダイアログの後ろで検証の吹き出しが隠れないように）。
 */
export function ApprovedValueSaveConfirm({
  formId,
  scope,
  impact,
  variant,
}: {
  formId: string;
  scope: string;
  /** 影響の要約（例「影響する節 2・承認済みレポート 1・保証側へ共有中 1」） */
  impact: string;
  variant: 'primary' | 'secondary';
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        type="button"
        variant={variant}
        size="sm"
        data-action-id="save-approved-value"
        // 保存の近道（record-shortcuts）でも、確認ダイアログを通す
        data-t4d-shortcut="save"
        onClick={() => {
          const form = document.getElementById(formId);
          if (form instanceof HTMLFormElement && !form.reportValidity()) return;
          setOpen(true);
        }}
      >
        <Save aria-hidden="true" />
        保存…
      </Button>
      <ConfirmDialog
        tier="bulk"
        title="承認済みの値を修正しますか"
        scope={scope}
        consequences={[
          impact,
          '保存すると新しい版が追加され、「承認後に変更あり」になります。引用している原稿は「再確認が必要」になります。',
          '承認済みのレポート（スナップショット）と保証側へ共有した写しは変わりません。',
        ]}
        confirmLabel="修正を保存"
        destructive={false}
        formId={formId}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
