import Link from 'next/link';
import { ArrowLeft, ClipboardList, Upload } from 'lucide-react';
import { DataPointStatusBadge } from '@/components/shared/badges';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { formatNumber } from '@/lib/format/datetime';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { loadDataCollection } from '@/lib/services/ssbj-gap';
import type { DataPointStatus } from '@/types/domain';

export const metadata = { title: 'SSBJ データ収集' };

export default async function SsbjCollectionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const rows = await loadDataCollection(shell.db, shell.ctx, shell.currentPeriod);

  const submitted = rows.filter((r) => r.collectedStatus === 'approved').length;
  const rate = rows.length === 0 ? 0 : Math.round((submitted / rows.length) * 100);
  const overdue = rows.filter(
    (r) => r.daysLeft !== null && r.daysLeft < 0 && r.collectedStatus !== 'approved',
  );

  return (
    <>
      <PageHeader
        title="SSBJ データ収集"
        description={`${shell.currentPeriod.label} ／ 対応計画から作成したデータ項目の収集状況`}
        breadcrumbs={[
          { label: '企業ワークスペース' },
          { label: '開示対応' },
          { label: 'SSBJ', href: '/enterprise/disclosures/ssbj' },
          { label: 'データ収集' },
        ]}
        actions={
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" asChild>
              <Link href="/enterprise/imports">
                <Upload aria-hidden="true" />
                ファイルを取り込む
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href="/enterprise/disclosures/ssbj/plans">
                <ArrowLeft aria-hidden="true" />
                対応計画へ戻る
              </Link>
            </Button>
          </div>
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        <div className="grid grid-cols-4 gap-2">
          <Card className="space-y-1 p-2.5">
            <p className="text-[11px] text-ink-muted">収集対象</p>
            <p className="text-[20px] font-semibold leading-none tabular-nums text-ink">
              {rows.length}
            </p>
          </Card>
          <Card className="space-y-1 p-2.5">
            <p className="text-[11px] text-ink-muted">承認済み</p>
            <p className="text-[20px] font-semibold leading-none tabular-nums text-ink">
              {submitted}
            </p>
          </Card>
          <Card className="space-y-1 p-2.5">
            <p className="text-[11px] text-ink-muted">期限超過</p>
            <p
              className={`text-[20px] font-semibold leading-none tabular-nums ${
                overdue.length > 0 ? 'text-danger' : 'text-ink'
              }`}
            >
              {overdue.length}
            </p>
          </Card>
          <Card className="space-y-1.5 p-2.5">
            <p className="text-[11px] text-ink-muted">収集の進捗</p>
            <div className="flex items-center gap-1.5">
              <Progress
                value={rate}
                tone={rate >= 80 ? 'success' : rate >= 50 ? 'warning' : 'danger'}
                label={`収集の進捗 ${rate}%`}
              />
              <span className="text-[13px] font-semibold tabular-nums text-ink">{rate}%</span>
            </div>
          </Card>
        </div>

        <Card className="overflow-hidden">
          <SectionTitle
            title={`データ項目（${rows.length}）`}
            action={
              <span className="text-[11px] text-ink-muted">
                対応計画で「データ収集項目を作成」したものが並びます
              </span>
            }
          />
          {rows.length === 0 ? (
            <EmptyState
              title="収集対象のデータ項目がありません"
              description="対応計画の画面で、データギャップから「データ収集項目を作成」してください。"
              action={
                <Button size="sm" asChild>
                  <Link href="/enterprise/disclosures/ssbj/plans">
                    <ClipboardList aria-hidden="true" />
                    対応計画へ
                  </Link>
                </Button>
              }
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>データ項目</TH>
                  <TH>集計対象範囲</TH>
                  <TH>入力担当者</TH>
                  <TH>提出期限</TH>
                  <TH align="right">収集済みの値</TH>
                  <TH>収集状況</TH>
                  <TH>元の対応計画</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((row) => (
                  <TR key={`${row.plan.id}-${row.metricCode}-${row.unitName}`}>
                    <TD className="font-medium text-ink">
                      {row.metricName}
                      <span className="ml-1 font-mono text-[11px] text-ink-muted">
                        {row.metricCode}
                      </span>
                    </TD>
                    <TD>{row.unitName}</TD>
                    <TD className="text-[11px]">{row.ownerName ?? '未設定'}</TD>
                    <TD className="text-[11px]">
                      {row.dueDate ?? '未設定'}
                      {row.daysLeft !== null && row.collectedStatus !== 'approved' && (
                        <span
                          className={
                            row.daysLeft < 0
                              ? 'ml-1 font-medium text-danger'
                              : 'ml-1 text-ink-muted'
                          }
                        >
                          {row.daysLeft < 0
                            ? `${Math.abs(row.daysLeft)} 日超過`
                            : `残り ${row.daysLeft} 日`}
                        </span>
                      )}
                    </TD>
                    <TD align="right">
                      {row.collectedValue === null ? (
                        <span className="text-ink-muted">未入力</span>
                      ) : (
                        <>
                          {formatNumber(row.collectedValue)}
                          <span className="ml-1 text-[11px] text-ink-muted">{row.unit}</span>
                        </>
                      )}
                    </TD>
                    <TD>
                      {row.collectedStatus === null ? (
                        <Badge tone="warning">未入力</Badge>
                      ) : (
                        <DataPointStatusBadge status={row.collectedStatus as DataPointStatus} />
                      )}
                    </TD>
                    <TD className="max-w-[220px] text-[11px] text-ink-muted">{row.plan.title}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
