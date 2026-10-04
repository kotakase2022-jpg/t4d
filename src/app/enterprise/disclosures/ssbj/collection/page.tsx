import Link from 'next/link';
import {
  ArrowLeft,
  CalendarClock,
  CircleCheck,
  ClipboardList,
  Clock,
  FileText,
  RotateCcw,
  Upload,
} from 'lucide-react';
import { StatusBreakdown } from '@/components/charts/status-breakdown';
import { DataPointStatusBadge } from '@/components/shared/badges';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { formatNumber } from '@/lib/format/datetime';
import { loadApprovalProgressMap } from '@/lib/services/approval-route';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { loadDataCollection } from '@/lib/services/ssbj-gap';
import type { DataPointStatus } from '@/types/domain';
import { collectionStatusItems } from '../_components/breakdown-items';

export const metadata = { title: 'SSBJ データ収集' };

export default async function SsbjCollectionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const rows = await loadDataCollection(shell.db, shell.ctx, shell.currentPeriod);

  // 取り込んだデータが今どの承認段階にいるかを、1 件ずつ問い合わせずまとめて読む
  const progressByDataPoint = await loadApprovalProgressMap(
    shell.db,
    shell.ctx,
    rows.map((r) => r.dataPointId).filter((id): id is string => Boolean(id)),
  );

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
            {/* データが集まったら開示ドラフトへ——次の工程を主導線として置く */}
            <Button size="sm" asChild>
              <Link href="/enterprise/disclosures/ssbj/draft">
                <FileText aria-hidden="true" />
                SSBJ 開示ドラフト
              </Link>
            </Button>
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

        {/* 収集の進捗。状態の内訳を 1 本の帯（合計 = 収集対象）にし、各区分を「n / 収集対象 件」で書く。
            期限超過は状態と重なるため帯の外に書く */}
        <Card className="space-y-2 p-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px]">
            <h2 className="text-[13px] font-semibold text-ink">収集の進捗</h2>
            <p className="flex items-baseline gap-1">
              <span className="text-ink-muted">収集対象</span>
              <span className="text-[20px] font-semibold leading-none tabular-nums text-ink">
                {rows.length}
              </span>
              <span className="text-ink-muted">件</span>
            </p>
            <p className="flex items-center gap-1">
              <CalendarClock className="size-3.5 text-ink-muted" aria-hidden="true" />
              <span className="text-ink-muted">期限超過</span>
              <span
                className={`font-semibold tabular-nums ${overdue.length > 0 ? 'text-danger' : 'text-ink'}`}
              >
                {overdue.length}
              </span>
              <span className="text-ink-muted">件（承認済み以外）</span>
            </p>
          </div>
          {rows.length > 0 && (
            <StatusBreakdown
              label="収集状況の内訳"
              items={collectionStatusItems(rows)}
              denominator={rows.length}
            />
          )}
        </Card>

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
                  <TH>承認の進み具合</TH>
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
                    <TD>
                      {(() => {
                        const progress = row.dataPointId
                          ? progressByDataPoint.get(row.dataPointId)
                          : undefined;
                        if (!row.dataPointId || !progress || progress.totalCount === 0) {
                          return <span className="text-[11px] text-ink-muted">—</span>;
                        }
                        return (
                          <Link
                            href={`/enterprise/data/${row.dataPointId}#承認履歴`}
                            className="block space-y-0.5 rounded-t4d px-1 py-0.5 hover:bg-surface-muted"
                          >
                            <span className="flex items-center gap-1.5">
                              {/* 色だけで状態を表さない。段数を必ず数字で書く */}
                              <span className="text-[12px] tabular-nums text-ink">
                                {progress.approvedCount} / {progress.totalCount} 段階
                              </span>
                              {progress.returnedStep ? (
                                <Badge tone="danger">
                                  <RotateCcw className="size-3" aria-hidden="true" />
                                  差し戻し
                                </Badge>
                              ) : progress.complete ? (
                                <Badge tone="success">
                                  <CircleCheck className="size-3" aria-hidden="true" />
                                  承認完了
                                </Badge>
                              ) : (
                                <Badge tone="warning">
                                  <Clock className="size-3" aria-hidden="true" />
                                  承認待ち
                                </Badge>
                              )}
                            </span>
                            <span className="block text-[11px] text-ink-muted">
                              {progress.returnedStep
                                ? `${progress.returnedStep.stageName} で差し戻し`
                                : progress.currentStep
                                  ? `次: ${progress.currentStep.stageName}（${progress.currentStep.department || '担当部署未設定'}）`
                                  : 'すべての段階で承認済み'}
                            </span>
                          </Link>
                        );
                      })()}
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
