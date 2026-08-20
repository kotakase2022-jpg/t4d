import Link from 'next/link';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { formatJstDate, formatNumber } from '@/lib/format/datetime';
import { loadAssuranceShell } from '@/lib/services/shell';

export const metadata = { title: '保証契約' };

export default async function EngagementsPage() {
  const shell = await loadAssuranceShell();
  const { db, ctx } = shell;

  const clientIds = [...new Set(shell.engagements.map((e) => e.clientOrganizationId))];
  const clients =
    clientIds.length > 0
      ? await db.select('organizations', { where: { id: { in: clientIds } } })
      : [];
  const periodIds = [...new Set(shell.engagements.map((e) => e.clientReportingPeriodId))];
  const periods =
    periodIds.length > 0 ? await db.select('periods', { where: { id: { in: periodIds } } }) : [];

  const members =
    shell.engagements.length > 0
      ? await db.select('engagementMembers', {
          where: { engagementId: { in: shell.engagements.map((e) => e.id) } },
        })
      : [];
  const profileIds = [...new Set(members.map((m) => m.userId))];
  const profiles =
    profileIds.length > 0 ? await db.select('profiles', { where: { id: { in: profileIds } } }) : [];

  return (
    <>
      <PageHeader
        title="保証契約"
        description="アサインされている案件のみ表示されます（監査法人管理者でも未アサイン案件は閲覧できません）。"
        breadcrumbs={[{ label: '監査法人ワークスペース' }, { label: '保証契約' }]}
      />

      <div className="p-4">
        <Card className="overflow-hidden">
          <SectionTitle title={`案件（${shell.engagements.length}）`} />
          {shell.engagements.length === 0 ? (
            <EmptyState title="アサインされている案件がありません" />
          ) : (
            <div className="t4d-scroll-x">
              <Table>
                <THead>
                  <TR>
                    <TH>コード</TH>
                    <TH>案件名</TH>
                    <TH>クライアント</TH>
                    <TH>対象期間</TH>
                    <TH>基準</TH>
                    <TH>保証水準</TH>
                    <TH>状態</TH>
                    <TH>重要性</TH>
                    <TH>期限</TH>
                    <TH>チーム</TH>
                  </TR>
                </THead>
                <TBody>
                  {shell.engagements.map((engagement) => {
                    const team = members.filter((m) => m.engagementId === engagement.id);
                    return (
                      <TR key={engagement.id} data-t4d-record>
                        <TD>
                          <Link
                            href={`/assurance/engagements/${engagement.id}/overview`}
                            className="font-mono text-[12px] text-brand-700 hover:underline"
                          >
                            {engagement.code}
                          </Link>
                        </TD>
                        <TD className="font-medium">{engagement.name}</TD>
                        <TD>
                          {clients.find((c) => c.id === engagement.clientOrganizationId)?.name ??
                            '—'}
                        </TD>
                        <TD>
                          {periods.find((p) => p.id === engagement.clientReportingPeriodId)?.code ??
                            '—'}
                        </TD>
                        <TD className="uppercase">{engagement.frameworkKey}</TD>
                        <TD>
                          <Badge tone="neutral">
                            {engagement.assuranceLevel === 'limited' ? '限定的保証' : '合理的保証'}
                          </Badge>
                        </TD>
                        <TD>
                          <Badge tone={engagement.status === 'fieldwork' ? 'brand' : 'neutral'}>
                            {engagement.status}
                          </Badge>
                        </TD>
                        <TD className="text-[11px]">
                          {engagement.materialityValue === null
                            ? '—'
                            : `${formatNumber(engagement.materialityValue)} ${engagement.materialityUnit ?? ''}`}
                          <div className="text-ink-muted">{engagement.materialityBasis ?? ''}</div>
                        </TD>
                        <TD>{formatJstDate(engagement.deadlineDate)}</TD>
                        <TD className="text-[11px]">
                          {team
                            .map((m) => profiles.find((p) => p.id === m.userId)?.displayName ?? '—')
                            .join(' / ')}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
          )}
        </Card>
        <p className="mt-2 text-[11px] text-ink-muted">
          ログイン中: {ctx.displayName} ／ アサイン案件 {ctx.engagementIds.length} 件
        </p>
      </div>
    </>
  );
}
