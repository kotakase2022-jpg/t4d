import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  CircleAlert,
  ClipboardList,
  Database,
  FilePenLine,
  Lock,
  Plus,
  Settings2,
} from 'lucide-react';
import { ResponseStatusBadge } from '@/components/shared/badges';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { FlashMessage } from '@/components/shared/flash';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MoreInfo } from '@/components/ui/more-info';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { getAiProvider } from '@/lib/ai';
import { can } from '@/lib/authorization/can';
import {
  CSRD_SECTION_LABEL,
  DMA_AXIS_ASSESSMENT_LABEL,
  ESRS_TOPIC_LABEL,
  isCsrdInScope,
} from '@/lib/domain/csrd';
import {
  ACTION_STATUS_LABEL,
  ACTION_STATUS_TONE,
  ACTION_TYPE_LABEL,
  GAP_KIND_LABEL,
  PRIORITY_MEANING,
} from '@/lib/domain/ssbj';
import { formatJstDate, formatNumber } from '@/lib/format/datetime';
import { listMentionCandidates } from '@/lib/services/comments';
import { loadCsrdRequirementDetail } from '@/lib/services/csrd/requirements';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { SSBJ_ACTION_TYPES, SSBJ_GAP_KINDS } from '@/types/domain';
import {
  ApplicabilityBadge,
  CsrdDataStateBadge,
  DmaOutcomeBadge,
  EstimateValueBadge,
  PerspectiveBadges,
  PlanPriorityBadge,
  ProvisionalBadge,
  RequiredItemBadge,
} from '../../_components/csrd-badges';
import { AssessmentSection, assessmentStageOf } from '../_components/assessment-section';
import { createCsrdActionPlanAction } from '../actions';

export const metadata = { title: 'CSRD 要求事項の詳細' };

const BASE = '/enterprise/disclosures/csrd';
const PLAN_PANEL_ID = 'csrd-plan-create';

/** 根拠の抜粋（長い根拠は画面の幅に合わせて切る。全文は事項の画面にある） */
function excerpt(text: string, max = 120): string {
  const trimmed = text.trim();
  if (trimmed === '') return '（根拠の記載なし）';
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * CSRD 要求事項の詳細（docs/disclosure-first.md §9.4・plan S4）。区画の順は SSBJ（S9）と同じ:
 *  ① 適用の根拠（1 行＋閉じた詳細）と要求事項（架空の縮小サンプル）
 *  ② 評価（3 観点）: AI の候補と担当者の確定を 1 つの流れにし、状態から主操作を 1 つだけ選ぶ
 *  ③ 優先順位 → ④ 対応計画（追加は CreatePanel。期限＝提出期限・担当部署＝評価の担当部署・担当者＝本人）
 *  ⑤ 当期データ（既定で閉じる）・回答（版・承認）
 * 主操作は 1 つ: 候補が未確認なら「候補を採用」、候補が無ければ「担当者の入力として確定」、
 * 確定の後はギャップが残っていれば「対応計画を立てる」（どれも人の操作。AI は確定しない）。
 *
 * 文字量を減らす（§10.4）: 3 観点の問い・判断の根拠の全文・優先度の付け方・回答画面でできることは既定で閉じる。
 * 適用の根拠の要点、架空の縮小サンプル、「この判定は候補です」、AI の下書きでは承認できないことは常に見せる。
 * 「確認待ち」と完全一致する表示はここで 1 つだけにする（E2E がその数で確認待ちの有無を確かめる）。
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
  const listLink = {
    kind: 'link' as const,
    id: 'list',
    label: '一覧へ戻る',
    href: `${BASE}/requirements`,
    icon: <ArrowLeft aria-hidden="true" />,
  };

  if (!can(ctx, 'enterprise.disclosure.read') && !can(ctx, 'enterprise.disclosure.write')) {
    return (
      <>
        <PageHeader
          title="CSRD 要求事項の詳細"
          autoBreadcrumbs
          actions={<PageActions secondary={[listLink]} />}
        />
        <PermissionDeniedState
          description="CSRD の画面は、開示の閲覧権限を持つ利用者のみ閲覧できます。"
          permission="enterprise.disclosure.read"
        />
      </>
    );
  }

  const detail = await loadCsrdRequirementDetail(db, ctx, shell.currentPeriod, itemId);
  if (!detail) notFound();

  const { view, matter, canWrite, canRunAi } = detail;
  const { item, applicability, priority } = view;
  const a = view.assessment;
  const inScope = isCsrdInScope(applicability);
  const canAct = canWrite && inScope;
  const aiRun = a?.aiRunId ? await db.findById('aiRuns', a.aiRunId) : null;
  const ownRun = aiRun && aiRun.organizationId === ctx.workspace.organizationId ? aiRun : null;
  const providerKind = (await getAiProvider()).kind;
  const members = canWrite ? await listMentionCandidates(db, ctx) : [];
  const hasCandidate =
    a !== null &&
    a.aiStatus !== null &&
    a.aiDisclosureStatus !== null &&
    a.aiDataStatus !== null &&
    a.aiProcessStatus !== null;
  const stage = assessmentStageOf(view, hasCandidate);
  // 確定の後、ギャップ（対応済み以外）が残っていれば次の作業は対応計画
  const gapRemains = stage === 'decided' && a?.finalStatus !== 'covered';
  const planPanelOpen = canAct && isCreatePanelOpen(query);
  const detailPath = `${BASE}/requirements/${item.id}`;
  const openPlanHref = `${createPanelHref(detailPath, query, { open: true })}#${PLAN_PANEL_ID}`;
  const closePlanHref = createPanelHref(detailPath, query, { open: false });
  // 担当者の既定は本人（候補に居るとき。D4）、期限は期間の提出期限（D3）
  const defaultAssignee = members.some((m) => m.userId === ctx.userId) ? ctx.userId : '';
  const planCount = view.plans.length;
  const approvedRows = detail.metricData.filter((row) => row.state === 'approved').length;

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
        breadcrumbsTail={[{ label: item.code }]}
        actions={
          <PageActions
            secondary={[
              {
                kind: 'link',
                id: 'response',
                label: '回答を編集（版・承認）',
                href: detail.responseHref,
                icon: <FilePenLine aria-hidden="true" />,
              },
              listLink,
            ]}
          />
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        {/* ① 適用の根拠と要求事項 */}
        <div className="grid grid-cols-2 gap-3">
          <Section
            title="適用の根拠"
            actions={applicability.provisional ? <ProvisionalBadge /> : undefined}
            bodyClassName="space-y-2 text-small"
          >
            {view.section === 'ESRS2' ? (
              <p className="flex items-start gap-1.5 text-ink">
                <Lock className="mt-0.5 size-3.5 text-ink-muted" aria-hidden="true" />
                重要性に関わらず適用（ESRS 2
                全般開示）。ダブル・マテリアリティ評価の結果に左右されません。
              </p>
            ) : matter ? (
              <>
                {/* 要点は 1 行（事項・人の判断・適用になった観点）。判断の根拠は閉じた詳細へ */}
                <p className="flex flex-wrap items-center gap-1.5 text-ink">
                  {matter.topic} {ESRS_TOPIC_LABEL[matter.topic]}
                  <DmaOutcomeBadge outcome={matter.outcome} />
                  {applicability.perspectives.length > 0 ? (
                    <PerspectiveBadges perspectives={applicability.perspectives} />
                  ) : (
                    <span className="text-ink-muted">—（{applicability.reason}）</span>
                  )}
                </p>
                <MoreInfo label="判断の根拠（インパクト・財務）">
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                    <dt className="text-caption text-ink-muted">インパクト重要性</dt>
                    <dd className="text-ink">
                      {DMA_AXIS_ASSESSMENT_LABEL[matter.matter.impactAssessment]}
                      {matter.matter.impactAssessment !== 'not_assessed' && (
                        <span className="block text-caption text-ink-muted">
                          根拠: {excerpt(matter.matter.impactRationale)}
                        </span>
                      )}
                    </dd>
                    <dt className="text-caption text-ink-muted">財務的重要性</dt>
                    <dd className="text-ink">
                      {DMA_AXIS_ASSESSMENT_LABEL[matter.matter.financialAssessment]}
                      {matter.matter.financialAssessment !== 'not_assessed' && (
                        <span className="block text-caption text-ink-muted">
                          根拠: {excerpt(matter.matter.financialRationale)}
                        </span>
                      )}
                    </dd>
                  </dl>
                </MoreInfo>
                <Button variant="secondary" size="xs" asChild>
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
              <p className="text-caption text-warning-ink">
                ダブル・マテリアリティ評価（DMA）が未確定のため、この適用は暫定です。
                <Link href={`${BASE}/settings`} className="ml-1 text-brand-800 underline">
                  設定で確定する
                </Link>
              </p>
            )}
          </Section>

          <Section
            title="要求事項（サンプル・架空）"
            actions={<span className="font-mono text-caption text-ink-muted">{item.code}</span>}
            bodyClassName="space-y-2"
          >
            <p className="text-body font-medium text-ink">{item.questionText}</p>
            {item.guidance && (
              <p className="rounded-t4d bg-surface-muted p-2.5 text-small leading-relaxed text-ink">
                {item.guidance}
              </p>
            )}
            <p className="text-caption text-ink-muted">
              架空の縮小サンプルの要求事項です（正式な ESRS の条文ではありません）。
            </p>
            <div>
              <p className="mb-1 text-caption text-ink-muted">対応付いた指標</p>
              {view.metrics.length === 0 ? (
                <p className="text-small text-ink-muted">
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
          </Section>
        </div>

        {/* ② 評価（3 観点）: AI の候補 → 担当者の確定 */}
        <Section
          id="csrd-requirement-assessment"
          title="評価（3 観点）"
          actions={
            view.awaitingReview ? (
              <Badge tone="warning">
                <CircleAlert className="size-3" aria-hidden="true" />
                確認待ち
              </Badge>
            ) : a?.reviewedAt ? undefined : (
              <Badge tone="neutral">
                <CircleAlert className="size-3" aria-hidden="true" />
                担当者が未確認
              </Badge>
            )
          }
        >
          <AssessmentSection
            view={view}
            stage={stage}
            hasCandidate={hasCandidate}
            inScope={inScope}
            canWrite={canWrite}
            canRunAi={canRunAi}
            reportingPeriodId={shell.currentPeriod.id}
            runProvider={ownRun?.provider ?? 'mock'}
            ownRun={ownRun}
            providerKind={providerKind}
            reviewedByName={detail.reviewedByName}
          />
        </Section>

        {/* ③ 優先順位 */}
        <Section
          title="優先順位の評価"
          actions={
            priority ? (
              <span className="flex items-center gap-1.5">
                <PlanPriorityBadge priority={priority.priority} />
                <span className="text-caption text-ink-muted">
                  {PRIORITY_MEANING[priority.priority]}
                </span>
              </span>
            ) : undefined
          }
        >
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
          ) : (
            <div className="space-y-1">
              <p className="text-small text-ink-muted">優先度なし（評価対象外）</p>
              <MoreInfo label="優先度の付け方">
                <p>優先度は評価対象（常に適用・重要と判断した事項）の要求事項だけに付けます。</p>
              </MoreInfo>
            </div>
          )}
        </Section>

        {/* ④ 対応計画 */}
        <Section
          id="csrd-requirement-plans"
          title={`対応計画（${planCount}）`}
          actions={
            <>
              {canAct && !planPanelOpen && (
                <Button
                  variant={gapRemains ? 'primary' : 'secondary'}
                  size="xs"
                  asChild
                  data-t4d-shortcut="new"
                >
                  <Link href={openPlanHref}>
                    <Plus aria-hidden="true" />
                    対応計画を立てる
                  </Link>
                </Button>
              )}
              <Button variant="secondary" size="xs" asChild>
                <Link href={`${BASE}/plans`}>
                  <ClipboardList aria-hidden="true" />
                  対応計画の一覧へ
                </Link>
              </Button>
            </>
          }
          bodyClassName="space-y-2"
        >
          {planCount > 0 ? (
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
                    <TD className="text-caption">{plan.department || '未設定'}</TD>
                    <TD className="text-caption">
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
          ) : canAct ? (
            <p className="text-small text-ink-muted">
              この要求事項の対応計画はまだありません。ギャップがあれば「対応計画を立てる」から追加します。
            </p>
          ) : null}
          {canAct ? (
            <CreatePanel
              id={PLAN_PANEL_ID}
              title="対応計画を立てる"
              searchParams={query}
              closeHref={closePlanHref}
              description="このギャップへの対応を計画にします。期限は期間の提出期限、担当部署は評価の担当部署、担当者は本人を初期値にしています。"
            >
              <form action={createCsrdActionPlanAction} className="space-y-2.5">
                <input type="hidden" name="reportingPeriodId" value={shell.currentPeriod.id} />
                <input type="hidden" name="itemId" value={item.id} />
                <div className="grid grid-cols-[1fr_1fr_2fr] gap-2">
                  <label className="space-y-1">
                    <span className="block text-caption text-ink-muted">観点</span>
                    <NativeSelect name="gapKind" defaultValue="disclosure">
                      {SSBJ_GAP_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {GAP_KIND_LABEL[kind]}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                  <label className="space-y-1">
                    <span className="block text-caption text-ink-muted">対応区分</span>
                    <NativeSelect name="actionType" defaultValue="disclosure_addition">
                      {SSBJ_ACTION_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {ACTION_TYPE_LABEL[type]}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                  <label className="block space-y-1">
                    <span className="text-caption text-ink-muted">対応内容（必須）</span>
                    <Input
                      name="title"
                      required
                      maxLength={200}
                      defaultValue={a?.aiRecommendation.slice(0, 60) ?? ''}
                    />
                  </label>
                </div>
                <label className="block space-y-1">
                  <span className="text-caption text-ink-muted">詳細（任意）</span>
                  <Input name="detail" defaultValue="" maxLength={1000} />
                </label>
                <div className="grid grid-cols-4 gap-2">
                  <label className="space-y-1">
                    <span className="block text-caption text-ink-muted">担当部署（任意）</span>
                    <Input
                      name="department"
                      defaultValue={a?.ownerDepartment ?? ''}
                      maxLength={100}
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="block text-caption text-ink-muted">担当者（任意）</span>
                    <NativeSelect name="assigneeUserId" defaultValue={defaultAssignee}>
                      <option value="">未設定</option>
                      {members.map((member) => (
                        <option key={member.userId} value={member.userId}>
                          {member.displayName}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                  <label className="space-y-1">
                    <span className="block text-caption text-ink-muted">期限（任意）</span>
                    <Input
                      type="date"
                      name="dueDate"
                      defaultValue={shell.currentPeriod.submissionDueDate ?? ''}
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="block text-caption text-ink-muted">優先順位</span>
                    <NativeSelect name="priority" defaultValue={priority?.priority ?? 'medium'}>
                      <option value="high">高</option>
                      <option value="medium">中</option>
                      <option value="low">低</option>
                    </NativeSelect>
                  </label>
                </div>
                <SubmitButton
                  size="sm"
                  // 確定の後は計画がこの画面の仕事（主操作）。候補の確認の前は主操作を評価に残す
                  variant={stage === 'decided' ? 'primary' : 'secondary'}
                  icon={<ClipboardList aria-hidden="true" />}
                  pendingLabel="追加しています…"
                >
                  対応計画に追加
                </SubmitButton>
              </form>
            </CreatePanel>
          ) : (
            <p className="text-small text-ink-muted">
              {canWrite
                ? '対応計画は評価対象（常に適用・重要と判断した事項）の要求事項にだけ立てられます。'
                : '対応計画の追加には開示対応の編集権限が必要です。'}
            </p>
          )}
        </Section>

        {/* ⑤ 当期データ（L2。既定で閉じる。値の扱いは要点の 1 行に出す）と回答 */}
        <Section
          id="csrd-requirement-data"
          title="対応付いた指標の当期データ"
          collapsible
          summary={`${detail.metricData.length} 行・承認済み ${approvedRows} 行（値は承認済みだけを表示し、未入力を 0 として扱いません）`}
        >
          {detail.metricData.length === 0 ? (
            <EmptyState
              kind="not-applicable"
              size="compact"
              title="対応付いた指標がありません"
              description="記述式の要求事項です。回答（版・承認）で本文を書きます。"
            />
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
                    <TD className="text-small text-ink">
                      {row.metric.name}
                      <span className="ml-1 font-mono text-caption text-ink-muted">
                        {row.metric.code}
                      </span>
                    </TD>
                    <TD className="text-small">{row.unit?.name ?? '全社（行なし）'}</TD>
                    <TD>
                      <CsrdDataStateBadge state={row.state} />
                    </TD>
                    <TD align="right" className="tabular-nums text-small">
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
                          className="ml-2 text-caption text-brand-700 hover:underline"
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
        </Section>

        <Section
          title="回答（版・承認）"
          actions={<ResponseStatusBadge status={view.response?.status ?? 'not_started'} />}
          bodyClassName="space-y-1"
        >
          {/* AI の下書きのままでは承認できないこと（確定は人）は閉じずに見せる */}
          <p className="text-small text-ink-muted">
            回答は回答画面で作成・承認します（AI の下書きのままでは承認できません）。
          </p>
          <MoreInfo label="回答画面でできること">
            <p>
              回答本文の作成・版の履歴・レビュー依頼・承認・AI 回答ドラフト（CDP
              と同じ画面）。上の「回答を編集（版・承認）」から開けます。
            </p>
          </MoreInfo>
        </Section>
      </div>
    </>
  );
}
