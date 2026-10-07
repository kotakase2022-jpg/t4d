'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { CalendarPlus } from 'lucide-react';
import { PreservingForm } from '@/components/shared/preserving-form';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { PERIOD_STATUS_LABELS } from '@/lib/domain/disclosure-status';
import type { FormActionState } from '@/lib/errors/form-action-state';
import { PERIOD_STATUSES } from '@/types/domain';
import type { PeriodDefaults } from '../_lib/period-defaults';

/**
 * 報告年度の追加（plan §2 S10: 6 項目の小さなダイアログのまま。§1.13-4）。
 *
 * - 既定値は最新の期間＋1 年（D12）。人は確かめて「作成」を押すだけで済む
 * - 送信に失敗したら、ダイアログを開いたまま理由を示し、入力を残す（PreservingForm）
 * - 作成できたらページが ?flash= 付きで描き直されるので、そのときに閉じる
 */
export function AddReportingPeriodButton({
  action,
  defaults,
}: {
  action: (previous: FormActionState, formData: FormData) => Promise<FormActionState>;
  defaults: PeriodDefaults;
}) {
  const [open, setOpen] = React.useState(false);
  const searchParams = useSearchParams();
  const flash = searchParams.get('flash');

  React.useEffect(() => {
    if (flash === 'masterPeriodCreated') setOpen(false);
  }, [flash]);

  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
        <CalendarPlus aria-hidden="true" />
        報告年度を追加
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>報告年度を追加</DialogTitle>
            <DialogDescription>
              最新の報告年度の 1 年後を入れてあります。違うところだけ直してください。
            </DialogDescription>
          </DialogHeader>
          <PreservingForm action={action} className="space-y-2 px-4 py-3">
            <div className="grid grid-cols-2 gap-2">
              <Field label="年度コード" id="period-code" required hint="例: FY2027">
                {(p) => <Input {...p} name="code" defaultValue={defaults.code} />}
              </Field>
              <Field label="表示名" id="period-label" required>
                {(p) => <Input {...p} name="label" defaultValue={defaults.label} />}
              </Field>
              <Field label="開始日" id="period-start" required>
                {(p) => (
                  <Input {...p} name="startDate" type="date" defaultValue={defaults.startDate} />
                )}
              </Field>
              <Field label="終了日" id="period-end" required>
                {(p) => <Input {...p} name="endDate" type="date" defaultValue={defaults.endDate} />}
              </Field>
              <Field label="状態" id="period-status" required>
                {(p) => (
                  <NativeSelect {...p} name="status" defaultValue="planning">
                    {PERIOD_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {PERIOD_STATUS_LABELS[status]}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field label="提出期限" id="period-due">
                {(p) => (
                  <Input
                    {...p}
                    name="submissionDueDate"
                    type="date"
                    defaultValue={defaults.submissionDueDate}
                  />
                )}
              </Field>
            </div>
            <DialogFooter className="-mx-4 -mb-3 mt-2">
              <Button variant="ghost" size="sm" type="button" onClick={() => setOpen(false)}>
                キャンセル
              </Button>
              <SubmitButton variant="primary" size="sm" pendingLabel="作成中…">
                作成
              </SubmitButton>
            </DialogFooter>
          </PreservingForm>
        </DialogContent>
      </Dialog>
    </>
  );
}
