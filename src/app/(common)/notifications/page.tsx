import Link from 'next/link';
import { BellOff, History } from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { SegmentedFilter } from '@/components/shared/nav-tabs';
import { PageHeader } from '@/components/shared/page-header';
import { Pagination } from '@/components/shared/pagination';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { requireSession } from '@/lib/auth/session';
import { formatJst } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import {
  ATTENTION_REASON_LABELS,
  ATTENTION_ROLE_LABELS,
  listDerivedAttention,
} from '@/lib/services/impact';
import { parsePage } from '@/lib/table/columns';
import { markAllNotificationsReadAction, markNotificationReadAction } from './actions';
import { NotificationList, type NotificationRow } from './notification-list';

export const metadata = { title: '通知' };

const CATEGORY_LABEL: Record<string, string> = {
  task: 'タスク',
  alert: 'アラート',
  pbc: '資料依頼',
  review: 'レビュー',
  system: 'システム',
};

/** 1 ページの件数（通知は新しい順。古いものはページ送りで辿る） */
const PAGE_SIZE = 25;
const BASE = '/notifications';

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const session = await requireSession();
  const ctx = session.context;
  const db = await getDb();

  const unreadOnly = params.filter === 'unread';
  const page = parsePage(params.page);
  const mine = { organizationId: ctx.workspace.organizationId, userId: ctx.userId };
  const [total, unreadTotal] = await Promise.all([
    db.count('notifications', { where: mine }),
    db.count('notifications', { where: { ...mine, readAt: { isNull: true } } }),
  ]);
  const notifications = await db.select('notifications', {
    where: unreadOnly ? { ...mine, readAt: { isNull: true } } : mine,
    orderBy: { column: 'createdAt', dir: 'desc' },
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const shownTotal = unreadOnly ? unreadTotal : total;
  // 要再確認（トライアル対応 NF-16）は通知の行を作らず、開くたびに導く（既読の管理は無い）。
  // 企業ワークスペースで開示の閲覧権限があるときだけ（関数の中でも同じ判定）
  const derived = await listDerivedAttention(db, ctx);

  // 日時の整形（formatJst）と区分のラベルはサーバーで済ませ、既読の即時反映だけをクライアントに置く
  const rows: NotificationRow[] = notifications.map((n) => ({
    id: n.id,
    categoryLabel: CATEGORY_LABEL[n.category] ?? 'その他',
    title: n.title,
    body: n.body || null,
    href: n.href || null,
    createdAtText: formatJst(n.createdAt),
    read: Boolean(n.readAt),
  }));

  return (
    <>
      <PageHeader
        title="通知"
        description={`${ctx.workspace.organizationName} / ${ctx.displayName} 宛`}
        autoBreadcrumbs
      />
      <div className="space-y-2 p-4">
        <FlashMessage searchParams={params} />
        {derived.length > 0 && (
          <Section
            id="derived-recheck"
            title="要再確認（上流の変更）"
            summary={`${derived.length} 節`}
            divider="none"
          >
            <p className="pb-1 text-caption text-ink-muted">
              自分が担当する節・最終承認者であるプロジェクトの節のうち、引用した数値・定性情報・資料に新しい版がある、
              根拠が失効した、承認後に修正を始めたものです。通知の行は作らず、表示のたびに状態から導きます（既読はありません）。
            </p>
            <ul className="divide-y divide-line rounded-t4d border border-line bg-surface">
              {derived.map((item) => (
                <li key={item.blockId} className="flex items-start gap-2 px-3 py-1.5">
                  <History
                    className="mt-0.5 size-3.5 shrink-0 text-warning-ink"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/enterprise/disclosure-projects/${item.projectId}/blocks/${item.blockId}`}
                      className="text-body font-medium text-brand-700 hover:underline"
                    >
                      {item.title}
                    </Link>
                    <p className="text-caption text-ink-muted">
                      {item.projectName}・理由:{' '}
                      {item.reasons.map((r) => ATTENTION_REASON_LABELS[r]).join('・')}
                      ・立場: {item.roles.map((r) => ATTENTION_ROLE_LABELS[r]).join('・')}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        )}
        <SegmentedFilter
          ariaLabel="通知の絞り込み"
          current={unreadOnly ? 'unread' : 'all'}
          items={[
            { key: 'all', label: 'すべて', href: BASE, count: total },
            {
              key: 'unread',
              label: '未読のみ',
              href: `${BASE}?filter=unread`,
              count: unreadTotal,
            },
          ]}
        />
        <NotificationList
          rows={rows}
          unreadTotal={unreadTotal}
          markReadAction={markNotificationReadAction}
          markAllReadAction={markAllNotificationsReadAction}
          empty={
            unreadOnly && total > 0 ? (
              <EmptyState
                kind="done"
                size="compact"
                title="未読の通知はありません"
                description="すべての通知を確認済みです。"
              />
            ) : (
              <EmptyState
                kind="not-applicable"
                title="通知はありません"
                description="タスクの割当、資料依頼（PBC）、Snapshot 後の変更検知などがここに表示されます。"
                icon={<BellOff className="size-5" aria-hidden="true" />}
              />
            )
          }
        />
        {shownTotal > PAGE_SIZE && (
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={shownTotal}
            basePath={BASE}
            searchParams={params}
          />
        )}
      </div>
    </>
  );
}
