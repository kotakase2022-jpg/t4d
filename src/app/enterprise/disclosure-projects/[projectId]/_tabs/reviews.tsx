import Link from 'next/link';
import { ClipboardCheck, Info } from 'lucide-react';
import { SectionTitle } from '@/components/shared/page-header';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { AuthorizationError } from '@/lib/authorization/can';
import { REVIEW_REQUEST_STATUS_LABELS } from '@/lib/domain/disclosure-status';
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
 * レビュー・承認タブ: 依頼ごとの審査対象の版・依頼者・レビュー担当・最終承認者と記録。
 * 自分の段階の依頼を先頭に出す（§6.9「自分に割り当てられた版を優先」）。
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
      return <PermissionDeniedState description="レビューを見るには、開示の閲覧権限が必要です。" />;
    }
    throw error;
  }

  const counts = Object.fromEntries(
    STATUS_FILTERS.map((s) => [s, items.filter((i) => i.status === s).length]),
  ) as Record<ReviewRequestStatus, number>;
  const visible = (status ? items.filter((i) => i.status === status) : items).sort(
    (a, b) => Number(b.myStage !== null) - Number(a.myStage !== null),
  );
  const base = `/enterprise/disclosure-projects/${projectId}?tab=reviews`;

  return (
    <div className="space-y-3">
      <p className="flex items-start gap-1 text-[12px] text-ink-muted">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        社内のレビュー・承認の記録です（第三者保証ではありません）。規則は依頼時点で固定し、後から変わりません。
      </p>
      <nav aria-label="レビューの絞り込み" className="flex flex-wrap items-center gap-1.5">
        <Link
          href={base}
          aria-current={status === null ? 'page' : undefined}
          className={`rounded-t4d border px-2 py-1 text-[12px] ${
            status === null
              ? 'border-brand-300 bg-brand-100 font-medium text-brand-900'
              : 'border-line text-ink hover:bg-brand-50'
          }`}
        >
          すべて（{items.length}）
        </Link>
        {STATUS_FILTERS.map((s) => (
          <Link
            key={s}
            href={`${base}&rstatus=${s}`}
            aria-current={status === s ? 'page' : undefined}
            className={`rounded-t4d border px-2 py-1 text-[12px] ${
              status === s
                ? 'border-brand-300 bg-brand-100 font-medium text-brand-900'
                : 'border-line text-ink hover:bg-brand-50'
            }`}
          >
            {REVIEW_REQUEST_STATUS_LABELS[s]}（{counts[s]}）
          </Link>
        ))}
      </nav>

      <Card className="overflow-hidden">
        <SectionTitle title={`レビュー依頼（${visible.length}）`} />
        {visible.length === 0 ? (
          <EmptyState
            title="レビュー依頼はありません"
            description="原稿の画面で「レビュー依頼」を押すと、ここに並びます。"
            icon={<ClipboardCheck className="size-5" aria-hidden="true" />}
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>節</TH>
                  <TH>審査する版</TH>
                  <TH>状態</TH>
                  <TH>依頼者</TH>
                  <TH>レビュー担当</TH>
                  <TH>最終承認者</TH>
                  <TH>記録</TH>
                </TR>
              </THead>
              <TBody>
                {visible.map((item) => (
                  <TR key={item.id}>
                    <TD>
                      <Link
                        href={`/enterprise/disclosure-projects/${projectId}/blocks/${item.blockId}`}
                        className="font-medium text-brand-700 underline-offset-2 hover:underline"
                      >
                        {item.blockTitle}
                      </Link>
                      {item.myStage && (
                        <Badge tone="brand" className="ml-1">
                          {item.myStage === 'review' ? 'あなたのレビュー待ち' : 'あなたの承認待ち'}
                        </Badge>
                      )}
                    </TD>
                    <TD className="tnum">版 {item.targetVersionNo ?? '—'}</TD>
                    <TD>
                      <ReviewRequestStatusBadge status={item.status} />
                    </TD>
                    <TD>{item.requestedByName}</TD>
                    <TD>{item.reviewerName}</TD>
                    <TD>{item.approverName}</TD>
                    <TD className="min-w-[260px]">
                      <details>
                        <summary className="cursor-pointer text-[12px] text-brand-700">
                          {item.events.length} 件の記録（{formatJst(item.updatedAt)} 更新）
                        </summary>
                        <ol className="mt-1 space-y-0.5 text-[11px] text-ink-muted">
                          {item.events.map((e) => (
                            <li key={e.id}>
                              {formatJst(e.createdAt)} {e.label}（{e.stageLabel}） {e.actorName}
                              {e.reason ? ` ／ 理由: ${e.reason}` : ''}
                              {e.paragraphId ? ` ／ 段落 ${e.paragraphId}` : ''}
                            </li>
                          ))}
                        </ol>
                        <p className="mt-1 text-[11px] text-ink-muted">
                          規則: {item.policyVersion}
                        </p>
                      </details>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}
