import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/shared/page-header';
import { PreservingForm } from '@/components/shared/preserving-form';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { can } from '@/lib/authorization/can';
import { METRIC_CATEGORY_LABEL } from '@/lib/domain/metrics';
import type { FormActionState } from '@/lib/errors/form-action-state';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { METRIC_CATEGORIES } from '@/types/domain';
import { createCampaignAction } from '../../../actions';
import { CampaignWizard } from '../../_components/campaign-wizard';
import { runKeepingInput } from '../../_lib/form-adapter';
import { campaignDefaults, orderedUnits } from '../../_lib/master-tables';
import { orgTabHref } from '../../_lib/tabs';

export const metadata = { title: '収集キャンペーンを作成' };

/**
 * 収集キャンペーンの作成（plan §2 S10・§4 B6: モーダルの 115 チェックを専用ページの 2 段へ）。
 * 保存は既存の createCampaignAction（F112）をそのまま呼ぶ。業務エラーはこの画面で理由を示し、入力を残す。
 * 作成できたら収集キャンペーンのタブへ戻る。権限（報告期間の管理）はサービスが検査し、ページも同じ権限で閉じる。
 */
async function saveCampaign(
  _previous: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  'use server';
  const failure = await runKeepingInput(() => createCampaignAction(formData), formData);
  if (failure) return failure;
  const name = String(formData.get('name') ?? '').trim();
  redirect(orgTabHref('campaigns', { flash: 'masterCampaignCreated', name }));
}

export default async function NewCampaignPage() {
  const shell = await loadEnterpriseShell();
  const backHref = orgTabHref('campaigns');
  const header = (
    <PageHeader
      title="収集キャンペーンを作成"
      description="対象期間・組織・指標・期限をまとめた収集依頼を作ります"
      breadcrumbsTail={[
        { label: '収集キャンペーン', href: backHref },
        { label: '収集キャンペーンを作成' },
      ]}
    />
  );
  if (!can(shell.ctx, 'enterprise.period.manage')) {
    return (
      <>
        {header}
        <div className="p-4">
          <PermissionDeniedState
            description="収集キャンペーンの作成は、報告期間を管理する権限を持つ利用者だけが行えます。"
            permission="enterprise.period.manage"
          />
        </div>
      </>
    );
  }

  // 前回のキャンペーンの指標を既定にする（毎回 60 の指標を選び直させない）
  const campaigns = await shell.db.select('campaigns', {
    where: { organizationId: shell.ctx.workspace.organizationId },
    orderBy: { column: 'createdAt', dir: 'desc' },
    limit: 1,
  });
  const lastCampaign = campaigns[0];
  const lastScopes = lastCampaign
    ? await shell.db.select('campaignScopes', { where: { campaignId: lastCampaign.id } })
    : [];
  const lastCampaignMetricIds = [...new Set(lastScopes.map((s) => s.metricId))];

  // サプライヤーは収集対象の組織から外す（企業内の拠点・子会社が対象）
  const targetUnits = shell.units.filter((u) => u.unitType !== 'supplier');
  const defaults = campaignDefaults({
    currentPeriod: shell.currentPeriod,
    units: targetUnits,
    metrics: shell.metrics,
    lastCampaignMetricIds,
  });
  const categoryOrder = new Map<string, number>(METRIC_CATEGORIES.map((c, i) => [c, i]));
  const metricChoices = [...shell.metrics]
    .sort(
      (a, b) =>
        (categoryOrder.get(a.category) ?? 99) - (categoryOrder.get(b.category) ?? 99) ||
        a.code.localeCompare(b.code),
    )
    .map((metric) => ({
      id: metric.id,
      label: `${metric.name}（${metric.unit}）`,
      group: METRIC_CATEGORY_LABEL[metric.category],
    }));

  return (
    <>
      {header}
      <div className="max-w-6xl p-4">
        {targetUnits.length === 0 || shell.metrics.length === 0 ? (
          <EmptyState
            kind="no-data"
            title={
              targetUnits.length === 0
                ? '収集の対象にできる組織がありません'
                : '収集の対象にできる指標がありません'
            }
            description="キャンペーンは組織 × 指標の組み合わせで作ります。先に組織・拠点と指標マスターを登録してください。"
            action={
              <Link
                href={orgTabHref(targetUnits.length === 0 ? 'units' : 'metrics')}
                className="text-small text-brand-700 underline underline-offset-2"
              >
                {targetUnits.length === 0 ? '組織・拠点を登録する' : '指標マスターを登録する'}
              </Link>
            }
          />
        ) : (
          <PreservingForm action={saveCampaign} aria-label="収集キャンペーンを作成">
            <CampaignWizard
              periods={shell.periods.map((p) => ({ id: p.id, label: p.label }))}
              units={orderedUnits(targetUnits).map(({ unit, depth }) => ({
                id: unit.id,
                label: unit.name,
                depth,
              }))}
              metrics={metricChoices}
              defaults={defaults}
            />
          </PreservingForm>
        )}
        <p className="mt-3 text-small">
          <Link href={backHref} className="text-brand-700 hover:underline">
            キャンセル（収集キャンペーンの一覧へ戻る）
          </Link>
        </p>
      </div>
    </>
  );
}
