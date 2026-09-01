import Link from 'next/link';
import { ArrowLeft, Check, CircleCheck, CircleDashed } from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SubmitButton } from '@/components/ui/submit-button';
import { formatJst } from '@/lib/format/datetime';
import { loadMateriality } from '@/lib/services/materiality';
import { loadEnterpriseShell } from '@/lib/services/shell';
import {
  loadSsbjSettings,
  SSBJ_CONSOLIDATION_OPTIONS,
  SSBJ_VALUE_CHAIN_OPTIONS,
} from '@/lib/services/ssbj-settings';
import { confirmSsbjSettingsAction, saveSsbjSettingsAction } from '../../../actions';
import { MaterialityManager } from './materiality-manager';

export const metadata = { title: 'SSBJ マテリアリティ・分析条件の設定' };

export default async function SsbjSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const [view, materiality] = await Promise.all([
    loadSsbjSettings(shell.db, shell.ctx, shell.currentPeriod, shell.metrics),
    loadMateriality(shell.db, shell.ctx, shell.currentPeriod, shell.metrics),
  ]);
  const settings = view.settings;
  const units = shell.units.filter((u) => u.deletedAt === null);

  return (
    <>
      <PageHeader
        title="マテリアリティ・分析条件の設定"
        description={`${shell.currentPeriod.label} ／ ここで決めたことが、以降すべての工程の前提になります`}
        breadcrumbs={[
          { label: '企業ワークスペース' },
          { label: '開示対応' },
          { label: 'SSBJ', href: '/enterprise/disclosures/ssbj' },
          { label: 'マテリアリティ・分析条件' },
        ]}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/enterprise/disclosures/ssbj">
              <ArrowLeft aria-hidden="true" />
              対応状況へ戻る
            </Link>
          </Button>
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        {/* 何が終わっていて何が残っているかを、作業の前に必ず見せる */}
        <Card className="overflow-hidden">
          <SectionTitle
            title="決めること（3 項目）"
            action={
              view.confirmed ? (
                <Badge tone="success">
                  <CircleCheck className="size-3" aria-hidden="true" />
                  確定済み
                </Badge>
              ) : (
                <Badge tone="warning">
                  <CircleDashed className="size-3" aria-hidden="true" />
                  未完了
                </Badge>
              )
            }
          />
          <ol className="divide-y divide-line">
            {view.steps.map((step, index) => (
              <li key={step.key} className="flex items-start gap-3 px-3 py-2.5">
                <span
                  className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                    step.done ? 'bg-success text-white' : 'bg-surface-muted text-ink-muted'
                  }`}
                  aria-hidden="true"
                >
                  {step.done ? '✓' : index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                    {step.title}
                    {step.done ? (
                      <Badge tone="success">完了</Badge>
                    ) : (
                      <Badge tone="warning">未完了</Badge>
                    )}
                  </p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
                    {step.description}
                  </p>
                  <p
                    className={`mt-0.5 text-[11px] ${step.done ? 'text-ink' : 'font-medium text-[#8a5d00]'}`}
                  >
                    {step.done ? step.summary : step.todo}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2">
            {view.confirmed ? (
              <p className="text-[11px] text-ink-muted">
                {view.confirmedAt ? formatJst(view.confirmedAt) : ''} に
                {view.confirmedByName ?? '担当者'} が確定しました。
                内容を変更すると確定は取り消されます。
              </p>
            ) : (
              <p className="text-[11px] text-ink-muted">
                3 項目すべてを決めると確定できます。確定は人の操作でのみ行われます。
              </p>
            )}
            {view.canEdit && !view.confirmed && (
              <form action={confirmSsbjSettingsAction}>
                <input type="hidden" name="reportingPeriodId" value={shell.currentPeriod.id} />
                <SubmitButton
                  size="sm"
                  icon={<Check aria-hidden="true" />}
                  pendingLabel="確定中…"
                  disabled={!view.ready}
                >
                  この内容で確定する
                </SubmitButton>
              </form>
            )}
          </div>
        </Card>

        {/* ①②: 適用する基準と報告の範囲 */}
        <Card className="overflow-hidden">
          <SectionTitle title="適用する基準と報告の範囲" />
          <form action={saveSsbjSettingsAction} className="space-y-4 p-3">
            <input type="hidden" name="reportingPeriodId" value={shell.currentPeriod.id} />

            <fieldset className="space-y-1.5">
              <legend className="text-[12px] font-medium text-ink">適用する基準</legend>
              <p className="text-[11px] text-ink-muted">
                適用しない基準の要求事項は、以降の評価対象から外れます。
              </p>
              {(
                [
                  [
                    'applyGeneral',
                    '一般開示基準（テーマ別基準第1号）',
                    settings?.applyGeneral ?? true,
                  ],
                  [
                    'applyClimate',
                    '気候関連開示基準（テーマ別基準第2号）',
                    settings?.applyClimate ?? true,
                  ],
                  [
                    'applyPractical',
                    '実務対応基準第1号（温対法 SHK 制度）',
                    settings?.applyPractical ?? false,
                  ],
                ] as Array<[string, string, boolean]>
              ).map(([name, label, checked]) => (
                <label key={name} className="flex items-center gap-1.5 text-[12px] text-ink">
                  <input
                    type="checkbox"
                    name={name}
                    defaultChecked={checked}
                    disabled={!view.canEdit}
                    className="size-3.5 accent-[#0b57a4]"
                  />
                  {label}
                </label>
              ))}
              <label className="flex items-center gap-1.5 pt-1 text-[12px] text-ink">
                <input
                  type="checkbox"
                  name="firstTimeAdoption"
                  defaultChecked={settings?.firstTimeAdoption ?? false}
                  disabled={!view.canEdit}
                  className="size-3.5 accent-[#0b57a4]"
                />
                初年度適用の経過措置を使う（比較情報の免除など）
              </label>
            </fieldset>

            <fieldset className="space-y-1.5">
              <legend className="text-[12px] font-medium text-ink">連結範囲</legend>
              <select
                name="consolidationScope"
                defaultValue={settings?.consolidationScope ?? 'same_as_financial'}
                disabled={!view.canEdit}
                aria-label="連結範囲"
                className="h-7 w-[280px] rounded-t4d border border-line bg-surface px-2 text-[12px]"
              >
                {Object.entries(SSBJ_CONSOLIDATION_OPTIONS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <input
                type="text"
                name="consolidationNote"
                defaultValue={settings?.consolidationNote ?? ''}
                placeholder="財務諸表と異なる範囲にする場合は、その範囲と理由"
                aria-label="連結範囲の補足"
                disabled={!view.canEdit}
                className="h-7 w-full rounded-t4d border border-line px-2 text-[12px]"
              />
            </fieldset>

            <fieldset className="space-y-1.5">
              <legend className="text-[12px] font-medium text-ink">
                報告対象に含める組織・拠点
              </legend>
              <p className="text-[11px] text-ink-muted">何も選ばなければ全社を対象とします。</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {units.map((unit) => (
                  <label key={unit.id} className="flex items-center gap-1.5 text-[12px] text-ink">
                    <input
                      type="checkbox"
                      name="includedUnitIds"
                      value={unit.id}
                      defaultChecked={settings?.includedUnitIds.includes(unit.id) ?? false}
                      disabled={!view.canEdit}
                      className="size-3.5 accent-[#0b57a4]"
                    />
                    {unit.name}
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="space-y-1.5">
              <legend className="text-[12px] font-medium text-ink">バリューチェーンの扱い</legend>
              <p className="text-[11px] text-ink-muted">
                ここが「未決定」のままでは、Scope3 の対象範囲が定まりません。
              </p>
              <select
                name="valueChainScope"
                defaultValue={settings?.valueChainScope ?? 'not_decided'}
                disabled={!view.canEdit}
                aria-label="バリューチェーンの扱い"
                className="h-7 w-[280px] rounded-t4d border border-line bg-surface px-2 text-[12px]"
              >
                {Object.entries(SSBJ_VALUE_CHAIN_OPTIONS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <input
                type="text"
                name="valueChainNote"
                defaultValue={settings?.valueChainNote ?? ''}
                placeholder="対象とする取引先の範囲・除外する理由など"
                aria-label="バリューチェーンの補足"
                disabled={!view.canEdit}
                className="h-7 w-full rounded-t4d border border-line px-2 text-[12px]"
              />
            </fieldset>

            {view.canEdit && (
              <div className="flex items-center gap-2">
                <SubmitButton size="sm" pendingLabel="保存中…">
                  分析条件を保存
                </SubmitButton>
                <span className="text-[11px] text-ink-muted">
                  保存しただけでは確定になりません。内容を変えると確定は取り消されます。
                </span>
              </div>
            )}
          </form>
        </Card>

        {/* ③: マテリアリティ。
            自由記述 → 区分の提示 → 選択、で課題を登録し、追加・編集・削除もここで行う */}
        <Card className="overflow-hidden">
          <SectionTitle
            title={`マテリアリティ評価（${view.assessedTopicCount} / ${view.totalTopicCount} 件を評価済み）`}
            action={
              <span className="text-[11px] text-ink-muted">
                重要と評価した課題の指標が、あとの「データ収集」の対象になります
              </span>
            }
          />
          <MaterialityManager
            reportingPeriodId={shell.currentPeriod.id}
            canEdit={view.canEdit}
            topics={materiality.topics.map((topic) => ({
              id: topic.id,
              title: topic.title,
              description: topic.description,
              category: topic.category,
              materiality: topic.materiality,
              rationale: topic.rationale,
              risks: topic.risks,
              opportunities: topic.opportunities,
              metricNames: topic.metricNames,
            }))}
          />
        </Card>
      </div>
    </>
  );
}
