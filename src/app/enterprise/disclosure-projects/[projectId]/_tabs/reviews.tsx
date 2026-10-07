import Link from 'next/link';
import { Hourglass, Info } from 'lucide-react';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { SegmentedFilter } from '@/components/shared/nav-tabs';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { AuthorizationError } from '@/lib/authorization/can';
import { REVIEW_REQUEST_STATUS_LABELS, reviewPolicyLabel } from '@/lib/domain/disclosure-status';
import { formatJst } from '@/lib/format/datetime';
import { listProjectReviews, type ReviewListItem } from '@/lib/services/disclosure-review';
import { loadEnterpriseShell } from '@/lib/services/shell';
import type { ReviewRequestStatus } from '@/types/domain';
import { ReviewRequestStatusBadge } from '../blocks/status-badges';

const STATUS_FILTERS: ReviewRequestStatus[] = [
  'open',
  'reviewed',
  'returned',
  'approved',
  'withdrawn',
];

function isStatus(value: unknown): value is ReviewRequestStatus {
  return typeof value === 'string' && (STATUS_FILTERS as string[]).includes(value);
}

/**
 * レビュー・承認タブ: 依頼ごとの審査対象の版・依頼者・レビュー担当・最終承認者と記録（plan S1）。
 * 自分の段階の依頼を先頭に出す（§6.9「自分に割り当てられた版を優先」）。
 * 一覧は DataTable。依頼ごとの記録（イベントと規則）は展開行に置く（行の中の折りたたみをやめる）。
 */
export async function ReviewsTab({
  projectId,
  searchParams,
}: {
  projectId: string;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const { db, ctx } = await loadEnterpriseShell();
  const status = isStatus(searchParams.rstatus) ? searchParams.rstatus : null;

  let items: ReviewListItem[];
  try {
    items = await listProjectReviews(db, ctx, projectId);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return (
        <PermissionDeniedState
          description="レビューを見るには、開示の閲覧権限が必要です。"
          permission="enterprise.disclosure.read"
        />
      );
    }
    throw error;
  }

  const counts = Object.fromEntries(
    STATUS_FILTERS.map((s) => [s, items.filter((i) => i.status === s).length]),
  ) as Record<ReviewRequestStatus, number>;
  const visible = (status ? items.filter((i) => i.status === status) : items).sort(
    (a, b) => Number(b.myStage !== null) - Number(a.myStage !== null),
  );
  const projectPath = `/enterprise/disclosure-projects/${projectId}`;
  const base = `${projectPath}?tab=reviews`;

  const columns: DataTableColumn<ReviewListItem>[] = [
    {
      key: 'block',
      header: '節',
      importance: 'primary',
      lockVisible: true,
      cell: (item) => (
        <>
          <Link
            href={`${projectPath}/blocks/${item.blockId}`}
            className="font-medium text-brand-700 underline-offset-2 hover:underline"
          >
            {item.blockTitle}
          </Link>
          {item.myStage && (
            <Badge tone="brand" className="ml-1">
              <Hourglass className="size-3" aria-hidden="true" />
              {item.myStage === 'review' ? 'あなたのレビュー待ち' : 'あなたの承認待ち'}
            </Badge>
          )}
        </>
      ),
    },
    {
      key: 'version',
      header: '審査する版',
      importance: 'primary',
      cell: (item) => <span className="tnum">版 {item.targetVersionNo ?? '—'}</span>,
    },
    {
      key: 'status',
      header: '状態',
      importance: 'primary',
      cell: (item) => <ReviewRequestStatusBadge status={item.status} />,
    },
    {
      key: 'requestedBy',
      header: '依頼者',
      importance: 'secondary',
      cell: (item) => item.requestedByName,
    },
    {
      key: 'reviewer',
      header: 'レビュー担当',
      importance: 'secondary',
      cell: (item) => item.reviewerName,
    },
    {
      key: 'approver',
      header: '最終承認者',
      importance: 'secondary',
      cell: (item) => item.approverName,
    },
    {
      key: 'updated',
      header: '更新',
      importance: 'detail',
      cell: (item) => (
        <span className="whitespace-nowrap text-small">{formatJst(item.updatedAt)}</span>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <p className="flex items-start gap-1 text-small text-ink-muted">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        社内のレビュー・承認の記録です（第三者保証ではありません）。規則は依頼時点で固定し、後から変わりません。
      </p>
      <SegmentedFilter
        ariaLabel="レビューの絞り込み"
        current={status ?? 'all'}
        items={[
          { key: 'all', label: 'すべて', href: base, count: items.length },
          ...STATUS_FILTERS.map((s) => ({
            key: s,
            label: REVIEW_REQUEST_STATUS_LABELS[s],
            href: `${base}&rstatus=${s}`,
            count: counts[s],
          })),
        ]}
      />

      {visible.length === 0 && status !== null && items.length > 0 ? (
        // 絞り込みで 0 件になっただけのときは、依頼が無いとは言わず、絞り込みを外す操作を示す
        <EmptyState
          kind="not-applicable"
          size="compact"
          title="条件に合うレビュー依頼はありません"
          description={`「${REVIEW_REQUEST_STATUS_LABELS[status]}」の依頼はありません。ほかの状態の依頼は ${items.length} 件あります。`}
          action={
            <Link href={base} className="text-small text-brand-800 underline">
              絞り込みを外す（すべて表示）
            </Link>
          }
        />
      ) : (
        <DataTable
          id="project-reviews"
          caption={`レビュー依頼（${visible.length}）`}
          columns={columns}
          rows={visible}
          getRowId={(item) => item.id}
          getRowLabel={(item) => `${item.blockTitle}（版 ${item.targetVersionNo ?? '—'}）`}
          getRowStatus={(item) => item.status}
          searchParams={searchParams}
          basePath={projectPath}
          search={false}
          className="rounded-t4d-lg border border-line bg-surface"
          expand={(item) => (
            <div className="space-y-1">
              <p className="font-medium text-ink">
                {item.events.length} 件の記録（{formatJst(item.updatedAt)} 更新）
              </p>
              <ol className="space-y-0.5 text-caption text-ink-muted">
                {item.events.map((e) => (
                  <li key={e.id}>
                    {formatJst(e.createdAt)} {e.label}（{e.stageLabel}） {e.actorName}
                    {e.reason ? ` ／ 理由: ${e.reason}` : ''}
                    {e.paragraphId ? ' ／ 段落を指定' : ''}
                  </li>
                ))}
              </ol>
              <p className="text-caption text-ink-muted">
                規則: {reviewPolicyLabel(item.policyVersion)}
              </p>
            </div>
          )}
          empty={{
            noData: {
              title: 'レビュー依頼はありません',
              description: '原稿の画面で「レビュー依頼」を押すと、ここに並びます。',
              action: (
                <Link
                  href={`${projectPath}?tab=manuscripts`}
                  className="text-small text-brand-800 underline"
                >
                  原稿の一覧を開く
                </Link>
              ),
            },
          }}
        />
      )}
    </div>
  );
}
