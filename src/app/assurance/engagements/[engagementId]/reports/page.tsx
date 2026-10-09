import Link from 'next/link';
import { FileText } from 'lucide-react';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { FlashMessage } from '@/components/shared/flash';
import { Section } from '@/components/shared/section';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { SemanticBadge, StatusBadge } from '@/components/shared/status-badge';
import { requireAssuranceContext } from '@/lib/auth/session';
import { AuthorizationError } from '@/lib/authorization/can';
import { formatJst } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import {
  loadEngagementOr404,
  loadSharedReportList,
  type SharedReportListRow,
} from '@/lib/services/assurance';
import { EngagementHeader } from '../engagement-header';
import { SharedReportHonesty } from './_components/report-honesty';

export const metadata = { title: '開示レポート' };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * 開示レポート（トライアル対応 NF-20 の保証側）。企業が案件へ共有した承認済みレポートの写しの一覧。
 *
 * 共有は企業側の行為（企業の出力タブ「保証側へ共有…」）で、監査法人は写しを読むだけ（企業原本を更新しない）。
 * 取り下げられた写しは出さない。行から内容（本文・数値・根拠・承認版・追跡番号）を開き、段落・数値に
 * コメントを付ける（NF-21）。
 */
export default async function SharedReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ engagementId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { engagementId } = await params;
  const query = await searchParams;
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const context = await loadEngagementOr404(db, ctx, engagementId);
  const basePath = `/assurance/engagements/${engagementId}/reports`;

  let rows: SharedReportListRow[];
  try {
    rows = await loadSharedReportList(db, ctx, engagementId);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return (
        <>
          <EngagementHeader context={context} page="開示レポート" />
          <PermissionDeniedState
            description="開示レポートを見るには、案件の閲覧権限が必要です。"
            permission="assurance.engagement.read"
          />
        </>
      );
    }
    throw error;
  }

  const columns: DataTableColumn<SharedReportListRow>[] = [
    {
      key: 'report',
      header: '開示レポート',
      importance: 'primary',
      lockVisible: true,
      pinned: 'left',
      cell: (row) => (
        <Link
          href={`${basePath}/${row.copy.id}`}
          className="font-medium text-brand-700 underline-offset-2 hover:underline"
        >
          {row.label}
        </Link>
      ),
    },
    {
      key: 'frameworks',
      header: '基準',
      importance: 'primary',
      cell: (row) =>
        row.frameworkNames.length > 0 ? (
          row.frameworkNames.join('・')
        ) : (
          <span className="text-ink-muted">—</span>
        ),
    },
    {
      key: 'state',
      header: '状態',
      importance: 'primary',
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1">
          <StatusBadge domain="sharedReport" value="active" />
          {!row.integrityOk && (
            <SemanticBadge
              semantic="error"
              label="写しの不一致"
              detail="写しの内容ハッシュが共有時と一致しないため、内容を表示しません。"
            />
          )}
        </span>
      ),
    },
    {
      key: 'notes',
      header: 'コメント',
      importance: 'secondary',
      align: 'right',
      cell: (row) => (
        <span className="tnum">
          {row.noteCount}
          {row.openNoteCount > 0 && (
            <span className="ml-1 text-caption text-ink-muted">
              （未クリア {row.openNoteCount}）
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'sharedAt',
      header: '共有日時',
      importance: 'secondary',
      cell: (row) => (
        <span className="whitespace-nowrap text-small">{formatJst(row.copy.sharedAt)}</span>
      ),
    },
    {
      key: 'hash',
      header: '内容ハッシュ',
      importance: 'detail',
      cell: (row) => (
        <span className="font-mono text-caption" data-copy-hash="">
          {row.copy.snapshotContentHash.slice(0, 12)}
        </span>
      ),
    },
  ];

  return (
    <>
      <EngagementHeader
        context={context}
        page="開示レポート"
        description="クライアントが共有した社内承認済みの開示レポート（写し・閲覧のみ）"
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />
        {/* 誠実さの注記（社内承認・提出ではない・閲覧のみ）。折りたたまない */}
        <SharedReportHonesty />

        <Section title={`共有された開示レポート（${rows.length}）`}>
          {rows.length === 0 ? (
            // 共有は企業側の操作。監査法人の画面からは作れないため、行き先は Data Room（共有の状況）
            <EmptyState
              kind="not-applicable"
              size="compact"
              title="共有された開示レポートはありません"
              description="クライアントが社内承認済みのレポートをこの案件へ共有すると、ここに並びます。共有中の非財務データは Data Room で確認できます。"
              action={
                <Link
                  href={`/assurance/engagements/${engagementId}/data-room`}
                  className="text-small text-brand-700 hover:underline"
                >
                  Data Room を開く
                </Link>
              }
            />
          ) : (
            <DataTable<SharedReportListRow>
              id="assurance-shared-reports"
              caption="共有された開示レポート"
              columns={columns}
              rows={rows}
              getRowId={(row) => row.copy.id}
              getRowLabel={(row) => row.label}
              searchParams={query}
              basePath={basePath}
              search={false}
              rowActions={(row) => ({
                rowLabel: row.label,
                primary: {
                  kind: 'link',
                  id: `open-${row.copy.id}`,
                  label: '内容を開く',
                  icon: <FileText aria-hidden="true" />,
                  href: `${basePath}/${row.copy.id}`,
                },
              })}
              empty={{
                noData: {
                  title: '共有された開示レポートはありません',
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
          )}
        </Section>
      </div>
    </>
  );
}
