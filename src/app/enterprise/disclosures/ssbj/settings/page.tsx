import Link from 'next/link';
import { ArrowLeft, Check, CircleCheck, CircleDashed, FileSearch } from 'lucide-react';
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
import {
  applySecuritiesReportAction,
  confirmSsbjSettingsAction,
  saveSsbjSettingsAction,
} from '../../../actions';
import { MaterialityManager } from './materiality-manager';

export const metadata = { title: 'SSBJ マテリアリティ・分析条件の設定' };

interface UnitOption {
  id: string;
  name: string;
  unitType: string;
  countryCode: string;
  consolidationMethod: string;
  ownershipPercent: number;
}

/**
 * 報告対象の組織・拠点を、資本関係 → 国内外 → サプライヤー の階層で選ぶ。
 *
 * 平らな一覧だと「どこまでが連結範囲か」が読めない。SSBJ の報告範囲の
 * 判断軸（資本関係・所在地・バリューチェーン）に沿って束ねる。
 */
function UnitScopeSelector({
  units,
  includedUnitIds,
  disabled,
}: {
  units: UnitOption[];
  includedUnitIds: string[];
  disabled: boolean;
}) {
  const groups: Array<{ title: string; note?: string; members: UnitOption[] }> = [
    {
      title: '本社・直轄拠点',
      members: units.filter((u) => u.unitType === 'headquarters' || u.unitType === 'site'),
    },
    {
      title: '100% 子会社（連結）',
      members: units.filter(
        (u) =>
          u.unitType === 'subsidiary' &&
          (u.consolidationMethod === 'full' || u.consolidationMethod === 'proportionate'),
      ),
    },
    {
      title: '持分法適用会社',
      note: '連結範囲の外。含めるかどうかは自社の方針で決めます',
      members: units.filter((u) => u.consolidationMethod === 'equity'),
    },
    {
      title: 'サプライヤー',
      note: '「バリューチェーンの扱い」で上流を含める場合の候補です',
      members: units.filter((u) => u.unitType === 'supplier'),
    },
  ];

  return (
    <div className="space-y-2">
      {groups
        .filter((group) => group.members.length > 0)
        .map((group) => (
          <div key={group.title} className="rounded-t4d border border-line px-2.5 py-2">
            <p className="flex items-center gap-2 text-[12px] font-medium text-ink">
              {group.title}
              {group.note && (
                <span className="font-normal text-[11px] text-ink-muted">（{group.note}）</span>
              )}
            </p>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {/* 国内 → 海外の順に並べ、所在をバッジで併記する */}
              {[...group.members]
                .sort((a, b) => Number(a.countryCode !== 'JP') - Number(b.countryCode !== 'JP'))
                .map((unit) => (
                  <label key={unit.id} className="flex items-center gap-1.5 text-[12px] text-ink">
                    <input
                      type="checkbox"
                      name="includedUnitIds"
                      value={unit.id}
                      defaultChecked={includedUnitIds.includes(unit.id)}
                      disabled={disabled}
                      className="size-3.5 accent-[#0b57a4]"
                    />
                    {unit.name}
                    <Badge tone="neutral">{unit.countryCode === 'JP' ? '国内' : '海外'}</Badge>
                    {unit.consolidationMethod === 'equity' && (
                      <span className="text-[11px] text-ink-muted">
                        持分 {unit.ownershipPercent}%
                      </span>
                    )}
                  </label>
                ))}
            </div>
          </div>
        ))}
    </div>
  );
}

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
              {view.canEdit && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {/* 同じフォーム内から別のアクションで送信する（formAction）。
                      有価証券報告書の「関係会社の状況」「設備の状況」から
                      下の「報告対象に含める組織・拠点」へ自動チェックを入れる */}
                  <SubmitButton
                    size="sm"
                    variant="outline"
                    icon={<FileSearch aria-hidden="true" />}
                    formAction={applySecuritiesReportAction}
                    pendingLabel="読み込み中…"
                  >
                    最新の有価証券報告書を取り込む
                  </SubmitButton>
                  <span className="text-[11px] text-ink-muted">
                    取り込み済みの有価証券報告書を読み、連結範囲の拠点へ自動でチェックを入れます。
                  </span>
                </div>
              )}
            </fieldset>

            <fieldset className="space-y-1.5">
              <legend className="text-[12px] font-medium text-ink">
                報告対象に含める組織・拠点
              </legend>
              <p className="text-[11px] text-ink-muted">
                何も選ばなければ全社を対象とします。SSBJ の報告範囲は連結財務諸表と
                同一が基本なので、有価証券報告書から自動で選ぶこともできます。
              </p>
              <UnitScopeSelector
                units={units.map((unit) => ({
                  id: unit.id,
                  name: unit.name,
                  unitType: unit.unitType,
                  countryCode: unit.countryCode,
                  consolidationMethod: unit.consolidationMethod,
                  ownershipPercent: unit.ownershipPercent,
                }))}
                includedUnitIds={settings?.includedUnitIds ?? []}
                disabled={!view.canEdit}
              />
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
