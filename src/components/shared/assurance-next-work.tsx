import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, Play } from 'lucide-react';
import { AttentionStrip } from './attention-strip';
import { EmptyState } from './states';
import { Button } from '@/components/ui/button';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatJstDate } from '@/lib/format/datetime';
import { MY_WORK_VISIBLE } from '@/lib/ui/my-work';
import { cn } from '@/lib/utils';
import type { AssuranceAttentionItem, AssuranceWorkItem } from '@/lib/ui/assurance-work';

/**
 * 監査法人の Attention → Action（plan §1.14・S13・S22）。企業ホームの MyWork と同じ並び・同じ見た目
 * （要対応の帯 → 「自分が次に行う作業」の表＋primary「最初の作業を開く」1 つ）。
 * MyWork は企業の作業の種類（MyWorkKind）に型が結び付いているため、案件の作業は別の部品にした
 * （案件ホームと案件の概要の 2 画面が使う共通部品。型と並びは src/lib/ui/assurance-work.ts）。
 *
 * - primary は「最初の作業を開く」だけ（行のリンクは文字。行ごとに primary を並べない）
 * - 作業の無い役割（法人管理者・閲覧）には表を出さない
 * - Sign-off・受理などの確定はここから実行しない（開いた画面で人が押す）
 */
export function AssuranceNextWork({
  attention,
  items,
  showWork,
  className,
}: {
  attention: readonly AssuranceAttentionItem[];
  items: readonly AssuranceWorkItem[];
  /** 作業の表を出すか（作業の無い役割では false） */
  showWork: boolean;
  className?: string;
}) {
  const visible = items.slice(0, MY_WORK_VISIBLE);
  const first = visible[0];
  if (!showWork && attention.length === 0) return null;
  return (
    <div className={cn('space-y-2', className)} data-assurance-work="">
      <AttentionStrip items={attention} />
      {showWork && (
        <section
          aria-labelledby="assurance-work-title"
          className="rounded-t4d-lg border border-line bg-surface"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <h2 id="assurance-work-title" className="text-body font-semibold text-ink">
              自分が次に行う作業（{items.length} 件
              {items.length > visible.length ? `中 ${visible.length} 件を表示` : ''}）
            </h2>
            {first && (
              <Button variant="primary" size="sm" asChild>
                <Link href={first.href} data-t4d-shortcut="first-work">
                  <Play aria-hidden="true" />
                  最初の作業を開く
                </Link>
              </Button>
            )}
          </div>
          {visible.length === 0 ? (
            <EmptyState
              kind="done"
              size="compact"
              title="いま、あなたが次に行う作業はありません"
              description="資料依頼の回答・レビュー待ちの調書・Sign-off の抑止条件が発生すると、ここに理由とともに表示されます。"
            />
          ) : (
            <div className="t4d-scroll-x border-t border-line">
              <Table aria-label="自分が次に行う作業">
                <THead>
                  <TR>
                    <TH className="w-col-sm">作業</TH>
                    <TH>案件</TH>
                    <TH>期限</TH>
                    <TH>理由</TH>
                    <TH align="right">
                      <span className="sr-only">開く</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {visible.map((work) => (
                    <TR key={work.key} data-t4d-record="">
                      <TD className="font-medium">{work.verb}</TD>
                      <TD>
                        <div className="font-mono text-small">{work.target}</div>
                        <div className="text-caption text-ink-muted">{work.context}</div>
                      </TD>
                      <TD className="tnum whitespace-nowrap text-small">
                        {work.dueDate ? formatJstDate(work.dueDate) : '—'}
                        {work.daysUntilDue !== null && (
                          <span
                            className={cn(
                              'ml-1 text-caption',
                              work.daysUntilDue < 0 ? 'text-danger' : 'text-ink-muted',
                            )}
                          >
                            {work.daysUntilDue < 0
                              ? `（${-work.daysUntilDue} 日超過）`
                              : `（あと ${work.daysUntilDue} 日）`}
                          </span>
                        )}
                      </TD>
                      <TD className="text-small">{work.reason ?? '—'}</TD>
                      <TD align="right">
                        <Link
                          href={work.href}
                          aria-label={`${work.target}: ${work.ctaLabel}`}
                          className="inline-flex items-center gap-1 whitespace-nowrap text-small font-medium text-brand-700 hover:underline"
                        >
                          {work.ctaLabel}
                          <ArrowRight className="size-3" aria-hidden="true" />
                        </Link>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
