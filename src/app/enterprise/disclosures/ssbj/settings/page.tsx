import { Check, CircleCheck, CircleDashed, FileSearch } from 'lucide-react';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { StepNav, type StepItem } from '@/components/shared/step-nav';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { MoreInfo } from '@/components/ui/more-info';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import { NativeSelect } from '@/components/ui/native-select';
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
import { UnitScopeSelector } from '../../_components/unit-scope-selector';
import { MaterialityManager } from './materiality-manager';

export const metadata = { title: 'SSBJ マテリアリティ・分析条件の設定' };

/**
 * SSBJ マテリアリティ・分析条件の設定（plan §2 S20 E23）。
 *
 * 段階 UI（StepNav: 基準と範囲 → マテリアリティ → 確定）で、いまの段階の操作だけを主操作にする
 * （画面に primary を 1 つ。以前は「確定」「分析条件を保存」「マテリアリティを追加」が同時に primary だった）。
 * 段階は同じ画面の節へのリンク（全部の節を 1 画面に残す。行き来しても入力を失わない）。
 * 確定は取り消しの効かない区切りとして確認ダイアログを通す（plan §1.16 区分 1・F032。必須チェックは要らない）。
 */
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

  const doneOf = (key: string) => view.steps.find((step) => step.key === key)?.done ?? false;
  const conditionsDone = doneOf('standards') && doneOf('boundary');
  const materialityDone = doneOf('materiality');
  // いまの段階 = 決まっていない最初の段階。すべて決まって未確定なら「確定」
  const current: 'conditions' | 'materiality' | 'confirm' | null = !conditionsDone
    ? 'conditions'
    : !materialityDone
      ? 'materiality'
      : view.confirmed
        ? null
        : 'confirm';
  const stateOf = (key: 'conditions' | 'materiality', done: boolean): StepItem['state'] =>
    done ? 'done' : current === key ? 'current' : 'todo';
  const steps: StepItem[] = [
    {
      key: 'conditions',
      label: '基準と範囲',
      state: stateOf('conditions', conditionsDone),
      href: '#ssbj-settings-conditions',
    },
    {
      key: 'materiality',
      label: 'マテリアリティ',
      state: stateOf('materiality', materialityDone),
      href: '#ssbj-settings-materiality',
    },
    {
      key: 'confirm',
      label: '確定',
      state: view.confirmed ? 'done' : current === 'confirm' ? 'current' : 'blocked',
      href: view.ready || view.confirmed ? '#ssbj-settings-confirm' : undefined,
      note: view.ready || view.confirmed ? undefined : '3 項目を決めると確定できます',
    },
  ];

  return (
    <>
      <PageHeader
        title="マテリアリティ・分析条件の設定"
        description={`${shell.currentPeriod.label} ／ ここで決めたことが、以降すべての工程の前提になります`}
        breadcrumbsTail={[{ label: 'マテリアリティ・分析条件' }]}
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        <StepNav ariaLabel="設定の段階" steps={steps} />

        {/* 何が終わっていて何が残っているかを、作業の前に必ず見せる */}
        <Card className="overflow-hidden" id="ssbj-settings-confirm">
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
                  className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-caption font-semibold ${
                    step.done ? 'bg-success text-white' : 'bg-surface-muted text-ink-muted'
                  }`}
                  aria-hidden="true"
                >
                  {step.done ? '✓' : index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-body font-medium text-ink">
                    {step.title}
                    {step.done ? (
                      <Badge tone="success">完了</Badge>
                    ) : (
                      <Badge tone="warning">未完了</Badge>
                    )}
                  </p>
                  <p className="mt-0.5 text-caption leading-relaxed text-ink-muted">
                    {step.description}
                  </p>
                  <p
                    className={`mt-0.5 text-caption ${step.done ? 'text-ink' : 'font-medium text-warning-ink'}`}
                  >
                    {step.done ? step.summary : step.todo}
                  </p>
                </div>
              </li>
            ))}
          </ol>
          <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2">
            {view.confirmed ? (
              <p className="text-caption text-ink-muted">
                {view.confirmedAt ? formatJst(view.confirmedAt) : ''} に
                {view.confirmedByName ?? '担当者'} が確定しました。
                内容を変更すると確定は取り消されます。
              </p>
            ) : (
              // 補助の説明は既定で閉じる（docs/disclosure-first.md §10.4）。確定ボタンは右に見えている
              <MoreInfo label="確定の条件">
                <p>3 項目すべてを決めると確定できます。確定は人の操作でのみ行われます。</p>
              </MoreInfo>
            )}
            {view.canEdit && !view.confirmed && (
              <ConfirmDialog
                tier="irreversible"
                title="マテリアリティ・分析条件を確定しますか"
                scope={`${shell.currentPeriod.label} の適用する基準・報告の範囲・マテリアリティ評価を、以降の工程の前提として確定します。`}
                consequences={[
                  '確定した内容が、要求事項の評価・対応計画・データ収集の前提になります。',
                  '確定後に内容を変更すると確定は取り消され、もう一度確定が必要になります。',
                ]}
                confirmLabel="確定する"
                destructive={false}
                action={confirmSsbjSettingsAction}
                fields={{ reportingPeriodId: shell.currentPeriod.id }}
                trigger={{
                  label: 'この内容で確定する',
                  icon: <Check aria-hidden="true" />,
                  variant: current === 'confirm' ? 'primary' : 'secondary',
                  size: 'sm',
                  disabled: !view.ready,
                  actionId: 'confirm-settings',
                }}
              />
            )}
          </div>
        </Card>

        {/* ①②: 適用する基準と報告の範囲 */}
        <Card className="overflow-hidden" id="ssbj-settings-conditions">
          <SectionTitle title="適用する基準と報告の範囲" />
          <form action={saveSsbjSettingsAction} className="space-y-4 p-3">
            <input type="hidden" name="reportingPeriodId" value={shell.currentPeriod.id} />

            <fieldset className="space-y-1.5">
              <legend className="text-small font-medium text-ink">適用する基準</legend>
              <p className="text-caption text-ink-muted">
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
                <div key={name}>
                  <NativeCheckbox
                    name={name}
                    defaultChecked={checked}
                    disabled={!view.canEdit}
                    label={label}
                  />
                </div>
              ))}
              <div className="pt-1">
                <NativeCheckbox
                  name="firstTimeAdoption"
                  defaultChecked={settings?.firstTimeAdoption ?? false}
                  disabled={!view.canEdit}
                  label="初年度適用の経過措置を使う（比較情報の免除など）"
                />
              </div>
            </fieldset>

            <fieldset className="space-y-1.5">
              <legend className="text-small font-medium text-ink">連結範囲</legend>
              <NativeSelect
                name="consolidationScope"
                defaultValue={settings?.consolidationScope ?? 'same_as_financial'}
                disabled={!view.canEdit}
                aria-label="連結範囲"
                className="w-field-md text-small"
              >
                {Object.entries(SSBJ_CONSOLIDATION_OPTIONS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
              <Input
                type="text"
                name="consolidationNote"
                defaultValue={settings?.consolidationNote ?? ''}
                placeholder="財務諸表と異なる範囲にする場合は、その範囲と理由"
                aria-label="連結範囲の補足"
                disabled={!view.canEdit}
                className="h-7 text-small"
              />
              {view.canEdit && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {/* 同じフォーム内から別のアクションで送信する（formAction）。
                      有価証券報告書の「関係会社の状況」「設備の状況」から
                      下の「報告対象に含める組織・拠点」へ自動チェックを入れる */}
                  <SubmitButton
                    size="sm"
                    variant="secondary"
                    icon={<FileSearch aria-hidden="true" />}
                    formAction={applySecuritiesReportAction}
                    pendingLabel="読み込み中…"
                  >
                    最新の有価証券報告書を取り込む
                  </SubmitButton>
                  <span className="text-caption text-ink-muted">
                    取り込み済みの有価証券報告書を読み、連結範囲の拠点へ自動でチェックを入れます。
                  </span>
                </div>
              )}
            </fieldset>

            <fieldset className="space-y-1.5">
              <legend className="text-small font-medium text-ink">
                報告対象に含める組織・拠点
              </legend>
              <MoreInfo label="選び方">
                <p>
                  何も選ばなければ全社を対象とします。SSBJ の報告範囲は連結財務諸表と
                  同一が基本なので、有価証券報告書から自動で選ぶこともできます。
                </p>
              </MoreInfo>
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
                supplierNote="「バリューチェーンの扱い」で上流を含める場合の候補です"
              />
            </fieldset>

            <fieldset className="space-y-1.5">
              <legend className="text-small font-medium text-ink">バリューチェーンの扱い</legend>
              <p className="text-caption text-ink-muted">
                ここが「未決定」のままでは、Scope3 の対象範囲が定まりません。
              </p>
              <NativeSelect
                name="valueChainScope"
                defaultValue={settings?.valueChainScope ?? 'not_decided'}
                disabled={!view.canEdit}
                aria-label="バリューチェーンの扱い"
                className="w-field-md text-small"
              >
                {Object.entries(SSBJ_VALUE_CHAIN_OPTIONS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
              <Input
                type="text"
                name="valueChainNote"
                defaultValue={settings?.valueChainNote ?? ''}
                placeholder="対象とする取引先の範囲・除外する理由など"
                aria-label="バリューチェーンの補足"
                disabled={!view.canEdit}
                className="h-7 text-small"
              />
            </fieldset>

            {view.canEdit && (
              <div className="flex items-center gap-2">
                <SubmitButton
                  variant={current === 'conditions' ? 'primary' : 'secondary'}
                  size="sm"
                  pendingLabel="保存中…"
                >
                  分析条件を保存
                </SubmitButton>
                <MoreInfo label="保存と確定の関係">
                  <p>保存しただけでは確定になりません。内容を変えると確定は取り消されます。</p>
                </MoreInfo>
              </div>
            )}
          </form>
        </Card>

        {/* ③: マテリアリティ。
            自由記述 → 区分の提示 → 選択、で課題を登録し、追加・編集・削除もここで行う */}
        <Card className="overflow-hidden" id="ssbj-settings-materiality">
          <SectionTitle
            title={`マテリアリティ評価（${view.assessedTopicCount} / ${view.totalTopicCount} 件を評価済み）`}
            action={
              <MoreInfo label="評価の使われ方">
                <p>重要と評価した課題の指標が、あとの「データ収集」の対象になります。</p>
              </MoreInfo>
            }
          />
          <MaterialityManager
            reportingPeriodId={shell.currentPeriod.id}
            canEdit={view.canEdit}
            addIsPrimary={current === 'materiality'}
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
