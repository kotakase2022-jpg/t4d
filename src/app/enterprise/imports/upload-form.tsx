'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { FileUp, Upload } from 'lucide-react';
import { FileDropZone } from '@/components/shared/file-drop-zone';
import { SubmitButton } from '@/components/ui/submit-button';
import { uploadFilesAction, type UploadResult } from '../actions';
import { savePreview } from './preview-store';
import type { PreviewOption } from './preview-table';

/**
 * ファイル投入フォーム。
 *
 * 取込結果はサーバーの応答としてこの画面へ返ってくる。
 * それを **このタブに預けてから**プレビュー画面へ移る。
 *
 * Demo Mode ではジョブがサーバーのメモリにしか無く、
 * 次のリクエストが別インスタンスへ届くと見つからない。
 * 50 ファイル（数百行）は Cookie に載らないので、ブラウザ側で持ち回る。
 */
export function UploadForm({
  reportingPeriodId,
  reportingPeriodLabel,
  units,
}: {
  reportingPeriodId: string;
  reportingPeriodLabel: string;
  units: PreviewOption[];
}) {
  const router = useRouter();
  const [state, formAction] = React.useActionState<UploadResult | null, FormData>(
    uploadFilesAction,
    null,
  );

  React.useEffect(() => {
    if (!state?.ok) return;
    savePreview(state.preview);
    router.push(`/enterprise/imports/${state.preview.jobId}?created=1`);
  }, [state, router]);

  return (
    <form action={formAction} className="space-y-3 p-3">
      <input type="hidden" name="reportingPeriodId" value={reportingPeriodId} />

      <div className="flex items-end gap-3">
        <label className="text-[12px] text-ink-muted">
          対象組織・拠点
          <select
            name="unitId"
            defaultValue={units[0]?.id ?? 'auto'}
            className="mt-0.5 block h-7 w-[220px] rounded-t4d border border-line bg-surface px-2 text-[13px]"
          >
            <option value="auto">ファイル内容から自動判定</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <p className="pb-1 text-[12px] text-ink-muted">
          対象期間: <span className="text-ink">{reportingPeriodLabel}</span>
        </p>
      </div>

      <FileDropZone
        inputId="import-files"
        className="flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-t4d-lg border-2 border-dashed border-line bg-surface-muted px-4 py-8 text-center transition-colors hover:border-brand-400 hover:bg-brand-50"
      >
        <FileUp className="size-6 text-brand-600" aria-hidden="true" />
        <span className="text-[13px] font-medium text-ink">
          クリックしてファイルを選択（複数可）／ ここへドロップ
        </span>
        <span className="text-[11px] text-ink-muted">
          対応形式: .csv / .tsv / .xlsx / .xlsm / .pdf / .docx ／ 1 ファイル 25MB まで ／ 一度に 50
          ファイルまで
        </span>
        <input
          id="import-files"
          type="file"
          name="files"
          multiple
          accept=".csv,.tsv,.xlsx,.xlsm,.pdf,.docx,text/csv,text/tab-separated-values,application/pdf"
          className="sr-only"
        />
      </FileDropZone>

      {state && !state.ok && (
        <p
          role="alert"
          className="rounded-t4d border border-danger/40 bg-danger-soft px-3 py-1.5 text-[12px] text-ink"
        >
          {state.message}
        </p>
      )}

      <div className="flex items-center gap-2">
        <SubmitButton size="sm" icon={<Upload aria-hidden="true" />} pendingLabel="解析中…">
          取込を開始
        </SubmitButton>
        <span className="text-[11px] text-ink-muted">
          解析が終わるとプレビュー画面へ移ります。
          テンプレートに記入したファイルもここへドロップしてください。
        </span>
      </div>
    </form>
  );
}
