'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, CheckCheck } from 'lucide-react';
import { SemanticBadge } from '@/components/shared/status-badge';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';

/** サーバーで整形した通知 1 件（日時は formatJst 済み、区分はラベル済み） */
export interface NotificationRow {
  id: string;
  categoryLabel: string;
  title: string;
  body: string | null;
  href: string | null;
  createdAtText: string;
  read: boolean;
}

type ReadIntent = { kind: 'one'; id: string } | { kind: 'all' };

/**
 * 通知の一覧と既読の操作（plan §1.18 Optimistic UI・C07）。
 *
 * 「既読にする」を押したら、サーバーの応答を待たずに未読の印とボタンを消す（useOptimistic）。
 * 既読は本人だけに関わる取り消しの要らない操作なので、即時反映にしてよい（業務データの状態遷移には使わない）。
 * 保存に失敗したときは、再描画でサーバーの状態（未読のまま）に戻る。
 * 「すべて既読にする」も確認を挟まない（元に戻す必要の無い、本人だけの操作）。
 *
 * 一覧はカードではなく表（状態・区分・件名・受信日時・操作）にして、1 画面で多く見渡せるようにする。
 */
export function NotificationList({
  rows,
  markReadAction,
  markAllReadAction,
  empty,
  unreadTotal,
}: {
  rows: NotificationRow[];
  markReadAction: (formData: FormData) => Promise<void>;
  markAllReadAction: () => Promise<void>;
  empty: React.ReactNode;
  /** ページ送りで表に出ていない分も含めた未読の数（省略時は表の中の未読の数） */
  unreadTotal?: number;
}) {
  const [optimisticRows, markOptimistic] = React.useOptimistic<NotificationRow[], ReadIntent>(
    rows,
    (state, intent) =>
      state.map((row) =>
        intent.kind === 'all' || row.id === intent.id ? { ...row, read: true } : row,
      ),
  );
  // 「すべて既読にする」はページ外の未読も既読にするので、押した時点で件数を 0 にする
  const [markedAll, setMarkedAll] = React.useOptimistic(false, (_state, next: boolean) => next);
  const unreadOnPage = rows.filter((row) => !row.read).length;
  const markedOnPage = unreadOnPage - optimisticRows.filter((row) => !row.read).length;
  const unreadCount = markedAll ? 0 : Math.max(0, (unreadTotal ?? unreadOnPage) - markedOnPage);

  return (
    <div className="space-y-2">
      {unreadCount > 0 && (
        <form
          action={async () => {
            markOptimistic({ kind: 'all' });
            setMarkedAll(true);
            await markAllReadAction();
          }}
          className="flex justify-end"
        >
          <SubmitButton size="sm" variant="secondary" icon={<CheckCheck aria-hidden="true" />}>
            すべて既読にする（{unreadCount}）
          </SubmitButton>
        </form>
      )}
      {optimisticRows.length === 0 ? (
        empty
      ) : (
        <div className="t4d-scroll-x rounded-t4d border border-line">
          <Table aria-label="通知">
            <THead>
              <TR>
                <TH className="w-col-xs">状態</TH>
                <TH className="w-col-xs">区分</TH>
                <TH>件名</TH>
                <TH className="w-col-sm">受信日時</TH>
                <TH align="right">
                  <span className="sr-only">操作</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {optimisticRows.map((n) => (
                <TR key={n.id} data-t4d-record="" data-read={n.read ? 'true' : 'false'}>
                  <TD>
                    {n.read ? (
                      <span className="text-caption text-ink-muted">既読</span>
                    ) : (
                      <SemanticBadge semantic="pending" label="未読" />
                    )}
                  </TD>
                  <TD className="text-small text-ink-muted">{n.categoryLabel}</TD>
                  <TD>
                    <div
                      className={n.read ? 'text-body text-ink' : 'text-body font-medium text-ink'}
                    >
                      {n.title}
                    </div>
                    {/* 別のサーバーから持ち回した通知は本文を持たない（題名とリンクで用件が分かる） */}
                    {n.body ? <p className="text-small text-ink-muted">{n.body}</p> : null}
                  </TD>
                  <TD className="tnum whitespace-nowrap text-caption text-ink-muted">
                    {n.createdAtText}
                  </TD>
                  <TD align="right">
                    <div className="flex items-center justify-end gap-2">
                      {n.href && (
                        <Link
                          href={n.href}
                          className="inline-flex items-center gap-1 whitespace-nowrap text-small text-brand-700 hover:underline"
                        >
                          対象を開く
                          <ArrowRight className="size-3" aria-hidden="true" />
                        </Link>
                      )}
                      {!n.read && (
                        <form
                          action={async (formData) => {
                            markOptimistic({ kind: 'one', id: n.id });
                            await markReadAction(formData);
                          }}
                        >
                          <input type="hidden" name="notificationId" value={n.id} />
                          <SubmitButton size="xs" variant="secondary">
                            既読にする
                          </SubmitButton>
                        </form>
                      )}
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </div>
  );
}
