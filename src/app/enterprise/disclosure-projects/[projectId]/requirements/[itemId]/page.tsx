import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  AlertTriangle,
  ClipboardPen,
  ExternalLink,
  FileText,
  GitCompareArrows,
  History,
} from 'lucide-react';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { FlashMessage } from '@/components/shared/flash';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Collapsible } from '@/components/ui/collapsible';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { AuthorizationError, NotFoundError, can } from '@/lib/authorization/can';
import { COVERAGE_LABEL } from '@/lib/domain/ssbj';
import { DRAFT_STANDARD_CAP_NOTE } from '@/lib/domain/requirement-coverage';
import { formatJst, formatJstDate } from '@/lib/format/datetime';
import { nameOf } from '@/lib/services/disclosure-project';
import {
  APPLICABILITY_LABELS,
  COVERAGE_ASPECT_LABELS,
  assessmentTextLimit,
  loadProjectRequirementDetail,
  type ProjectRequirementDetail,
} from '@/lib/services/project-requirement-assessment';
import { exclusionDecisionBlocker, exclusionNoteLimit } from '@/lib/services/requirement-exclusion';
import { loadEnterpriseShell } from '@/lib/services/shell';
import type { ActionSpec, MenuActionSpec } from '@/lib/ui/actions';
import type { RequirementApplicability, SsbjCoverageStatus } from '@/types/domain';
import { exclusionActions, reasonHead } from '../_components/exclusion-action-specs';
import { AssessmentForm } from './assessment-form';

export const metadata = { title: '要求事項の詳細（プロジェクト）' };

const EXCLUSION_EVENT_LABELS = {
  requested: '申請',
  approved: '承認',
  returned: '差戻し',
  withdrawn: '取り下げ',
} as const;

function coverageText(value: unknown): string {
  return typeof value === 'string' && value in COVERAGE_LABEL
    ? COVERAGE_LABEL[value as SsbjCoverageStatus]
    : '未評価';
}

function applicabilityText(value: unknown): string {
  return typeof value === 'string' && value in APPLICABILITY_LABELS
    ? APPLICABILITY_LABELS[value as RequirementApplicability]
    : '—';
}

/**
 * 要求事項の詳細（プロジェクト）（トライアル対応 NF-01・NF-02・NF-09。付録 D）。
 *
 * 1 つの要求事項について、区分（5 区分）と理由・適用判断と出所・3 観点の評価・対象外の申請と承認・
 * 対応する原稿の節・数値と根拠・横断対応を 1 画面で確かめる。
 *  - SSBJ・CSRD 以外の基準（ESRS-40a など）: 「判断を記録」（CreatePanel）で判断を保存する（表示では行を作らない）
 *  - SSBJ: 判断の編集は SSBJ の要求事項の詳細（1 か所）。ここは読むだけで、対象外の申請・承認はできる
 *  - CSRD: 判断はダブル・マテリアリティ評価から導く（CSRD の画面へのリンク）
 * 主操作は状態で 1 つ: 承認者で承認待ちの申請があれば「対象外を承認」、編集者なら「判断を記録」。
 */
export default async function ProjectRequirementDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; itemId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId, itemId } = await params;
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const projectsCrumbs = [
    { label: 'ホーム', href: '/enterprise/dashboard' },
    { label: '開示プロジェクト', href: '/enterprise/disclosure-projects' },
  ];

  let data: ProjectRequirementDetail;
  try {
    data = await loadProjectRequirementDetail(db, ctx, { projectId, itemId });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof AuthorizationError) {
      return (
        <>
          <PageHeader title="要求事項の詳細（プロジェクト）" breadcrumbs={projectsCrumbs} />
          <PermissionDeniedState
            description="開示プロジェクトの要求事項を見るには、開示の閲覧権限が必要です。"
            permission="enterprise.disclosure.read"
          />
        </>
      );
    }
    throw error;
  }

  const { detail, framework, item, row, home, assessment, assessmentEvents, exclusion } = data;
  const project = detail.project;
  const base = `/enterprise/disclosure-projects/${project.id}`;
  const path = `${base}/requirements/${item.id}`;
  const canWrite = can(ctx, 'enterprise.disclosure.write');
  const canApprove = can(ctx, 'enterprise.disclosure.approve');
  const panelOpen = home === 'project' && canWrite && isCreatePanelOpen(query);
  const isSample = framework.legal.isSample;

  // 対象外の申請・承認の操作（SSBJ・プロジェクトの判断）
  const exclusionFields: Record<string, string> | null = exclusion
    ? {
        projectId: project.id,
        itemId: item.id,
        source: exclusion.target.source,
        returnTo: 'detail',
        ...(exclusion.target.source === 'ssbj_assessment'
          ? { reportingPeriodId: exclusion.target.reportingPeriodId }
          : { projectFrameworkId: exclusion.target.projectFrameworkId ?? '' }),
      }
    : null;
  const exclusionState = exclusion?.state.state ?? null;
  const current = exclusion?.target.current ?? null;
  const decisionBlocker = exclusion ? exclusionDecisionBlocker(ctx, exclusion) : null;
  const approvable = canApprove && exclusionState === 'requested';
  const exclusionOps =
    exclusionFields && exclusion && current
      ? exclusionActions({
          fields: exclusionFields,
          state: exclusion.state.state,
          requestedBy: exclusion.state.requestedBy,
          recordedBy: exclusion.target.recorder,
          decision: current.decision,
          reason: current.reason,
          frameworkLabel: framework.label,
          code: item.code,
          viewerId: ctx.userId,
          canWrite,
          canApprove,
          noteLimit: exclusionNoteLimit(ctx),
        })
      : {};
  const approveAction = exclusionOps.approve;
  const returnAction = exclusionOps.returnBack;
  const requestAction = exclusionOps.request;
  const recordAction: ActionSpec | undefined =
    home === 'project' && canWrite
      ? {
          kind: 'link',
          id: 'record-assessment',
          shortcut: 'new',
          label: '判断を記録',
          icon: <ClipboardPen aria-hidden="true" />,
          href: `${createPanelHref(path, query, { open: true })}#assessment-panel`,
          hidden: panelOpen,
        }
      : undefined;
  const editElsewhere: ActionSpec | undefined =
    home === 'ssbj'
      ? {
          kind: 'link',
          id: 'open-ssbj',
          label: 'SSBJ の要求事項の詳細で編集',
          icon: <ExternalLink aria-hidden="true" />,
          href: `/enterprise/disclosures/ssbj/requirements/${item.id}?period=${project.reportingPeriodId}`,
        }
      : home === 'csrd'
        ? {
            kind: 'link',
            id: 'open-csrd',
            label: 'CSRD の要求事項の詳細を開く',
            icon: <ExternalLink aria-hidden="true" />,
            href: `/enterprise/disclosures/csrd/requirements/${item.id}`,
          }
        : undefined;
  const more: MenuActionSpec[] = exclusionOps.withdraw ? [exclusionOps.withdraw] : [];
  more.push({
    kind: 'link',
    id: 'open-crosswalk',
    label: '横断対応表を開く',
    href: `${base}?tab=crosswalk`,
  });
  // インパクト・リスク・機会の台帳（T8 の画面。plan 付録 D の入口。読むだけ）
  more.push({
    kind: 'link',
    id: 'open-impact-ledger',
    label: 'インパクト・リスク・機会の台帳を開く',
    href: '/enterprise/disclosures/impacts',
  });

  // 主操作は 1 つ: 承認待ちを承認できる人には承認、それ以外は判断の記録（パネルを開いている間は無し）
  const primary =
    approveAction ?? (recordAction && !recordAction.hidden ? recordAction : undefined);
  const secondary = [
    returnAction,
    approveAction ? recordAction : undefined,
    requestAction,
    editElsewhere,
  ].filter((a): a is ActionSpec => a !== undefined && !a.hidden);

  const ownerOptions = detail.members.map((m) => ({ userId: m.userId, name: m.displayName }));

  return (
    <>
      <PageHeader
        title={`${item.code} ${item.questionText}`}
        breadcrumbs={[
          ...projectsCrumbs,
          {
            label: project.name,
            href: `${base}?tab=requirements&fw=${framework.projectFramework.id}`,
          },
          { label: item.code },
        ]}
        context={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              {framework.label}（{framework.legal.label}）
            </span>
            <span>{item.section}</span>
            <span>報告期間 {detail.period?.code ?? '—'}</span>
          </span>
        }
        actions={<PageActions primary={primary} secondary={secondary} more={more} />}
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />
        {/* 誠実さの注記は折りたたまない */}
        {isSample && (
          <p className="flex flex-wrap items-center gap-1.5 text-small text-ink">
            <HonestyBadge kind="sample-master" />
            サンプル（架空）の要求事項です。基準の条文・要約ではありません（トライアルの操作確認用）。
          </p>
        )}
        {framework.legal.isPreparationOnly && !isSample && (
          <p className="flex items-center gap-1.5 text-small text-ink">
            <AlertTriangle className="size-3.5 text-warning-ink" aria-hidden="true" />
            {framework.legal.label}の版です。人が確認しても「充足確認済み」にはしません（
            {DRAFT_STANDARD_CAP_NOTE}）。
          </p>
        )}

        {/* L1: 区分と判断の要約 */}
        <dl
          className="grid gap-x-6 gap-y-2 rounded-t4d border border-line bg-surface px-3 py-2 text-small sm:grid-cols-2 xl:grid-cols-4"
          aria-label="要求事項の状況"
        >
          <div>
            <dt className="text-caption text-ink-muted">区分</dt>
            <dd className="space-y-0.5">
              <StatusBadge domain="requirementCoverage" value={row.category} />
              <ul className="text-caption text-ink-muted">
                {row.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </dd>
          </div>
          <div>
            <dt className="text-caption text-ink-muted">適用判断（出所）</dt>
            <dd>
              <span className="font-medium text-ink">{row.decisionLabel}</span>
              <span className="block text-caption text-ink-muted">
                出所: {row.decisionSourceLabel}
              </span>
              {row.decidedByName && (
                <span className="block text-caption text-ink-muted">判断: {row.decidedByName}</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-ink-muted">対象外・非重要の承認</dt>
            <dd>
              {exclusionState && current ? (
                <>
                  <StatusBadge domain="exclusionApproval" value={exclusionState} />
                  {row.approvedByName && (
                    <span className="block text-caption text-ink-muted">
                      承認: {row.approvedByName}（{formatJst(row.approvedAt)}）
                    </span>
                  )}
                </>
              ) : (
                <span className="text-ink-muted">—（対象外・非重要の判断はありません）</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-ink-muted">担当・期限（出所）</dt>
            <dd>
              <span className="text-ink">{row.ownerName ?? '未定'}</span>
              <span className="text-ink-muted">
                {' '}
                ／ {row.dueDate ? formatJstDate(row.dueDate) : '期限なし'}
              </span>
              <span className="block text-caption text-ink-muted">
                出所: {row.ownerDueSourceLabel}
              </span>
            </dd>
          </div>
          {row.gapLabels.length > 0 && (
            <div className="sm:col-span-2 xl:col-span-4">
              <dt className="text-caption text-ink-muted">不足</dt>
              <dd className="flex flex-wrap gap-1">
                {row.gapLabels.map((gap) => (
                  <Badge key={gap} tone="warning">
                    <AlertTriangle className="size-3" aria-hidden="true" />
                    {gap}
                  </Badge>
                ))}
              </dd>
            </div>
          )}
        </dl>

        {home === 'project' && canWrite && (
          <CreatePanel
            id="assessment-panel"
            title="判断を記録"
            searchParams={query}
            closeHref={createPanelHref(path, query, { open: false })}
            description="適用区分・理由・3 観点の評価を記録します。保存のたびに履歴へ前後の値を残します。対象外・非重要は理由が必須で、別の人の承認があるまで分母から外しません。"
          >
            <AssessmentForm
              projectId={project.id}
              projectFrameworkId={framework.projectFramework.id}
              itemId={item.id}
              textLimit={assessmentTextLimit(ctx)}
              members={ownerOptions}
              defaults={{
                applicability: assessment?.applicability ?? 'not_assessed',
                applicabilityReason: assessment?.applicabilityReason ?? '',
                ruleRef: assessment?.ruleRef ?? '',
                disclosureCoverage: assessment?.disclosureCoverage ?? '',
                dataCoverage: assessment?.dataCoverage ?? '',
                processCoverage: assessment?.processCoverage ?? '',
                missingInformation: assessment?.missingInformation ?? '',
                ownerUserId: assessment?.ownerUserId ?? '',
                dueOn: assessment?.dueOn ?? '',
                actionNote: assessment?.actionNote ?? '',
              }}
            />
          </CreatePanel>
        )}

        <div className="grid gap-3 xl:grid-cols-2">
          <Section title="要求事項" divider="none">
            <div className="space-y-2 text-small">
              <p className="text-body font-medium text-ink">{item.questionText}</p>
              {item.guidance && (
                <p className="rounded-t4d bg-surface-muted p-2 leading-relaxed text-ink">
                  {item.guidance}
                </p>
              )}
              <p className="text-caption text-ink-muted">
                {item.required ? '開示が求められる項目' : '任意の項目'}・節 {item.section}
              </p>
            </div>
          </Section>

          <Section title="適用判断と 3 観点の評価" divider="none">
            {home === 'project' ? (
              assessment ? (
                <div className="space-y-2 text-small">
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
                    <div>
                      <dt className="text-caption text-ink-muted">適用区分</dt>
                      <dd className="text-ink">{APPLICABILITY_LABELS[assessment.applicability]}</dd>
                    </div>
                    <div>
                      <dt className="text-caption text-ink-muted">参照した規則</dt>
                      <dd className="text-ink">{assessment.ruleRef || '—'}</dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="text-caption text-ink-muted">理由</dt>
                      <dd className="whitespace-pre-wrap text-ink">
                        {assessment.applicabilityReason || '—'}
                      </dd>
                    </div>
                  </dl>
                  <div className="grid grid-cols-3 gap-2">
                    {(
                      [
                        ['disclosure', assessment.disclosureCoverage],
                        ['data', assessment.dataCoverage],
                        ['process', assessment.processCoverage],
                      ] as const
                    ).map(([aspect, value]) => (
                      <div key={aspect} className="rounded-t4d border border-line p-2">
                        <p className="text-caption text-ink-muted">
                          {COVERAGE_ASPECT_LABELS[aspect]}
                        </p>
                        {value ? (
                          <StatusBadge domain="ssbjCoverage" value={value} />
                        ) : (
                          <span className="text-caption text-ink-muted">未評価</span>
                        )}
                      </div>
                    ))}
                  </div>
                  {assessment.missingInformation && (
                    <p>
                      <span className="text-caption text-ink-muted">不足情報: </span>
                      {assessment.missingInformation}
                    </p>
                  )}
                  {assessment.actionNote && (
                    <p>
                      <span className="text-caption text-ink-muted">対応メモ: </span>
                      {assessment.actionNote}
                    </p>
                  )}
                  <p className="text-caption text-ink-muted">
                    判断 {nameOf(detail.members, assessment.decidedBy) ?? '—'}
                    {assessment.decidedAt
                      ? `（${formatJst(assessment.decidedAt)}）`
                      : ''}・担当 {nameOf(detail.members, assessment.ownerUserId) ?? '未定'}・期限{' '}
                    {formatJstDate(assessment.dueOn)}
                  </p>
                  {assessmentEvents.length > 0 && (
                    <Collapsible
                      variant="plain"
                      summary={
                        <span className="inline-flex items-center gap-1">
                          <History className="size-3.5" aria-hidden="true" />
                          判断の履歴（{assessmentEvents.length} 件）
                        </span>
                      }
                    >
                      <ol className="space-y-1">
                        {assessmentEvents.map((event) => (
                          <li
                            key={event.id}
                            className="rounded-t4d bg-surface-muted px-2 py-1 text-caption"
                          >
                            <span className="font-medium text-ink">
                              {formatJst(event.createdAt)}{' '}
                              {nameOf(detail.members, event.actorUserId) ?? '—'}
                            </span>
                            <span className="block">
                              {event.before
                                ? `${applicabilityText(event.before.applicability)} → ${applicabilityText(event.after.applicability)}`
                                : `記録: ${applicabilityText(event.after.applicability)}`}
                              ／ 評価 {coverageText(event.after.disclosureCoverage)}・
                              {coverageText(event.after.dataCoverage)}・
                              {coverageText(event.after.processCoverage)}
                            </span>
                            {typeof event.after.applicabilityReason === 'string' &&
                              event.after.applicabilityReason && (
                                <span className="block text-ink-muted">
                                  理由: {event.after.applicabilityReason}
                                </span>
                              )}
                            {event.reason && (
                              <span className="block text-ink-muted">
                                変更の理由: {event.reason}
                              </span>
                            )}
                          </li>
                        ))}
                      </ol>
                    </Collapsible>
                  )}
                </div>
              ) : (
                <EmptyState
                  kind={canWrite ? 'no-data' : 'not-applicable'}
                  size="compact"
                  title="まだ判断を記録していません（未判定）"
                  description="判断の記録が無い要求事項は「未判定」として分母に残します。"
                  action={
                    canWrite ? (
                      <Link
                        href={`${createPanelHref(path, query, { open: true })}#assessment-panel`}
                        className="text-small text-brand-800 underline"
                      >
                        判断の記録欄を開く
                      </Link>
                    ) : undefined
                  }
                />
              )
            ) : (
              <div className="space-y-1 text-small">
                <p className="text-ink">
                  {home === 'ssbj'
                    ? 'SSBJ の判断（対象判定・重要性）と 3 観点の評価は、SSBJ の要求事項の詳細で記録します（編集は 1 か所）。'
                    : 'CSRD の判断はダブル・マテリアリティ評価から導きます。評価は CSRD の要求事項の詳細で記録します。'}
                </p>
                {row.humanEvaluationLabel && (
                  <p>
                    <span className="text-caption text-ink-muted">人の評価: </span>
                    {row.humanEvaluationLabel}
                  </p>
                )}
                {row.aiCandidateLabel && (
                  <p className="flex flex-wrap items-center gap-1.5">
                    <HonestyBadge kind="ai-candidate" />
                    <span>{row.aiCandidateLabel}（人が確認していません）</span>
                  </p>
                )}
              </div>
            )}
          </Section>
        </div>

        <Section
          title="対象外・非重要の申請と承認"
          summary={
            <span className="text-caption text-ink-muted">
              申請した人・理由を記録した人は承認できません。承認は理由に結び付き、理由を変えると承認し直しです。
            </span>
          }
        >
          {!exclusion ? (
            <p className="text-small text-ink-muted">
              {home === 'csrd'
                ? 'CSRD の非重要は、ダブル・マテリアリティ評価の確定（確定者）を承認の記録として扱います。'
                : 'SSBJ の評価の行がまだ無いため、申請できません（SSBJ の要求事項の詳細で判断を記録してください）。'}
            </p>
          ) : !current ? (
            <p className="text-small text-ink-muted">
              対象外・非重要の判断（理由付き）が無いため、申請の対象はありません。
            </p>
          ) : (
            <div className="space-y-2 text-small">
              <p className="flex flex-wrap items-center gap-2">
                <StatusBadge domain="exclusionApproval" value={exclusion.state.state} />
                <span className="text-ink">
                  {current.decision === 'not_applicable' ? '対象外' : '非重要'}:{' '}
                  {reasonHead(current.reason)}
                </span>
              </p>
              {exclusion.state.requestedBy && (
                <p className="text-caption text-ink-muted">
                  申請 {nameOf(detail.members, exclusion.state.requestedBy) ?? '—'}（
                  {formatJst(exclusion.state.requestedAt)}）
                  {exclusion.state.decidedBy &&
                    ` ／ ${exclusion.state.state === 'approved' ? '承認' : '差戻し'} ${nameOf(detail.members, exclusion.state.decidedBy) ?? '—'}（${formatJst(exclusion.state.decidedAt)}）`}
                </p>
              )}
              {exclusion.state.returnNote && (
                <p className="text-ink">差戻しの理由: {exclusion.state.returnNote}</p>
              )}
              {approvable && decisionBlocker && (
                <p className="text-caption text-ink-muted">{decisionBlocker}</p>
              )}
              {exclusion.events.length > 0 && (
                <Collapsible
                  variant="plain"
                  summary={`申請・承認の記録（${exclusion.events.length} 件）`}
                >
                  <ol className="space-y-0.5 text-caption">
                    {exclusion.events.map((event) => (
                      <li key={event.id}>
                        {formatJst(event.createdAt)} {EXCLUSION_EVENT_LABELS[event.event]}{' '}
                        {nameOf(detail.members, event.actorUserId) ?? '—'}
                        {event.note ? ` ／ ${event.note}` : ''}
                        <span className="text-ink-muted">（理由: {event.reasonExcerpt}）</span>
                      </li>
                    ))}
                  </ol>
                </Collapsible>
              )}
            </div>
          )}
        </Section>

        <Section title={`対応する原稿の節（${row.blocks.length}）`}>
          {row.blocks.length === 0 ? (
            <EmptyState
              kind="no-data"
              size="compact"
              title="この要求事項に対応する節はありません"
              description="原稿タブで節を追加するときに対応する要求事項を選ぶか、原稿エディタの根拠パネルで対応付けます。"
              action={
                <Link
                  href={`${base}?tab=manuscripts`}
                  className="text-small text-brand-800 underline"
                >
                  原稿タブを開く
                </Link>
              }
            />
          ) : (
            <div className="t4d-scroll-x rounded-t4d border border-line">
              <Table>
                <caption className="sr-only">対応する原稿の節</caption>
                <THead>
                  <TR>
                    <TH>節</TH>
                    <TH>状態・版</TH>
                    <TH>承認（版・承認者・日時）</TH>
                    <TH>本文の抜粋</TH>
                  </TR>
                </THead>
                <TBody>
                  {row.blocks.map((b) => (
                    <TR key={b.blockId} data-t4d-record="">
                      <TD className="text-small">
                        <Link
                          href={`${base}/blocks/${b.blockId}?pane=requirements`}
                          className="text-brand-800 hover:underline"
                        >
                          {b.title}
                        </Link>
                        {b.translation && (
                          <span className="block text-caption text-ink-muted">翻訳版</span>
                        )}
                      </TD>
                      <TD className="whitespace-nowrap text-small">
                        {b.statusLabel}・版 {b.versionNo ?? '—'}
                      </TD>
                      <TD className="text-small">
                        {b.approvedVersionNo !== null
                          ? `版 ${b.approvedVersionNo}・${b.approvedByName ?? '—'}・${formatJst(b.approvedAt)}`
                          : '—'}
                      </TD>
                      <TD className="max-w-col-xl text-caption text-ink-muted">
                        {b.excerpt || '—'}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
          <p className="mt-1 text-caption text-ink-muted">
            承認は企業内の承認です。第三者による保証ではありません。
          </p>
        </Section>

        <Section
          id="requirement-evidence"
          title="数値・根拠・定性情報"
          collapsible
          summary={`数値 ${row.metrics.length} 件・根拠 ${row.evidence.length} 件・定性情報 ${row.narratives.length} 件`}
        >
          <div className="grid gap-3 text-small lg:grid-cols-3">
            <div>
              <h3 className="mb-1 font-semibold text-ink">数値</h3>
              {row.metrics.length === 0 ? (
                <p className="text-ink-muted">引用している数値はありません。</p>
              ) : (
                <ul className="space-y-1">
                  {row.metrics.map((m, index) => (
                    <li key={`${m.metricName}-${index}`}>
                      {m.metricName}／{m.unitName}／{m.periodCode}：{m.value} {m.unitOfMeasure}（版{' '}
                      {m.versionNo}・{m.approved ? '承認済み' : '未承認'}）
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="mb-1 font-semibold text-ink">根拠</h3>
              {row.evidence.length === 0 ? (
                <p className="text-ink-muted">根拠の引用はありません。</p>
              ) : (
                <ul className="space-y-1">
                  {row.evidence.map((e, index) => (
                    <li key={`${e.fileName}-${index}`} className="flex items-start gap-1">
                      <FileText
                        className="mt-0.5 size-3.5 shrink-0 text-ink-muted"
                        aria-hidden="true"
                      />
                      {e.fileName}（版 {e.fileVersionNo ?? '—'}）{e.locator}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="mb-1 font-semibold text-ink">定性情報</h3>
              {row.narratives.length === 0 ? (
                <p className="text-ink-muted">引用している定性情報はありません。</p>
              ) : (
                <ul className="space-y-1">
                  {row.narratives.map((n) => (
                    <li key={`${n.title}-${n.versionNo}`}>
                      {n.title}（版 {n.versionNo}）
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Section>

        <Section
          title={`横断対応（${row.crosswalk.length}）`}
          actions={
            <Link
              href={`${base}?tab=crosswalk`}
              className="inline-flex items-center gap-1 text-small text-brand-800 hover:underline"
            >
              <GitCompareArrows className="size-3.5" aria-hidden="true" />
              横断対応表を開く
            </Link>
          }
        >
          {row.crosswalk.length === 0 ? (
            <p className="text-small text-ink-muted">
              この要求事項の横断対応は登録されていません。
            </p>
          ) : (
            <ul className="space-y-1 text-small">
              {row.crosswalk.map((c, index) => (
                <li
                  key={`${c.counterpartFramework}-${c.counterpartCode ?? 'none'}-${index}`}
                  className="flex flex-wrap items-center gap-1.5"
                >
                  <StatusBadge domain="crosswalkRelation" value={c.relation} />
                  <span className="text-ink">
                    {c.counterpartFramework} {c.counterpartCode ?? '（対応先なし）'}
                  </span>
                  {c.sample && <HonestyBadge kind="sample-master" />}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}
