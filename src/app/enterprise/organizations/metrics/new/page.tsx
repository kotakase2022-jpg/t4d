import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Plus } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { PreservingForm } from '@/components/shared/preserving-form';
import { PermissionDeniedState } from '@/components/shared/states';
import { SubmitButton } from '@/components/ui/submit-button';
import { can } from '@/lib/authorization/can';
import type { FormActionState } from '@/lib/errors/form-action-state';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { createMetricAction } from '../../../actions';
import { MetricFormFields } from '../../_components/metric-form';
import { runKeepingInput } from '../../_lib/form-adapter';
import { orgTabHref } from '../../_lib/tabs';

export const metadata = { title: '指標を追加' };

/**
 * 指標マスターの追加（plan §2 S10・§4 B6: モーダルに入れていた 19 項目を専用ページへ）。
 * 保存は既存の createMetricAction（F107）をそのまま呼ぶ。業務エラーはこの画面で理由を示し、入力を残す
 * （runKeepingInput）。追加できたら指標マスターのタブへ戻り、追加した指標で絞って見せる。
 * 権限（指標の管理）はサービスが検査する。ページも同じ権限で入口を閉じる。
 */
async function saveNewMetric(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  'use server';
  const failure = await runKeepingInput(() => createMetricAction(formData), formData);
  if (failure) return failure;
  const code = String(formData.get('code') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  redirect(orgTabHref('metrics', { q: code, flash: 'masterMetricCreated', name }));
}

export default async function NewMetricPage() {
  const shell = await loadEnterpriseShell();
  const backHref = orgTabHref('metrics');
  const header = (
    <PageHeader
      title="指標を追加"
      description="新しい非財務指標を指標マスターに登録します"
      breadcrumbsTail={[{ label: '指標マスター', href: backHref }, { label: '指標を追加' }]}
    />
  );
  if (!can(shell.ctx, 'enterprise.metric.manage')) {
    return (
      <>
        {header}
        <div className="p-4">
          <PermissionDeniedState
            description="指標の追加は、指標を管理する権限を持つ利用者だけが行えます。"
            permission="enterprise.metric.manage"
          />
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="max-w-5xl p-4">
        <PreservingForm action={saveNewMetric} className="space-y-3" aria-label="指標を追加">
          <MetricFormFields
            metricCodes={shell.metrics.map((m) => ({ code: m.code, name: m.name }))}
          />
          <div className="flex items-center gap-2 border-t border-line pt-3">
            <SubmitButton
              variant="primary"
              size="sm"
              icon={<Plus aria-hidden="true" />}
              pendingLabel="追加中…"
            >
              追加する
            </SubmitButton>
            <Link href={backHref} className="text-small text-brand-700 hover:underline">
              キャンセル（指標マスターへ戻る）
            </Link>
          </div>
        </PreservingForm>
      </div>
    </>
  );
}
