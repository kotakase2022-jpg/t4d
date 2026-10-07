import Link from 'next/link';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { Notice } from '@/components/shared/notice';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { requireAssuranceContext } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import { formatJst } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import { loadEngagementOr404 } from '@/lib/services/assurance';
import type { AuditEvent } from '@/types/domain';
import { STORAGE_ACTION_LABEL, auditEventLabel } from '../../../_components/labels';
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
  const basePath = `/assurance/engagements/${engagementId}/audit-trail`;

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

  const canReadAccess = can(ctx, 'common.audit.read');
  const accessEvents = canReadAccess
    ? await db.select('storageAccessEvents', {
        where: { engagementId },
        orderBy: { column: 'createdAt', dir: 'desc' },
        limit: 50,
      })
    : [];

  const columns: DataTableColumn<AuditEvent>[] = [
    {
      key: 'at',
      header: '日時',
      importance: 'primary',
      lockVisible: true,
      cell: (event) => (
        <span className="whitespace-nowrap text-caption text-ink-muted">
          {formatJst(event.createdAt)}
        </span>
      ),
    },
    {
      key: 'event',
      header: 'イベント',
      importance: 'primary',
      // 監査ログは記録上の識別子（イベントのコード）も照合に使うため、業務の名前と併記する
      cell: (event) => (
        <span className="flex flex-col">
          <span className="text-small text-ink">{auditEventLabel(event.eventType)}</span>
          <code className="font-mono text-caption text-ink-muted">{event.eventType}</code>
        </span>
      ),
    },
    {
      key: 'actor',
      header: '実行者',
      importance: 'primary',
      cell: (event) => profiles.find((p) => p.id === event.actorUserId)?.displayName ?? 'システム',
    },
    {
      key: 'target',
      header: '対象',
      importance: 'secondary',
      cell: (event) => (
        <span className="text-caption">
          {event.resourceType ?? '—'}
          {event.resourceId ? ` (${event.resourceId.slice(0, 8)})` : ''}
        </span>
      ),
    },
    {
      key: 'before',
      header: '変更前',
      importance: 'detail',
      cell: (event) => (
        <span className="block max-w-[220px] truncate text-caption text-ink-muted">
          {event.beforeSummary ?? '—'}
        </span>
      ),
    },
    {
      key: 'after',
      header: '変更後',
      importance: 'primary',
      cell: (event) => (
        <span className="block max-w-[260px] truncate text-caption">
          {event.afterSummary ?? '—'}
        </span>
      ),
    },
    {
      key: 'ip',
      header: 'IP（ハッシュ）',
      importance: 'detail',
      cell: (event) => (
        <span className="font-mono text-caption text-ink-muted">{event.clientIpHash ?? '—'}</span>
      ),
    },
  ];

  return (
    <>
      <EngagementHeader context={context} page="監査ログ" />

      <div className="space-y-3 p-4">
        {/* 追記専用・保存しない情報は安全の注記（折りたたまない） */}
        <Notice tone="info">
          監査ログは<strong>追記専用</strong>です（UPDATE / DELETE は RLS と DB
          トリガの両方で禁止）。PII や Evidence
          本文は保存せず、要約と最小限のメタデータのみを記録します。 IP アドレスはハッシュの先頭 16
          文字のみ保持します。
        </Notice>

        <Section title={`案件の監査イベント（表示 ${events.length} / 全 ${total}）`}>
          <DataTable<AuditEvent>
            id="assurance-audit-trail"
            caption="案件の監査イベント"
            columns={columns}
            rows={events}
            getRowId={(event) => event.id}
            getRowLabel={(event) =>
              `${formatJst(event.createdAt)} ${auditEventLabel(event.eventType)}`
            }
            searchParams={query}
            basePath={basePath}
            search={false}
            page={{ page, pageSize: PAGE_SIZE, total }}
            empty={{
              noData: {
                title: '記録がありません',
                description:
                  'Snapshot の固定・サンプルの抽出・手続の記録などが、ここに追記されます。',
                action: (
                  <Link
                    href={`/assurance/engagements/${engagementId}/data-room`}
                    className="text-small text-brand-700 hover:underline"
                  >
                    Data Room を開く
                  </Link>
                ),
              },
            }}
          />
        </Section>

        {canReadAccess && (
          <Section
            id="access-log"
            title={`資料へのアクセス記録（${accessEvents.length}）`}
            collapsible
            summary={accessEvents.length === 0 ? '記録なし' : `最新 ${accessEvents.length} 件まで`}
          >
            {accessEvents.length === 0 ? (
              <EmptyState
                kind="not-applicable"
                size="compact"
                title="資料へのアクセス記録はありません"
                description="資料を開く・ダウンロードすると、ここに記録されます。"
              />
            ) : (
              <div className="t4d-scroll-x rounded-t4d border border-line">
                <Table>
                  <THead>
                    <TR>
                      <TH>日時</TH>
                      <TH>操作</TH>
                      <TH>ファイルの版</TH>
                      <TH>有効期限</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {accessEvents.map((event) => (
                      <TR key={event.id}>
                        <TD className="whitespace-nowrap text-caption text-ink-muted">
                          {formatJst(event.createdAt)}
                        </TD>
                        <TD className="text-small">
                          {STORAGE_ACTION_LABEL[event.action] ?? '操作'}
                        </TD>
                        <TD className="font-mono text-caption">
                          {event.fileVersionId.slice(0, 12)}
                        </TD>
                        <TD className="text-caption text-ink-muted">
                          {event.expiresAt ? formatJst(event.expiresAt) : '—'}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
          </Section>
        )}
      </div>
    </>
  );
}
