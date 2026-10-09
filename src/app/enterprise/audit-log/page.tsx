import Link from 'next/link';
import { Download } from 'lucide-react';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { Notice } from '@/components/shared/notice';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { PermissionDeniedState } from '@/components/shared/states';
import { SemanticBadge } from '@/components/shared/status-badge';
import { can } from '@/lib/authorization/can';
import { formatJst } from '@/lib/format/datetime';
import {
  AUDIT_LOG_PERIOD_LABELS,
  AUDIT_LOG_PERIODS,
  auditFilterFrom,
  listOrganizationAudit,
  type AuditLogEntry,
} from '@/lib/services/audit-log';
import { loadEnterpriseShell } from '@/lib/services/shell';
import type { StatusSemantic } from '@/lib/ui/status/registry';
import { auditEventLabel } from '@/app/assurance/_components/labels';
import { AUDIT_EVENT_TYPES } from '@/types/domain';

export const metadata = { title: '監査ログ' };

const BASE = '/enterprise/audit-log';
const PAGE_SIZE = 50;

/** 所属の表示（色だけにしない: ラベルとアイコンは SemanticBadge が併記する） */
const AFFILIATION_SEMANTIC: Record<AuditLogEntry['affiliation']['kind'], StatusSemantic> = {
  own: 'info',
  firm: 'in_review',
  external: 'blocked',
  system: 'excluded',
};

/**
 * 企業側の監査ログ（トライアル対応 NF-26）。自社のメンバーの操作と、自社の資料へのアクセス
 * （監査法人のメンバーが許諾で開いたものを含む）を新しい順に並べる。common.audit.read（企業管理者）。
 * メニューには載せない（設定の見出しの「その他」と Command Palette から開く。K2）。
 */
export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;

  if (!can(ctx, 'common.audit.read')) {
    return (
      <>
        <PageHeader title="監査ログ" autoBreadcrumbs />
        <PermissionDeniedState
          permission="common.audit.read"
          description="監査ログは、監査ログの閲覧権限を持つ人（企業管理者）だけが見られます。"
        />
      </>
    );
  }

  const filter = auditFilterFrom(params);
  const page = Math.max(1, Number(typeof params.page === 'string' ? params.page : '1') || 1);
  const result = await listOrganizationAudit(db, ctx, filter, { page, pageSize: PAGE_SIZE });

  // CSV は画面と同じ絞り込みで出す（ページ・表示の引数は渡さない）
  const exportQuery = new URLSearchParams();
  for (const key of ['period', 'kind', 'actor', 'scope']) {
    const value = params[key];
    if (typeof value === 'string' && value !== '') exportQuery.set(key, value);
  }
  const exportSearch = exportQuery.toString();
  const exportHref = `/api/exports/audit-log${exportSearch ? `?${exportSearch}` : ''}`;

  const columns: DataTableColumn<AuditLogEntry>[] = [
    {
      key: 'at',
      header: '日時',
      importance: 'primary',
      lockVisible: true,
      cell: (entry) => (
        <span className="whitespace-nowrap text-caption text-ink-muted">{formatJst(entry.at)}</span>
      ),
    },
    {
      key: 'kind',
      header: '種類',
      importance: 'primary',
      cell: (entry) => <span className="text-small text-ink">{entry.kindLabel}</span>,
    },
    {
      key: 'actor',
      header: '実行者',
      importance: 'primary',
      cell: (entry) => <span className="text-small">{entry.actorName}</span>,
    },
    {
      key: 'affiliation',
      header: '所属',
      importance: 'primary',
      cell: (entry) => (
        <SemanticBadge
          semantic={AFFILIATION_SEMANTIC[entry.affiliation.kind]}
          label={entry.affiliation.label}
        />
      ),
    },
    {
      key: 'target',
      header: '対象',
      importance: 'secondary',
      cell: (entry) => <span className="text-small">{entry.target}</span>,
    },
    {
      key: 'summary',
      header: '要約',
      importance: 'primary',
      cell: (entry) => (
        <span className="block max-w-col-xl text-caption text-ink">{entry.summary}</span>
      ),
    },
    // 記録の種類コード（照合用の識別子）は画面に出さず、CSV の列にだけ出す（生の値を画面に出さない）
  ];

  const kindOptions = [
    ...AUDIT_EVENT_TYPES.map((type) => ({ value: type, label: auditEventLabel(type) })),
    ...result.kinds.map((kind) => ({ value: kind.key, label: kind.label })),
  ];

  return (
    <>
      <PageHeader
        title="監査ログ"
        description="自社のメンバーの操作と、自社の資料へのアクセス（監査法人が許諾で開いたものを含む）の記録です。"
        autoBreadcrumbs
        actions={
          <PageActions
            secondary={[
              {
                kind: 'link',
                id: 'export-audit-log',
                label: 'CSV で出力',
                icon: <Download aria-hidden="true" />,
                href: exportHref,
                download: true,
              },
            ]}
          />
        }
      />

      <div className="space-y-3 p-4">
        {/* 追記専用・保存しない情報・デモの範囲は安全・誠実さの注記（折りたたまない） */}
        <Notice tone="info">
          監査ログは<strong>追記専用</strong>
          です（変更・削除はデータベースで禁止）。個人情報や資料の本文は保存せず、要約だけを記録します。
          監査法人の案件の中の操作は監査法人の記録で、ここには出ません（自社の資料へのアクセスは出ます）。
        </Notice>
        {ctx.demo && (
          <Notice tone="warning">
            <span className="mr-1.5 inline-flex align-middle">
              <HonestyBadge kind="demo-data" />
            </span>
            デモでは、同じサーバーのインスタンスで発生した記録と架空の記録だけを表示します（記録はブラウザに持ち回しません）。
          </Notice>
        )}

        <Section
          title={`記録（表示 ${result.entries.length} / 全 ${result.total}）`}
          divider="none"
        >
          <DataTable<AuditLogEntry>
            id="enterprise-audit-log"
            caption="監査ログ"
            columns={columns}
            rows={result.entries}
            getRowId={(entry) => entry.id}
            getRowLabel={(entry) => `${formatJst(entry.at)} ${entry.kindLabel}`}
            searchParams={params}
            basePath={BASE}
            search={false}
            page={{ page: result.page, pageSize: PAGE_SIZE, total: result.total }}
            filters={[
              {
                key: 'period',
                label: '期間',
                options: AUDIT_LOG_PERIODS.map((period) => ({
                  value: period,
                  label: AUDIT_LOG_PERIOD_LABELS[period],
                })),
              },
              {
                key: 'scope',
                label: '範囲',
                options: [{ value: 'firm-files', label: '監査法人の資料アクセスのみ' }],
              },
            ]}
            overflowFilters={[
              { key: 'kind', label: '種類', options: kindOptions },
              {
                key: 'actor',
                label: '実行者',
                options: result.actors.map((actor) => ({ value: actor.id, label: actor.name })),
              },
            ]}
            empty={{
              noData: {
                title: '記録がありません',
                description:
                  'データの登録・承認・設定の変更・資料のダウンロードなどの操作が、ここに追記されます。',
                action: (
                  <Link
                    href="/enterprise/settings"
                    className="text-small text-brand-700 hover:underline"
                  >
                    設定へ戻る
                  </Link>
                ),
              },
              filtered: {
                title: '条件に合う記録はありません',
                description: '期間・種類・実行者の絞り込みを外すと、ほかの記録が見られます。',
              },
            }}
          />
        </Section>
      </div>
    </>
  );
}
