import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  Banknote,
  CircleCheck,
  CircleDashed,
  Globe,
  HandHeart,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  TriangleAlert,
  UserCheck,
} from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { PreservingForm } from '@/components/shared/preserving-form';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { MoreInfo } from '@/components/ui/more-info';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { DMA_AXIS_ASSESSMENT_LABEL, ESRS_TOPIC_LABEL } from '@/lib/domain/csrd';
import {
  IRO_TYPE_LABEL,
  TIME_HORIZON_LABEL,
  VALUE_CHAIN_STAGE_LABEL,
  type DmaAxisResult,
} from '@/lib/domain/dma';
import { formatJst } from '@/lib/format/datetime';
import { loadCsrdMatterDetail } from '@/lib/services/csrd/settings';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { DMA_AXIS_ASSESSMENTS, type DmaAxisAssessment, type IroType } from '@/types/domain';
import { DmaOutcomeBadge, ProvisionalBadge } from '../../../_components/csrd-badges';
import { IroForm } from '../../_components/iro-form';
import {
  decideCsrdDmaMatterAction,
  deleteCsrdDmaIroAction,
  upsertCsrdDmaIroAction,
} from '../../actions';
import { axisProposalLabel, axisProposalText, formatScore, iroInputSummary } from '../../dma-view';
import { EMPTY_IRO_FORM, iroFormValuesOf } from '../../iro-form-values';

export const metadata = { title: 'CSRD サステナビリティ事項の評価' };

const BASE = '/enterprise/disclosures/csrd';

const IRO_TYPE_ICON: Record<IroType, typeof Globe> = {
  impact: Globe,
  risk: TriangleAlert,
  opportunity: Sparkles,
};

/** 1 つの観点の算定結果（提案） */
function AxisProposal({
  title,
  icon: Icon,
  axis,
  emptyNote,
}: {
  title: string;
  icon: typeof Globe;
  axis: DmaAxisResult;
  emptyNote: string;
}) {
  const label = axisProposalLabel(axis);
  return (
    <section
      aria-label={`${title}の算定結果`}
      className="space-y-1 rounded-t4d border border-line p-2.5"
    >
      <h3 className="flex items-center gap-1.5 text-[12px] font-semibold text-ink">
        <Icon className="size-3.5 text-ink-muted" aria-hidden="true" />
        {title}
      </h3>
      <p className="text-[18px] font-semibold tabular-nums text-ink">{axisProposalText(axis)}</p>
      <p className="text-[11px] text-ink-muted">
        {label === '評価材料なし'
          ? emptyNote
          : `提案: ${label}（最大スコア。IRO ${axis.iroCount} 件から算定）`}
      </p>
    </section>
  );
}

/**
 * サステナビリティ事項 1 件のダブル・マテリアリティ評価（docs/disclosure-first.md §9.4）。
 * IRO（影響・リスク・機会）の一覧・追加・編集・削除（論理削除）と、観点ごとの人の判断。
 * 算定結果は自社の方法・閾値による提案で、重要性を決めるのは人（根拠が必須）。AI は書き込まない。
 * `[topic]` が ESRS のテーマでなければ 404。
 */
export default async function CsrdMatterPage({
  params,
  searchParams,
}: {
  params: Promise<{ topic: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { topic } = await params;
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const backButton = (
    <Button variant="outline" size="sm" asChild>
      <Link href={`${BASE}/settings`}>
        <ArrowLeft aria-hidden="true" />
        設定へ戻る
      </Link>
    </Button>
  );

  if (!can(ctx, 'enterprise.disclosure.read') && !can(ctx, 'enterprise.disclosure.write')) {
    return (
      <>
        <PageHeader title="CSRD サステナビリティ事項" actions={backButton} />
        <PermissionDeniedState description="CSRD の設定は、開示の閲覧権限を持つ利用者のみ閲覧できます。" />
      </>
    );
  }

  const detail = await loadCsrdMatterDetail(db, ctx, shell.currentPeriod, topic);
  if (!detail) notFound();

  const { state, thresholds } = detail;
  const matter = state.matter;
  const topicName = `${state.topic} ${ESRS_TOPIC_LABEL[state.topic]}`;

  return (
    <>
      <PageHeader
        title={`${topicName}（ダブル・マテリアリティ評価）`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {shell.currentPeriod.label} ／ {detail.scoringMethodLabel}
            </span>
            <span className="flex items-center gap-1">
              人の判断:
              <DmaOutcomeBadge outcome={state.outcome} />
            </span>
            {detail.dmaConfirmed ? (
              <Badge tone="success">
                <CircleCheck className="size-3" aria-hidden="true" />
                DMA 確定済み
              </Badge>
            ) : (
              <ProvisionalBadge />
            )}
          </span>
        }
        breadcrumbs={[
          { label: '企業ワークスペース' },
          { label: '開示対応' },
          { label: 'CSRD', href: BASE },
          { label: '設定（報告範囲・DMA）', href: `${BASE}/settings` },
          { label: state.topic },
        ]}
        actions={backButton}
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        <Card className="overflow-hidden">
          <SectionTitle
            title="算定結果（提案・自社の方法と閾値）"
            action={
              <span className="flex items-center gap-1 text-[11px] text-ink-muted">
                提案
                <DmaOutcomeBadge outcome={state.proposedOutcome} />
              </span>
            }
          />
          <div className="grid grid-cols-2 gap-2 px-3 pb-2">
            <AxisProposal
              title="インパクト重要性"
              icon={Globe}
              axis={state.axes.impact}
              emptyNote="インパクトの IRO がありません（評価材料なし）。"
            />
            <AxisProposal
              title="財務的重要性"
              icon={Banknote}
              axis={state.axes.financial}
              emptyNote="リスク・機会の IRO がありません（評価材料なし）。"
            />
          </div>
          <p className="border-t border-line px-3 py-1.5 text-[11px] text-ink-muted">
            閾値はインパクト {formatScore(thresholds.impactThreshold)}・財務{' '}
            {formatScore(thresholds.financialThreshold)}（自社の評価方法・デモ既定。ESRS
            は数値の閾値を定めていません）。算定結果は提案で、重要性は下の「人の判断」で決めます。
          </p>
        </Card>

        <Card className="overflow-hidden">
          <SectionTitle title={`IRO（影響・リスク・機会）（${detail.iros.length} 件）`} />
          {detail.iros.length === 0 ? (
            <EmptyState
              title="IRO が登録されていません"
              description="インパクトとリスク・機会を登録すると、算定結果（提案）が出ます。"
            />
          ) : (
            <div className="t4d-scroll-x">
              <Table aria-label={`${topicName} の IRO`}>
                <THead>
                  <TR>
                    <TH>種類</TH>
                    <TH>内容</TH>
                    <TH>段階・期間</TH>
                    <TH>入力</TH>
                    <TH align="right">深刻度</TH>
                    <TH align="right">スコア</TH>
                    <TH>影響を受ける人・関連</TH>
                    {detail.canEdit && <TH>操作</TH>}
                  </TR>
                </THead>
                <TBody>
                  {detail.iros.map(
                    ({ iro, severity, impactScore, financialScore, relatedImpactDescription }) => {
                      const Icon = IRO_TYPE_ICON[iro.iroType];
                      return (
                        <TR key={iro.id}>
                          <TD>
                            <Badge tone={iro.iroType === 'impact' ? 'brand' : 'outline'}>
                              <Icon className="size-3" aria-hidden="true" />
                              {IRO_TYPE_LABEL[iro.iroType]}
                            </Badge>
                          </TD>
                          <TD className="max-w-[280px] text-[12px] text-ink">
                            {iro.description}
                            {iro.subTopic && (
                              <span className="block text-[11px] text-ink-muted">
                                サブトピック: {iro.subTopic}
                              </span>
                            )}
                          </TD>
                          <TD className="whitespace-nowrap text-[11px]">
                            {VALUE_CHAIN_STAGE_LABEL[iro.valueChainStage]}
                            <span className="block text-ink-muted">
                              {iro.timeHorizon
                                ? TIME_HORIZON_LABEL[iro.timeHorizon]
                                : '期間 未設定'}
                            </span>
                          </TD>
                          <TD className="whitespace-nowrap text-[11px]">
                            {iroInputSummary(iro)}
                            {iro.humanRights && (
                              <span className="mt-0.5 flex items-center gap-1 text-ink-muted">
                                <HandHeart className="size-3" aria-hidden="true" />
                                人権（深刻度で評価）
                              </span>
                            )}
                          </TD>
                          <TD align="right" className="tabular-nums text-[12px]">
                            {formatScore(severity)}
                          </TD>
                          <TD align="right" className="tabular-nums text-[12px] font-semibold">
                            {formatScore(impactScore ?? financialScore)}
                            <span className="block text-[10px] font-normal text-ink-muted">
                              {iro.iroType === 'impact' ? 'インパクト' : '財務'}
                            </span>
                          </TD>
                          <TD className="max-w-[200px] text-[11px] text-ink-muted">
                            {iro.affectedStakeholders || '—'}
                            {relatedImpactDescription && (
                              <span className="block">関連: {relatedImpactDescription}</span>
                            )}
                          </TD>
                          {detail.canEdit && (
                            <TD>
                              <form action={deleteCsrdDmaIroAction}>
                                <input type="hidden" name="iroId" value={iro.id} />
                                <input type="hidden" name="topic" value={state.topic} />
                                <SubmitButton
                                  size="xs"
                                  variant="outline"
                                  icon={<Trash2 aria-hidden="true" />}
                                  pendingLabel="削除中…"
                                  aria-label={`IRO「${iro.description}」を削除`}
                                >
                                  削除
                                </SubmitButton>
                              </form>
                            </TD>
                          )}
                        </TR>
                      );
                    },
                  )}
                </TBody>
              </Table>
            </div>
          )}
          {/* 編集フォームは表の外に置く（行の中で開くと表の幅が崩れる）。summary は Card（overflow-hidden）の
              端まで広がるため、フォーカスリングは内側に描く（外側に描くと切れて見えない） */}
          {detail.canEdit &&
            detail.iros.map(({ iro }) => (
              <details key={`edit-${iro.id}`} className="border-t border-line">
                <summary className="flex cursor-pointer list-none items-center gap-1 px-3 py-2 text-[12px] text-brand-700 hover:underline focus-visible:outline-offset-[-2px]">
                  <Pencil className="size-3.5" aria-hidden="true" />
                  {IRO_TYPE_LABEL[iro.iroType]}「{iro.description}」を編集
                </summary>
                <div className="px-3 pb-3">
                  <IroForm
                    action={upsertCsrdDmaIroAction}
                    reportingPeriodId={shell.currentPeriod.id}
                    topic={state.topic}
                    initial={iroFormValuesOf(iro)}
                    impactIroOptions={detail.impactIroOptions.filter(
                      (option) => option.id !== iro.id,
                    )}
                    submitLabel="IRO を更新"
                  />
                </div>
              </details>
            ))}
          {detail.canEdit && (
            <details className="border-t border-line">
              <summary className="flex cursor-pointer list-none items-center gap-1 px-3 py-2 text-[12px] font-medium text-brand-700 hover:underline focus-visible:outline-offset-[-2px]">
                <Plus className="size-3.5" aria-hidden="true" />
                IRO を追加する
              </summary>
              <div className="px-3 pb-3">
                <IroForm
                  action={upsertCsrdDmaIroAction}
                  reportingPeriodId={shell.currentPeriod.id}
                  topic={state.topic}
                  initial={EMPTY_IRO_FORM}
                  impactIroOptions={detail.impactIroOptions}
                  submitLabel="IRO を追加"
                />
              </div>
            </details>
          )}
          {detail.canEdit && (
            <MoreInfo label="削除の扱い" className="border-t border-line px-3 py-1.5">
              <p>削除は論理削除です（履歴は残り、算定からは外れます）。</p>
            </MoreInfo>
          )}
        </Card>

        <Card className="overflow-hidden">
          <SectionTitle
            title="人の判断"
            action={
              matter.decidedAt ? (
                <span className="flex items-center gap-1 text-[11px] text-ink-muted">
                  <UserCheck className="size-3" aria-hidden="true" />
                  {detail.decidedByName ?? '担当者'} ・ {formatJst(matter.decidedAt)}
                </span>
              ) : (
                <Badge tone="warning">
                  <CircleDashed className="size-3" aria-hidden="true" />
                  未判断
                </Badge>
              )
            }
          />
          {detail.canEdit ? (
            <PreservingForm action={decideCsrdDmaMatterAction} className="space-y-3 p-3">
              <input type="hidden" name="reportingPeriodId" value={shell.currentPeriod.id} />
              <input type="hidden" name="topic" value={state.topic} />
              <div className="grid grid-cols-2 gap-3">
                <AxisDecision
                  name="impact"
                  title="インパクト重要性（人・環境への影響）"
                  icon={Globe}
                  current={matter.impactAssessment}
                  rationale={matter.impactRationale}
                  proposal={`${axisProposalText(state.axes.impact)}（${axisProposalLabel(state.axes.impact)}）`}
                />
                <AxisDecision
                  name="financial"
                  title="財務的重要性（企業へのリスク・機会）"
                  icon={Banknote}
                  current={matter.financialAssessment}
                  rationale={matter.financialRationale}
                  proposal={`${axisProposalText(state.axes.financial)}（${axisProposalLabel(state.axes.financial)}）`}
                />
              </div>
              <label className="block space-y-1 text-[12px] text-ink">
                <span className="block font-medium">ステークホルダーの意見（任意）</span>
                <Textarea name="stakeholderNote" rows={2} defaultValue={matter.stakeholderNote} />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <SubmitButton
                  size="sm"
                  icon={<UserCheck aria-hidden="true" />}
                  pendingLabel="保存中…"
                >
                  判断を保存
                </SubmitButton>
                {/* AI は判断しないことは常に見せる。確定の取り消しは、取り消す確定があるときだけ書く */}
                <span className="text-[11px] text-ink-muted">
                  AI は判断しません。
                  {detail.dmaConfirmed && '保存すると DMA の確定は取り消されます。'}
                </span>
              </div>
              <MoreInfo label="判断の決まり">
                <p>
                  重要／重要でないと評価した観点は根拠が必須です。算定結果（提案）と違う判断もできます（根拠を残してください）。
                </p>
                <p>判断を保存すると、確定済みの DMA は確定が取り消されます。</p>
              </MoreInfo>
            </PreservingForm>
          ) : (
            <div className="space-y-2 p-3">
              <dl className="grid grid-cols-2 gap-3 text-[12px]">
                <div>
                  <dt className="text-[11px] text-ink-muted">インパクト重要性</dt>
                  <dd className="text-ink">
                    {DMA_AXIS_ASSESSMENT_LABEL[matter.impactAssessment]}
                    {matter.impactRationale && (
                      <span className="block text-[11px] text-ink-muted">
                        {matter.impactRationale}
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-ink-muted">財務的重要性</dt>
                  <dd className="text-ink">
                    {DMA_AXIS_ASSESSMENT_LABEL[matter.financialAssessment]}
                    {matter.financialRationale && (
                      <span className="block text-[11px] text-ink-muted">
                        {matter.financialRationale}
                      </span>
                    )}
                  </dd>
                </div>
              </dl>
              <p className="text-[11px] text-ink-muted">
                判断を変えるには開示対応の編集権限が必要です。
              </p>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

/** 1 つの観点の判断（重要／重要でない／未評価＋根拠）。算定結果（提案）を横に示す */
function AxisDecision({
  name,
  title,
  icon: Icon,
  current,
  rationale,
  proposal,
}: {
  name: 'impact' | 'financial';
  title: string;
  icon: typeof Globe;
  current: DmaAxisAssessment;
  rationale: string;
  proposal: string;
}) {
  return (
    <fieldset className="space-y-1.5 rounded-t4d border border-line p-2.5">
      <legend className="flex items-center gap-1.5 px-1 text-[12px] font-semibold text-ink">
        <Icon className="size-3.5 text-ink-muted" aria-hidden="true" />
        {title}
      </legend>
      <p className="text-[11px] text-ink-muted">算定結果（提案）: {proposal}</p>
      <div className="flex flex-wrap gap-3">
        {DMA_AXIS_ASSESSMENTS.map((value) => (
          <label key={value} className="flex items-center gap-1 text-[12px] text-ink">
            <input
              type="radio"
              name={`${name}Assessment`}
              value={value}
              defaultChecked={current === value}
              className="accent-[#0b57a4]"
            />
            {DMA_AXIS_ASSESSMENT_LABEL[value]}
          </label>
        ))}
      </div>
      <label className="block space-y-1 text-[11px] text-ink-muted">
        <span className="block">根拠（重要／重要でないを選んだときは必須）</span>
        {/* 「重要」「重要でない」を選んだときだけ必須にする（送る前にブラウザが止める。最終の検査はサーバー） */}
        <Textarea
          name={`${name}Rationale`}
          rows={3}
          defaultValue={rationale}
          maxLength={600}
          data-required-if={`${name}Assessment=material|not_material`}
        />
      </label>
    </fieldset>
  );
}
