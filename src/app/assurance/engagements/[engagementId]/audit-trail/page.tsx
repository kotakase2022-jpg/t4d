import { SectionTitle } from '@/components/shared/page-header';
import { Pagination } from '@/components/shared/pagination';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { requireAssuranceContext } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import { formatJst } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import { loadEngagementOr404 } from '@/lib/services/assurance';
import { EngagementHeader } from '../engagement-header';

export const metadata = { title: '監査ログ' };

export default async function AuditTrailPage({
  params,
  searchParams,
}: {
  params: Promise<{ engagementId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { engagementId } = await params;
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const context = await loadEngagementOr404(db, ctx, engagementId);

  // 200 件で無言に打ち切ると、見出しの件数が総件数のように見えて
  // 「これで全部だ」と誤解される。総件数を出し、ページで辿れるようにする。
  const PAGE_SIZE = 100;
  const query = await searchParams;
  const page = Math.max(1, Number(typeof query.page === 'string' ? query.page : '1') || 1);
  const total = await db.count('auditEvents', { where: { engagementId } });
  const events = await db.select('auditEvents', {
    where: { engagementId },
    orderBy: { column: 'createdAt', dir: 'desc' },
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const actorIds = [
    ...new Set(events.map((e) => e.actorUserId).filter((id): id is string => !!id)),
  ];
  const profiles =
    actorIds.length > 0 ? await db.select('profiles', { where: { id: { in: actorIds } } }) : [];

  const accessEvents = await db.select('storageAccessEvents', {
    where: { engagementId },
    orderBy: { column: 'createdAt', dir: 'desc' },
    limit: 50,
  });

  return (
    <>
      <EngagementHeader context={context} page="監査ログ" />

      <div className="space-y-3 p-4">
        <Card className="border-brand-200 bg-brand-50">
          <p className="px-3 py-2 text-[12px] text-brand-900">
            監査ログは<strong>追記専用</strong>です（UPDATE / DELETE は RLS と DB
            トリガの両方で禁止）。PII や Evidence
            本文は保存せず、要約と最小限のメタデータのみを記録します。 IP アドレスはハッシュの先頭
            16 文字のみ保持します。
          </p>
        </Card>

        <Card className="overflow-hidden">
          <SectionTitle title={`案件の監査イベント（表示 ${events.length} / 全 ${total}）`} />
          {events.length === 0 ? (
            <EmptyState title="記録がありません" />
          ) : (
            <div className="t4d-scroll-x">
              <Table className="t4d-sticky-head">
                <THead>
                  <TR>
                    <TH>日時</TH>
                    <TH>イベント</TH>
                    <TH>実行者</TH>
                    <TH>対象</TH>
                    <TH>変更前</TH>
                    <TH>変更後</TH>
                    <TH>IP(hash)</TH>
                  </TR>
                </THead>
                <TBody>
                  {events.map((event) => (
                    <TR key={event.id}>
                      <TD className="whitespace-nowrap text-[11px] text-ink-muted">
                        {formatJst(event.createdAt)}
                      </TD>
                      <TD>
                        <Badge tone="neutral">{event.eventType}</Badge>
                      </TD>
                      <TD>
                        {profiles.find((p) => p.id === event.actorUserId)?.displayName ?? 'system'}
                      </TD>
                      <TD className="text-[11px]">
                        {event.resourceType ?? '—'}
                        {event.resourceId ? ` (${event.resourceId.slice(0, 8)})` : ''}
                      </TD>
                      <TD className="max-w-[220px] truncate text-[11px] text-ink-muted">
                        {event.beforeSummary ?? '—'}
                      </TD>
                      <TD className="max-w-[260px] truncate text-[11px]">
                        {event.afterSummary ?? '—'}
                      </TD>
                      <TD className="font-mono text-[10px] text-ink-muted">
                        {event.clientIpHash ?? '—'}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
          {total > PAGE_SIZE && (
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={total}
              basePath={`/assurance/engagements/${engagementId}/audit-trail`}
              searchParams={query}
            />
          )}
        </Card>

        {can(ctx, 'common.audit.read') && (
          <Card className="overflow-hidden">
            <SectionTitle title={`Evidence アクセス記録（${accessEvents.length}）`} />
            {accessEvents.length === 0 ? (
              <EmptyState title="Evidence へのアクセス記録はありません" />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>日時</TH>
                    <TH>操作</TH>
                    <TH>File Version</TH>
                    <TH>有効期限</TH>
                  </TR>
                </THead>
                <TBody>
                  {accessEvents.map((event) => (
                    <TR key={event.id}>
                      <TD className="whitespace-nowrap text-[11px] text-ink-muted">
                        {formatJst(event.createdAt)}
                      </TD>
                      <TD>
                        <Badge tone="neutral">{event.action}</Badge>
                      </TD>
                      <TD className="font-mono text-[11px]">{event.fileVersionId.slice(0, 12)}</TD>
                      <TD className="text-[11px] text-ink-muted">
                        {event.expiresAt ? formatJst(event.expiresAt) : '—'}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
