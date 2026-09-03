import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  Bot,
  CircleAlert,
  ClipboardList,
  Database,
  FileText,
  ScrollText,
  ShieldCheck,
  UserCheck,
} from 'lucide-react';
import { AiGeneratedBadge } from '@/components/shared/badges';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import {
  ACTION_STATUS_LABEL,
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
import type { SsbjCoverageStatus, SsbjGapKind } from '@/types/domain';
import {
  createSsbjActionPlanAction,
  runSsbjGapAnalysisAction,
  saveSsbjReviewAction,
  saveSsbjScopeAction,
} from '../../../../actions';

export const metadata = { title: 'SSBJ 要求事項の詳細' };

const COVERAGE_OPTIONS: SsbjCoverageStatus[] = [
  'covered',
  'mostly_covered',
  'partial',
  'not_covered',
  'unconfirmed',
];

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
        <span className="text-[12px] font-semibold text-ink">{GAP_KIND_LABEL[kind]}ギャップ</span>
      </div>
      <Badge tone={COVERAGE_TONE[status]}>{COVERAGE_LABEL[status]}</Badge>
      <p className="text-[11px] leading-relaxed text-ink-muted">{GAP_KIND_QUESTION[kind]}</p>
    </div>
  );
}

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

  const detail = await loadSsbjRequirementDetail(shell.db, shell.ctx, shell.currentPeriod, itemId);
  if (!detail) notFound();

  const { view, metrics } = detail;
  const { item, assessment: a, priority } = view;
  const members = await listMentionCandidates(shell.db, shell.ctx);

  return (
    <>
      <PageHeader
        title={`${item.code} ${item.questionText}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {AREA_LABEL[view.area]} ／ {item.section} ／ {shell.currentPeriod.label}
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
        breadcrumbs={[
          { label: '企業ワークスペース' },
          { label: '開示対応' },
          { label: 'SSBJ', href: '/enterprise/disclosures/ssbj' },
          { label: '要求事項の評価', href: '/enterprise/disclosures/ssbj/requirements' },
          { label: item.code },
        ]}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/enterprise/disclosures/ssbj/requirements">
              <ArrowLeft aria-hidden="true" />
              一覧へ戻る
            </Link>
          </Button>
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        {a.recheckReason && (
          <Card className="flex items-start gap-2 border-warning/40 p-3">
            <CircleAlert className="mt-0.5 size-4 text-[#8a5d00]" aria-hidden="true" />
            <div>
              <p className="text-[13px] font-semibold text-ink">今年度に再評価が必要です</p>
              <p className="text-[12px] text-ink-muted">{a.recheckReason}</p>
            </div>
          </Card>
        )}

        {/* 左: SSBJ 要求事項 / 右: 現在の開示内容 */}
        <div className="grid grid-cols-2 gap-3">
          <Card className="overflow-hidden">
            <SectionTitle
              title="SSBJ 要求事項"
              action={<span className="font-mono text-[11px] text-ink-muted">{item.code}</span>}
            />
            <div className="space-y-3 p-3">
              <div>
                <p className="text-[11px] text-ink-muted">要求事項の見出し</p>
                <p className="text-[13px] font-medium text-ink">{item.questionText}</p>
              </div>
              <div>
                <p className="mb-1 text-[11px] text-ink-muted">基準の原文</p>
                <p className="rounded-t4d bg-surface-muted p-2.5 text-[12px] leading-relaxed text-ink">
                  {item.guidance}
                </p>
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[12px]">
                <div>
                  <dt className="text-[11px] text-ink-muted">対象領域</dt>
                  <dd className="text-ink">{AREA_LABEL[view.area]}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-ink-muted">適用区分</dt>
                  <dd className="text-ink">{APPLICABILITY_LABEL[a.applicability]}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-ink-muted">重要性</dt>
                  <dd className="text-ink">{MATERIALITY_LABEL[a.materiality]}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-ink-muted">担当部署</dt>
                  <dd className="text-ink">{a.ownerDepartment || '未設定'}</dd>
                </div>
              </dl>
              {a.applicabilityReason && (
                <p className="text-[11px] text-ink-muted">対象外の理由: {a.applicabilityReason}</p>
              )}
              {a.materialityReason && (
                <p className="text-[11px] text-ink-muted">
                  重要性の判断理由: {a.materialityReason}
                </p>
              )}
              <div>
                <p className="mb-1 text-[11px] text-ink-muted">関連する指標</p>
                {metrics.length === 0 ? (
                  <p className="text-[12px] text-ink-muted">
                    紐づく指標がありません（定性的な要求事項です）。
                  </p>
                ) : (
                  <ul className="flex flex-wrap gap-1">
                    {metrics.map((metric) => (
                      <li key={metric.id}>
                        <Badge tone="outline">
                          {metric.name}（{metric.unit}）
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </Card>

          <Card className="overflow-hidden">
            <SectionTitle
              title="現在の開示内容"
              action={
                <span className="text-[11px] text-ink-muted">
                  取り込んだ資料から見つけた該当箇所
                </span>
              }
            />
            <div className="space-y-3 p-3">
              {a.sourceDocument === null ? (
                <EmptyState
                  title="該当する記述が見つかっていません"
                  description="資料を取り込んだうえで、人工知能によるギャップ分析を実行してください。"
                  icon={<FileText className="size-5" aria-hidden="true" />}
                />
              ) : (
                <>
                  <div className="flex items-center gap-1.5 text-[12px]">
                    <FileText className="size-3.5 text-ink-muted" aria-hidden="true" />
                    <span className="text-ink-muted">出典:</span>
                    <span className="font-medium text-ink">{a.sourceDocument}</span>
                    <span className="text-ink-muted">{a.sourcePage}</span>
                  </div>
                  <blockquote className="rounded-t4d border-l-2 border-brand-300 bg-brand-50/60 p-2.5 text-[12px] leading-relaxed text-ink">
                    {a.sourceExcerpt}
                  </blockquote>
                </>
              )}

              <div>
                <p className="mb-1.5 text-[11px] text-ink-muted">3 つの観点それぞれの対応状況</p>
                <div className="grid grid-cols-3 gap-2">
                  <GapCard kind="disclosure" status={a.disclosureStatus} icon={ScrollText} />
                  <GapCard kind="data" status={a.dataStatus} icon={Database} />
                  <GapCard kind="process" status={a.processStatus} icon={ShieldCheck} />
                </div>
              </div>
            </div>
          </Card>
        </div>

        {/* 人工知能による評価 */}
        <Card className="overflow-hidden">
          <SectionTitle
            title="人工知能による評価"
            action={
              a.aiEvaluatedAt ? (
                <span className="flex items-center gap-1.5">
                  <AiGeneratedBadge provider="mock" />
                  <span className="text-[11px] text-ink-muted">
                    実行日時 {formatJst(a.aiEvaluatedAt)}
                  </span>
                </span>
              ) : undefined
            }
          />
          <div className="space-y-3 p-3">
            {a.aiStatus === null ? (
              <EmptyState
                title="まだ分析していません"
                description="取り込んだ資料と要求事項を比較し、対応状況の候補を作成します。"
                icon={<Bot className="size-5" aria-hidden="true" />}
              />
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-ink-muted">判定</span>
                  <Badge tone={COVERAGE_TONE[a.aiStatus]}>{COVERAGE_LABEL[a.aiStatus]}</Badge>
                  <span className="text-[11px] text-ink-muted">
                    この判定は候補です。最終判定は担当者の確認で確定します。
                  </span>
                </div>
                <div>
                  <p className="text-[11px] text-ink-muted">評価コメント</p>
                  <p className="text-[12px] leading-relaxed text-ink">{a.aiComment}</p>
                </div>
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
                <div>
                  <p className="text-[11px] text-ink-muted">推奨される対応</p>
                  <p className="text-[12px] leading-relaxed text-ink">{a.aiRecommendation}</p>
                </div>
              </>
            )}
            {canRunAi && (
              <form action={runSsbjGapAnalysisAction}>
                <input type="hidden" name="assessmentId" value={a.id} />
                <input type="hidden" name="itemId" value={item.id} />
                <SubmitButton size="sm" variant="outline" pendingLabel="分析しています…">
                  <Bot aria-hidden="true" />
                  {a.aiStatus === null ? 'ギャップ分析を実行' : 'ギャップ分析をやり直す'}
                </SubmitButton>
              </form>
            )}
          </div>
        </Card>

        <div className="grid grid-cols-2 gap-3">
          {/* 担当者による確認 */}
          <Card className="overflow-hidden">
            <SectionTitle
              title="担当者による確認"
              action={
                a.reviewedAt ? (
                  <span className="text-[11px] text-ink-muted">
                    確認日 {formatJst(a.reviewedAt)}
                  </span>
                ) : (
                  <Badge tone="warning">
                    <CircleAlert className="size-3" aria-hidden="true" />
                    確認待ち
                  </Badge>
                )
              }
            />
            <div className="space-y-3 p-3">
              {a.finalStatus !== null && (
                <div className="flex items-center gap-2 rounded-t4d bg-surface-muted p-2">
                  <UserCheck className="size-3.5 text-ink-muted" aria-hidden="true" />
                  <span className="text-[11px] text-ink-muted">最終判定</span>
                  <Badge tone={COVERAGE_TONE[a.finalStatus]}>{COVERAGE_LABEL[a.finalStatus]}</Badge>
                  <span className="text-[11px] text-ink-muted">
                    {a.reviewDecision === 'approved'
                      ? '人工知能の判定を承認'
                      : '担当者が判定を修正'}
                  </span>
                </div>
              )}
              {a.reviewComment && (
                <p className="text-[12px] leading-relaxed text-ink">{a.reviewComment}</p>
              )}

              {canWrite ? (
                <form action={saveSsbjReviewAction} className="space-y-2.5">
                  <input type="hidden" name="assessmentId" value={a.id} />
                  <input type="hidden" name="itemId" value={item.id} />
                  <fieldset className="space-y-1.5">
                    <legend className="text-[11px] text-ink-muted">確認の結果</legend>
                    <label className="flex items-center gap-1.5 text-[12px] text-ink">
                      <input
                        type="radio"
                        name="decision"
                        value="approve_ai"
                        defaultChecked
                        className="accent-[#0b57a4]"
                      />
                      人工知能の判定を承認する
                    </label>
                    <label className="flex items-center gap-1.5 text-[12px] text-ink">
                      <input
                        type="radio"
                        name="decision"
                        value="modify"
                        className="accent-[#0b57a4]"
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
                        <span className="block text-[11px] text-ink-muted">{label}</span>
                        <select
                          name={name}
                          defaultValue={value}
                          aria-label={`${label}の対応状況`}
                          className="h-7 w-full rounded-t4d border border-line bg-surface px-1.5 text-[12px]"
                        >
                          {COVERAGE_OPTIONS.map((status) => (
                            <option key={status} value={status}>
                              {COVERAGE_LABEL[status]}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>

                  <label className="block space-y-1">
                    <span className="text-[11px] text-ink-muted">
                      確認コメント（履歴に残ります）
                    </span>
                    <input
                      type="text"
                      name="comment"
                      defaultValue=""
                      placeholder="判断の根拠を記入してください"
                      aria-label="確認コメント"
                      className="h-7 w-full rounded-t4d border border-line px-2 text-[12px]"
                    />
                  </label>

                  <SubmitButton size="sm" pendingLabel="確定しています…">
                    <UserCheck aria-hidden="true" />
                    最終判定として確定する
                  </SubmitButton>
                </form>
              ) : (
                <p className="text-[12px] text-ink-muted">
                  確認・確定を行うには開示対応の編集権限が必要です。
                </p>
              )}
            </div>
          </Card>

          {/* 対象判定・重要性判断・優先順位 */}
          <div className="space-y-3">
            <Card className="overflow-hidden">
              <SectionTitle
                title="優先順位の評価"
                action={
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
                    <span className="text-[11px] text-ink-muted">
                      {PRIORITY_MEANING[priority.priority]}
                    </span>
                  </span>
                }
              />
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
            </Card>

            {canWrite && (
              <Card className="overflow-hidden">
                <SectionTitle title="対象判定・重要性判断" />
                <form action={saveSsbjScopeAction} className="space-y-2.5 p-3">
                  <input type="hidden" name="assessmentId" value={a.id} />
                  <input type="hidden" name="itemId" value={item.id} />
                  <div className="grid grid-cols-2 gap-2">
                    <label className="space-y-1">
                      <span className="block text-[11px] text-ink-muted">適用区分</span>
                      <select
                        name="applicability"
                        defaultValue={a.applicability}
                        aria-label="適用区分"
                        className="h-7 w-full rounded-t4d border border-line bg-surface px-1.5 text-[12px]"
                      >
                        <option value="applicable">対象</option>
                        <option value="not_applicable">対象外</option>
                      </select>
                    </label>
                    <label className="space-y-1">
                      <span className="block text-[11px] text-ink-muted">重要性</span>
                      <select
                        name="materiality"
                        defaultValue={a.materiality}
                        aria-label="重要性"
                        className="h-7 w-full rounded-t4d border border-line bg-surface px-1.5 text-[12px]"
                      >
                        <option value="material">重要性あり</option>
                        <option value="not_material">重要性なし</option>
                        <option value="not_assessed">未判定</option>
                      </select>
                    </label>
                  </div>
                  <label className="block space-y-1">
                    <span className="text-[11px] text-ink-muted">
                      対象外とする理由（対象外を選ぶ場合は必須）
                    </span>
                    <input
                      type="text"
                      name="applicabilityReason"
                      defaultValue={a.applicabilityReason}
                      aria-label="対象外とする理由"
                      className="h-7 w-full rounded-t4d border border-line px-2 text-[12px]"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[11px] text-ink-muted">
                      重要性なしとする理由（重要性なしを選ぶ場合は必須）
                    </span>
                    <input
                      type="text"
                      name="materialityReason"
                      defaultValue={a.materialityReason}
                      aria-label="重要性なしとする理由"
                      className="h-7 w-full rounded-t4d border border-line px-2 text-[12px]"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[11px] text-ink-muted">担当部署</span>
                    <input
                      type="text"
                      name="ownerDepartment"
                      defaultValue={a.ownerDepartment}
                      aria-label="担当部署"
                      className="h-7 w-full rounded-t4d border border-line px-2 text-[12px]"
                    />
                  </label>
                  <SubmitButton size="sm" variant="outline" pendingLabel="保存しています…">
                    判定を保存
                  </SubmitButton>
                </form>
              </Card>
            )}
          </div>
        </div>

        {/* 対応計画 */}
        <Card className="overflow-hidden">
          <SectionTitle
            title={`対応計画（${view.plans.length}）`}
            action={
              <Button variant="outline" size="xs" asChild>
                <Link href="/enterprise/disclosures/ssbj/plans">
                  <ClipboardList aria-hidden="true" />
                  対応計画の一覧へ
                </Link>
              </Button>
            }
          />
          {view.plans.length > 0 && (
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
                    <TD className="max-w-[320px] font-medium text-ink">{plan.title}</TD>
                    <TD>{ACTION_TYPE_LABEL[plan.actionType]}</TD>
                    <TD className="text-[11px]">{plan.department || '未設定'}</TD>
                    <TD className="text-[11px]">{plan.dueDate ?? '未設定'}</TD>
                    <TD>
                      <Badge tone="neutral">{ACTION_STATUS_LABEL[plan.status]}</Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}

          {canWrite && (
            <form
              action={createSsbjActionPlanAction}
              className="space-y-2.5 border-t border-line p-3"
            >
              <input type="hidden" name="assessmentId" value={a.id} />
              <input type="hidden" name="itemId" value={item.id} />
              <p className="text-[12px] font-semibold text-ink">このギャップを対応計画に追加する</p>
              <div className="grid grid-cols-4 gap-2">
                <label className="space-y-1">
                  <span className="block text-[11px] text-ink-muted">観点</span>
                  <select
                    name="gapKind"
                    defaultValue="disclosure"
                    aria-label="ギャップの観点"
                    className="h-7 w-full rounded-t4d border border-line bg-surface px-1.5 text-[12px]"
                  >
                    <option value="disclosure">開示</option>
                    <option value="data">データ</option>
                    <option value="process">業務プロセス・内部統制</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="block text-[11px] text-ink-muted">対応区分</span>
                  <select
                    name="actionType"
                    defaultValue="disclosure_addition"
                    aria-label="対応区分"
                    className="h-7 w-full rounded-t4d border border-line bg-surface px-1.5 text-[12px]"
                  >
                    {Object.entries(ACTION_TYPE_LABEL).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="block text-[11px] text-ink-muted">担当部署</span>
                  <input
                    type="text"
                    name="department"
                    defaultValue={a.ownerDepartment}
                    aria-label="対応計画の担当部署"
                    className="h-7 w-full rounded-t4d border border-line px-2 text-[12px]"
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-[11px] text-ink-muted">担当者</span>
                  <select
                    name="assigneeUserId"
                    defaultValue=""
                    aria-label="対応計画の担当者"
                    className="h-7 w-full rounded-t4d border border-line bg-surface px-1.5 text-[12px]"
                  >
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
                <span className="text-[11px] text-ink-muted">対応内容</span>
                <input
                  type="text"
                  name="title"
                  required
                  defaultValue={a.aiRecommendation.slice(0, 60)}
                  aria-label="対応内容"
                  className="h-7 w-full rounded-t4d border border-line px-2 text-[12px]"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] text-ink-muted">詳細</span>
                <input
                  type="text"
                  name="detail"
                  defaultValue=""
                  aria-label="対応の詳細"
                  className="h-7 w-full rounded-t4d border border-line px-2 text-[12px]"
                />
              </label>
              <div className="flex items-end gap-2">
                <label className="space-y-1">
                  <span className="block text-[11px] text-ink-muted">期限</span>
                  <input
                    type="date"
                    name="dueDate"
                    aria-label="対応期限"
                    className="h-7 rounded-t4d border border-line px-2 text-[12px]"
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-[11px] text-ink-muted">優先順位</span>
                  <select
                    name="priority"
                    defaultValue={priority.priority}
                    aria-label="対応計画の優先順位"
                    className="h-7 rounded-t4d border border-line bg-surface px-1.5 text-[12px]"
                  >
                    <option value="high">高</option>
                    <option value="medium">中</option>
                    <option value="low">低</option>
                  </select>
                </label>
                <SubmitButton size="sm" pendingLabel="追加しています…">
                  <ClipboardList aria-hidden="true" />
                  対応計画に追加
                </SubmitButton>
              </div>
            </form>
          )}
        </Card>
      </div>
    </>
  );
}
