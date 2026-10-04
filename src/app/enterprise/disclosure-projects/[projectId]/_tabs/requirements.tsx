import Link from 'next/link';
import { ClipboardCheck, FileQuestion, FlaskConical, ListFilter } from 'lucide-react';
import { SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { MoreInfo } from '@/components/ui/more-info';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { getReferenceDate } from '@/lib/clock';
import { formatJstDate, isOverdue } from '@/lib/format/datetime';
import {
  REQUIREMENT_FILTERS,
  REQUIREMENT_FILTER_LABELS,
  isRequirementFilter,
  loadProjectRequirements,
} from '@/lib/services/disclosure-project';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { cn } from '@/lib/utils';
import {
  EvidenceStateBadge,
  LegalStatusBadge,
  ManuscriptStatusBadge,
  MetricStateBadge,
  RequirementDecisionBadge,
} from '../../_components/framework-badges';

/**
 * 要求事項タブ（§6.3・§8.3）。
 *
 * 列は「適用判断」「内容評価（対応済み…。既存 SSBJ の評価）」「本文状態（原稿の工程）」を分ける。
 * 内容評価の AI 判定は「候補」と明示し、人の判定を優先する。未判定の要求事項は一覧から消さない。
 * 標準フィルタ（自分の担当／情報不足／レビュー待ち／差戻し／要再確認）は URL に持つ。
 */
export async function RequirementsTab({
  projectId,
  searchParams,
}: {
  projectId: string;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const { db, ctx } = await loadEnterpriseShell();
  const fw = typeof searchParams.fw === 'string' ? searchParams.fw : null;
  const filter = isRequirementFilter(searchParams.filter) ? searchParams.filter : null;
  const { detail, result, filteredRows, filterCounts } = await loadProjectRequirements(
    db,
    ctx,
    projectId,
    { projectFrameworkId: fw, filter },
  );
  const today = getReferenceDate();

  if (!result) {
    return (
      <Card>
        <EmptyState
          title="基準が登録されていません"
          description="このプロジェクトは社内 ESG 管理のみです。基準の要求事項はありません。"
        />
      </Card>
    );
  }

  const selected = result.framework;
  const hrefFor = (params: { fw?: string; filter?: string | null }) => {
    const search = new URLSearchParams();
    search.set('tab', 'requirements');
    search.set('fw', params.fw ?? selected.projectFramework.id);
    if (params.filter) search.set('filter', params.filter);
    return `/enterprise/disclosure-projects/${projectId}?${search.toString()}`;
  };
  const summary = result.summary;

  return (
    <div className="space-y-3">
      <nav aria-label="基準の切り替え" className="flex flex-wrap gap-2">
        {detail.frameworks.map((f) => {
          const active = f.projectFramework.id === selected.projectFramework.id;
          return (
            <Link
              key={f.projectFramework.id}
              href={hrefFor({ fw: f.projectFramework.id })}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-1.5 rounded-t4d border px-2.5 py-1.5 text-[12px]',
                active
                  ? 'border-brand-300 bg-brand-50 font-semibold text-brand-900'
                  : 'border-line bg-surface text-ink hover:border-brand-300',
              )}
            >
              {f.label}
              <LegalStatusBadge legal={f.legal} />
            </Link>
          );
        })}
      </nav>

      {result.mode === 'not_loaded' ? (
        <Card>
          <div className="flex items-start gap-2 p-4">
            <FileQuestion className="mt-0.5 size-5 text-[#8a5d00]" aria-hidden="true" />
            <div className="space-y-1 text-[12px]">
              <p className="text-[13px] font-semibold text-ink">要求事項は未収録（公開草案）</p>
              <p className="text-ink">
                「{selected.label}」は{selected.legal.label}
                の段階の版で、要求事項の本文は収録していません。
                草案の条文を推測で作らず、正式版の公表後に収録・検証して差し替えます。
              </p>
              {selected.legal.coverageNote && (
                <p className="text-ink-muted">{selected.legal.coverageNote}</p>
              )}
              <p className="text-ink-muted">
                この基準の原稿は準備として作成できますが、正式な準拠の完了とは表示しません。 SSBJ
                の原稿や定性情報を再利用する場合も、「再利用できる」ことと「この基準を満たす」ことは別に判断します。
              </p>
            </div>
          </div>
        </Card>
      ) : (
        <>
          <Card>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-[12px]">
              <span>
                適用確定済み <strong>{summary.applicableConfirmed}</strong> 項目中、承認済み{' '}
                <strong>{summary.approvedOfApplicable}</strong> 項目
              </span>
              <span>
                適用未判定 <strong>{summary.notAssessed}</strong> 件
              </span>
              <span className="text-ink-muted">
                対象外・非重要と判断 {summary.excludedDecided} 件（理由・判断者あり）
              </span>
              <span className="text-ink-muted">収録 {summary.total} 項目</span>
              {selected.legal.isSample && (
                <Badge tone="neutral">
                  <FlaskConical className="size-3" aria-hidden="true" />
                  サンプル（架空）の要求事項です
                </Badge>
              )}
            </div>
          </Card>

          <nav aria-label="標準フィルタ" className="flex flex-wrap items-center gap-1.5">
            <ListFilter className="size-3.5 text-ink-muted" aria-hidden="true" />
            <Link
              href={hrefFor({ filter: null })}
              aria-current={filter === null ? 'page' : undefined}
              className={cn(
                'rounded-t4d border px-2 py-1 text-[12px]',
                filter === null
                  ? 'border-brand-300 bg-brand-50 font-semibold text-brand-900'
                  : 'border-line bg-surface text-ink',
              )}
            >
              すべて（{result.rows.length}）
            </Link>
            {REQUIREMENT_FILTERS.map((key) => (
              <Link
                key={key}
                href={hrefFor({ filter: key })}
                aria-current={filter === key ? 'page' : undefined}
                className={cn(
                  'rounded-t4d border px-2 py-1 text-[12px]',
                  filter === key
                    ? 'border-brand-300 bg-brand-50 font-semibold text-brand-900'
                    : 'border-line bg-surface text-ink',
                )}
              >
                {REQUIREMENT_FILTER_LABELS[key]}（{filterCounts[key]}）
              </Link>
            ))}
          </nav>

          <Card className="overflow-hidden">
            <SectionTitle
              title={`要求事項（${filteredRows.length} 件${filter ? `／${REQUIREMENT_FILTER_LABELS[filter]}` : ''}）`}
            />
            {filteredRows.length === 0 ? (
              <EmptyState
                title="該当する要求事項はありません"
                description="フィルタを外すと全件を表示します。"
                action={
                  <Link
                    href={hrefFor({ filter: null })}
                    className="text-[12px] text-brand-800 underline"
                  >
                    フィルタを外す
                  </Link>
                }
              />
            ) : (
              <div className="t4d-scroll-x max-h-[70vh] overflow-y-auto">
                <Table>
                  <THead className="sticky top-0 z-10 bg-surface">
                    <TR>
                      <TH>基準・条項</TH>
                      <TH>テーマ</TH>
                      <TH>要求事項</TH>
                      <TH>適用判断</TH>
                      <TH>内容評価</TH>
                      <TH>本文状態</TH>
                      <TH>根拠の充足</TH>
                      <TH>数値の状態</TH>
                      <TH>担当</TH>
                      <TH>期限</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {filteredRows.map((row) => (
                      <TR key={row.item.id}>
                        <TD className="whitespace-nowrap align-top text-[12px] font-medium">
                          {row.item.code}
                          {row.isSample && (
                            <Badge tone="neutral" className="ml-1">
                              <FlaskConical className="size-3" aria-hidden="true" />
                              サンプル
                            </Badge>
                          )}
                        </TD>
                        <TD className="align-top text-[12px]">{row.item.section}</TD>
                        <TD className="min-w-[240px] max-w-[360px] align-top text-[12px]">
                          {selected.frameworkKey === 'ssbj' ? (
                            <Link
                              // プロジェクトの報告期間の評価を開く（ヘッダーで選んでいる期間ではなく）
                              href={`/enterprise/disclosures/ssbj/requirements/${row.item.id}?period=${detail.project.reportingPeriodId}`}
                              className="text-brand-800 hover:underline"
                            >
                              {row.item.questionText}
                            </Link>
                          ) : (
                            row.item.questionText
                          )}
                        </TD>
                        <TD className="min-w-[150px] align-top text-[12px]">
                          <RequirementDecisionBadge
                            kind={row.decision.kind}
                            label={row.decision.label}
                          />
                          {row.decision.excluded && (
                            <span className="mt-0.5 block text-[11px] text-ink-muted">
                              理由: {row.decision.reason}／判断: {row.decision.decidedByName ?? '—'}
                            </span>
                          )}
                          {row.decision.kind === 'not_assessed' && row.decision.note && (
                            <span className="mt-0.5 block text-[11px] text-ink-muted">
                              {row.decision.note}
                            </span>
                          )}
                        </TD>
                        <TD className="whitespace-nowrap align-top text-[12px]">
                          {row.contentEvaluation.source === 'ai_candidate' ? (
                            <span title="AI の判定は候補です。担当者の確認で確定します。">
                              <Badge tone="outline">
                                <ClipboardCheck className="size-3" aria-hidden="true" />
                                {row.contentEvaluation.label}
                              </Badge>
                              <span className="block text-[11px] text-ink-muted">
                                AI 候補・未確認
                              </span>
                            </span>
                          ) : (
                            <span
                              className={
                                row.contentEvaluation.source === 'none' ? 'text-ink-muted' : ''
                              }
                            >
                              {row.contentEvaluation.label}
                            </span>
                          )}
                        </TD>
                        <TD className="min-w-[140px] align-top text-[12px]">
                          <ManuscriptStatusBadge status={row.manuscript.status} />
                          {row.blocks.map((b) => (
                            <Link
                              key={b.id}
                              href={`/enterprise/disclosure-projects/${projectId}/blocks/${b.id}`}
                              className="mt-0.5 block text-[11px] text-brand-800 hover:underline"
                            >
                              {b.title}
                              {b.language === 'en' ? '（英語）' : ''}
                            </Link>
                          ))}
                        </TD>
                        <TD className="align-top">
                          <EvidenceStateBadge kind={row.evidence.kind} label={row.evidence.label} />
                        </TD>
                        <TD className="align-top">
                          <MetricStateBadge kind={row.metrics.kind} label={row.metrics.label} />
                        </TD>
                        <TD className="min-w-[120px] align-top text-[12px]">
                          {row.ownerLabel ?? '未定'}
                        </TD>
                        <TD
                          className={cn(
                            'whitespace-nowrap align-top text-[12px]',
                            isOverdue(row.dueDate, today) && row.manuscript.status !== 'approved'
                              ? 'text-danger'
                              : '',
                          )}
                        >
                          {formatJstDate(row.dueDate)}
                          {isOverdue(row.dueDate, today) &&
                            row.manuscript.status !== 'approved' && (
                              <span className="block text-[11px]">期限超過</span>
                            )}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
          </Card>
          <MoreInfo label="内容評価と本文状態の違い">
            <p>
              内容評価は既存の SSBJ
              評価（対応済み／おおむね対応／一部対応／未対応／未確認）で、原稿の工程（本文状態）とは別の値です。
              資料を登録しただけでは要求事項を対応済みにしません。
            </p>
          </MoreInfo>
        </>
      )}
    </div>
  );
}
