import Link from 'next/link';
import { AlertTriangle, Plus } from 'lucide-react';
import { FractionBar } from '@/components/charts/fraction-bar';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { FlashMessage } from '@/components/shared/flash';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { PermissionDeniedState } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { AuthorizationError, can } from '@/lib/authorization/can';
import { DISCLOSURE_PURPOSE_LABELS } from '@/lib/domain/disclosure-status';
import { formatJstDate } from '@/lib/format/datetime';
import { listProjects, type ProjectListRow } from '@/lib/services/disclosure-project';
import { loadEnterpriseShell } from '@/lib/services/shell';
import {
  ApplicabilityBadge,
  LegalStatusBadge,
  ProjectStatusBadge,
} from './_components/framework-badges';

export const metadata = { title: '開示プロジェクト' };

const BASE_PATH = '/enterprise/disclosure-projects';
const NEW_PATH = `${BASE_PATH}/new`;

/**
 * 開示プロジェクトの一覧（§6.2・§6.3。plan §2.26 E37）。
 *
 * - 画面の仕事は「プロジェクトを開く・作る」。主操作は作成の 1 つ（開示の編集権限があるときだけ）
 * - 一覧は DataTable。既定の列はプロジェクト・報告期間・状態・承認済みの節（分母つき）・期限。
 *   目的・基準と適用判断・担当は「列 ▾」で出す（L2）
 * - 期間は FY と開始日・終了日を併記し、選択中の報告期間と違うプロジェクトは「別の年度」と明示する（A02）
 */
export default async function DisclosureProjectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;

  let all: ProjectListRow[];
  try {
    all = await listProjects(db, ctx);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return (
        <>
          <PageHeader title="開示プロジェクト" autoBreadcrumbs />
          <PermissionDeniedState
            description="開示プロジェクトを見るには、開示の閲覧権限が必要です。"
            permission="enterprise.disclosure.read"
          />
        </>
      );
    }
    throw error;
  }
  const canWrite = can(ctx, 'enterprise.disclosure.write');
  const q = typeof query.q === 'string' ? query.q.trim() : '';
  const rows = q
    ? all.filter((row) =>
        [row.project.name, row.period?.code ?? '', ...row.frameworks.map((f) => f.label)]
          .join(' ')
          .includes(q),
      )
    : all;

  const columns: DataTableColumn<ProjectListRow>[] = [
    {
      key: 'name',
      header: 'プロジェクト',
      importance: 'primary',
      lockVisible: true,
      pinned: 'left',
      width: 'lg',
      cell: (row) => (
        <Link
          href={`${BASE_PATH}/${row.project.id}`}
          className="font-medium text-brand-800 hover:underline"
        >
          {row.project.name}
        </Link>
      ),
    },
    {
      key: 'period',
      header: '報告期間',
      importance: 'primary',
      cell: (row) => {
        const isOtherPeriod = row.period !== null && row.period.id !== shell.currentPeriod.id;
        return (
          <span className="whitespace-nowrap text-small">
            {row.period?.code ?? '—'}
            <span className="block text-caption text-ink-muted">
              {formatJstDate(row.project.periodStart)}〜{formatJstDate(row.project.periodEnd)}
            </span>
            {isOtherPeriod && (
              <span className="flex items-center gap-1 text-caption text-warning-ink">
                <AlertTriangle className="size-3" aria-hidden="true" />
                選択中の期間（{shell.currentPeriod.code}）とは別の年度
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: 'status',
      header: '状態',
      importance: 'primary',
      cell: (row) => <ProjectStatusBadge status={row.project.status} />,
    },
    {
      key: 'approved',
      header: '承認済みの節',
      importance: 'primary',
      width: 'sm',
      // 承認済みの節（分母つき）。企業内の承認で、保証の結論ではない
      cell: (row) => (
        <FractionBar
          label="承認済み"
          numerator={row.approvedBlockCount}
          denominator={row.blockCount}
          unit="節"
        />
      ),
    },
    {
      key: 'due',
      header: '期限',
      importance: 'primary',
      cell: (row) => (
        <span className="whitespace-nowrap text-small">{formatJstDate(row.project.dueDate)}</span>
      ),
    },
    {
      key: 'purpose',
      header: '目的',
      importance: 'detail',
      cell: (row) => (
        <span className="text-small">
          {row.project.purposes.map((p) => DISCLOSURE_PURPOSE_LABELS[p]).join('・')}
        </span>
      ),
    },
    {
      key: 'frameworks',
      header: '基準・版と適用判断',
      importance: 'detail',
      cell: (row) =>
        row.frameworks.length === 0 ? (
          <span className="text-small text-ink-muted">基準なし（社内 ESG 管理）</span>
        ) : (
          <ul className="space-y-1">
            {row.frameworks.map((f) => (
              <li
                key={f.projectFramework.id}
                className="flex flex-wrap items-center gap-1 text-small"
              >
                <span>{f.label}</span>
                <LegalStatusBadge legal={f.legal} />
                <ApplicabilityBadge
                  status={f.projectFramework.applicabilityStatus}
                  confirmed={f.confirmed}
                />
              </li>
            ))}
          </ul>
        ),
    },
    {
      key: 'owner',
      header: '担当',
      importance: 'detail',
      cell: (row) => (
        <span className="whitespace-nowrap text-small">{row.ownerName ?? '未定'}</span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="開示プロジェクト"
        description="報告期間・目的・基準の版・担当を束ねた開示の作業単位"
        help={
          <p>
            報告期間・制度目的・基準の版・担当を束ねた開示の作業単位です。基準の版はプロジェクトごとに固定され、新しい版が出ても自動では切り替わりません。
          </p>
        }
        autoBreadcrumbs
        actions={
          <PageActions
            primary={{
              kind: 'link',
              id: 'create-project',
              shortcut: 'new',
              label: 'プロジェクトを作成',
              href: NEW_PATH,
              icon: <Plus aria-hidden="true" />,
              hidden: !canWrite,
            }}
          />
        }
      />
      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />
        <DataTable
          id="disclosure-projects"
          caption="開示プロジェクト"
          columns={columns}
          rows={rows}
          getRowId={(row) => row.project.id}
          getRowLabel={(row) => row.project.name}
          getRowStatus={(row) => row.project.status}
          searchParams={query}
          basePath={BASE_PATH}
          search={{ placeholder: 'プロジェクト名・期間・基準で検索' }}
          className="rounded-t4d-lg border border-line bg-surface"
          empty={{
            noData: {
              title: '開示プロジェクトがありません',
              description: canWrite
                ? '報告期間と対応する制度・基準を選んで、最初のプロジェクトを作成してください。'
                : 'プロジェクトは作成担当・管理者（開示の編集権限を持つ人）が作成します。作成されるとここに並びます。',
              action: canWrite ? (
                <Button variant="secondary" size="sm" asChild>
                  <Link href={NEW_PATH}>
                    <Plus aria-hidden="true" />
                    プロジェクトを作成
                  </Link>
                </Button>
              ) : (
                <Button variant="secondary" size="sm" asChild>
                  <Link href="/enterprise/dashboard">ホームへ戻る</Link>
                </Button>
              ),
            },
          }}
        />
      </div>
    </>
  );
}
