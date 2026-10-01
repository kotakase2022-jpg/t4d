import Link from 'next/link';
import { ArrowLeft, Check, CircleCheck, CircleDashed, PencilLine } from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
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

export const metadata = { title: 'CSRD 設定（報告範囲・ダブル・マテリアリティ評価）' };

const BASE = '/enterprise/disclosures/csrd';

/**
 * CSRD の設定（docs/disclosure-first.md §9.4）。SSBJ と同様にメニュー外で、対応状況の工程①から入る。
 *  ① 報告範囲（SSBJ と同じ部品・同じ値）
 *  ② 評価方法・閾値・ステークホルダー関与（ESRS は数値の閾値を定めていない。会社が決める）
 *  ③ ダブル・マテリアリティ評価（10 事項。算定結果は提案で、各軸の重要性は人が根拠付きで判断する）
 *  ＋ DMA の確定（人の操作。条件が揃ったときだけ。AI は判断・確定に一切書かない）
 */
export default async function CsrdSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const breadcrumbs = [
    { label: '企業ワークスペース' },
    { label: '開示対応' },
    { label: 'CSRD', href: BASE },
    { label: '設定（報告範囲・DMA）' },
  ];
  const backButton = (
    <Button variant="outline" size="sm" asChild>
      <Link href={BASE}>
        <ArrowLeft aria-hidden="true" />
        対応状況へ戻る
      </Link>
    </Button>
  );

  if (!can(ctx, 'enterprise.disclosure.read') && !can(ctx, 'enterprise.disclosure.write')) {
    return (
      <>
        <PageHeader title="CSRD 設定" breadcrumbs={breadcrumbs} actions={backButton} />
        <PermissionDeniedState description="CSRD の設定は、開示の閲覧権限を持つ利用者のみ閲覧できます。" />
      </>
    );
  }

  const view = await loadCsrdSettings(db, ctx, shell.currentPeriod);
  if (!view) {
    return (
      <>
        <PageHeader title="CSRD 設定" breadcrumbs={breadcrumbs} actions={backButton} />
        <div className="p-4">
          <EmptyState title="ESRS 項目マスターが登録されていません" />
        </div>
      </>
    );
  }

  const { settings, readiness } = view;
  const units = shell.units.filter((u) => u.deletedAt === null);
  const decidedCount = view.matterTotal - view.outcomeCounts.not_assessed;
  const steps = [
    {
      key: 'boundary',
      title: '① 報告範囲を決める',
      done: view.settingsPersisted && readiness.boundaryDecided,
      summary: `${SSBJ_CONSOLIDATION_OPTIONS[settings.consolidationScope]} ／ バリューチェーン: ${SSBJ_VALUE_CHAIN_OPTIONS[settings.valueChainScope]}`,
      todo: view.settingsPersisted
        ? 'バリューチェーンの扱い（異なる連結範囲ならその説明）を決めてください。'
        : '報告範囲を保存してください（既定値で表示しています）。',
    },
    {
      key: 'method',
      title: '② 評価方法・閾値・ステークホルダー関与',
      done: view.settingsPersisted && readiness.stakeholderNoted,
      summary: `閾値 インパクト ${formatScore(view.thresholds.impactThreshold)}・財務 ${formatScore(view.thresholds.financialThreshold)} ／ ステークホルダー関与: 記載あり`,
      todo: 'ステークホルダー関与（誰の意見をどう聞いたか）を記載して保存してください。',
    },
    {
      key: 'dma',
      title: '③ 10 事項のダブル・マテリアリティ評価',
      done: readiness.allMattersAssessed,
      summary: `判断済み ${decidedCount} / ${view.matterTotal} 事項（両面 ${view.outcomeCounts.both}・インパクトのみ ${view.outcomeCounts.impact_only}・財務のみ ${view.outcomeCounts.financial_only}・重要でない ${view.outcomeCounts.not_material}）`,
      todo: `判断済み ${decidedCount} / ${view.matterTotal} 事項。未評価: ${readiness.unassessedTopics
        .map((t) => `${t} ${ESRS_TOPIC_LABEL[t]}`)
        .join('、')}`,
    },
  ];
  const canConfirm = view.canEdit && !view.confirmed;
  const confirmReady = view.settingsPersisted && readiness.ready;

  return (
    <>
      <PageHeader
        title="CSRD 設定（報告範囲・ダブル・マテリアリティ評価）"
        description={`${shell.currentPeriod.label} ／ ここで決めた報告範囲と DMA が、要求事項の適用（評価対象）の前提になります`}
        breadcrumbs={breadcrumbs}
        actions={backButton}
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        <DoubleMaterialityNote />

        {/* 何が終わっていて何が残っているかを、作業の前に見せる */}
        <Card className="overflow-hidden">
          <SectionTitle
            title="決めること（3 手順＋確定）"
            action={
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
          />
          <ol className="divide-y divide-line">
            {steps.map((step) => (
              <li key={step.key} className="flex items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                    {step.title}
                    {step.done ? (
                      <Badge tone="success">
                        <CircleCheck className="size-3" aria-hidden="true" />
                        完了
                      </Badge>
                    ) : (
                      <Badge tone="warning">
                        <CircleDashed className="size-3" aria-hidden="true" />
                        未完了
                      </Badge>
                    )}
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
          <div className="space-y-1.5 border-t border-line px-3 py-2">
            {view.confirmed ? (
              <p className="text-[11px] text-ink-muted">
                {formatJst(view.confirmedAt)} に {view.confirmedByName ?? '担当者'}{' '}
                が確定しました。報告範囲・閾値・IRO・事項の判断を変更すると確定は取り消されます。
              </p>
            ) : (
              <>
                {!confirmReady && (
                  <ul className="list-inside list-disc text-[11px] text-[#8a5d00]">
                    {!view.settingsPersisted && <li>先に報告範囲と評価方法を保存してください。</li>}
                    {readiness.missing.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[11px] text-ink-muted">
                    確定は人の操作でのみ行われます。AI は DMA
                    の判断・確定を行いません（候補も作りません）。
                  </p>
                  {canConfirm && (
                    <form action={confirmCsrdDmaAction}>
                      <input
                        type="hidden"
                        name="reportingPeriodId"
                        value={shell.currentPeriod.id}
                      />
                      <SubmitButton
                        size="sm"
                        icon={<Check aria-hidden="true" />}
                        pendingLabel="確定中…"
                        disabled={!confirmReady}
                      >
                        DMA を確定する
                      </SubmitButton>
                    </form>
                  )}
                </div>
              </>
            )}
          </div>
        </Card>

        {/* ① 報告範囲 */}
        <Card className="overflow-hidden">
          <SectionTitle title="① 報告範囲" />
          <form action={saveCsrdBoundaryAction} className="space-y-4 p-3">
            <input type="hidden" name="reportingPeriodId" value={shell.currentPeriod.id} />
            <fieldset className="space-y-1.5">
              <legend className="text-[12px] font-medium text-ink">連結範囲</legend>
              <select
                name="consolidationScope"
                defaultValue={settings.consolidationScope}
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
              <Input
                name="consolidationNote"
                defaultValue={settings.consolidationNote}
                placeholder="財務諸表と異なる範囲にする場合は、その範囲と理由"
                aria-label="連結範囲の補足"
                disabled={!view.canEdit}
              />
            </fieldset>

            <fieldset className="space-y-1.5">
              <legend className="text-[12px] font-medium text-ink">
                報告対象に含める組織・拠点
              </legend>
              <p className="text-[11px] text-ink-muted">何も選ばなければ全社を対象とします。</p>
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
              <legend className="text-[12px] font-medium text-ink">バリューチェーンの扱い</legend>
              <p className="text-[11px] text-ink-muted">
                インパクトは自社の事業だけでなく、上流・下流のバリューチェーンでも生じます。「未決定」のままでは
                DMA を確定できません。
              </p>
              <select
                name="valueChainScope"
                defaultValue={settings.valueChainScope}
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
                <SubmitButton size="sm" variant="outline" pendingLabel="保存中…">
                  報告範囲を保存
                </SubmitButton>
                <span className="text-[11px] text-ink-muted">
                  保存すると DMA の確定は取り消されます（前提が変わるため）。
                </span>
              </div>
            )}
          </form>
        </Card>

        {/* ② 評価方法・閾値・ステークホルダー関与 */}
        <Card className="overflow-hidden">
          <SectionTitle
            title="② 評価方法・閾値・ステークホルダー関与"
            action={<span className="text-[11px] text-ink-muted">{view.scoringMethodLabel}</span>}
          />
          <form action={saveCsrdMethodAction} className="space-y-3 p-3">
            <input type="hidden" name="reportingPeriodId" value={shell.currentPeriod.id} />
            <p className="rounded-t4d bg-surface-muted p-2 text-[11px] leading-relaxed text-ink-muted">
              {DMA_METHOD_NOTE}
              インパクトのスコア = 深刻度（負: 規模・範囲・回復困難性の平均、正:
              規模・範囲の平均）。潜在は √(深刻度 ×
              発生可能性)、ただし人権に関わる潜在のインパクトは深刻度を使います。リスク・機会のスコア
              = √(発生可能性 × 財務影響の大きさ)。小数 1
              桁に丸めた値で閾値と比べ、閾値ちょうどは「重要」を提案します。
            </p>
            <div className="flex flex-wrap gap-4">
              <label className="space-y-1 text-[12px] text-ink">
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
              <label className="space-y-1 text-[12px] text-ink">
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
              <p className="self-end text-[11px] text-ink-muted">
                {DMA_THRESHOLD_MIN.toFixed(1)}〜{DMA_THRESHOLD_MAX.toFixed(1)} の小数 1
                桁（自社の評価方法・デモ既定は 3.0）
              </p>
            </div>
            <label className="block space-y-1 text-[12px] text-ink">
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
            <label className="block space-y-1 text-[12px] text-ink">
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
                <SubmitButton size="sm" variant="outline" pendingLabel="保存中…">
                  評価方法を保存
                </SubmitButton>
                <span className="text-[11px] text-ink-muted">
                  閾値を変えると算定結果（提案）が変わり、DMA
                  の確定は取り消されます。人の判断は変わりません。
                </span>
              </div>
            )}
          </form>
        </Card>

        {/* ③ ダブル・マテリアリティ評価 */}
        <Card className="overflow-hidden">
          <SectionTitle
            title={`③ ダブル・マテリアリティ評価（判断済み ${decidedCount} / ${view.matterTotal} 事項）`}
            action={
              <span className="text-[11px] text-ink-muted">
                算定結果は提案です。各観点の重要性は、事項ごとに人が根拠を付けて判断します
              </span>
            }
          />
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
                          <span className="font-mono text-[11px]">{state.topic}</span>{' '}
                          {ESRS_TOPIC_LABEL[state.topic]}
                        </Link>
                      </TD>
                      <TD align="right" className="whitespace-nowrap text-[11px] tabular-nums">
                        インパクト {impactCount} ／ リスク・機会 {financialCount}
                      </TD>
                      <TD className="whitespace-nowrap text-[12px]">
                        <span className="tabular-nums">{axisProposalText(state.axes.impact)}</span>
                        <span className="block text-[11px] text-ink-muted">
                          {axisProposalLabel(state.axes.impact) === '評価材料なし'
                            ? 'インパクト IRO がありません'
                            : `${axisProposalLabel(state.axes.impact)}を提案`}
                        </span>
                      </TD>
                      <TD className="whitespace-nowrap text-[12px]">
                        <span className="tabular-nums">
                          {axisProposalText(state.axes.financial)}
                        </span>
                        <span className="block text-[11px] text-ink-muted">
                          {axisProposalLabel(state.axes.financial) === '評価材料なし'
                            ? 'リスク・機会の IRO がありません'
                            : `${axisProposalLabel(state.axes.financial)}を提案`}
                        </span>
                      </TD>
                      <TD>
                        <span className="flex items-center gap-1">
                          <span className="text-[10px] text-ink-muted">提案</span>
                          <DmaOutcomeBadge outcome={state.proposedOutcome} />
                        </span>
                      </TD>
                      <TD>
                        <DmaOutcomeBadge outcome={state.outcome} />
                        <span className="mt-0.5 block whitespace-nowrap text-[11px] text-ink-muted">
                          インパクト: {DMA_AXIS_ASSESSMENT_LABEL[state.matter.impactAssessment]} ／
                          財務: {DMA_AXIS_ASSESSMENT_LABEL[state.matter.financialAssessment]}
                        </span>
                      </TD>
                      <TD className="whitespace-nowrap text-[11px] text-ink-muted">
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
          <div className="grid grid-cols-[minmax(0,440px)_1fr] items-start gap-4 border-t border-line p-3">
            <DmaMatrix inputs={matrixInputsOf(view.matters)} thresholds={view.thresholds} />
            <div className="space-y-2 text-[12px] text-ink">
              <p className="font-medium">マトリクスの読み方</p>
              <p className="text-[11px] leading-relaxed text-ink-muted">
                各事項を、算定したインパクトのスコア（縦）とリスク・機会のスコア（横）の位置に置いています（表と同じ内容）。
                閾値の線より上ならインパクト重要性、右なら財務的重要性で「重要」を提案します。
                適用を決めるのは位置ではなく人の判断（表の「人の判断」）です。
              </p>
              <ul className="space-y-0.5 text-[11px] text-ink-muted">
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
              {view.canEdit && (
                <p className="flex items-center gap-1 text-[11px] text-ink-muted">
                  <PencilLine className="size-3" aria-hidden="true" />
                  IRO の追加・編集と判断は、表の事項名から事項の画面で行います。
                </p>
              )}
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
