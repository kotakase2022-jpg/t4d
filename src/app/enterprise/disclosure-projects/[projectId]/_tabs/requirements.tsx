import Link from 'next/link';
import { AlertTriangle, ClipboardCheck, FileQuestion, FlaskConical } from 'lucide-react';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { SegmentedFilter } from '@/components/shared/nav-tabs';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { MoreInfo } from '@/components/ui/more-info';
import { getReferenceDate } from '@/lib/clock';
import { formatJstDate, isOverdue } from '@/lib/format/datetime';
import { DEFAULT_PAGE_SIZES, parsePage, parsePageSize } from '@/lib/table/columns';
import {
  REQUIREMENT_FILTERS,
  REQUIREMENT_FILTER_LABELS,
  isRequirementFilter,
  loadProjectRequirements,
  type RequirementRow,
} from '@/lib/services/disclosure-project';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { cn } from '@/lib/utils';
import {
  EvidenceStateBadge,
  ManuscriptStatusBadge,
  MetricStateBadge,
  RequirementDecisionBadge,
} from '../../_components/framework-badges';

/**
 * 承認まで進めない理由（展開行に出す。plan S1「展開行に阻害条件」）。
 * 値はサービスの判定（根拠の充足・数値の状態・適用判断）をそのまま使い、新しい規則を作らない
 */
function blockingReasons(row: RequirementRow): string[] {
  const reasons: string[] = [];
  if (row.decision.kind === 'not_assessed') {
    reasons.push(
      `適用判断: ${row.decision.label}${row.decision.note ? `（${row.decision.note}）` : ''}`,
    );
  }
  if (row.evidence.kind === 'none' || row.evidence.kind === 'prior_only') {
    reasons.push(`根拠の充足: ${row.evidence.label}`);
  }
  if (
    row.metrics.kind === 'stale' ||
    row.metrics.kind === 'unapproved' ||
    row.metrics.kind === 'missing_value'
  ) {
    reasons.push(`数値の状態: ${row.metrics.label}`);
  }
  return reasons;
}

/**
 * 要求事項タブ（§6.3・§8.3。plan S1）。
 *
 * 列は「適用判断」「内容評価（対応済み…。既存 SSBJ の評価）」「本文状態（原稿の工程）」を分ける。
 * 内容評価の AI 判定は「候補」と明示し、人の判定を優先する。未判定の要求事項は一覧から消さない。
 * 標準フィルタ（自分の担当／情報不足／レビュー待ち／差戻し／要再確認）と基準の切り替えは URL に持つ。
 *
 * 一覧は DataTable（既定の列: 基準・条項・要求事項・適用判断・本文状態・担当・期限。テーマ・内容評価・
 * 根拠の充足・数値の状態は「列 ▾」）。SSBJ は 133 項目あるため 25 件ずつのページ送りにする（plan §1.12-5）。
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
  const base = `/enterprise/disclosure-projects/${projectId}`;

  if (!result) {
    return (
      <EmptyState
        kind="not-applicable"
        title="基準が登録されていません"
        description="このプロジェクトは社内 ESG 管理のみです。基準の要求事項はありません。"
      />
    );
  }

  const selected = result.framework;
  // 絞り込み・基準の切り替えではページを 1 へ戻す（page を引き継がない）
  const hrefFor = (params: { fw?: string; filter?: string | null }) => {
    const search = new URLSearchParams();
    search.set('tab', 'requirements');
    search.set('fw', params.fw ?? selected.projectFramework.id);
    if (params.filter) search.set('filter', params.filter);
    return `${base}?${search.toString()}`;
  };
  const summary = result.summary;
  const pageSize = parsePageSize(searchParams.size);
  const page = Math.min(
    parsePage(searchParams.page),
    Math.max(1, Math.ceil(filteredRows.length / pageSize)),
  );
  const pageRows = filteredRows.slice((page - 1) * pageSize, page * pageSize);
  const isSsbj = selected.frameworkKey === 'ssbj';
  const overdue = (row: RequirementRow) =>
    isOverdue(row.dueDate, today) && row.manuscript.status !== 'approved';

  const columns: DataTableColumn<RequirementRow>[] = [
    {
      key: 'code',
      header: '基準・条項',
      importance: 'primary',
      lockVisible: true,
      pinned: 'left',
      cell: (row) => (
        <span className="whitespace-nowrap text-small font-medium">
          {row.item.code}
          {row.isSample && (
            <Badge tone="neutral" className="ml-1">
              <FlaskConical className="size-3" aria-hidden="true" />
              サンプル
            </Badge>
          )}
        </span>
      ),
    },
    {
      key: 'question',
      header: '要求事項',
      importance: 'primary',
      width: 'lg',
      cell: (row) =>
        isSsbj ? (
          <Link
            // プロジェクトの報告期間の評価を開く（ヘッダーで選んでいる期間ではなく）
            href={`/enterprise/disclosures/ssbj/requirements/${row.item.id}?period=${detail.project.reportingPeriodId}`}
            className="text-small text-brand-800 hover:underline"
          >
            {row.item.questionText}
          </Link>
        ) : (
          <span className="text-small">{row.item.questionText}</span>
        ),
    },
    {
      key: 'decision',
      header: '適用判断',
      importance: 'primary',
      cell: (row) => (
        <span className="text-small">
          <RequirementDecisionBadge kind={row.decision.kind} label={row.decision.label} />
          {row.decision.excluded && (
            <span className="mt-0.5 block text-caption text-ink-muted">
              理由: {row.decision.reason}／判断: {row.decision.decidedByName ?? '—'}
            </span>
          )}
          {row.decision.kind === 'not_assessed' && row.decision.note && (
            <span className="mt-0.5 block text-caption text-ink-muted">{row.decision.note}</span>
          )}
        </span>
      ),
    },
    {
      key: 'manuscript',
      header: '本文状態',
      importance: 'primary',
      // 節の名前は文字で示し、開く操作は行の「原稿を開く」にまとめる（同じ行き先のリンクを重ねない。§1.12-7）
      cell: (row) => (
        <span className="text-small">
          <ManuscriptStatusBadge status={row.manuscript.status} />
          {row.blocks.map((b) => (
            <span key={b.id} className="mt-0.5 block text-caption text-ink-muted">
              {b.title}
              {b.language === 'en' ? '（英語）' : ''}
            </span>
          ))}
        </span>
      ),
    },
    {
      key: 'owner',
      header: '担当',
      importance: 'secondary',
      cell: (row) => <span className="text-small">{row.ownerLabel ?? '未定'}</span>,
    },
    {
      key: 'due',
      header: '期限',
      importance: 'secondary',
      cell: (row) => (
        <span
          className={cn('whitespace-nowrap text-small', overdue(row) ? 'text-danger' : undefined)}
        >
          {formatJstDate(row.dueDate)}
          {overdue(row) && <span className="block text-caption">期限超過</span>}
        </span>
      ),
    },
    {
      key: 'theme',
      header: 'テーマ',
      importance: 'detail',
      cell: (row) => <span className="text-small">{row.item.section}</span>,
    },
    {
      key: 'evaluation',
      header: '内容評価',
      importance: 'detail',
      cell: (row) =>
        row.contentEvaluation.source === 'ai_candidate' ? (
          <span className="whitespace-nowrap text-small">
            <Badge tone="outline">
              <ClipboardCheck className="size-3" aria-hidden="true" />
              {row.contentEvaluation.label}
            </Badge>
            <span className="block text-caption text-ink-muted">AI 候補・未確認</span>
            <span className="sr-only">（AI の判定は候補です。担当者の確認で確定します）</span>
          </span>
        ) : (
          <span
            className={cn(
              'whitespace-nowrap text-small',
              row.contentEvaluation.source === 'none' && 'text-ink-muted',
            )}
          >
            {row.contentEvaluation.label}
          </span>
        ),
    },
    {
      key: 'evidence',
      header: '根拠の充足',
      importance: 'detail',
      cell: (row) => <EvidenceStateBadge kind={row.evidence.kind} label={row.evidence.label} />,
    },
    {
      key: 'metrics',
      header: '数値の状態',
      importance: 'detail',
      cell: (row) => <MetricStateBadge kind={row.metrics.kind} label={row.metrics.label} />,
    },
  ];

  return (
    <div className="space-y-3">
      {/* 基準ごとの法的な位置付け（公開草案・サンプルなど）は選ぶ前に読めるよう、名前に併記する */}
      <SegmentedFilter
        ariaLabel="基準の切り替え"
        current={selected.projectFramework.id}
        items={detail.frameworks.map((f) => ({
          key: f.projectFramework.id,
          label: `${f.label}（${f.legal.label}）`,
          href: hrefFor({ fw: f.projectFramework.id }),
        }))}
      />

      {result.mode === 'not_loaded' ? (
        <Section title="要求事項は未収録（公開草案）" divider="none">
          <div className="flex items-start gap-2">
            <FileQuestion className="mt-0.5 size-5 text-warning-ink" aria-hidden="true" />
            <div className="space-y-1 text-small">
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
        </Section>
      ) : (
        <>
          {/* 分母つきの主要数値（閉じない。§10.4） */}
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-t4d border border-line bg-surface px-3 py-2 text-small">
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
          </p>

          <SegmentedFilter
            ariaLabel="標準フィルタ"
            current={filter ?? 'all'}
            items={[
              {
                key: 'all',
                label: 'すべて',
                href: hrefFor({ filter: null }),
                count: result.rows.length,
              },
              ...REQUIREMENT_FILTERS.map((key) => ({
                key,
                label: REQUIREMENT_FILTER_LABELS[key],
                href: hrefFor({ filter: key }),
                count: filterCounts[key],
              })),
            ]}
          />

          {filteredRows.length === 0 && filter ? (
            <EmptyState
              kind="filtered"
              size="compact"
              title={`「${REQUIREMENT_FILTER_LABELS[filter]}」に当たる要求事項はありません`}
              description="絞り込みを外すと全件を表示します。"
              resetHref={hrefFor({ filter: null })}
            />
          ) : (
            <DataTable
              id="project-requirements"
              caption={`要求事項（${filteredRows.length} 件${filter ? `／${REQUIREMENT_FILTER_LABELS[filter]}` : ''}）`}
              columns={columns}
              rows={pageRows}
              getRowId={(row) => row.item.id}
              getRowLabel={(row) => row.item.code}
              getRowStatus={(row) => row.manuscript.status}
              searchParams={searchParams}
              basePath={base}
              search={false}
              page={{ page, pageSize, total: filteredRows.length, sizes: DEFAULT_PAGE_SIZES }}
              className="rounded-t4d-lg border border-line bg-surface"
              rowActions={(row) => {
                // 行の主操作は「原稿を開く」（元の節を優先）。翻訳版など残りの節は「操作 ▾」から開く
                const ordered = [...row.blocks].sort(
                  (a, b) => Number(a.translation) - Number(b.translation),
                );
                const [first, ...rest] = ordered;
                if (!first) return null;
                return {
                  rowLabel: row.item.code,
                  primary: {
                    kind: 'link',
                    id: `open-${first.id}`,
                    label: '原稿を開く',
                    href: `${base}/blocks/${first.id}`,
                  },
                  items: rest.map((b) => ({
                    kind: 'link' as const,
                    id: `open-${b.id}`,
                    label: `「${b.title}」${b.language === 'en' ? '（英語）' : ''}を開く`,
                    href: `${base}/blocks/${b.id}`,
                  })),
                };
              }}
              expand={(row) => {
                // 承認まで進めない理由（根拠・数値・未判定）。無い行は展開しない
                const reasons = blockingReasons(row);
                return reasons.length === 0 ? null : (
                  <ul className="space-y-0.5">
                    {reasons.map((reason) => (
                      <li key={reason} className="flex items-start gap-1 text-ink">
                        <AlertTriangle
                          className="mt-0.5 size-3 shrink-0 text-warning-ink"
                          aria-hidden="true"
                        />
                        {reason}
                      </li>
                    ))}
                  </ul>
                );
              }}
              empty={{
                noData: {
                  title: 'この基準の要求事項はありません',
                  description: '基準の版と適用条件は「設定」タブで確認できます。',
                  action: (
                    <Link
                      href={`${base}?tab=settings`}
                      className="text-small text-brand-800 underline"
                    >
                      設定タブを開く
                    </Link>
                  ),
                },
              }}
            />
          )}
          <MoreInfo label="内容評価と本文状態の違い">
            <p>
              内容評価は既存の SSBJ
              評価（対応済み／おおむね対応／一部対応／未対応／未確認）で、原稿の工程（本文状態）とは別の値です。
              資料を登録しただけでは要求事項を対応済みにしません。内容評価・根拠の充足・数値の状態は「列」から表示できます。
            </p>
          </MoreInfo>
        </>
      )}
    </div>
  );
}
