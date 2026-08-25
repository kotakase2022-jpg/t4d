import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAppMode } from '@/lib/config';
import { AlertTriangle, FileWarning } from 'lucide-react';
import { AiGeneratedBadge, JobStatusBadge } from '@/components/shared/badges';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { formatEstimatedCostUsd, formatJst } from '@/lib/format/datetime';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { JobPoller } from './job-poller';
import { ImportPreviewTable } from '../preview-table';
import { ImportPreviewFallback } from './preview-fallback';

export const metadata = { title: '取込プレビュー' };

export default async function ImportJobPage({
  params,
  searchParams,
}: {
  params: Promise<{ jobId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { jobId } = await params;
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;

  const job = await db.findById('ingestionJobs', jobId);

  // Demo Mode は状態がプロセスのメモリにしか無いため、Vercel で別インスタンスへ
  // 振り分けられるとジョブが見つからない（known-limitations D-3）。
  // 投入したブラウザは取込内容を持っているので、そこから同じ画面を描く。
  // **取込直後（created=1）に限る**。それ以外は存在秘匿のため 404 のままにする。
  if (!job && getAppMode() === 'demo' && query.created === '1') {
    const fallbackShell = await loadEnterpriseShell();
    return (
      <>
        <PageHeader
          title="取込プレビュー"
          description="このタブが保持している取込内容を表示しています"
          breadcrumbs={[
            { label: '企業ワークスペース' },
            { label: 'データ収集', href: '/enterprise/imports' },
            { label: jobId.slice(0, 8) },
          ]}
        />
        <div className="space-y-3 p-4">
          <ImportPreviewFallback
            jobId={jobId}
            metrics={fallbackShell.metrics.map((m) => ({ id: m.id, name: m.name }))}
            units={fallbackShell.units
              .filter(
                (u) =>
                  u.unitType !== 'supplier' &&
                  (fallbackShell.ctx.workspace.unitScopeIds.length === 0 ||
                    fallbackShell.ctx.workspace.unitScopeIds.includes(u.id)),
              )
              .map((u) => ({ id: u.id, name: u.name }))}
          />
        </div>
      </>
    );
  }

  if (!job || job.organizationId !== ctx.workspace.organizationId) notFound();

  const [jobFiles, rows] = await Promise.all([
    db.select('ingestionJobFiles', { where: { jobId } }),
    db.select('ingestionRows', { where: { jobId }, orderBy: { column: 'rowIndex' } }),
  ]);

  const aiRunId = rows.find((r) => r.aiRunId)?.aiRunId ?? null;
  const aiRun = aiRunId ? await db.findById('aiRuns', aiRunId) : null;

  const period = shell.periods.find((p) => p.id === job.reportingPeriodId);
  // 担当範囲外の拠点を選べてしまうと、確定時に権限エラーで全画面エラーになる。
  // 投入画面（imports/page.tsx）と同じ条件で絞る。
  const editableUnits = shell.units.filter(
    (u) =>
      u.unitType !== 'supplier' &&
      (shell.ctx.workspace.unitScopeIds.length === 0 ||
        shell.ctx.workspace.unitScopeIds.includes(u.id)),
  );
  const pendingRows = rows.filter((r) => r.status !== 'confirmed' && r.status !== 'rejected');
  const confirmed = rows.filter((r) => r.status === 'confirmed').length;

  return (
    <>
      <PageHeader
        title={`取込ジョブ ${job.id.slice(0, 8)}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <JobStatusBadge status={job.status} />
            {aiRun && <AiGeneratedBadge provider={aiRun.provider} />}
            <span>
              {period?.label} ／ {jobFiles.length} ファイル ／ {rows.length} 行
            </span>
          </span>
        }
        breadcrumbs={[
          { label: '企業ワークスペース' },
          { label: 'データ収集', href: '/enterprise/imports' },
          { label: job.id.slice(0, 8) },
        ]}
      />

      <div className="space-y-3 p-4">
        <Card>
          <div className="p-3">
            <JobPoller
              jobId={job.id}
              initialStatus={job.status}
              initialProgress={job.progressPercent}
            />
          </div>
        </Card>

        <Card>
          <SectionTitle title="ファイル解析結果" />
          <Table>
            <THead>
              <TR>
                <TH>ファイル名</TH>
                <TH>解析</TH>
                <TH>シート</TH>
                <TH>文字コード</TH>
                <TH>メッセージ</TH>
              </TR>
            </THead>
            <TBody>
              {jobFiles.map((file) => (
                <TR key={file.id}>
                  <TD className="font-medium">{file.originalName}</TD>
                  <TD>
                    {file.parseStatus === 'parsed' && <Badge tone="success">解析済み</Badge>}
                    {file.parseStatus === 'needs_ocr' && (
                      <Badge tone="warning">
                        <FileWarning className="size-3" aria-hidden="true" />
                        OCR／AI解析要確認
                      </Badge>
                    )}
                    {file.parseStatus === 'failed' && <Badge tone="danger">失敗</Badge>}
                    {file.parseStatus === 'pending' && <Badge tone="neutral">待機中</Badge>}
                  </TD>
                  <TD>{file.sheetName ?? '—'}</TD>
                  <TD>{file.detectedEncoding ?? '—'}</TD>
                  <TD className="text-[11px] text-ink-muted">{file.parseMessage ?? '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>

        {job.status === 'failed' && (
          <Card className="border-danger/40 bg-danger-soft">
            <div className="flex items-start gap-2 p-3 text-[12px] text-danger">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <div>
                <p className="font-medium">取込に失敗しました（{job.errorCode}）</p>
                <p>{job.errorMessage}</p>
                <p className="mt-1 text-ink-muted">再試行回数: {job.retryCount}</p>
              </div>
            </div>
          </Card>
        )}

        <Card className="overflow-hidden">
          <SectionTitle
            title={`取込プレビュー（${pendingRows.length} 行）`}
            action={
              confirmed > 0 ? (
                <span className="text-[12px] text-success">{confirmed} 行を確定済み</span>
              ) : undefined
            }
          />

          {pendingRows.length === 0 ? (
            <EmptyState
              title={
                rows.length === 0 ? '取り込める表データがありません' : 'すべての行を処理しました'
              }
              description={
                rows.length === 0
                  ? 'PDF のみの取込では表データは生成されません。抽出テキストは Evidence として利用できます。'
                  : undefined
              }
              action={
                <Button asChild size="sm">
                  <Link href="/enterprise/data">非財務データへ</Link>
                </Button>
              }
            />
          ) : (
            <ImportPreviewTable
              jobId={job.id}
              reportingPeriodId={job.reportingPeriodId}
              rows={pendingRows.map((row) => ({
                id: row.id,
                rowIndex: row.rowIndex,
                raw: row.raw,
                sourceLocator: row.sourceLocator,
                metricId: row.metricId,
                unitId: row.unitId,
                value: row.value,
                unitOfMeasure: row.unitOfMeasure,
                confidence: row.confidence,
                warnings: row.warnings,
                status: row.status,
              }))}
              metrics={shell.metrics.map((m) => ({ id: m.id, name: m.name }))}
              units={editableUnits.map((u) => ({ id: u.id, name: u.name }))}
            />
          )}
        </Card>

        {aiRun && (
          <Card>
            <SectionTitle title="AI 実行記録（Provenance）" />
            <div className="grid grid-cols-4 gap-x-6 px-3 pb-3 text-[12px]">
              <Meta label="Provider" value={aiRun.provider} />
              <Meta label="Model" value={aiRun.model} />
              <Meta label="Prompt Version" value={aiRun.promptVersion} />
              <Meta label="確信度" value={`${Math.round(aiRun.confidence * 100)}%`} />
              <Meta label="Latency" value={`${aiRun.latencyMs} ms`} />
              <Meta label="Token" value={`${aiRun.tokenUsage.total}`} />
              <Meta label="推定コスト" value={formatEstimatedCostUsd(aiRun.estimatedCostUsd)} />
              <Meta label="実行日時" value={formatJst(aiRun.createdAt)} />
            </div>
            {aiRun.warnings.length > 0 && (
              <ul className="border-t border-line px-3 py-2">
                {aiRun.warnings.map((w, i) => (
                  <li key={i} className="text-[11px] text-[#8a5d00]">
                    ⚠ {w}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 border-b border-line py-1">
      <span className="text-ink-muted">{label}</span>
      <span className="truncate text-ink">{value}</span>
    </div>
  );
}
