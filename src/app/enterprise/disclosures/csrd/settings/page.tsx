import Link from 'next/link';
import { ArrowLeft, Check, CircleCheck, CircleDashed, PencilLine, Save } from 'lucide-react';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { FlashMessage } from '@/components/shared/flash';
import { Notice } from '@/components/shared/notice';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { StepNav, type StepItem } from '@/components/shared/step-nav';
import { Badge } from '@/components/ui/badge';
import { Collapsible } from '@/components/ui/collapsible';
import { Input, Textarea } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import {
  DMA_AXIS_ASSESSMENT_LABEL,
  DMA_METHOD_NOTE,
  DMA_OUTCOME_LABEL,
  ESRS_TOPIC_LABEL,
} from '@/lib/domain/csrd';
import { DMA_THRESHOLD_MAX, DMA_THRESHOLD_MIN } from '@/lib/domain/dma';
import { formatJst } from '@/lib/format/datetime';
import { loadCsrdSettings } from '@/lib/services/csrd/settings';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { SSBJ_CONSOLIDATION_OPTIONS, SSBJ_VALUE_CHAIN_OPTIONS } from '@/lib/services/ssbj-settings';
import { DmaOutcomeBadge } from '../_components/csrd-badges';
import { DmaMatrix } from './_components/dma-matrix';
import { DoubleMaterialityNote } from './_components/materiality-note';
import { UnitScopeSelector } from '../../_components/unit-scope-selector';
import { confirmCsrdDmaAction, saveCsrdBoundaryAction, saveCsrdMethodAction } from './actions';
import { axisProposalLabel, axisProposalText, formatScore, matrixInputsOf } from './dma-view';
import { CSRD_SETTINGS_PATH } from './form-input';

export const metadata = { title: 'CSRD 設定（報告範囲・ダブル・マテリアリティ評価）' };

const BASE = '/enterprise/disclosures/csrd';

/** 手順（URL の ?step=）。既存の①〜③の番号をそのまま使う */
const STEP_KEYS = ['boundary', 'method', 'dma'] as const;
type StepKey = (typeof STEP_KEYS)[number];

/** 開く手順: URL の指定 → 未完了の最初の手順 → すべて完了なら③（確定がある段） */
function resolveStep(value: unknown, done: Record<StepKey, boolean>): StepKey {
  if (typeof value === 'string' && (STEP_KEYS as readonly string[]).includes(value)) {
    return value as StepKey;
  }
  return STEP_KEYS.find((key) => !done[key]) ?? 'dma';
}

/**
 * CSRD の設定（docs/disclosure-first.md §9.4・plan S11）。SSBJ と同様にメニュー外で、対応状況の工程①から入る。
 *  ① 報告範囲（SSBJ と同じ部品・同じ値）
 *  ② 評価方法・閾値・ステークホルダー関与（ESRS は数値の閾値を定めていない。会社が決める）
 *  ③ ダブル・マテリアリティ評価（10 事項。算定結果は提案で、各軸の重要性は人が根拠付きで判断する）
 *  ＋ DMA の確定（人の操作。条件が揃ったときだけ。確認ダイアログを通す。AI は判断・確定に一切書かない）
 *
 * 段階の UI（StepNav。?step=boundary|method|dma）: 1 画面に 1 つの手順だけを出し、主操作はその手順の 1 つ
 * （報告範囲を保存／評価方法を保存／DMA を確定する）。既定は未完了の最初の手順（すべて完了なら③）。
 * 手順の状況（何が終わって何が残っているか）は手順の帯に文字で出す。
 *
 * 文字量を減らす（§10.4）: 考え方の詳細・算定式・マトリクスの読み方は既定で閉じる。
 * SSBJ／CSRD の見出し、未発効の注記（summary）、確定の不足一覧、AI は判断しない旨、表・図・フォームは常に見せる。
 */
export default async function CsrdSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const actions = (
    <PageActions
      secondary={[
        {
          kind: 'link',
          id: 'back',
          label: '対応状況へ戻る',
          href: BASE,
          icon: <ArrowLeft aria-hidden="true" />,
        },
      ]}
    />
  );

  if (!can(ctx, 'enterprise.disclosure.read') && !can(ctx, 'enterprise.disclosure.write')) {
    return (
      <>
        <PageHeader title="CSRD 設定" autoBreadcrumbs actions={actions} />
        <PermissionDeniedState
          description="CSRD の設定は、開示の閲覧権限を持つ利用者のみ閲覧できます。"
          permission="enterprise.disclosure.read"
        />
      </>
    );
  }

  const view = await loadCsrdSettings(db, ctx, shell.currentPeriod);
  if (!view) {
    return (
      <>
        <PageHeader title="CSRD 設定" autoBreadcrumbs actions={actions} />
        <div className="p-4">
          <EmptyState
            kind="not-applicable"
            title="ESRS 項目マスターが登録されていません"
            description="CSRD の要求事項マスター（架空の縮小サンプル）が登録されると、報告範囲とダブル・マテリアリティ評価を設定できます。マスターの登録は管理者が行います。"
          />
        </div>
      </>
    );
  }

  const { settings, readiness } = view;
  const units = shell.units.filter((u) => u.deletedAt === null);
  const decidedCount = view.matterTotal - view.outcomeCounts.not_assessed;
  const steps: Record<
    StepKey,
    { title: string; label: string; done: boolean; summary: string; todo: string }
  > = {
    boundary: {
      title: '① 報告範囲',
      label: '① 報告範囲',
      done: view.settingsPersisted && readiness.boundaryDecided,
      summary: `${SSBJ_CONSOLIDATION_OPTIONS[settings.consolidationScope]} ／ バリューチェーン: ${SSBJ_VALUE_CHAIN_OPTIONS[settings.valueChainScope]}`,
      todo: view.settingsPersisted
        ? 'バリューチェーンの扱い（異なる連結範囲ならその説明）を決めてください。'
        : '報告範囲を保存してください（既定値で表示しています）。',
    },
    method: {
      title: '② 評価方法・閾値・ステークホルダー関与',
      label: '② 評価方法・閾値',
      done: view.settingsPersisted && readiness.stakeholderNoted,
      summary: `閾値 インパクト ${formatScore(view.thresholds.impactThreshold)}・財務 ${formatScore(view.thresholds.financialThreshold)} ／ ステークホルダー関与: 記載あり`,
      todo: 'ステークホルダー関与（誰の意見をどう聞いたか）を記載して保存してください。',
    },
    dma: {
      title: `③ ダブル・マテリアリティ評価（判断済み ${decidedCount} / ${view.matterTotal} 事項）`,
      label: '③ 10 事項の判断と DMA の確定',
      done: readiness.allMattersAssessed,
      summary: `判断済み ${decidedCount} / ${view.matterTotal} 事項（両面 ${view.outcomeCounts.both}・インパクトのみ ${view.outcomeCounts.impact_only}・財務のみ ${view.outcomeCounts.financial_only}・重要でない ${view.outcomeCounts.not_material}）`,
      todo: `判断済み ${decidedCount} / ${view.matterTotal} 事項。未評価: ${readiness.unassessedTopics
        .map((t) => `${t} ${ESRS_TOPIC_LABEL[t]}`)
        .join('、')}`,
    },
  };
  const step = resolveStep(query.step, {
    boundary: steps.boundary.done,
    method: steps.method.done,
    dma: steps.dma.done,
  });
  const stepItems: StepItem[] = STEP_KEYS.map((key) => ({
    key,
    label: steps[key].label,
    state: key === step ? 'current' : steps[key].done ? 'done' : 'todo',
    href: `${CSRD_SETTINGS_PATH}?step=${key}`,
    // 未完了の手順は、何をすれば終わるかを文字で添える
    note: steps[key].done ? undefined : steps[key].todo,
  }));
  const canConfirm = view.canEdit && !view.confirmed;
  const confirmReady = view.settingsPersisted && readiness.ready;
  const differing = view.matters.filter((m) => m.proposedOutcome !== m.outcome).length;
  const current = steps[step];

  return (
    <>
      <PageHeader
        title="CSRD 設定（報告範囲・ダブル・マテリアリティ評価）"
        description={`${shell.currentPeriod.label} ／ 報告範囲と DMA が要求事項の適用を決めます`}
        help={
          <>
            <p>
              ここで決めた報告範囲とダブル・マテリアリティ評価（DMA）が、要求事項の適用（評価対象）の前提になります。
            </p>
            <p>
              ① 報告範囲 → ② 評価方法・閾値・ステークホルダー関与 → ③ 10
              事項の判断の順に決め、条件が揃ったら人が DMA
              を確定します。手順は上の帯から切り替えられます。
            </p>
            <p>
              インパクトは自社の事業だけでなく、上流・下流のバリューチェーンでも生じるため、バリューチェーンの扱いも決めます。
            </p>
          </>
        }
        autoBreadcrumbs
        actions={actions}
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        <DoubleMaterialityNote />

        {/* 何が終わっていて何が残っているかを、作業の前に見せる（手順の帯。未完了の手順には残りを文字で） */}
        <Section
          title="決めること（3 手順＋確定）"
          actions={
            view.confirmed ? (
              <Badge tone="success">
                <CircleCheck className="size-3" aria-hidden="true" />
                DMA 確定済み
              </Badge>
            ) : (
              <Badge tone="warning">
                <CircleDashed className="size-3" aria-hidden="true" />
                DMA 未確定
              </Badge>
            )
          }
          bodyClassName="space-y-1.5"
        >
          <StepNav ariaLabel="CSRD 設定の手順" steps={stepItems} />
          {/* 確定は人だけが行うこと（AI は判断・確定に書かない）は、どの手順でも閉じずに見せる */}
          {view.confirmed ? (
            <p className="text-caption text-ink-muted">
              {formatJst(view.confirmedAt)} に {view.confirmedByName ?? '担当者'}{' '}
              が確定しました。報告範囲・閾値・IRO・事項の判断を変更すると確定は取り消されます。
            </p>
          ) : (
            <p className="text-caption text-ink-muted">
              確定は人の操作でのみ行われます。AI は DMA
              の判断・確定を行いません（候補も作りません）。
            </p>
          )}
        </Section>

        {step === 'boundary' && (
          <Section
            id="csrd-settings-boundary"
            title={current.title}
            summary={current.done ? current.summary : undefined}
          >
            <form action={saveCsrdBoundaryAction} className="space-y-4">
              <input type="hidden" name="reportingPeriodId" value={shell.currentPeriod.id} />
              <fieldset className="space-y-1.5">
                <legend className="text-small font-medium text-ink">連結範囲</legend>
                <NativeSelect
                  name="consolidationScope"
                  defaultValue={settings.consolidationScope}
                  disabled={!view.canEdit}
                  aria-label="連結範囲"
                  className="max-w-[280px]"
                >
                  {Object.entries(SSBJ_CONSOLIDATION_OPTIONS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </NativeSelect>
                <Input
                  name="consolidationNote"
                  defaultValue={settings.consolidationNote}
                  placeholder="財務諸表と異なる範囲にする場合は、その範囲と理由"
                  aria-label="連結範囲の補足"
                  disabled={!view.canEdit}
                />
              </fieldset>

              <fieldset className="space-y-1.5">
                <legend className="text-small font-medium text-ink">
                  報告対象に含める組織・拠点
                </legend>
                <p className="text-caption text-ink-muted">何も選ばなければ全社を対象とします。</p>
                <UnitScopeSelector
                  units={units.map((unit) => ({
                    id: unit.id,
                    name: unit.name,
                    unitType: unit.unitType,
                    countryCode: unit.countryCode,
                    consolidationMethod: unit.consolidationMethod,
                    ownershipPercent: unit.ownershipPercent,
                  }))}
                  includedUnitIds={settings.includedUnitIds}
                  disabled={!view.canEdit}
                  supplierNote="バリューチェーン（上流）を含める場合の候補です"
                />
              </fieldset>

              <fieldset className="space-y-1.5">
                <legend className="text-small font-medium text-ink">バリューチェーンの扱い</legend>
                <p className="text-caption text-ink-muted">
                  「未決定」のままでは DMA を確定できません。
                </p>
                <NativeSelect
                  name="valueChainScope"
                  defaultValue={settings.valueChainScope}
                  disabled={!view.canEdit}
                  aria-label="バリューチェーンの扱い"
                  className="max-w-[280px]"
                >
                  {Object.entries(SSBJ_VALUE_CHAIN_OPTIONS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </NativeSelect>
                <Input
                  name="valueChainNote"
                  defaultValue={settings.valueChainNote}
                  placeholder="対象とする取引先の範囲・除外する理由など"
                  aria-label="バリューチェーンの補足"
                  disabled={!view.canEdit}
                />
              </fieldset>

              {view.canEdit && (
                <div className="flex items-center gap-2">
                  <SubmitButton
                    size="sm"
                    variant="primary"
                    icon={<Save aria-hidden="true" />}
                    pendingLabel="保存中…"
                  >
                    報告範囲を保存
                  </SubmitButton>
                  {/* 取り消す確定があるときだけ書く（未確定のときは何も起きない） */}
                  {view.confirmed && (
                    <span className="text-caption text-ink-muted">
                      保存すると DMA の確定は取り消されます（前提が変わるため）。
                    </span>
                  )}
                </div>
              )}
            </form>
          </Section>
        )}

        {step === 'method' && (
          <Section
            id="csrd-settings-method"
            title={current.title}
            summary={current.done ? current.summary : undefined}
            actions={<span className="text-caption text-ink-muted">{view.scoringMethodLabel}</span>}
          >
            <form action={saveCsrdMethodAction} className="space-y-3">
              <input type="hidden" name="reportingPeriodId" value={shell.currentPeriod.id} />
              {/* 「ESRS は数値の閾値を定めていない」ことは summary に置き、閉じていても見せる */}
              <Collapsible
                variant="plain"
                summary="算定式と閾値の決め方（ESRS は数値の閾値を定めていません）"
                bodyClassName="space-y-1 leading-relaxed text-ink-muted"
              >
                <p>{DMA_METHOD_NOTE}</p>
                <p>
                  インパクトのスコア = 深刻度（負: 規模・範囲・回復困難性の平均、正:
                  規模・範囲の平均）。潜在は √(深刻度 ×
                  発生可能性)、ただし人権に関わる潜在のインパクトは深刻度を使います。リスク・機会のスコア
                  = √(発生可能性 × 財務影響の大きさ)。小数 1
                  桁に丸めた値で閾値と比べ、閾値ちょうどは「重要」を提案します。
                </p>
                <p>
                  閾値は {DMA_THRESHOLD_MIN.toFixed(1)}〜{DMA_THRESHOLD_MAX.toFixed(1)} の小数 1
                  桁（デモ既定は
                  3.0）。閾値を変えると算定結果（提案）が変わります。人の判断は変わりません。
                </p>
              </Collapsible>
              <div className="flex flex-wrap gap-4">
                <label className="space-y-1 text-small text-ink">
                  <span className="block font-medium">インパクトの閾値（インパクト重要性）</span>
                  <Input
                    type="number"
                    name="impactThreshold"
                    step="0.1"
                    min={DMA_THRESHOLD_MIN}
                    max={DMA_THRESHOLD_MAX}
                    defaultValue={formatScore(view.thresholds.impactThreshold)}
                    disabled={!view.canEdit}
                    className="w-28"
                  />
                </label>
                <label className="space-y-1 text-small text-ink">
                  <span className="block font-medium">財務の閾値（財務的重要性）</span>
                  <Input
                    type="number"
                    name="financialThreshold"
                    step="0.1"
                    min={DMA_THRESHOLD_MIN}
                    max={DMA_THRESHOLD_MAX}
                    defaultValue={formatScore(view.thresholds.financialThreshold)}
                    disabled={!view.canEdit}
                    className="w-28"
                  />
                </label>
              </div>
              <label className="block space-y-1 text-small text-ink">
                <span className="block font-medium">
                  評価方法の説明（自社の方法として開示する内容）
                </span>
                <Textarea
                  name="methodNote"
                  rows={2}
                  defaultValue={settings.methodNote}
                  disabled={!view.canEdit}
                />
              </label>
              <label className="block space-y-1 text-small text-ink">
                <span className="block font-medium">
                  ステークホルダー関与（誰の意見をどう聞いたか。DMA の確定に必要）
                </span>
                <Textarea
                  name="stakeholderEngagementNote"
                  rows={2}
                  defaultValue={settings.stakeholderEngagementNote}
                  disabled={!view.canEdit}
                />
              </label>
              {view.canEdit && (
                <div className="flex items-center gap-2">
                  <SubmitButton
                    size="sm"
                    variant="primary"
                    icon={<Save aria-hidden="true" />}
                    pendingLabel="保存中…"
                  >
                    評価方法を保存
                  </SubmitButton>
                  {view.confirmed && (
                    <span className="text-caption text-ink-muted">
                      保存すると DMA の確定は取り消されます（人の判断は変わりません）。
                    </span>
                  )}
                </div>
              )}
            </form>
          </Section>
        )}

        {step === 'dma' && (
          <Section
            id="csrd-settings-dma"
            title={current.title}
            summary="算定結果は提案。重要性は事項ごとに人が根拠を付けて判断します"
            actions={
              canConfirm ? (
                <ConfirmDialog
                  tier="irreversible"
                  destructive={false}
                  title="ダブル・マテリアリティ評価（DMA）を確定しますか"
                  scope={`${shell.currentPeriod.label} の DMA（10 事項の人の判断・報告範囲・評価方法）を確定します`}
                  consequences={[
                    '要求事項の適用から「暫定」が外れ、確定した判断に基づく適用になります。',
                    '確定の後に報告範囲・閾値・IRO・事項の判断を変更すると、確定は取り消されます。',
                    '確定は人の操作です。AI は DMA の判断・確定を行いません。',
                  ]}
                  confirmLabel="確定する"
                  action={confirmCsrdDmaAction}
                  fields={{ reportingPeriodId: shell.currentPeriod.id }}
                  trigger={{
                    label: 'DMA を確定する',
                    variant: 'primary',
                    size: 'sm',
                    icon: <Check aria-hidden="true" />,
                    disabled: !confirmReady,
                    actionId: 'confirm-dma',
                  }}
                />
              ) : undefined
            }
            bodyClassName="space-y-3"
          >
            {/* 確定できない理由（不足一覧）は確定の操作の近くに閉じずに見せる */}
            {!view.confirmed && !confirmReady && (
              <Notice tone="warning" className="mb-0">
                <ul className="list-inside list-disc text-caption">
                  {!view.settingsPersisted && <li>先に報告範囲と評価方法を保存してください。</li>}
                  {readiness.missing.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </Notice>
            )}
            <div className="t4d-scroll-x">
              <Table aria-label="サステナビリティ事項のダブル・マテリアリティ評価">
                <THead>
                  <TR>
                    <TH>サステナビリティ事項</TH>
                    <TH align="right">IRO</TH>
                    <TH>インパクト重要性（算定）</TH>
                    <TH>財務的重要性（算定）</TH>
                    <TH>算定結果（提案）</TH>
                    <TH>人の判断</TH>
                    <TH>判断者・日時</TH>
                  </TR>
                </THead>
                <TBody>
                  {view.matters.map((state) => {
                    const impactCount = state.iros.filter((i) => i.iroType === 'impact').length;
                    const financialCount = state.iros.length - impactCount;
                    const decidedBy = state.matter.decidedBy
                      ? (view.decidedByNames[state.matter.decidedBy] ?? '—')
                      : null;
                    return (
                      <TR key={state.topic}>
                        <TD className="font-medium text-ink">
                          <Link
                            href={`${BASE}/settings/matters/${state.topic}`}
                            className="text-brand-700 underline-offset-2 hover:underline"
                          >
                            <span className="font-mono text-caption">{state.topic}</span>{' '}
                            {ESRS_TOPIC_LABEL[state.topic]}
                          </Link>
                        </TD>
                        <TD align="right" className="whitespace-nowrap text-caption tabular-nums">
                          インパクト {impactCount} ／ リスク・機会 {financialCount}
                        </TD>
                        <TD className="whitespace-nowrap text-small">
                          <span className="tabular-nums">
                            {axisProposalText(state.axes.impact)}
                          </span>
                          <span className="block text-caption text-ink-muted">
                            {axisProposalLabel(state.axes.impact) === '評価材料なし'
                              ? 'インパクト IRO がありません'
                              : `${axisProposalLabel(state.axes.impact)}を提案`}
                          </span>
                        </TD>
                        <TD className="whitespace-nowrap text-small">
                          <span className="tabular-nums">
                            {axisProposalText(state.axes.financial)}
                          </span>
                          <span className="block text-caption text-ink-muted">
                            {axisProposalLabel(state.axes.financial) === '評価材料なし'
                              ? 'リスク・機会の IRO がありません'
                              : `${axisProposalLabel(state.axes.financial)}を提案`}
                          </span>
                        </TD>
                        <TD>
                          <span className="flex items-center gap-1">
                            <span className="text-caption text-ink-muted">提案</span>
                            <DmaOutcomeBadge outcome={state.proposedOutcome} />
                          </span>
                        </TD>
                        <TD>
                          <DmaOutcomeBadge outcome={state.outcome} />
                          <span className="mt-0.5 block whitespace-nowrap text-caption text-ink-muted">
                            インパクト: {DMA_AXIS_ASSESSMENT_LABEL[state.matter.impactAssessment]}{' '}
                            ／ 財務: {DMA_AXIS_ASSESSMENT_LABEL[state.matter.financialAssessment]}
                          </span>
                        </TD>
                        <TD className="whitespace-nowrap text-caption text-ink-muted">
                          {decidedBy ? (
                            <>
                              {decidedBy}
                              <span className="block">{formatJst(state.matter.decidedAt)}</span>
                            </>
                          ) : (
                            '未判断'
                          )}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
            <div className="grid grid-cols-[minmax(0,440px)_1fr] items-start gap-4">
              <DmaMatrix inputs={matrixInputsOf(view.matters)} thresholds={view.thresholds} />
              <div className="min-w-0 space-y-2 text-small text-ink">
                <p className="text-caption text-ink-muted">
                  位置は算定結果（提案）。適用を決めるのは表の「人の判断」です。閾値はインパクト{' '}
                  {formatScore(view.thresholds.impactThreshold)}・財務{' '}
                  {formatScore(view.thresholds.financialThreshold)}
                  （自社の評価方法・デモ既定。ESRS は数値の閾値を定めていません。変更は「②
                  評価方法・閾値」で行います）。
                </p>
                {/* 読み方と事項ごとの一覧は表と同じ内容なので既定で閉じる（§10.4） */}
                <Collapsible
                  variant="plain"
                  summary={`マトリクスの読み方・事項ごとの判断（提案と人の判断が違う事項 ${differing} 件）`}
                  bodyClassName="space-y-1.5"
                >
                  <p className="text-caption leading-relaxed text-ink-muted">
                    各事項を、算定したインパクトのスコア（縦）とリスク・機会のスコア（横）の位置に置いています（表と同じ内容）。
                    閾値の線より上ならインパクト重要性、右なら財務的重要性で「重要」を提案します。
                  </p>
                  <ul className="space-y-0.5 text-caption text-ink-muted">
                    {view.matters.map((state) => (
                      <li key={state.topic} className="flex flex-wrap items-center gap-1">
                        <span className="font-mono text-ink">{state.topic}</span>
                        {ESRS_TOPIC_LABEL[state.topic]}: 人の判断 {DMA_OUTCOME_LABEL[state.outcome]}
                        {state.proposedOutcome !== state.outcome && (
                          <span>（提案は {DMA_OUTCOME_LABEL[state.proposedOutcome]}）</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </Collapsible>
                {view.canEdit && (
                  <p className="flex items-center gap-1 text-caption text-ink-muted">
                    <PencilLine className="size-3" aria-hidden="true" />
                    IRO の追加・編集と判断は、表の事項名から事項の画面で行います。
                  </p>
                )}
              </div>
            </div>
          </Section>
        )}
      </div>
    </>
  );
}
