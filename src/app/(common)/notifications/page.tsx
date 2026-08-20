import Link from 'next/link';
import { BellOff } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { requireSession } from '@/lib/auth/session';
import { formatJst } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';

export const metadata = { title: '通知' };

const CATEGORY_LABEL: Record<string, string> = {
  task: 'タスク',
  alert: 'アラート',
  pbc: 'PBC',
  review: 'レビュー',
  system: 'システム',
};

export default async function NotificationsPage() {
  const session = await requireSession();
  const ctx = session.context;
  const db = await getDb();

  const notifications = await db.select('notifications', {
    where: { organizationId: ctx.workspace.organizationId, userId: ctx.userId },
    orderBy: { column: 'createdAt', dir: 'desc' },
    limit: 50,
  });

  return (
    <>
      <PageHeader
        title="通知"
        description={`${ctx.workspace.organizationName} / ${ctx.displayName} 宛`}
        breadcrumbs={[{ label: 'ホーム', href: '/workspace' }, { label: '通知' }]}
      />
      <div className="p-4">
        <Card>
          {notifications.length === 0 ? (
            <EmptyState
              title="通知はありません"
              description="タスクの割当、PBC 依頼、Snapshot 後の変更検知などがここに表示されます。"
              icon={<BellOff className="size-5" aria-hidden="true" />}
            />
          ) : (
            <ul className="divide-y divide-line">
              {notifications.map((n) => (
                <li key={n.id} className="px-3 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge tone={n.readAt ? 'neutral' : 'brand'}>
                          {CATEGORY_LABEL[n.category] ?? n.category}
                        </Badge>
                        <span className="text-[13px] font-medium text-ink">{n.title}</span>
                        {!n.readAt && <Badge tone="danger">未読</Badge>}
                      </div>
                      <p className="mt-0.5 text-[12px] text-ink-muted">{n.body}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-[11px] text-ink-muted">{formatJst(n.createdAt)}</div>
                      {n.href && (
                        <Link href={n.href} className="text-[12px] text-brand-700 hover:underline">
                          対象を開く
                        </Link>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
