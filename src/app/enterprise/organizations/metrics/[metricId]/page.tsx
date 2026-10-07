import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Save } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { PreservingForm } from '@/components/shared/preserving-form';
import { PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { SubmitButton } from '@/components/ui/submit-button';
import { can } from '@/lib/authorization/can';
import type { FormActionState } from '@/lib/errors/form-action-state';
import { METRIC_FRAMEWORK_LABEL } from '@/lib/domain/metrics';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { updateMetricAction } from '../../../actions';
import { MetricFormFields } from '../../_components/metric-form';
import { runKeepingInput } from '../../_lib/form-adapter';
import { orgTabHref } from '../../_lib/tabs';

export const metadata = { title: '指標を編集' };

/**
 * 指標マスターの編集（plan §2 S10・§4 B6）。保存は既存の updateMetricAction（F108）をそのまま呼ぶ。
 * 業務エラーはこの画面で理由を示し、入力を残す。保存できたら指標マスターのタブへ戻り、その指標で絞る。
 * 値が入っている任意の節は開いて描く（何が設定されているかを隠さない）。
 */
async function saveMetric(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  'use server';
  const failure = await runKeepingInput(() => updateMetricAction(formData), formData);
  if (failure) return failure;
  const code = String(formData.get('code') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  redirect(orgTabHref('metrics', { q: code, flash: 'masterMetricUpdated', name }));
}

export default async function EditMetricPage({
  params,
}: {
  params: Promise<{ metricId: string }>;
}) {
  const { metricId } = await params;
  const shell = await loadEnterpriseShell();
  const metric = shell.metrics.find((m) => m.id === metricId);
  if (!metric) notFound();
  const backHref = orgTabHref('metrics');
  const header = (
    <PageHeader
      title="指標を編集"
      context={
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-caption">{metric.code}</span>
          <span>{metric.name}</span>
          {metric.frameworks.length === 0 ? (
            <Badge tone="neutral">自社独自</Badge>
          ) : (
            metric.frameworks.map((framework) => (
              <Badge key={framework} tone="brand">
                {METRIC_FRAMEWORK_LABEL[framework]} が求める指標
              </Badge>
            ))
          )}
        </span>
      }
      breadcrumbsTail={[{ label: '指標マスター', href: backHref }, { label: metric.name }]}
    />
  );
  if (!can(shell.ctx, 'enterprise.metric.manage')) {
    return (
      <>
        {header}
        <div className="p-4">
          <PermissionDeniedState
            description="指標の編集は、指標を管理する権限を持つ利用者だけが行えます。"
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
        <PreservingForm action={saveMetric} className="space-y-3" aria-label="指標を編集">
          <MetricFormFields
            metric={metric}
            metricCodes={shell.metrics
              .filter((m) => m.id !== metric.id)
              .map((m) => ({ code: m.code, name: m.name }))}
          />
          <div className="flex items-center gap-2 border-t border-line pt-3">
            <SubmitButton
              variant="primary"
              size="sm"
              icon={<Save aria-hidden="true" />}
              pendingLabel="更新中…"
            >
              更新する
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
