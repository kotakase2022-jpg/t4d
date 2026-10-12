import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  Bot,
  CircleAlert,
  ClipboardList,
  Database,
  FileText,
  Plus,
  ScrollText,
  ShieldCheck,
  UserCheck,
} from 'lucide-react';
import { AiGeneratedBadge } from '@/components/shared/badges';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { FlashMessage } from '@/components/shared/flash';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { Notice } from '@/components/shared/notice';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { FormSection } from '@/components/ui/form-section';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { Collapsible } from '@/components/ui/collapsible';
import { NotFoundError, can } from '@/lib/authorization/can';
import {
  ACTION_TYPE_LABEL,
  APPLICABILITY_LABEL,
  AREA_LABEL,
  COVERAGE_LABEL,
  COVERAGE_TONE,
  GAP_KIND_LABEL,
  GAP_KIND_QUESTION,
  MATERIALITY_LABEL,
  PRIORITY_LABEL,
  PRIORITY_MEANING,
} from '@/lib/domain/ssbj';
import { formatJst } from '@/lib/format/datetime';
import { listMentionCandidates } from '@/lib/services/comments';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { loadSsbjRequirementDetail } from '@/lib/services/ssbj-gap';
import {
  exclusionNoteLimit,
  loadExclusionStatus,
  type ExclusionStatus,
} from '@/lib/services/requirement-exclusion';
import type { ActionSpec } from '@/lib/ui/actions';
import {
  exclusionActions,
  reasonHead,
} from '@/app/enterprise/disclosure-projects/[projectId]/requirements/_components/exclusion-action-specs';
import type { SsbjActionType, SsbjCoverageStatus, SsbjGapKind } from '@/types/domain';
import {
  createSsbjActionPlanAction,
  runSsbjGapAnalysisAction,
  saveSsbjReviewAction,
  saveSsbjScopeAction,
} from '../../../../actions';
import { ScopeForm } from './_components/scope-form';

export const metadata = { title: 'SSBJ 要求事項の詳細' };

const COVERAGE_OPTIONS: SsbjCoverageStatus[] = [
  'covered',
  'mostly_covered',
  'partial',
  'not_covered',
  'unconfirmed',
];

/** 遅れている順（対応計画の観点の既定を「いちばん遅れている観点」にするため） */
const COVERAGE_SEVERITY: Record<SsbjCoverageStatus, number> = {
  not_covered: 4,
  partial: 3,
  unconfirmed: 2,
  mostly_covered: 1,
  covered: 0,
};

/** 観点ごとの既定の対応区分（選び直せる） */
const DEFAULT_ACTION_TYPE: Record<SsbjGapKind, SsbjActionType> = {
  disclosure: 'disclosure_addition',
  data: 'data_collection',
  process: 'internal_control',
};

/** 3 観点の 1 つを表す小さなカード */
function GapCard({
  kind,
  status,
  icon: Icon,
}: {
  kind: SsbjGapKind;
  status: SsbjCoverageStatus;
  icon: typeof Database;
}) {
  return (
    <div className="space-y-1 rounded-t4d border border-line p-2.5">
      <div className="flex items-center gap-1.5">
        <Icon className="size-3.5 text-ink-muted" aria-hidden="true" />
        <span className="text-small font-semibold text-ink">{GAP_KIND_LABEL[kind]}ギャップ</span>
      </div>
      <StatusBadge domain="ssbjCoverage" value={status} />
      <p className="text-caption leading-relaxed text-ink-muted">{GAP_KIND_QUESTION[kind]}</p>
    </div>
  );
}

/**
 * SSBJ 要求事項の詳細（plan §2 S9）。区画は CSRD の要求事項の詳細（S4）と同じ順にする:
 *  ① 適用の根拠（要求事項・現在の開示・対象判定）→ ② 評価（AI の候補・担当者の確認）→ ③ 優先順位 → ④ 対応計画。
 *
 * 主操作は状態で 1 つ（plan §1.6・CandidateDecision と同じ規則）:
 *  - 最終判定が未確定 → 「最終判定として確定する」（AI の判定は候補。確定は人が押す）
 *  - 確定済み → 次の作業「対応計画に追加」（作成欄は ?new=1 の CreatePanel。開いている間は作成欄の追加ボタン）
 * AI ギャップ分析はいつでも secondary（候補が無いときの入口。やり直しも同じ場所）。
 */
export default async function SsbjRequirementDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { itemId } = await params;
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const canWrite = can(shell.ctx, 'enterprise.disclosure.write');
  const canRunAi = can(shell.ctx, 'enterprise.ai.run');

  // 開示プロジェクトの要求事項タブからは、プロジェクトの報告期間を ?period= で明示して開く。
  // ヘッダーの期間と違えば、その旨を帯で示す（別の年度の評価を見ていると取り違えない）
  const requestedPeriodId = typeof query.period === 'string' ? query.period : null;
  const period =
    (requestedPeriodId && shell.periods.find((p) => p.id === requestedPeriodId)) ||
    shell.currentPeriod;
  const periodDiffers = period.id !== shell.currentPeriod.id;
  const detail = await loadSsbjRequirementDetail(shell.db, shell.ctx, period, itemId);
  if (!detail) notFound();

  const { view, metrics } = detail;
  const { item, assessment: a, priority } = view;
  const [members, exclusion] = await Promise.all([
    listMentionCandidates(shell.db, shell.ctx),
    // 対象外・非重要の申請と承認（トライアル対応 NF-02）。評価の行が無ければ出さない。
    // SSBJ の画面は開示の閲覧権限を求めない（拠点担当も開ける）。申請・承認の状態は開示の閲覧権限が
    // あるときだけ読む（読めない役割に例外を投げて画面ごと落とさない）
    can(shell.ctx, 'enterprise.disclosure.read')
      ? loadExclusionStatus(shell.db, shell.ctx, {
          source: 'ssbj_assessment',
          itemId: item.id,
          reportingPeriodId: period.id,
        }).catch((error: unknown): ExclusionStatus | null => {
          if (error instanceof NotFoundError) return null;
          throw error;
        })
      : Promise.resolve(null),
  ]);
  const canApprove = can(shell.ctx, 'enterprise.disclosure.approve');
  const exclusionCurrent = exclusion?.target.current ?? null;
  const exclusionOps =
    exclusion && exclusionCurrent
      ? exclusionActions({
          fields: {
            source: 'ssbj_assessment',
            itemId: item.id,
            reportingPeriodId: period.id,
            returnTo: 'ssbj',
          },
          state: exclusion.state.state,
          requestedBy: exclusion.state.requestedBy,
          recordedBy: exclusion.target.recorder,
          decision: exclusionCurrent.decision,
          reason: exclusionCurrent.reason,
          frameworkLabel: 'SSBJ',
          code: item.code,
          viewerId: shell.ctx.userId,
          canWrite,
          canApprove,
          noteLimit: exclusionNoteLimit(shell.ctx),
        })
      : {};
  // 主操作は 1 つ: 編集者には既存の確定・対応計画が主操作。承認だけを持つ人には「対象外を承認」を主操作にする
  const exclusionPrimary: ActionSpec | undefined = canWrite ? undefined : exclusionOps.approve;
  const exclusionSecondary = [
    canWrite ? exclusionOps.approve : undefined,
    exclusionOps.returnBack,
    exclusionOps.request,
  ].filter((op): op is ActionSpec => op !== undefined);
  const memberName = (userId: string | null) =>
    members.find((m) => m.userId === userId)?.displayName ?? '—';

  const basePath = `/enterprise/disclosures/ssbj/requirements/${item.id}`;
  const decided = a.finalStatus !== null;
  const planPanelOpen = canWrite && isCreatePanelOpen(query);
  const hasAiCandidate = a.aiStatus !== null;
  // 主操作は 1 つ: 作成欄を開いていればその追加、未確定なら確定、確定済みなら「対応計画に追加」
  const reviewIsPrimary = canWrite && !decided && !planPanelOpen;
  const planOpenerIsPrimary = canWrite && decided && !planPanelOpen;

  // 対応計画の既定（plan D3・D4）: 観点はいちばん遅れている観点、期限は報告期間の提出期限、
  // 担当部署は評価の担当部署、担当者は本人（メンバーに居れば）
  const worstKind = (['disclosure', 'data', 'process'] as const).reduce<SsbjGapKind>(
    (worst, kind) => {
      const status = (k: SsbjGapKind) =>
        k === 'disclosure' ? a.disclosureStatus : k === 'data' ? a.dataStatus : a.processStatus;
      return COVERAGE_SEVERITY[status(kind)] > COVERAGE_SEVERITY[status(worst)] ? kind : worst;
    },
    'disclosure',
  );
  const defaultAssignee = members.some((m) => m.userId === shell.ctx.userId)
    ? shell.ctx.userId
    : '';
  const hidden = { assessmentId: a.id, itemId: item.id, periodId: period.id };

  return (
    <>
      <PageHeader
        title={`${item.code} ${item.questionText}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {AREA_LABEL[view.area]} ／ {item.section} ／ {period.label}
            </span>
            <Badge tone={a.applicability === 'applicable' ? 'neutral' : 'outline'}>
              {APPLICABILITY_LABEL[a.applicability]}
            </Badge>
            <Badge tone={a.materiality === 'material' ? 'brand' : 'neutral'}>
              {MATERIALITY_LABEL[a.materiality]}
            </Badge>
            {item.required && <Badge tone="brand">開示が求められる項目</Badge>}
          </span>
        }
        breadcrumbsTail={[{ label: item.code }]}
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />
        {periodDiffers && (
          <p
            role="note"
            className="flex flex-wrap items-center gap-1.5 rounded-t4d border border-warning/40 bg-warning-soft px-3 py-1.5 text-small text-ink"
          >
            <CircleAlert className="size-3.5 text-warning-ink" aria-hidden="true" />
            開示プロジェクトの報告期間（{period.label}
            ）の評価を表示しています。ヘッダーで選んでいる期間（
            {shell.currentPeriod.label}）とは異なります。
            <Link
              href={`/enterprise/disclosures/ssbj/requirements/${item.id}`}
              className="text-brand-800 underline"
            >
              {shell.currentPeriod.label} の評価を開く
            </Link>
          </p>
        )}

        {a.recheckReason && (
          <Notice tone="warning" title="今年度に再評価が必要です">
            {a.recheckReason}
          </Notice>
        )}

        {/* ① 適用の根拠。左: SSBJ 要求事項 / 右: 現在の開示内容 */}
        <div className="grid grid-cols-2 gap-3">
          <Section
            title="SSBJ 要求事項"
            divider="none"
            actions={<span className="font-mono text-caption text-ink-muted">{item.code}</span>}
          >
            <div className="space-y-3">
              <div>
                <p className="text-caption text-ink-muted">要求事項の見出し</p>
                <p className="text-body font-medium text-ink">{item.questionText}</p>
              </div>
              <div>
                <p className="mb-1 text-caption text-ink-muted">基準の原文</p>
                <p className="rounded-t4d bg-surface-muted p-2.5 text-small leading-relaxed text-ink">
                  {item.guidance}
                </p>
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-small">
                <div>
                  <dt className="text-caption text-ink-muted">対象領域</dt>
                  <dd className="text-ink">{AREA_LABEL[view.area]}</dd>
                </div>
                <div>
                  <dt className="text-caption text-ink-muted">適用区分</dt>
                  <dd className="text-ink">{APPLICABILITY_LABEL[a.applicability]}</dd>
                </div>
                <div>
                  <dt className="text-caption text-ink-muted">重要性</dt>
                  <dd className="text-ink">{MATERIALITY_LABEL[a.materiality]}</dd>
                </div>
                <div>
                  <dt className="text-caption text-ink-muted">担当部署</dt>
                  <dd className="text-ink">{a.ownerDepartment || '未設定'}</dd>
                </div>
              </dl>
              {a.applicabilityReason && (
                <p className="text-caption text-ink-muted">対象外の理由: {a.applicabilityReason}</p>
              )}
              {a.materialityReason && (
                <p className="text-caption text-ink-muted">
                  重要性の判断理由: {a.materialityReason}
                </p>
              )}
              <div>
                <p className="mb-1 text-caption text-ink-muted">関連する指標</p>
                {metrics.length === 0 ? (
                  <p className="text-small text-ink-muted">
                    紐づく指標がありません（定性的な要求事項です）。
                  </p>
                ) : (
                  <>
                    {/* 指標ごとに当期の値の有無を出す。1 指標の値で要求事項全体を
                        「データあり」と見せない（W0 O7） */}
                    <ul className="flex flex-wrap gap-1">
                      {metrics.map((metric) => {
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
                    {view.dataCoverage === 'partial' && (
                      <p className="mt-1 text-caption text-warning-ink">
                        一部の指標にだけ値があります（不足:{' '}
                        {view.missingMetrics.map((m) => m.name).join('・')}）。
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          </Section>

          <Section
            title="現在の開示内容"
            divider="none"
            summary={
              <span className="text-caption text-ink-muted">
                取り込んだ資料から見つけた該当箇所
              </span>
            }
          >
            <div className="space-y-3">
              {a.sourceDocument === null ? (
                <EmptyState
                  kind="no-data"
                  size="compact"
                  title="該当する記述が見つかっていません"
                  description="資料を取り込んだうえで、人工知能によるギャップ分析を実行してください。"
                  icon={<FileText className="size-5" aria-hidden="true" />}
                  action={
                    <Link
                      href="/enterprise/imports"
                      className="text-small text-brand-700 hover:underline"
                    >
                      資料を取り込む
                    </Link>
                  }
                />
              ) : (
                <>
                  <div className="flex items-center gap-1.5 text-small">
                    <FileText className="size-3.5 text-ink-muted" aria-hidden="true" />
                    <span className="text-ink-muted">出典:</span>
                    <span className="font-medium text-ink">{a.sourceDocument}</span>
                    <span className="text-ink-muted">{a.sourcePage}</span>
                  </div>
                  <blockquote className="rounded-t4d border-l-2 border-brand-300 bg-brand-50/60 p-2.5 text-small leading-relaxed text-ink">
                    {a.sourceExcerpt}
                  </blockquote>
                </>
              )}

              <div>
                <p className="mb-1.5 text-caption text-ink-muted">3 つの観点それぞれの対応状況</p>
                <div className="grid grid-cols-3 gap-2">
                  <GapCard kind="disclosure" status={a.disclosureStatus} icon={ScrollText} />
                  <GapCard kind="data" status={a.dataStatus} icon={Database} />
                  <GapCard kind="process" status={a.processStatus} icon={ShieldCheck} />
                </div>
              </div>
            </div>
          </Section>
        </div>

        {canWrite && (
          <Section title="対象判定・重要性判断">
            <ScopeForm
              action={saveSsbjScopeAction}
              hidden={hidden}
              defaults={{
                applicability: a.applicability,
                materiality: a.materiality,
                applicabilityReason: a.applicabilityReason,
                materialityReason: a.materialityReason,
                ownerDepartment: a.ownerDepartment,
              }}
            />
          </Section>
        )}

        {exclusion && exclusionCurrent && (
          <Section
            title="対象外・非重要の申請と承認"
            summary={
              <span className="text-caption text-ink-muted">
                申請した人は承認できません。承認は理由に結び付き、理由を変えると承認し直しです。
              </span>
            }
            actions={
              <PageActions
                primary={exclusionPrimary}
                secondary={exclusionSecondary}
                more={exclusionOps.withdraw ? [exclusionOps.withdraw] : undefined}
              />
            }
          >
            <div className="space-y-1.5 text-small">
              <p className="flex flex-wrap items-center gap-2">
                <StatusBadge domain="exclusionApproval" value={exclusion.state.state} />
                <span className="text-ink">
                  {exclusionCurrent.decision === 'not_applicable' ? '対象外' : '非重要'}:{' '}
                  {reasonHead(exclusionCurrent.reason)}
                </span>
              </p>
              {exclusion.state.requestedBy && (
                <p className="text-caption text-ink-muted">
                  申請 {memberName(exclusion.state.requestedBy)}（
                  {formatJst(exclusion.state.requestedAt)}）
                  {exclusion.state.decidedBy &&
                    ` ／ ${exclusion.state.state === 'approved' ? '承認' : '差戻し'} ${memberName(exclusion.state.decidedBy)}（${formatJst(exclusion.state.decidedAt)}）`}
                </p>
              )}
              {exclusion.state.returnNote && (
                <p className="text-ink">差戻しの理由: {exclusion.state.returnNote}</p>
              )}
              <p className="text-caption text-ink-muted">
                承認されるまで、開示プロジェクトの要求事項では「未判定」として分母に残します（承認は社内の記録です）。
              </p>
              {exclusion.events.length > 0 && (
                <Collapsible
                  variant="plain"
                  summary={`申請・承認の記録（${exclusion.events.length} 件）`}
                >
                  <ol className="space-y-0.5 text-caption">
                    {exclusion.events.map((event) => (
                      <li key={event.id}>
                        {formatJst(event.createdAt)}{' '}
                        {
                          {
                            requested: '申請',
                            approved: '承認',
                            returned: '差戻し',
                            withdrawn: '取り下げ',
                          }[event.event]
                        }{' '}
                        {memberName(event.actorUserId)}
                        {event.note ? ` ／ ${event.note}` : ''}
                      </li>
                    ))}
                  </ol>
                </Collapsible>
              )}
            </div>
          </Section>
        )}

        {/* ② 評価: 人工知能の候補 → 担当者の確認（確定は人） */}
        <div className="grid grid-cols-2 gap-3">
          <Section
            title="人工知能による評価"
            actions={
              a.aiEvaluatedAt ? (
                <span className="flex items-center gap-1.5">
                  <AiGeneratedBadge provider="mock" />
                  <span className="text-caption text-ink-muted">
                    実行日時 {formatJst(a.aiEvaluatedAt)}
                  </span>
                </span>
              ) : undefined
            }
          >
            <div className="space-y-3">
              {a.aiStatus === null ? (
                <EmptyState
                  kind="not-applicable"
                  size="compact"
                  title="まだ分析していません"
                  description="取り込んだ資料と要求事項を比較し、対応状況の候補を作成します。"
                  icon={<Bot className="size-5" aria-hidden="true" />}
                />
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-caption text-ink-muted">判定</span>
                    <StatusBadge domain="ssbjCoverage" value={a.aiStatus} />
                    <HonestyBadge kind="ai-candidate" />
                    <span className="text-caption text-ink-muted">
                      この判定は候補です。最終判定は担当者の確認で確定します。
                    </span>
                  </div>
                  <div>
                    <p className="text-caption text-ink-muted">評価コメント</p>
                    <p className="text-small leading-relaxed text-ink">{a.aiComment}</p>
                  </div>
                  {a.aiMissingInfo.length > 0 && (
                    <div>
                      <p className="text-caption text-ink-muted">不足している情報</p>
                      <ul className="list-inside list-disc space-y-0.5 text-small text-ink">
                        {a.aiMissingInfo.map((info) => (
                          <li key={info}>{info}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div>
                    <p className="text-caption text-ink-muted">推奨される対応</p>
                    <p className="text-small leading-relaxed text-ink">{a.aiRecommendation}</p>
                  </div>
                </>
              )}
              {canRunAi && (
                <form action={runSsbjGapAnalysisAction}>
                  {Object.entries(hidden).map(([name, value]) => (
                    <input key={name} type="hidden" name={name} value={value} />
                  ))}
                  <SubmitButton
                    size="sm"
                    variant="secondary"
                    icon={<Bot aria-hidden="true" />}
                    pendingLabel="分析しています…"
                  >
                    {hasAiCandidate ? 'ギャップ分析をやり直す' : 'ギャップ分析を実行'}
                  </SubmitButton>
                </form>
              )}
            </div>
          </Section>

          <Section
            title="担当者による確認"
            actions={
              a.reviewedAt ? (
                <span className="text-caption text-ink-muted">
                  確認日 {formatJst(a.reviewedAt)}
                </span>
              ) : (
                <Badge tone="warning">
                  <CircleAlert className="size-3" aria-hidden="true" />
                  確認待ち
                </Badge>
              )
            }
          >
            <div className="space-y-3">
              {a.finalStatus !== null && (
                <div className="flex items-center gap-2 rounded-t4d bg-surface-muted p-2">
                  <UserCheck className="size-3.5 text-ink-muted" aria-hidden="true" />
                  <span className="text-caption text-ink-muted">最終判定</span>
                  <Badge tone={COVERAGE_TONE[a.finalStatus]}>{COVERAGE_LABEL[a.finalStatus]}</Badge>
                  <span className="text-caption text-ink-muted">
                    {a.reviewDecision === 'approved'
                      ? '人工知能の判定を承認'
                      : '担当者が判定を修正'}
                  </span>
                </div>
              )}
              {a.reviewComment && (
                <p className="text-small leading-relaxed text-ink">{a.reviewComment}</p>
              )}

              {canWrite ? (
                <form action={saveSsbjReviewAction} className="space-y-2.5">
                  {Object.entries(hidden).map(([name, value]) => (
                    <input key={name} type="hidden" name={name} value={value} />
                  ))}
                  <fieldset className="space-y-1.5">
                    <legend className="text-caption text-ink-muted">確認の結果</legend>
                    <label className="flex items-center gap-1.5 text-small text-ink">
                      <input
                        type="radio"
                        name="decision"
                        value="approve_ai"
                        // 候補が無いときは承認できない（サーバーも同じ理由で止める）。既定を「修正」にする
                        defaultChecked={hasAiCandidate}
                        disabled={!hasAiCandidate}
                        className="accent-brand-700"
                      />
                      人工知能の判定を承認する
                      {!hasAiCandidate && (
                        <span className="text-caption text-ink-muted">
                          （人工知能の判定がまだありません）
                        </span>
                      )}
                    </label>
                    <label className="flex items-center gap-1.5 text-small text-ink">
                      <input
                        type="radio"
                        name="decision"
                        value="modify"
                        defaultChecked={!hasAiCandidate}
                        className="accent-brand-700"
                      />
                      判定を修正する（下の 3 つを直してください）
                    </label>
                  </fieldset>

                  <div className="grid grid-cols-3 gap-2">
                    {(
                      [
                        ['disclosureStatus', '開示', a.disclosureStatus],
                        ['dataStatus', 'データ', a.dataStatus],
                        ['processStatus', '業務プロセス', a.processStatus],
                      ] as const
                    ).map(([name, label, value]) => (
                      <label key={name} className="space-y-1">
                        <span className="block text-caption text-ink-muted">{label}</span>
                        <NativeSelect
                          name={name}
                          defaultValue={value}
                          aria-label={`${label}の対応状況`}
                          className="px-1.5 text-small"
                        >
                          {COVERAGE_OPTIONS.map((status) => (
                            <option key={status} value={status}>
                              {COVERAGE_LABEL[status]}
                            </option>
                          ))}
                        </NativeSelect>
                      </label>
                    ))}
                  </div>

                  <label className="block space-y-1">
                    <span className="text-caption text-ink-muted">
                      確認コメント（履歴に残ります）
                    </span>
                    <Input
                      type="text"
                      name="comment"
                      defaultValue=""
                      placeholder="判断の根拠を記入してください"
                      aria-label="確認コメント"
                      className="h-7 text-small"
                    />
                  </label>

                  <SubmitButton
                    variant={reviewIsPrimary ? 'primary' : 'secondary'}
                    size="sm"
                    icon={<UserCheck aria-hidden="true" />}
                    pendingLabel="確定しています…"
                  >
                    最終判定として確定する
                  </SubmitButton>
                </form>
              ) : (
                <p className="text-small text-ink-muted">
                  確認・確定を行うには開示対応の編集権限が必要です。
                </p>
              )}
            </div>
          </Section>
        </div>

        {/* ③ 優先順位 */}
        <Section
          title="優先順位の評価"
          actions={
            <span className="flex items-center gap-1.5">
              <Badge
                tone={
                  priority.priority === 'high'
                    ? 'danger'
                    : priority.priority === 'medium'
                      ? 'warning'
                      : 'neutral'
                }
              >
                優先度 {PRIORITY_LABEL[priority.priority]}
              </Badge>
              <span className="text-caption text-ink-muted">
                {PRIORITY_MEANING[priority.priority]}
              </span>
            </span>
          }
        >
          <Table>
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
                    <p className="text-caption font-normal text-ink-muted">{factor.note}</p>
                  </TD>
                  <TD className="text-small">{factor.judgement}</TD>
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
        </Section>

        {/* ④ 対応計画 */}
        <Section
          id="plans"
          title={`対応計画（${view.plans.length}）`}
          actions={
            <span className="flex items-center gap-1.5">
              <Button variant="ghost" size="xs" asChild>
                <Link href="/enterprise/disclosures/ssbj/plans">
                  <ClipboardList aria-hidden="true" />
                  対応計画の一覧へ
                </Link>
              </Button>
              {canWrite && !planPanelOpen && (
                <Button variant={planOpenerIsPrimary ? 'primary' : 'secondary'} size="xs" asChild>
                  <Link
                    href={`${createPanelHref(basePath, query, { open: true })}#plan-create`}
                    scroll={false}
                    data-t4d-shortcut="new"
                  >
                    <Plus aria-hidden="true" />
                    対応計画に追加
                  </Link>
                </Button>
              )}
            </span>
          }
        >
          {view.plans.length === 0 ? (
            canWrite && !planPanelOpen ? (
              <EmptyState
                kind="no-data"
                size="compact"
                title="この要求事項の対応計画はまだありません"
                description="最終判定を確定したら、ギャップごとに担当部署・期限を決めて対応計画に追加します。"
                action={
                  <Link
                    href={`${createPanelHref(basePath, query, { open: true })}#plan-create`}
                    scroll={false}
                    className="text-small text-brand-700 hover:underline"
                  >
                    対応計画の作成欄を開く
                  </Link>
                }
              />
            ) : (
              <EmptyState
                kind="not-applicable"
                size="compact"
                title="この要求事項の対応計画はまだありません"
                description={
                  canWrite
                    ? '下の作成欄から追加できます。'
                    : '対応計画は、開示の編集権限を持つ担当者が追加します。'
                }
              />
            )
          ) : (
            <Table>
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
                    <TD className="max-w-col-lg font-medium text-ink">{plan.title}</TD>
                    <TD>{ACTION_TYPE_LABEL[plan.actionType]}</TD>
                    <TD className="text-caption">{plan.department || '未設定'}</TD>
                    <TD className="text-caption">{plan.dueDate ?? '未設定'}</TD>
                    <TD>
                      <StatusBadge domain="ssbjAction" value={plan.status} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}

          {canWrite && (
            <CreatePanel
              id="plan-create"
              title="このギャップを対応計画に追加"
              searchParams={query}
              closeHref={createPanelHref(basePath, query, { open: false })}
              description="期限は報告期間の提出期限、担当部署は評価の担当部署を入れてあります。必要なら変えてください。"
              className="mt-2"
            >
              <form action={createSsbjActionPlanAction} className="space-y-2.5">
                {Object.entries(hidden).map(([name, value]) => (
                  <input key={name} type="hidden" name={name} value={value} />
                ))}
                <FormSection title="対応の内容" kind="required">
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="観点" name="gapKind" required>
                      {(p) => (
                        <NativeSelect
                          {...p}
                          name="gapKind"
                          defaultValue={worstKind}
                          aria-label="ギャップの観点"
                        >
                          <option value="disclosure">開示</option>
                          <option value="data">データ</option>
                          <option value="process">業務プロセス・内部統制</option>
                        </NativeSelect>
                      )}
                    </Field>
                    <Field label="対応区分" name="actionType" required>
                      {(p) => (
                        <NativeSelect
                          {...p}
                          name="actionType"
                          defaultValue={DEFAULT_ACTION_TYPE[worstKind]}
                          aria-label="対応区分"
                        >
                          {Object.entries(ACTION_TYPE_LABEL).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </NativeSelect>
                      )}
                    </Field>
                  </div>
                  <Field label="対応内容" name="title" required>
                    {(p) => (
                      <Input
                        {...p}
                        type="text"
                        name="title"
                        defaultValue={a.aiRecommendation.slice(0, 60)}
                        aria-label="対応内容"
                        className="h-7 text-small"
                      />
                    )}
                  </Field>
                </FormSection>
                <FormSection title="担当・期限・優先順位" kind="optional" open>
                  <div className="grid grid-cols-4 gap-2">
                    <Field label="担当部署" name="department">
                      {(p) => (
                        <Input
                          {...p}
                          type="text"
                          name="department"
                          defaultValue={a.ownerDepartment}
                          aria-label="対応計画の担当部署"
                          className="h-7 text-small"
                        />
                      )}
                    </Field>
                    <Field label="担当者" name="assigneeUserId">
                      {(p) => (
                        <NativeSelect
                          {...p}
                          name="assigneeUserId"
                          defaultValue={defaultAssignee}
                          aria-label="対応計画の担当者"
                        >
                          <option value="">未設定</option>
                          {members.map((member) => (
                            <option key={member.userId} value={member.userId}>
                              {member.displayName}
                            </option>
                          ))}
                        </NativeSelect>
                      )}
                    </Field>
                    <Field label="期限" name="dueDate">
                      {(p) => (
                        <Input
                          {...p}
                          type="date"
                          name="dueDate"
                          defaultValue={period.submissionDueDate ?? ''}
                          aria-label="対応期限"
                          className="h-7 text-small"
                        />
                      )}
                    </Field>
                    <Field label="優先順位" name="priority">
                      {(p) => (
                        <NativeSelect
                          {...p}
                          name="priority"
                          defaultValue={priority.priority}
                          aria-label="対応計画の優先順位"
                        >
                          <option value="high">高</option>
                          <option value="medium">中</option>
                          <option value="low">低</option>
                        </NativeSelect>
                      )}
                    </Field>
                  </div>
                  <Field label="詳細" name="detail">
                    {(p) => (
                      <Input
                        {...p}
                        type="text"
                        name="detail"
                        defaultValue=""
                        aria-label="対応の詳細"
                        className="h-7 text-small"
                      />
                    )}
                  </Field>
                </FormSection>
                <SubmitButton
                  variant="primary"
                  size="sm"
                  icon={<ClipboardList aria-hidden="true" />}
                  pendingLabel="追加しています…"
                >
                  対応計画に追加
                </SubmitButton>
              </form>
            </CreatePanel>
          )}
        </Section>
      </div>
    </>
  );
}
