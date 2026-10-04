import Link from 'next/link';
import { FolderKanban, Plus } from 'lucide-react';
import { FractionBar } from '@/components/charts/fraction-bar';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
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

/**
 * 開示プロジェクトの一覧（§6.2・§6.3）。
 * 期間は FY と開始日・終了日を併記し、選択中の報告期間と違うプロジェクトは「過年度」と明示する（A02）。
 */
export default async function DisclosureProjectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;

  let rows: ProjectListRow[];
  try {
    rows = await listProjects(db, ctx);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return (
        <>
          <PageHeader
            title="開示プロジェクト"
            breadcrumbs={[{ label: '企業ワークスペース' }, { label: '開示プロジェクト' }]}
          />
          <PermissionDeniedState description="開示プロジェクトを見るには、開示の閲覧権限が必要です。" />
        </>
      );
    }
    throw error;
  }
  const canWrite = can(ctx, 'enterprise.disclosure.write');

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
        breadcrumbs={[{ label: '企業ワークスペース' }, { label: '開示プロジェクト' }]}
        actions={
          canWrite ? (
            <Button size="sm" asChild>
              <Link href="/enterprise/disclosure-projects/new">
                <Plus aria-hidden="true" />
                新しいプロジェクト
              </Link>
            </Button>
          ) : undefined
        }
      />
      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />
        <Card className="overflow-hidden">
          <SectionTitle title={`プロジェクト（${rows.length}）`} />
          {rows.length === 0 ? (
            <EmptyState
              title="開示プロジェクトがありません"
              description="報告期間と対応する制度・基準を選んで、最初のプロジェクトを作成してください。"
              icon={<FolderKanban className="size-5" aria-hidden="true" />}
              action={
                canWrite ? (
                  <Button size="sm" asChild>
                    <Link href="/enterprise/disclosure-projects/new">新しいプロジェクト</Link>
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="max-h-[70vh] overflow-auto">
              <Table>
                <THead className="sticky top-0 z-10 bg-surface">
                  <TR>
                    <TH>プロジェクト</TH>
                    <TH>報告期間</TH>
                    <TH>目的</TH>
                    <TH>基準・版と適用判断</TH>
                    <TH>状態</TH>
                    <TH>承認済みの節</TH>
                    <TH>担当</TH>
                    <TH>期限</TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((row) => {
                    const isOtherPeriod =
                      row.period !== null && row.period.id !== shell.currentPeriod.id;
                    return (
                      <TR key={row.project.id}>
                        <TD className="min-w-[220px] font-medium">
                          <Link
                            href={`/enterprise/disclosure-projects/${row.project.id}`}
                            className="text-brand-800 hover:underline"
                          >
                            {row.project.name}
                          </Link>
                        </TD>
                        <TD className="whitespace-nowrap text-[12px]">
                          {row.period?.code ?? '—'}
                          <span className="block text-[11px] text-ink-muted">
                            {formatJstDate(row.project.periodStart)}〜
                            {formatJstDate(row.project.periodEnd)}
                          </span>
                          {isOtherPeriod && (
                            <span className="text-[11px] text-[#8a5d00]">
                              選択中の期間（{shell.currentPeriod.code}）とは別の年度
                            </span>
                          )}
                        </TD>
                        <TD className="text-[12px]">
                          {row.project.purposes.map((p) => DISCLOSURE_PURPOSE_LABELS[p]).join('・')}
                        </TD>
                        <TD>
                          <ul className="space-y-1">
                            {row.frameworks.map((f) => (
                              <li
                                key={f.projectFramework.id}
                                className="flex flex-wrap items-center gap-1 text-[12px]"
                              >
                                <span>{f.label}</span>
                                <LegalStatusBadge legal={f.legal} />
                                <ApplicabilityBadge
                                  status={f.projectFramework.applicabilityStatus}
                                  confirmed={f.confirmed}
                                />
                              </li>
                            ))}
                            {row.frameworks.length === 0 && (
                              <li className="text-[12px] text-ink-muted">
                                基準なし（社内 ESG 管理）
                              </li>
                            )}
                          </ul>
                        </TD>
                        <TD>
                          <ProjectStatusBadge status={row.project.status} />
                        </TD>
                        <TD className="min-w-[140px]">
                          {/* 承認済みの節（分母つき）。企業内の承認で、保証の結論ではない */}
                          <FractionBar
                            label="承認済み"
                            numerator={row.approvedBlockCount}
                            denominator={row.blockCount}
                            unit="節"
                          />
                        </TD>
                        <TD className="whitespace-nowrap text-[12px]">{row.ownerName ?? '未定'}</TD>
                        <TD className="whitespace-nowrap text-[12px]">
                          {formatJstDate(row.project.dueDate)}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
