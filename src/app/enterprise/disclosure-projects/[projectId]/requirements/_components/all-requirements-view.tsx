import Link from 'next/link';
import { AlertTriangle, Info } from 'lucide-react';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { SegmentedFilter } from '@/components/shared/nav-tabs';
import { EmptyState } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import {
  REQUIREMENT_COVERAGE_CATEGORIES,
  countByCategory,
  type RequirementCoverageCategory,
} from '@/lib/domain/requirement-coverage';
import { formatJst, formatJstDate } from '@/lib/format/datetime';
import { DEFAULT_PAGE_SIZES, parsePage, parsePageSize } from '@/lib/table/columns';
import {
  loadRequirementMatrix,
  type RequirementMatrixRow,
} from '@/lib/services/requirement-matrix';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { statusLabel } from '@/lib/ui/status/registry';

/**
 * 要求事項タブの「すべての基準」（?fw=all。トライアル対応 NF-04 の画面）。
 *
 * 要求事項 1 件＝1 行で、全基準・全件（対象外・未判定・未対応も消さない）を並べる。行は出力（XLSX・CSV）と
 * 同じ loadRequirementMatrix の行（件数を食い違わせない）。書き込まない。
 * 基準ごとの件数は分母付き。要求事項が未収録の基準は「要求事項未収録のため算定しない」と示し、0 件として数えない。
 */
export async function AllRequirementsView({
  projectId,
  searchParams,
  coverage,
  coverageHref,
}: {
  projectId: string;
  searchParams: Record<string, string | string[] | undefined>;
  coverage: RequirementCoverageCategory | null;
  coverageHref: (key: RequirementCoverageCategory | null) => string;
}) {
  const { db, ctx } = await loadEnterpriseShell();
  const matrix = await loadRequirementMatrix(db, ctx, { projectId });
  const base = `/enterprise/disclosure-projects/${projectId}`;
  const counts = countByCategory(matrix.rows.map((r) => r.category));
  const rows = coverage ? matrix.rows.filter((r) => r.category === coverage) : matrix.rows;
  const pageSize = parsePageSize(searchParams.size);
  const page = Math.min(
    parsePage(searchParams.page),
    Math.max(1, Math.ceil(rows.length / pageSize)),
  );
  const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);

  const columns: DataTableColumn<RequirementMatrixRow>[] = [
    {
      key: 'code',
      header: '基準・条項',
      importance: 'primary',
      lockVisible: true,
      pinned: 'left',
      cell: (row) => (
        <span className="text-small">
          <span className="whitespace-nowrap font-medium">{row.code}</span>
          {row.isSample && <HonestyBadge kind="sample-master" className="ml-1" />}
          <span className="block text-caption text-ink-muted">
            {row.frameworkLabel}（{row.frameworkPositioning}）
          </span>
        </span>
      ),
    },
    {
      key: 'title',
      header: '要求事項',
      importance: 'primary',
      width: 'lg',
      cell: (row) => (
        <Link
          href={`/enterprise/disclosure-projects/${projectId}/requirements/${row.itemId}`}
          className="text-small text-brand-800 hover:underline"
        >
          {row.title}
        </Link>
      ),
    },
    {
      key: 'decision',
      header: '適用判断',
      importance: 'primary',
      cell: (row) => (
        <span className="text-small">
          {row.decisionLabel}
          <span className="block text-caption text-ink-muted">出所: {row.decisionSourceLabel}</span>
        </span>
      ),
    },
    {
      key: 'category',
      header: '区分',
      importance: 'primary',
      cell: (row) => (
        <StatusBadge
          domain="requirementCoverage"
          value={row.category}
          detail={row.reasons.join(' ')}
        />
      ),
    },
    {
      key: 'blocks',
      header: '原稿の節',
      importance: 'secondary',
      cell: (row) =>
        row.blocks.length === 0 ? (
          <span className="text-small text-ink-muted">—（原稿なし）</span>
        ) : (
          <span className="text-small">
            {row.blocks.map((b) => (
              <span key={b.blockId} className="block">
                {b.title}
                {b.translation ? '（翻訳版）' : ''}・{b.statusLabel}
              </span>
            ))}
          </span>
        ),
    },
    {
      key: 'ownerDue',
      header: '担当・期限（出所）',
      importance: 'secondary',
      cell: (row) => (
        <span className="text-small">
          {row.ownerName ?? '未定'}
          <span className="text-ink-muted"> ／ {formatJstDate(row.dueDate)}</span>
          <span className="block text-caption text-ink-muted">出所: {row.ownerDueSourceLabel}</span>
        </span>
      ),
    },
    {
      key: 'gaps',
      header: '不足',
      importance: 'detail',
      cell: (row) =>
        row.gapLabels.length === 0 ? (
          <span className="text-small text-ink-muted">—</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {row.gapLabels.map((gap) => (
              <Badge key={gap} tone="warning">
                <AlertTriangle className="size-3" aria-hidden="true" />
                {gap}
              </Badge>
            ))}
          </span>
        ),
    },
    {
      key: 'exclusion',
      header: '対象外の理由・判断者・承認者',
      importance: 'detail',
      cell: (row) =>
        row.exclusionReason === null ? (
          <span className="text-small text-ink-muted">—</span>
        ) : (
          <span className="text-small">
            {row.exclusionReason}
            <span className="block text-caption text-ink-muted">
              判断: {row.decidedByName ?? '—'}／承認:{' '}
              {row.approvedByName
                ? `${row.approvedByName}（${formatJst(row.approvedAt)}）`
                : '未承認'}
            </span>
          </span>
        ),
    },
    {
      key: 'crosswalk',
      header: '横断対応',
      importance: 'detail',
      cell: (row) =>
        row.crosswalk.length === 0 ? (
          <span className="text-small text-ink-muted">—</span>
        ) : (
          <span className="space-y-0.5 text-small">
            {row.crosswalk.map((c, index) => (
              <span
                key={`${c.counterpartCode ?? 'none'}-${index}`}
                className="flex items-center gap-1"
              >
                <StatusBadge domain="crosswalkRelation" value={c.relation} />
                {c.counterpartCode ?? '（対応先なし）'}
              </span>
            ))}
          </span>
        ),
    },
    {
      key: 'ai',
      header: 'AI の判定（候補）',
      importance: 'detail',
      cell: (row) =>
        row.aiCandidateLabel ? (
          <span className="text-small">
            {row.aiCandidateLabel}
            <span className="block text-caption text-ink-muted">AI 候補・未確認</span>
          </span>
        ) : (
          <span className="text-small text-ink-muted">—</span>
        ),
    },
  ];

  return (
    <div className="space-y-3">
      {/* 基準別の件数（分母付き。閉じない） */}
      <ul
        aria-label="基準別の件数"
        className="space-y-1 rounded-t4d border border-line bg-surface px-3 py-2 text-small"
      >
        {matrix.frameworks.map((f) => (
          <li key={f.frameworkVersionId} className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <span className="font-medium text-ink">
              {f.label}（{f.positioning}）
            </span>
            {f.isSample && <HonestyBadge kind="sample-master" />}
            {f.mode === 'not_loaded' ? (
              <span className="inline-flex items-center gap-1 text-ink-muted">
                <Info className="size-3.5" aria-hidden="true" />
                {f.notCalculatedReason}
              </span>
            ) : (
              <span className="text-ink-muted">
                分母 {f.total} 件:{' '}
                {REQUIREMENT_COVERAGE_CATEGORIES.map(
                  (c) => `${statusLabel('requirementCoverage', c)} ${f.counts[c]}`,
                ).join('／')}
              </span>
            )}
          </li>
        ))}
      </ul>

      <SegmentedFilter
        ariaLabel="区分の絞り込み"
        current={coverage ?? 'all'}
        items={[
          {
            key: 'all',
            label: '区分: すべて',
            href: coverageHref(null),
            count: matrix.rows.length,
          },
          ...REQUIREMENT_COVERAGE_CATEGORIES.map((key) => ({
            key,
            label: statusLabel('requirementCoverage', key),
            href: coverageHref(key),
            count: counts[key],
          })),
        ]}
      />

      {rows.length === 0 && coverage ? (
        <EmptyState
          kind="filtered"
          size="compact"
          title={`「${statusLabel('requirementCoverage', coverage)}」に当たる要求事項はありません`}
          description="絞り込みを外すと全件を表示します。"
          resetHref={coverageHref(null)}
        />
      ) : (
        <DataTable
          id="project-requirements-all"
          caption={`要求事項・情報対応表（全基準 ${rows.length} 件${coverage ? `／${statusLabel('requirementCoverage', coverage)}` : ''}）`}
          columns={columns}
          rows={pageRows}
          getRowId={(row) => row.itemId}
          getRowLabel={(row) => row.code}
          getRowStatus={(row) => row.category}
          searchParams={searchParams}
          basePath={base}
          search={false}
          page={{ page, pageSize, total: rows.length, sizes: DEFAULT_PAGE_SIZES }}
          className="rounded-t4d-lg border border-line bg-surface"
          rowActions={(row) => ({
            rowLabel: row.code,
            primary: {
              kind: 'link',
              id: `detail-${row.code}`,
              label: '詳細を開く',
              href: `${base}/requirements/${row.itemId}`,
            },
          })}
          expand={(row) =>
            row.category === 'confirmed' || row.category === 'excluded' ? null : (
              <ul className="space-y-0.5">
                {row.reasons.map((reason) => (
                  <li key={reason} className="flex items-start gap-1 text-ink">
                    <AlertTriangle
                      className="mt-0.5 size-3 shrink-0 text-warning-ink"
                      aria-hidden="true"
                    />
                    {reason}
                  </li>
                ))}
              </ul>
            )
          }
          empty={{
            noData: {
              title: '要求事項が収録された基準がありません',
              description: '基準の版と適用条件は「設定」タブで確認できます。',
              action: (
                <Link href={`${base}?tab=settings`} className="text-small text-brand-800 underline">
                  設定タブを開く
                </Link>
              ),
            },
          }}
        />
      )}
      <p className="text-caption text-ink-muted">
        社内資料です。承認は企業内の承認であり、第三者による保証ではありません。出力（XLSX）には対象外一覧・未対応一覧・基準別件数・基準横断・注記のシートが付きます。
      </p>
    </div>
  );
}
