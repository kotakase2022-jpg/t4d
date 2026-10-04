import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  Bot,
  CircleAlert,
  ClipboardList,
  Database,
  FilePenLine,
  Lock,
  ScrollText,
  Settings2,
  ShieldCheck,
  UserCheck,
} from 'lucide-react';
import { ResponseStatusBadge } from '@/components/shared/badges';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { PreservingForm } from '@/components/shared/preserving-form';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { MoreInfo } from '@/components/ui/more-info';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { getAiProvider } from '@/lib/ai';
import { can } from '@/lib/authorization/can';
import {
  CSRD_GAP_KIND_QUESTION,
  CSRD_SECTION_LABEL,
  DMA_AXIS_ASSESSMENT_LABEL,
  ESRS_TOPIC_LABEL,
  isCsrdInScope,
} from '@/lib/domain/csrd';
import {
  ACTION_STATUS_LABEL,
  ACTION_STATUS_TONE,
  ACTION_TYPE_LABEL,
  COVERAGE_LABEL,
  GAP_KIND_LABEL,
  PRIORITY_MEANING,
} from '@/lib/domain/ssbj';
import { formatJst, formatJstDate, formatNumber } from '@/lib/format/datetime';
import { listMentionCandidates } from '@/lib/services/comments';
import { loadCsrdRequirementDetail } from '@/lib/services/csrd/requirements';
import { loadEnterpriseShell } from '@/lib/services/shell';
import {
  SSBJ_ACTION_TYPES,
  SSBJ_COVERAGE_STATUSES,
  SSBJ_GAP_KINDS,
  type SsbjCoverageStatus,
  type SsbjGapKind,
} from '@/types/domain';
import {
  ApplicabilityBadge,
  CoverageStatusBadge,
  CsrdDataStateBadge,
  DmaOutcomeBadge,
  EstimateValueBadge,
  FinalStatusBadge,
  PerspectiveBadges,
  PlanPriorityBadge,
  ProvisionalBadge,
  RequiredItemBadge,
} from '../../_components/csrd-badges';
import { AiCandidateBadge } from '../_components/detail-badges';
import {
  createCsrdActionPlanAction,
  reviewCsrdAssessmentAction,
  reviewCsrdAssessmentFormAction,
  runCsrdGapAnalysisAction,
  saveCsrdAssessmentAction,
} from '../actions';

export const metadata = { title: 'CSRD 要求事項の詳細' };

const BASE = '/enterprise/disclosures/csrd';

const SELECT_CLASS = 'h-7 w-full rounded-t4d border border-line bg-surface px-1.5 text-[12px]';

const GAP_ICON: Record<SsbjGapKind, typeof Database> = {
  disclosure: ScrollText,
  data: Database,
  process: ShieldCheck,
};

/** 根拠の抜粋（長い根拠は画面の幅に合わせて切る。全文は事項の画面にある） */
function excerpt(text: string, max = 120): string {
  const trimmed = text.trim();
  if (trimmed === '') return '（根拠の記載なし）';
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** 3 観点の 1 つ（人が確定した値）。観点が問う内容は下の「3 観点が問うこと」（既定で閉じる）にまとめる */
function GapCard({ kind, status }: { kind: SsbjGapKind; status: SsbjCoverageStatus }) {
  const Icon = GAP_ICON[kind];
  return (
    <div className="space-y-1 rounded-t4d border border-line p-2.5">
      <div className="flex items-center gap-1.5">
        <Icon className="size-3.5 text-ink-muted" aria-hidden="true" />
        <span className="text-[12px] font-semibold text-ink">{GAP_KIND_LABEL[kind]}</span>
      </div>
      <CoverageStatusBadge status={status} />
    </div>
  );
}

/** 3 観点の選択（担当者の入力・修正して確定で使う） */
function CoverageSelects({
  values,
  labelPrefix,
}: {
  values: Record<SsbjGapKind, SsbjCoverageStatus>;
  labelPrefix: string;
}) {
  const fields: Array<[string, SsbjGapKind]> = [
    ['disclosureStatus', 'disclosure'],
    ['dataStatus', 'data'],
    ['processStatus', 'process'],
  ];
  return (
    <div className="grid grid-cols-3 gap-2">
      {fields.map(([name, kind]) => (
        <label key={name} className="space-y-1">
          <span className="block text-[11px] text-ink-muted">{GAP_KIND_LABEL[kind]}</span>
          <select
            name={name}
            defaultValue={values[kind]}
            aria-label={`${labelPrefix}: ${GAP_KIND_LABEL[kind]}`}
            className={SELECT_CLASS}
          >
            {SSBJ_COVERAGE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {COVERAGE_LABEL[status]}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}

/**
 * CSRD 要求事項の詳細（docs/disclosure-first.md §9.4）。
 *  - 適用の根拠（事項・観点・判断根拠の抜粋。ESRS 2 は重要性に関わらず適用）
 *  - 3 観点の人の入力、AI ギャップ分析（候補・デモ生成）と「候補を採用」「修正して確定」
 *  - 対応付いた指標の当期データ（値は承認済みだけ）、対応計画の一覧と追加
 *  - 回答（版・承認）の状態と「回答を編集（版・承認）」（既存の回答画面へ）
 *
 * 文字量を減らす（§10.4）: 3 観点の問い・優先度の付け方・回答画面でできることは既定で閉じる。
 * 適用の根拠、架空の縮小サンプル、「この判定は候補です」、AI の下書きでは承認できないことは常に見せる。
 * 「確認待ち」と完全一致する表示はここで新しく作らない（E2E がその数で確認待ちの有無を確かめる）。
 */
export default async function CsrdRequirementDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { itemId } = await params;
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const listButton = (
    <Button variant="outline" size="sm" asChild>
      <Link href={`${BASE}/requirements`}>
        <ArrowLeft aria-hidden="true" />
        一覧へ戻る
      </Link>
    </Button>
  );

  if (!can(ctx, 'enterprise.disclosure.read') && !can(ctx, 'enterprise.disclosure.write')) {
    return (
      <>
        <PageHeader title="CSRD 要求事項の詳細" actions={listButton} />
        <PermissionDeniedState description="CSRD の画面は、開示の閲覧権限を持つ利用者のみ閲覧できます。" />
      </>
    );
  }

  const detail = await loadCsrdRequirementDetail(db, ctx, shell.currentPeriod, itemId);
  if (!detail) notFound();

  const { view, matter, canWrite, canRunAi } = detail;
  const { item, applicability, priority } = view;
  const a = view.assessment;
  const inScope = isCsrdInScope(applicability);
  const statuses: Record<SsbjGapKind, SsbjCoverageStatus> = {
    disclosure: a?.disclosureStatus ?? 'unconfirmed',
    data: a?.dataStatus ?? 'unconfirmed',
    process: a?.processStatus ?? 'unconfirmed',
  };
  const aiRun = a?.aiRunId ? await db.findById('aiRuns', a.aiRunId) : null;
  const ownRun = aiRun && aiRun.organizationId === ctx.workspace.organizationId ? aiRun : null;
  const runProvider = ownRun?.provider ?? 'mock';
  const providerKind = (await getAiProvider()).kind;
  const members = canWrite ? await listMentionCandidates(db, ctx) : [];
  const hasCandidate =
    a !== null &&
    a.aiStatus !== null &&
    a.aiDisclosureStatus !== null &&
    a.aiDataStatus !== null &&
    a.aiProcessStatus !== null;

  return (
    <>
      <PageHeader
        title={`${item.code} ${item.questionText}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {view.section ? CSRD_SECTION_LABEL[view.section] : '節を判定できない要求事項'} ／{' '}
              {shell.currentPeriod.label}
            </span>
            <ApplicabilityBadge applicability={applicability} />
            {item.required && <RequiredItemBadge />}
          </span>
        }
        breadcrumbs={[
          { label: '企業ワークスペース' },
          { label: '開示対応' },
          { label: 'CSRD', href: BASE },
          { label: '要求事項の評価', href: `${BASE}/requirements` },
          { label: item.code },
        ]}
        actions={
          <div className="flex items-center gap-1.5">
            {listButton}
            <Button variant="outline" size="sm" asChild>
              <Link href={detail.responseHref}>
                <FilePenLine aria-hidden="true" />
                回答を編集（版・承認）
              </Link>
            </Button>
          </div>
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        <div className="grid grid-cols-2 gap-3">
          {/* 適用の根拠 */}
          <Card className="overflow-hidden">
            <SectionTitle
              title="適用の根拠"
              action={applicability.provisional ? <ProvisionalBadge /> : undefined}
            />
            <div className="space-y-2 px-3 pb-3 text-[12px]">
              {view.section === 'ESRS2' ? (
                <p className="flex items-start gap-1.5 text-ink">
                  <Lock className="mt-0.5 size-3.5 text-ink-muted" aria-hidden="true" />
                  重要性に関わらず適用（ESRS 2
                  全般開示）。ダブル・マテリアリティ評価の結果に左右されません。
                </p>
              ) : matter ? (
                <>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                    <dt className="text-[11px] text-ink-muted">サステナビリティ事項</dt>
                    <dd className="flex flex-wrap items-center gap-1.5 text-ink">
                      {matter.topic} {ESRS_TOPIC_LABEL[matter.topic]}
                      <DmaOutcomeBadge outcome={matter.outcome} />
                    </dd>
                    <dt className="text-[11px] text-ink-muted">適用になった観点</dt>
                    <dd>
                      {applicability.perspectives.length > 0 ? (
                        <PerspectiveBadges perspectives={applicability.perspectives} />
                      ) : (
                        <span className="text-ink-muted">—（{applicability.reason}）</span>
                      )}
                    </dd>
                    <dt className="text-[11px] text-ink-muted">インパクト重要性</dt>
                    <dd className="text-ink">
                      {DMA_AXIS_ASSESSMENT_LABEL[matter.matter.impactAssessment]}
                      {matter.matter.impactAssessment !== 'not_assessed' && (
                        <span className="block text-[11px] text-ink-muted">
                          根拠: {excerpt(matter.matter.impactRationale)}
                        </span>
                      )}
                    </dd>
                    <dt className="text-[11px] text-ink-muted">財務的重要性</dt>
                    <dd className="text-ink">
                      {DMA_AXIS_ASSESSMENT_LABEL[matter.matter.financialAssessment]}
                      {matter.matter.financialAssessment !== 'not_assessed' && (
                        <span className="block text-[11px] text-ink-muted">
                          根拠: {excerpt(matter.matter.financialRationale)}
                        </span>
                      )}
                    </dd>
                  </dl>
                  <Button variant="outline" size="xs" asChild>
                    <Link href={`${BASE}/settings/matters/${matter.topic}`}>
                      <Settings2 aria-hidden="true" />
                      事項の IRO と判断を見る
                    </Link>
                  </Button>
                </>
              ) : (
                <p className="text-ink-muted">{applicability.reason}</p>
              )}
              {applicability.provisional && (
                <p className="text-[11px] text-[#8a5d00]">
                  ダブル・マテリアリティ評価（DMA）が未確定のため、この適用は暫定です。
                  <Link href={`${BASE}/settings`} className="ml-1 text-brand-800 underline">
                    設定で確定する
                  </Link>
                </p>
              )}
            </div>
          </Card>

          {/* 要求事項 */}
          <Card className="overflow-hidden">
            <SectionTitle
              title="要求事項（サンプル・架空）"
              action={<span className="font-mono text-[11px] text-ink-muted">{item.code}</span>}
            />
            <div className="space-y-2 px-3 pb-3">
              <p className="text-[13px] font-medium text-ink">{item.questionText}</p>
              {item.guidance && (
                <p className="rounded-t4d bg-surface-muted p-2.5 text-[12px] leading-relaxed text-ink">
                  {item.guidance}
                </p>
              )}
              <p className="text-[11px] text-ink-muted">
                架空の縮小サンプルの要求事項です（正式な ESRS の条文ではありません）。
              </p>
              <div>
                <p className="mb-1 text-[11px] text-ink-muted">対応付いた指標</p>
                {view.metrics.length === 0 ? (
                  <p className="text-[12px] text-ink-muted">
                    対応付いた指標がありません（記述式の要求事項です）。
                  </p>
                ) : (
                  <ul className="flex flex-wrap gap-1">
                    {view.metrics.map((metric) => {
                      const missing = view.missingMetrics.some((m) => m.id === metric.id);
                      return (
                        <li key={metric.id}>
                          <Badge tone={missing ? 'warning' : 'outline'}>
                            {missing ? (
                              <CircleAlert className="size-3" aria-hidden="true" />
                            ) : (
                              <Database className="size-3" aria-hidden="true" />
                            )}
                            {metric.name}（{metric.unit}）: {missing ? '値なし' : '値あり'}
                          </Badge>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          </Card>
        </div>

        {/* AI ギャップ分析（候補） */}
        <Card className="overflow-hidden">
          <SectionTitle
            title="AI ギャップ分析（候補）"
            action={
              a?.aiEvaluatedAt ? (
                <span className="flex items-center gap-1.5">
                  <AiCandidateBadge provider={runProvider} />
                  <span className="text-[11px] text-ink-muted">
                    実行日時 {formatJst(a.aiEvaluatedAt)}
                  </span>
                  {view.awaitingReview && (
                    <Badge tone="warning">
                      <CircleAlert className="size-3" aria-hidden="true" />
                      確認待ち
                    </Badge>
                  )}
                </span>
              ) : undefined
            }
          />
          <div className="space-y-3 px-3 pb-3">
            {!inScope ? (
              <EmptyState
                title="評価対象ではありません"
                description={`${applicability.reason} 事項が重要と判断されると評価できます。`}
                icon={<Bot className="size-5" aria-hidden="true" />}
              />
            ) : !hasCandidate ? (
              <EmptyState
                title="まだ分析していません"
                description="承認済みの値・回答の状態・DMA の結果から、3 観点の候補を作ります。候補は担当者が確認して初めて確定します。"
                icon={<Bot className="size-5" aria-hidden="true" />}
              />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] text-ink-muted">候補</span>
                  {SSBJ_GAP_KINDS.map((kind) => {
                    const value =
                      kind === 'disclosure'
                        ? a.aiDisclosureStatus
                        : kind === 'data'
                          ? a.aiDataStatus
                          : a.aiProcessStatus;
                    return value ? (
                      <CoverageStatusBadge
                        key={kind}
                        status={value}
                        prefix={GAP_KIND_LABEL[kind]}
                      />
                    ) : null;
                  })}
                  {a.aiStatus && (
                    <Badge tone="outline">
                      <Bot className="size-3" aria-hidden="true" />
                      総合（候補）: {COVERAGE_LABEL[a.aiStatus]}
                    </Badge>
                  )}
                </div>
                <p className="text-[11px] text-ink-muted">
                  この判定は候補です。最終判定は担当者の確認（候補を採用／修正して確定）で入ります。
                </p>
                {a.aiComment && (
                  <div>
                    <p className="text-[11px] text-ink-muted">評価コメント</p>
                    <p className="text-[12px] leading-relaxed text-ink">{a.aiComment}</p>
                  </div>
                )}
                {a.aiMissingInfo.length > 0 && (
                  <div>
                    <p className="text-[11px] text-ink-muted">不足している情報</p>
                    <ul className="list-inside list-disc space-y-0.5 text-[12px] text-ink">
                      {a.aiMissingInfo.map((info) => (
                        <li key={info}>{info}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {a.aiRecommendation && (
                  <div>
                    <p className="text-[11px] text-ink-muted">推奨される対応</p>
                    <p className="text-[12px] leading-relaxed text-ink">{a.aiRecommendation}</p>
                  </div>
                )}
                {ownRun && (
                  <p className="text-[11px] text-ink-muted">
                    確信度 {Math.round(ownRun.confidence * 100)}% ／ {ownRun.promptVersion}
                    {ownRun.warnings.length > 0 && ` ／ 注意: ${ownRun.warnings.join('・')}`}
                  </p>
                )}
                {canWrite && (
                  <div className="grid grid-cols-2 gap-3 border-t border-line pt-3">
                    <form action={reviewCsrdAssessmentAction} className="space-y-2">
                      <input type="hidden" name="assessmentId" value={a.id} />
                      <input type="hidden" name="itemId" value={item.id} />
                      <input type="hidden" name="decision" value="approved" />
                      {/* 表示した候補（実行日時）。採用までに分析がやり直されていれば、サーバーが断る */}
                      <input type="hidden" name="aiEvaluatedAt" value={a.aiEvaluatedAt ?? ''} />
                      <p className="text-[12px] font-semibold text-ink">候補をそのまま採用する</p>
                      <label className="block space-y-1">
                        <span className="text-[11px] text-ink-muted">確認コメント（任意）</span>
                        <Input name="comment" defaultValue="" maxLength={600} />
                      </label>
                      <SubmitButton
                        size="sm"
                        icon={<UserCheck aria-hidden="true" />}
                        pendingLabel="確定しています…"
                      >
                        候補を採用
                      </SubmitButton>
                    </form>
                    <PreservingForm action={reviewCsrdAssessmentFormAction} className="space-y-2">
                      <input type="hidden" name="assessmentId" value={a.id} />
                      <input type="hidden" name="itemId" value={item.id} />
                      <input type="hidden" name="decision" value="modified" />
                      <p className="text-[12px] font-semibold text-ink">候補を修正して確定する</p>
                      <CoverageSelects
                        labelPrefix="修正後の対応状況"
                        values={{
                          disclosure: a.aiDisclosureStatus ?? 'unconfirmed',
                          data: a.aiDataStatus ?? 'unconfirmed',
                          process: a.aiProcessStatus ?? 'unconfirmed',
                        }}
                      />
                      <label className="block space-y-1">
                        <span className="text-[11px] text-ink-muted">修正の理由（必須）</span>
                        <Input name="comment" defaultValue="" required maxLength={600} />
                      </label>
                      <SubmitButton
                        size="sm"
                        variant="outline"
                        icon={<UserCheck aria-hidden="true" />}
                        pendingLabel="確定しています…"
                      >
                        修正して確定
                      </SubmitButton>
                    </PreservingForm>
                  </div>
                )}
              </>
            )}
            {inScope && canRunAi && (
              <form action={runCsrdGapAnalysisAction}>
                <input type="hidden" name="reportingPeriodId" value={shell.currentPeriod.id} />
                <input type="hidden" name="itemId" value={item.id} />
                <SubmitButton
                  size="sm"
                  variant="outline"
                  icon={<Bot aria-hidden="true" />}
                  pendingLabel="分析しています…"
                >
                  {hasCandidate ? 'AI ギャップ分析をやり直す' : 'AI ギャップ分析を実行'}
                  {providerKind === 'mock' ? '（デモ生成）' : ''}
                </SubmitButton>
              </form>
            )}
          </div>
        </Card>

        <div className="grid grid-cols-2 gap-3">
          {/* 担当者の確認・入力 */}
          <Card className="overflow-hidden">
            <SectionTitle
              title="担当者の確認（3 観点）"
              action={
                a?.reviewedAt ? (
                  <span className="text-[11px] text-ink-muted">
                    {detail.reviewedByName ?? '担当者'} ・ {formatJst(a.reviewedAt)}
                  </span>
                ) : (
                  <Badge tone="warning">
                    <CircleAlert className="size-3" aria-hidden="true" />
                    未確認
                  </Badge>
                )
              }
            />
            <div className="space-y-3 px-3 pb-3">
              <div className="grid grid-cols-3 gap-2">
                <GapCard kind="disclosure" status={statuses.disclosure} />
                <GapCard kind="data" status={statuses.data} />
                <GapCard kind="process" status={statuses.process} />
              </div>
              <MoreInfo label="3 観点が問うこと">
                <dl className="space-y-0.5">
                  {SSBJ_GAP_KINDS.map((kind) => (
                    <div key={kind}>
                      <dt className="inline font-medium text-ink">{GAP_KIND_LABEL[kind]}: </dt>
                      <dd className="inline">{CSRD_GAP_KIND_QUESTION[kind]}</dd>
                    </div>
                  ))}
                </dl>
              </MoreInfo>
              {a?.finalStatus && (
                <div className="flex flex-wrap items-center gap-2 rounded-t4d bg-surface-muted p-2">
                  <UserCheck className="size-3.5 text-ink-muted" aria-hidden="true" />
                  <span className="text-[11px] text-ink-muted">最終判定</span>
                  <FinalStatusBadge status={a.finalStatus} />
                  <span className="text-[11px] text-ink-muted">
                    {a.reviewDecision === 'approved'
                      ? 'AI の候補を採用'
                      : a.reviewDecision === 'modified'
                        ? '担当者が修正'
                        : '担当者が入力'}
                  </span>
                </div>
              )}
              {a?.reviewComment && (
                <p className="text-[12px] leading-relaxed text-ink">{a.reviewComment}</p>
              )}
              {canWrite && inScope ? (
                <PreservingForm action={saveCsrdAssessmentAction} className="space-y-2.5">
                  <input type="hidden" name="reportingPeriodId" value={shell.currentPeriod.id} />
                  <input type="hidden" name="itemId" value={item.id} />
                  <CoverageSelects labelPrefix="担当者の入力" values={statuses} />
                  <div className="grid grid-cols-[2fr_1fr] gap-2">
                    <label className="block space-y-1">
                      <span className="text-[11px] text-ink-muted">
                        {hasCandidate
                          ? 'コメント（AI の候補と違う値で確定するときは理由が必須。履歴に残ります）'
                          : 'コメント（履歴に残ります）'}
                      </span>
                      <Textarea name="comment" rows={2} defaultValue="" maxLength={600} />
                    </label>
                    <label className="block space-y-1">
                      <span className="text-[11px] text-ink-muted">担当部署</span>
                      <Input
                        name="ownerDepartment"
                        defaultValue={a?.ownerDepartment ?? ''}
                        maxLength={100}
                      />
                    </label>
                  </div>
                  <SubmitButton
                    size="sm"
                    variant="outline"
                    icon={<UserCheck aria-hidden="true" />}
                    pendingLabel="確定しています…"
                  >
                    担当者の入力として確定
                  </SubmitButton>
                </PreservingForm>
              ) : (
                <p className="text-[12px] text-ink-muted">
                  {canWrite
                    ? '評価対象（常に適用・重要と判断した事項）の要求事項だけ入力できます。'
                    : '確認・入力には開示対応の編集権限が必要です。'}
                </p>
              )}
            </div>
          </Card>

          {/* 優先順位 */}
          <Card className="overflow-hidden">
            <SectionTitle
              title="優先順位の評価"
              action={
                priority ? (
                  <span className="flex items-center gap-1.5">
                    <PlanPriorityBadge priority={priority.priority} />
                    <span className="text-[11px] text-ink-muted">
                      {PRIORITY_MEANING[priority.priority]}
                    </span>
                  </span>
                ) : undefined
              }
            />
            {priority ? (
              <Table aria-label="優先順位の評価項目">
                <THead>
                  <TR>
                    <TH>評価項目</TH>
                    <TH>判定</TH>
                    <TH align="right">加点</TH>
                  </TR>
                </THead>
                <TBody>
                  {priority.factors.map((factor) => (
                    <TR key={factor.label}>
                      <TD className="font-medium text-ink">
                        {factor.label}
                        <p className="text-[11px] font-normal text-ink-muted">{factor.note}</p>
                      </TD>
                      <TD className="text-[12px]">{factor.judgement}</TD>
                      <TD align="right">{factor.score}</TD>
                    </TR>
                  ))}
                  <TR>
                    <TD className="font-semibold text-ink">合計</TD>
                    <TD />
                    <TD align="right" className="font-semibold">
                      {priority.score}
                    </TD>
                  </TR>
                </TBody>
              </Table>
            ) : (
              <div className="space-y-1 px-3 pb-3">
                <p className="text-[12px] text-ink-muted">優先度なし（評価対象外）</p>
                <MoreInfo label="優先度の付け方">
                  <p>優先度は評価対象（常に適用・重要と判断した事項）の要求事項だけに付けます。</p>
                </MoreInfo>
              </div>
            )}
          </Card>
        </div>

        {/* 対応付いた指標の当期データ */}
        <Card className="overflow-hidden">
          <SectionTitle
            title="対応付いた指標の当期データ"
            action={
              <span className="text-[11px] text-ink-muted">
                値は承認済みだけを表示します（未入力を 0 として扱いません）
              </span>
            }
          />
          {detail.metricData.length === 0 ? (
            <EmptyState title="対応付いた指標がありません" />
          ) : (
            <Table aria-label="対応付いた指標の当期データ">
              <THead>
                <TR>
                  <TH>指標</TH>
                  <TH>拠点</TH>
                  <TH>状況</TH>
                  <TH align="right">当期の値（承認済み）</TH>
                </TR>
              </THead>
              <TBody>
                {detail.metricData.map((row) => (
                  <TR key={`${row.metric.id}-${row.unit?.id ?? 'none'}`}>
                    <TD className="text-[12px] text-ink">
                      {row.metric.name}
                      <span className="ml-1 font-mono text-[10px] text-ink-muted">
                        {row.metric.code}
                      </span>
                    </TD>
                    <TD className="text-[12px]">{row.unit?.name ?? '全社（行なし）'}</TD>
                    <TD>
                      <CsrdDataStateBadge state={row.state} />
                    </TD>
                    <TD align="right" className="tabular-nums text-[12px]">
                      {row.value === null ? (
                        <span className="text-ink-muted">—</span>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          {formatNumber(row.value)} {row.unitOfMeasure}
                          {row.valueKind === 'estimate' && <EstimateValueBadge />}
                        </span>
                      )}
                      {row.dataPointId && (
                        <Link
                          href={`/enterprise/data/${row.dataPointId}`}
                          className="ml-2 text-[11px] text-brand-700 hover:underline"
                        >
                          データを見る
                        </Link>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        {/* 対応計画 */}
        <Card className="overflow-hidden">
          <SectionTitle
            title={`対応計画（${view.plans.length}）`}
            action={
              <Button variant="outline" size="xs" asChild>
                <Link href={`${BASE}/plans`}>
                  <ClipboardList aria-hidden="true" />
                  対応計画の一覧へ
                </Link>
              </Button>
            }
          />
          {view.plans.length > 0 && (
            <Table aria-label="この要求事項の対応計画">
              <THead>
                <TR>
                  <TH>観点</TH>
                  <TH>対応内容</TH>
                  <TH>対応区分</TH>
                  <TH>担当部署</TH>
                  <TH>期限</TH>
                  <TH>対応状況</TH>
                </TR>
              </THead>
              <TBody>
                {view.plans.map((plan) => (
                  <TR key={plan.id}>
                    <TD>{GAP_KIND_LABEL[plan.gapKind]}</TD>
                    <TD className="max-w-[320px] font-medium text-ink">{plan.title}</TD>
                    <TD>{ACTION_TYPE_LABEL[plan.actionType]}</TD>
                    <TD className="text-[11px]">{plan.department || '未設定'}</TD>
                    <TD className="text-[11px]">
                      {plan.dueDate ? formatJstDate(plan.dueDate) : '未設定'}
                    </TD>
                    <TD>
                      <Badge tone={ACTION_STATUS_TONE[plan.status]}>
                        <ClipboardList className="size-3" aria-hidden="true" />
                        {ACTION_STATUS_LABEL[plan.status]}
                      </Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          {canWrite && inScope ? (
            <form
              action={createCsrdActionPlanAction}
              className="space-y-2.5 border-t border-line p-3"
            >
              <input type="hidden" name="reportingPeriodId" value={shell.currentPeriod.id} />
              <input type="hidden" name="itemId" value={item.id} />
              <p className="text-[12px] font-semibold text-ink">このギャップを対応計画に追加する</p>
              <div className="grid grid-cols-4 gap-2">
                <label className="space-y-1">
                  <span className="block text-[11px] text-ink-muted">観点</span>
                  <select name="gapKind" defaultValue="disclosure" className={SELECT_CLASS}>
                    {SSBJ_GAP_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {GAP_KIND_LABEL[kind]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="block text-[11px] text-ink-muted">対応区分</span>
                  <select
                    name="actionType"
                    defaultValue="disclosure_addition"
                    className={SELECT_CLASS}
                  >
                    {SSBJ_ACTION_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {ACTION_TYPE_LABEL[type]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="block text-[11px] text-ink-muted">担当部署</span>
                  <Input
                    name="department"
                    defaultValue={a?.ownerDepartment ?? ''}
                    maxLength={100}
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-[11px] text-ink-muted">担当者</span>
                  <select name="assigneeUserId" defaultValue="" className={SELECT_CLASS}>
                    <option value="">未設定</option>
                    {members.map((member) => (
                      <option key={member.userId} value={member.userId}>
                        {member.displayName}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="block space-y-1">
                <span className="text-[11px] text-ink-muted">対応内容（必須）</span>
                <Input
                  name="title"
                  required
                  maxLength={200}
                  defaultValue={a?.aiRecommendation.slice(0, 60) ?? ''}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] text-ink-muted">詳細</span>
                <Input name="detail" defaultValue="" maxLength={1000} />
              </label>
              <div className="flex flex-wrap items-end gap-2">
                <label className="space-y-1">
                  <span className="block text-[11px] text-ink-muted">期限</span>
                  <Input type="date" name="dueDate" className="w-40" />
                </label>
                <label className="space-y-1">
                  <span className="block text-[11px] text-ink-muted">優先順位</span>
                  <select
                    name="priority"
                    defaultValue={priority?.priority ?? 'medium'}
                    className="h-7 rounded-t4d border border-line bg-surface px-1.5 text-[12px]"
                  >
                    <option value="high">高</option>
                    <option value="medium">中</option>
                    <option value="low">低</option>
                  </select>
                </label>
                <SubmitButton
                  size="sm"
                  variant="outline"
                  icon={<ClipboardList aria-hidden="true" />}
                  pendingLabel="追加しています…"
                >
                  対応計画に追加
                </SubmitButton>
              </div>
            </form>
          ) : (
            <p className="border-t border-line px-3 py-2 text-[12px] text-ink-muted">
              {canWrite
                ? '対応計画は評価対象（常に適用・重要と判断した事項）の要求事項にだけ立てられます。'
                : '対応計画の追加には開示対応の編集権限が必要です。'}
            </p>
          )}
        </Card>

        {/* 回答（版・承認） */}
        <Card className="overflow-hidden">
          <SectionTitle
            title="回答（版・承認）"
            action={<ResponseStatusBadge status={view.response?.status ?? 'not_started'} />}
          />
          {/* AI の下書きのままでは承認できないこと（確定は人）は閉じずに見せる */}
          <div className="space-y-1 px-3 pb-3">
            <p className="text-[12px] text-ink-muted">
              回答は回答画面で作成・承認します（AI の下書きのままでは承認できません）。
            </p>
            <MoreInfo label="回答画面でできること">
              <p>
                回答本文の作成・版の履歴・レビュー依頼・承認・AI 回答ドラフト（CDP
                と同じ画面）。上の「回答を編集（版・承認）」から開けます。
              </p>
            </MoreInfo>
          </div>
        </Card>
      </div>
    </>
  );
}
