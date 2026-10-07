import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatJstDate } from '@/lib/format/datetime';
import { MY_WORK_VISIBLE, type MyWorkModel } from '@/lib/ui/my-work';
import { cn } from '@/lib/utils';
import { AttentionStrip } from './attention-strip';
import { EmptyState } from './states';

/**
 * 役割別ホームの先頭（plan §1.3・§1.14・S2）: Attention（放置すると問題になる事実）→ Action（次にやること）。
 *
 * - primary は「最初の作業を開く」の 1 つだけ（行のリンクは文字。行ごとに primary を並べない）
 * - 行は 7 件まで。残りは「すべて見る」（行き先は呼び出し側が渡す）
 * - 閲覧者（自分が行う作業が無い役割）には Action を出さない
 * - 承認・確定は開いた画面で人が押す（ここから実行しない）
 */
export function MyWork({
  work,
  moreLinks = [],
  className,
}: {
  work: MyWorkModel;
  /** 「すべて見る」などの補助のリンク（例: 自分の原稿をすべて見る） */
  moreLinks?: Array<{ label: string; href: string }>;
  className?: string;
}) {
  if (work.profile === 'viewer' && work.attention.length === 0) return null;
  const visible = work.items.slice(0, MY_WORK_VISIBLE);
  const total = work.items.length;
  const first = visible[0];

  return (
    <div className={cn('space-y-2', className)} data-my-work={work.profile}>
      <AttentionStrip items={work.attention} />

      {work.profile !== 'viewer' && (
        <section
          aria-labelledby="my-work-title"
          className="rounded-t4d-lg border border-line bg-surface"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <h2 id="my-work-title" className="text-body font-semibold text-ink">
              自分が次に行う作業（{total} 件
              {total > visible.length ? `中 ${visible.length} 件を表示` : ''}）
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              {moreLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="inline-flex items-center gap-1 text-small text-brand-700 hover:underline"
                >
                  {link.label} <ArrowRight className="size-3" aria-hidden="true" />
                </Link>
              ))}
              {first && (
                <Button variant="primary" size="sm" asChild>
                  <Link href={first.cta.href} data-t4d-shortcut="first-work">
                    <Play aria-hidden="true" />
                    最初の作業を開く
                  </Link>
                </Button>
              )}
            </div>
          </div>
          {visible.length === 0 ? (
            <EmptyState
              kind="done"
              size="compact"
              title="いま、あなたが次に行う作業はありません"
              description="差戻し・レビューの依頼・資料依頼・取込の確認が発生すると、ここに理由とともに表示されます。"
            />
          ) : (
            <div className="t4d-scroll-x border-t border-line">
              <Table aria-label="自分が次に行う作業">
                <THead>
                  <TR>
                    <TH className="w-col-xs">作業</TH>
                    <TH>対象</TH>
                    <TH>期限</TH>
                    <TH>理由</TH>
                    <TH align="right">
                      <span className="sr-only">開く</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {visible.map((item) => (
                    <TR key={item.key} data-t4d-record="" data-work-kind={item.kind}>
                      <TD className="font-medium">{item.verb}</TD>
                      <TD>
                        <div className="font-medium">{item.target}</div>
                        {item.context && (
                          <div className="text-caption text-ink-muted">{item.context}</div>
                        )}
                      </TD>
                      <TD className="tnum whitespace-nowrap text-small">
                        {item.dueDate ? (
                          <>
                            {formatJstDate(item.dueDate)}
                            {item.daysUntilDue !== null && (
                              <span
                                className={cn(
                                  'ml-1 text-caption',
                                  item.daysUntilDue < 0 ? 'text-danger' : 'text-ink-muted',
                                )}
                              >
                                {item.daysUntilDue < 0
                                  ? `（${-item.daysUntilDue} 日超過）`
                                  : `（あと ${item.daysUntilDue} 日）`}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-ink-muted">—</span>
                        )}
                      </TD>
                      <TD className="max-w-col-lg text-small">
                        {item.reason ?? <span className="text-ink-muted">—</span>}
                      </TD>
                      <TD align="right">
                        <Link
                          href={item.cta.href}
                          aria-label={`${item.target}: ${item.cta.label}`}
                          className="inline-flex items-center gap-1 whitespace-nowrap text-small font-medium text-brand-700 hover:underline"
                        >
                          {item.cta.label}
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
