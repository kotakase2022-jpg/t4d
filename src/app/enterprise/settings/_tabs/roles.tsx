import Link from 'next/link';
import { Check } from 'lucide-react';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { Notice } from '@/components/shared/notice';
import { Section } from '@/components/shared/section';
import type { EnterpriseRole } from '@/types/domain';
import type { RoleMatrix, RoleMatrixRow } from '../_lib/role-matrix';

/**
 * 設定「役割と権限」タブ（トライアル対応 NF-27。読み取り専用）。役割 × できること と役割ごとの人数。
 * 権限キーは出さず、権限の名前で出す。「できる／—」は文字とアイコンで示す（色だけにしない）
 */

const BASE = '/enterprise/settings';

export function RolesTab({
  params,
  matrix,
  counts,
}: {
  params: Record<string, string | string[] | undefined>;
  matrix: RoleMatrix;
  counts: Record<EnterpriseRole, number>;
}) {
  const columns: DataTableColumn<RoleMatrixRow>[] = [
    {
      key: 'permission',
      header: 'できること',
      importance: 'primary',
      lockVisible: true,
      pinned: 'left',
      cell: (row) => <span className="font-medium">{row.label}</span>,
    },
    ...matrix.roles.map((role): DataTableColumn<RoleMatrixRow> => ({
      key: role.key,
      header: `${role.name}（${counts[role.key]} 人）`,
      importance: 'primary',
      align: 'center',
      cell: (row) =>
        row.allowed[role.key] ? (
          <span className="inline-flex items-center gap-0.5 text-small text-ink">
            <Check className="size-3.5 text-success" aria-hidden="true" />
            できる
          </span>
        ) : (
          <span className="text-small text-ink-muted">
            —<span className="sr-only">できない</span>
          </span>
        ),
    })),
  ];

  return (
    <>
      <Notice tone="info">
        画面の権限（アプリ）とデータベースの権限（行単位のアクセス制御）は同じ定義で、両者が一致することは自動テストで検査済みです。
        役割の割り当ては「メンバー」タブで変えます。権限そのものの変更は運営の手続き（定義の変更と検査）で行い、この画面からは変えられません。
      </Notice>
      <Section title="役割と権限" divider="none">
        <DataTable<RoleMatrixRow>
          id="settings-role-matrix"
          caption="役割と権限の一覧"
          columns={columns}
          rows={matrix.rows}
          getRowId={(row) => row.permission}
          getRowLabel={(row) => row.label}
          searchParams={params}
          basePath={BASE}
          search={false}
          empty={{
            noData: {
              title: '表示できる権限がありません',
              action: (
                <Link
                  href={`${BASE}?tab=members`}
                  className="text-small text-brand-700 hover:underline"
                >
                  メンバーを確認
                </Link>
              ),
            },
          }}
        />
        <ul className="mt-2 space-y-0.5 text-caption text-ink-muted">
          {matrix.roles.map((role) => (
            <li key={role.key}>
              <span className="font-medium text-ink">{role.name}</span>: {role.description}
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
