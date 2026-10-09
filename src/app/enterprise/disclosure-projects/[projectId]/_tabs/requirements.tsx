import Link from 'next/link';
import {
  AlertTriangle,
  ClipboardCheck,
  ClipboardPen,
  FileQuestion,
  FileSpreadsheet,
} from 'lucide-react';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { SegmentedFilter } from '@/components/shared/nav-tabs';
import { PageActions } from '@/components/shared/page-actions';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { MoreInfo } from '@/components/ui/more-info';
import { can } from '@/lib/authorization/can';
import { getReferenceDate } from '@/lib/clock';
import {
  OWNER_DUE_SOURCE_LABELS,
  REQUIREMENT_COVERAGE_CATEGORIES,
  REQUIREMENT_GAP_LABELS,
  countByCategory,
  type RequirementCoverageCategory,
} from '@/lib/domain/requirement-coverage';
import { formatJstDate, isOverdue } from '@/lib/format/datetime';
import { DEFAULT_PAGE_SIZES, parsePage, parsePageSize } from '@/lib/table/columns';
import {
  REQUIREMENT_DECISION_SOURCE_LABELS,
  REQUIREMENT_FILTERS,
  REQUIREMENT_FILTER_LABELS,
  isRequirementFilter,
  loadProjectRequirements,
  nameOf,
  type RequirementRow,
} from '@/lib/services/disclosure-project';
import { decisionHomeOf } from '@/lib/services/project-requirement-assessment';
import { exclusionNoteLimit } from '@/lib/services/requirement-exclusion';
import { loadEnterpriseShell } from '@/lib/services/shell';
import type { ActionSpec, MenuActionSpec } from '@/lib/ui/actions';
import { statusLabel } from '@/lib/ui/status/registry';
import { cn } from '@/lib/utils';
import {
  EvidenceStateBadge,
  ManuscriptStatusBadge,
  MetricStateBadge,
  RequirementDecisionBadge,
} from '../../_components/framework-badges';
import { AllRequirementsView } from '../requirements/_components/all-requirements-view';
import { exclusionActions } from '../requirements/_components/exclusion-action-specs';

/** すべての基準を並べる表示（?fw=all。NF-04） */
export const ALL_FRAMEWORKS_KEY = 'all';

export function isCoverageFilter(value: unknown): value is RequirementCoverageCategory {
  return (
    typeof value === 'string' &&
    (REQUIREMENT_COVERAGE_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * 承認まで進めない理由（展開行に出す。plan S1「展開行に阻害条件」）。
 * 値はサービスの判定（根拠の充足・数値の状態・適用判断・区分の理由）をそのまま使い、新しい規則を作らない
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
  if (row.coverage.category !== 'confirmed' && row.coverage.category !== 'excluded') {
    for (const reason of row.coverage.reasons) {
      const line = `区分（${statusLabel('requirementCoverage', row.coverage.category)}）: ${reason}`;
      if (!reasons.includes(line)) reasons.push(line);
    }
  }
  return reasons;
}

/** 対応表の出力（XLSX・CSV）。出力の権限があるときだけ */
function exportMenu(projectId: string, canExport: boolean): MenuActionSpec[] {
  if (!canExport) return [];
  const href = (format: 'xlsx' | 'csv') =>
    `/api/exports/requirement-matrix?project=${projectId}&format=${format}`;
  return [
    {
      kind: 'link',
      id: 'export-requirement-matrix-xlsx',
      label: '要求事項・情報対応表（XLSX・全基準）',
      icon: <FileSpreadsheet aria-hidden="true" />,
      href: href('xlsx'),
      download: true,
      group: 'export',
    },
    {
      kind: 'link',
      id: 'export-requirement-matrix-csv',
      label: '要求事項・情報対応表（CSV・全基準）',
      icon: <FileSpreadsheet aria-hidden="true" />,
      href: href('csv'),
      download: true,
      group: 'export',
    },
  ];
}

/**
 * 要求事項タブ（§6.3・§8.3。plan S1。トライアル対応 NF-01〜NF-04）。
 *
 * 列は「適用判断（と出所）」「区分（5 区分）」「本文状態（原稿の工程）」を分ける。区分は保存せず、
 * 要求事項・情報対応表・開示ホームと同じ関数で毎回導く。内容評価の AI 判定は「候補」と明示し、人の判定を優先する。
 * 未判定の要求事項は一覧から消さない。標準フィルタ・区分の絞り込み・基準の切り替えは URL に持つ。
 * 基準の切り替えの「すべての基準」（?fw=all）は全基準・全件の対応表（NF-04）。
 *
 * 一覧は DataTable（既定の列: 基準・条項・要求事項・適用判断・区分・本文状態・担当・期限。テーマ・内容評価・
 * 根拠の充足・数値の状態・不足・担当期限の出所は「列 ▾」）。SSBJ は 133 項目あるため 25 件ずつのページ送り。
 * 行の主操作: 承認待ちの対象外を承認できる人は「対象外を承認」、判断を記録できる基準（ESRS-40a など）の
 * 編集者は「判断を記録」、それ以外は「原稿を開く」。
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
  const coverage = isCoverageFilter(searchParams.coverage) ? searchParams.coverage : null;
  const showAll = fw === ALL_FRAMEWORKS_KEY;
  const { detail, result, filteredRows, filterCounts } = await loadProjectRequirements(
    db,
    ctx,
    projectId,
    { projectFrameworkId: showAll ? null : fw, filter },
  );
  const today = getReferenceDate();
  const base = `/enterprise/disclosure-projects/${projectId}`;
  const canWrite = can(ctx, 'enterprise.disclosure.write');
  const canApprove = can(ctx, 'enterprise.disclosure.approve');
  const canExport = can(ctx, 'enterprise.export.run');

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
  const hrefFor = (params: { fw?: string; filter?: string | null; coverage?: string | null }) => {
    const search = new URLSearchParams();
    search.set('tab', 'requirements');
    search.set('fw', params.fw ?? (showAll ? ALL_FRAMEWORKS_KEY : selected.projectFramework.id));
    const nextFilter = params.filter === undefined ? filter : params.filter;
    const nextCoverage = params.coverage === undefined ? coverage : params.coverage;
    if (nextFilter && params.fw === undefined) search.set('filter', nextFilter);
    if (nextCoverage && params.fw === undefined) search.set('coverage', nextCoverage);
    return `${base}?${search.toString()}`;
  };

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-2">
      {/* 基準ごとの法的な位置付け（公開草案・サンプルなど）は選ぶ前に読めるよう、名前に併記する */}
      <SegmentedFilter
        ariaLabel="基準の切り替え"
        current={showAll ? ALL_FRAMEWORKS_KEY : selected.projectFramework.id}
        items={[
          ...detail.frameworks.map((f) => ({
            key: f.projectFramework.id,
            label: `${f.label}（${f.legal.label}）`,
            href: hrefFor({ fw: f.projectFramework.id }),
          })),
          {
            key: ALL_FRAMEWORKS_KEY,
            label: 'すべての基準（要求事項・情報対応表）',
            href: hrefFor({ fw: ALL_FRAMEWORKS_KEY }),
          },
        ]}
      />
      <PageActions moreLabel="対応表を出力" more={exportMenu(projectId, canExport)} />
    </div>
  );

  if (showAll) {
    return (
      <div className="space-y-3">
        {header}
        <AllRequirementsView
          projectId={projectId}
          searchParams={searchParams}
          coverage={coverage}
          coverageHref={(key) => hrefFor({ coverage: key })}
        />
      </div>
    );
  }

  const summary = result.summary;
  const coverageRows = coverage
    ? filteredRows.filter((r) => r.coverage.category === coverage)
    : filteredRows;
  const coverageCounts = countByCategory(filteredRows.map((r) => r.coverage.category));
  const pageSize = parsePageSize(searchParams.size);
  const page = Math.min(
    parsePage(searchParams.page),
    Math.max(1, Math.ceil(coverageRows.length / pageSize)),
  );
  const pageRows = coverageRows.slice((page - 1) * pageSize, page * pageSize);
  const isSsbj = selected.frameworkKey === 'ssbj';
  const home = decisionHomeOf(selected);
  const overdue = (row: RequirementRow) =>
    isOverdue(row.dueDate, today) && row.manuscript.status !== 'approved';
  const noteLimit = exclusionNoteLimit(ctx);

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
          {row.isSample && <HonestyBadge kind="sample-master" className="ml-1" />}
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
          <Link
            href={`/enterprise/disclosure-projects/${projectId}/requirements/${row.item.id}`}
            className="text-small text-brand-800 hover:underline"
          >
            {row.item.questionText}
          </Link>
        ),
    },
    {
      key: 'decision',
      header: '適用判断',
      importance: 'primary',
      cell: (row) => (
        <span className="text-small">
          <RequirementDecisionBadge kind={row.decision.kind} label={row.decision.label} />
          {row.decision.exclusion && (
            <StatusBadge
              domain="exclusionApproval"
              value={row.decision.exclusion.state}
              className="ml-1"
            />
          )}
          {/* 判断の出所（SSBJ の評価・DMA・判断の記録）を小さく併記する（NF-01） */}
          <span className="mt-0.5 block text-caption text-ink-muted">
            出所: {REQUIREMENT_DECISION_SOURCE_LABELS[row.decision.source]}
          </span>
          {row.decision.reason && (row.decision.excluded || row.decision.exclusion !== null) && (
            <span className="mt-0.5 block text-caption text-ink-muted">
              理由: {row.decision.reason}／判断: {row.decision.decidedByName ?? '—'}
              {row.decision.approvedByName ? `／承認: ${row.decision.approvedByName}` : ''}
            </span>
          )}
          {row.decision.kind === 'not_assessed' && row.decision.note && (
            <span className="mt-0.5 block text-caption text-ink-muted">{row.decision.note}</span>
          )}
        </span>
      ),
    },
    {
      key: 'coverage',
      header: '区分',
      importance: 'primary',
      cell: (row) => (
        <StatusBadge
          domain="requirementCoverage"
          value={row.coverage.category}
          detail={row.coverage.reasons.join(' ')}
        />
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
      key: 'gaps',
      header: '不足',
      importance: 'detail',
      cell: (row) =>
        row.coverage.gaps.length === 0 ? (
          <span className="text-small text-ink-muted">—</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {row.coverage.gaps.map((gap) => (
              <Badge key={gap} tone="warning">
                <AlertTriangle className="size-3" aria-hidden="true" />
                {REQUIREMENT_GAP_LABELS[gap]}
              </Badge>
            ))}
          </span>
        ),
    },
    {
      key: 'ownerDue',
      header: '担当・期限（出所）',
      importance: 'detail',
      cell: (row) => (
        <span className="text-small">
          {nameOf(detail.members, row.ownerDue.ownerUserId) ?? row.ownerDue.ownerLabel ?? '未定'}
          <span className="text-ink-muted"> ／ {formatJstDate(row.ownerDue.dueDate)}</span>
          <span className="block text-caption text-ink-muted">
            出所: {OWNER_DUE_SOURCE_LABELS[row.ownerDue.source]}
          </span>
          {row.actionPlans.length > 0 && (
            <span className="block text-caption text-ink-muted">
              対応計画: {row.actionPlans.join('／')}
            </span>
          )}
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

  /** 行の操作（対象外の承認・判断の記録・原稿を開く・詳細） */
  const rowActionsOf = (row: RequirementRow) => {
    const detailHref = `/enterprise/disclosure-projects/${projectId}/requirements/${row.item.id}`;
    const exclusion = row.decision.exclusion;
    const ops =
      exclusion && row.decision.reason && home !== 'csrd'
        ? exclusionActions({
            fields: {
              projectId,
              itemId: row.item.id,
              returnTo: 'requirements',
              fw: selected.projectFramework.id,
              ...(home === 'ssbj'
                ? {
                    source: 'ssbj_assessment',
                    reportingPeriodId: detail.project.reportingPeriodId,
                  }
                : {
                    source: 'project_assessment',
                    projectFrameworkId: selected.projectFramework.id,
                  }),
            },
            state: exclusion.state,
            requestedBy: exclusion.requestedBy,
            // 承認待ちの判断は decision.kind が「未判定」になるため、判断の区分（exclusionDecision）から取る
            decision: row.decision.exclusionDecision ?? 'not_applicable',
            reason: row.decision.reason,
            frameworkLabel: selected.label,
            code: row.item.code,
            viewerId: ctx.userId,
            canWrite,
            canApprove,
            noteLimit,
            idSuffix: row.item.code,
          })
        : {};
    const ordered = [...row.blocks].sort((a, b) => Number(a.translation) - Number(b.translation));
    const openBlocks: MenuActionSpec[] = ordered.map((b) => ({
      kind: 'link' as const,
      id: `open-${b.id}`,
      label: `「${b.title}」${b.language === 'en' ? '（英語）' : ''}を開く`,
      href: `${base}/blocks/${b.id}`,
    }));
    const record: ActionSpec | undefined =
      home === 'project' && canWrite
        ? {
            kind: 'link',
            id: `record-${row.item.code}`,
            label: '判断を記録',
            icon: <ClipboardPen aria-hidden="true" />,
            href: `${detailHref}?new=1#assessment-panel`,
          }
        : undefined;
    const openDetail: MenuActionSpec = {
      kind: 'link',
      id: `detail-${row.item.code}`,
      label: '要求事項の詳細（プロジェクト）を開く',
      href: detailHref,
    };
    const firstBlock: ActionSpec | undefined = ordered[0]
      ? {
          kind: 'link',
          id: `open-${ordered[0].id}`,
          label: '原稿を開く',
          href: `${base}/blocks/${ordered[0].id}`,
        }
      : undefined;
    const primary = ops.approve ?? record ?? firstBlock;
    const items: MenuActionSpec[] = [
      ...(ops.returnBack ? [ops.returnBack] : []),
      ...(ops.request ? [ops.request] : []),
      ...(primary !== record && record ? [record] : []),
      ...openBlocks.filter((b) => !(primary === firstBlock && b.id === firstBlock?.id)),
      openDetail,
      ...(ops.withdraw ? [ops.withdraw] : []),
    ];
    return { rowLabel: row.item.code, primary, items };
  };

  return (
    <div className="space-y-3">
      {header}

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
              対象外・非重要と判断 {summary.excludedDecided} 件（理由・判断者・承認者あり）
            </span>
            <span className="text-ink-muted">収録 {summary.total} 項目</span>
            {selected.legal.isSample && (
              <span className="inline-flex items-center gap-1">
                <HonestyBadge kind="sample-master" />
                サンプル（架空）の要求事項です（基準の条文ではありません）
              </span>
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
          {/* 5 区分（スライド 5 の 4 区分＋未判定）。分母は上の絞り込みの結果（NF-03） */}
          <SegmentedFilter
            ariaLabel="区分の絞り込み"
            current={coverage ?? 'all'}
            items={[
              {
                key: 'all',
                label: '区分: すべて',
                href: hrefFor({ coverage: null }),
                count: filteredRows.length,
              },
              ...REQUIREMENT_COVERAGE_CATEGORIES.map((key) => ({
                key,
                label: statusLabel('requirementCoverage', key),
                href: hrefFor({ coverage: key }),
                count: coverageCounts[key],
              })),
            ]}
          />
          {!selected.legal.isPreparationOnly ? null : (
            <p className="text-caption text-ink-muted">
              {selected.legal.label}
              の基準は、人が確認しても「充足確認済み」にしません（上限は「追加確認が必要」）。
            </p>
          )}

          {coverageRows.length === 0 && (filter || coverage) ? (
            <EmptyState
              kind="filtered"
              size="compact"
              title={`「${[filter ? REQUIREMENT_FILTER_LABELS[filter] : null, coverage ? statusLabel('requirementCoverage', coverage) : null].filter(Boolean).join('・')}」に当たる要求事項はありません`}
              description="絞り込みを外すと全件を表示します。"
              resetHref={hrefFor({ filter: null, coverage: null })}
            />
          ) : (
            <DataTable
              id="project-requirements"
              caption={`要求事項（${coverageRows.length} 件${filter ? `／${REQUIREMENT_FILTER_LABELS[filter]}` : ''}${coverage ? `／${statusLabel('requirementCoverage', coverage)}` : ''}）`}
              columns={columns}
              rows={pageRows}
              getRowId={(row) => row.item.id}
              getRowLabel={(row) => row.item.code}
              getRowStatus={(row) => row.manuscript.status}
              searchParams={searchParams}
              basePath={base}
              search={false}
              page={{ page, pageSize, total: coverageRows.length, sizes: DEFAULT_PAGE_SIZES }}
              className="rounded-t4d-lg border border-line bg-surface"
              rowActions={rowActionsOf}
              expand={(row) => {
                // 承認まで進めない理由（根拠・数値・未判定・区分の理由）。無い行は展開しない
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
          <MoreInfo label="区分・内容評価・本文状態の違い">
            <p>
              区分（充足確認済み／追加確認が必要／未対応／未判定／対象外）は、判断・原稿・数値・根拠・人の評価から毎回導く値です。
              対象外・非重要は、理由があり別の人が承認したときだけ「対象外」として分母から外し、承認待ちは「未判定」として残します。
            </p>
            <p>
              内容評価は既存の SSBJ
              評価（対応済み／おおむね対応／一部対応／未対応／未確認）で、原稿の工程（本文状態）とは別の値です。
              資料を登録しただけでは要求事項を対応済みにしません。内容評価・根拠の充足・数値の状態・不足・担当期限の出所は「列」から表示できます。
            </p>
          </MoreInfo>
        </>
      )}
    </div>
  );
}
