import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAppMode } from '@/lib/config';
import { AlertTriangle, Check, FileWarning } from 'lucide-react';
import { AiGeneratedBadge, JobStatusBadge } from '@/components/shared/badges';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { formatEstimatedCostUsd, formatJst } from '@/lib/format/datetime';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { confirmImportAction } from '../../actions';
import { JobPoller } from './job-poller';

export const metadata = { title: '取込プレビュー' };

const ROW_STATUS_LABEL: Record<
  string,
  { label: string; tone: 'neutral' | 'brand' | 'success' | 'warning' | 'danger' }
> = {
  pending: { label: '未処理', tone: 'neutral' },
  mapped: { label: 'マッピング済み', tone: 'success' },
  needs_review: { label: '要確認', tone: 'warning' },
  duplicate: { label: '重複', tone: 'warning' },
  rejected: { label: '除外', tone: 'neutral' },
  confirmed: { label: '確定済み', tone: 'brand' },
};

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
  // 振り分けられるとジョブが見つからないことがある（known-limitations D-3）。
  // **取込直後（created=1）に限り**理由を示す。
  // それ以外は存在秘匿のため 404 のままにする（他人が URL を推測した場合の情報漏れを防ぐ）。
  if (!job && getAppMode() === 'demo' && query.created === '1') {
    return (
      <>
        <PageHeader
          title="取込ジョブ"
          description="この環境では取込結果を保持できませんでした"
          breadcrumbs={[
            { label: '企業ワークスペース' },
            { label: 'データ収集', href: '/enterprise/imports' },
            { label: jobId.slice(0, 8) },
          ]}
        />
        <div className="p-4">
          <Card className="p-4">
            <p className="text-[13px] text-ink">
              デモ環境（Demo Mode）は取込結果をサーバーのメモリに保持します。
              サーバーが複数ある構成では、直後の画面表示が別のサーバーへ割り振られると
              結果を参照できないことがあります。
            </p>
            <p className="mt-2 text-[12px] text-ink-muted">
              直近の操作はブラウザの Cookie に控えていますが、Cookie の上限（約 4KB）があるため、
              おおよそ 25 行を超える取込は保持できません。
              お手数ですが、ファイルを分けて取り込んでください（2 ファイル程度なら保持されます）。
            </p>
            <p className="mt-2 text-[12px] text-ink-muted">
              実 Supabase
              へ接続した環境ではこの制限はありません（ファイル数・行数の制限なく取り込めます）。
            </p>
            <div className="mt-3">
              <Button size="sm" variant="outline" asChild>
                <Link href="/enterprise/imports">データ収集へ戻る</Link>
              </Button>
            </div>
          </Card>
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
  const editableUnits = shell.units.filter((u) => u.unitType !== 'supplier');
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
            <form action={confirmImportAction}>
              <input type="hidden" name="jobId" value={job.id} />
              <div className="t4d-scroll-x">
                <Table className="t4d-sticky-head">
                  <THead>
                    <TR>
                      <TH className="w-10">取込</TH>
                      <TH>元データ</TH>
                      <TH className="w-[200px]">指標</TH>
                      <TH className="w-[160px]">組織</TH>
                      <TH className="w-[120px]">値</TH>
                      <TH className="w-[90px]">単位</TH>
                      <TH className="w-[90px]">信頼度</TH>
                      <TH>状態・警告</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {pendingRows.map((row) => {
                      const status = ROW_STATUS_LABEL[row.status] ?? ROW_STATUS_LABEL.pending;
                      return (
                        <TR key={row.id}>
                          <TD>
                            <input type="hidden" name="rowId" value={row.id} />
                            <input
                              type="checkbox"
                              name={`include:${row.id}`}
                              defaultChecked={row.status === 'mapped'}
                              aria-label={`行 ${row.rowIndex} を取り込む`}
                              className="size-3.5 accent-[#0b57a4]"
                            />
                          </TD>
                          <TD className="max-w-[240px]">
                            <div className="truncate text-[11px] text-ink-muted">
                              {Object.entries(row.raw)
                                .map(([k, v]) => `${k}: ${v}`)
                                .join(' / ')}
                            </div>
                            <div className="text-[11px] text-ink-muted">{row.sourceLocator}</div>
                          </TD>
                          <TD>
                            <select
                              name={`metricId:${row.id}`}
                              defaultValue={row.metricId ?? ''}
                              aria-label={`行 ${row.rowIndex} の指標`}
                              className="h-7 w-full rounded-t4d border border-line bg-surface px-1 text-[12px]"
                            >
                              <option value="">（未選択）</option>
                              {shell.metrics.map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.name}
                                </option>
                              ))}
                            </select>
                          </TD>
                          <TD>
                            <select
                              name={`unitId:${row.id}`}
                              defaultValue={row.unitId ?? ''}
                              aria-label={`行 ${row.rowIndex} の組織`}
                              className="h-7 w-full rounded-t4d border border-line bg-surface px-1 text-[12px]"
                            >
                              <option value="">（未選択）</option>
                              {editableUnits.map((u) => (
                                <option key={u.id} value={u.id}>
                                  {u.name}
                                </option>
                              ))}
                            </select>
                          </TD>
                          <TD>
                            <input
                              name={`value:${row.id}`}
                              defaultValue={row.value ?? ''}
                              inputMode="decimal"
                              aria-label={`行 ${row.rowIndex} の値`}
                              className="tnum h-7 w-full rounded-t4d border border-line px-1 text-right text-[12px]"
                            />
                          </TD>
                          <TD>
                            <input
                              name={`unitOfMeasure:${row.id}`}
                              defaultValue={row.unitOfMeasure ?? ''}
                              aria-label={`行 ${row.rowIndex} の単位`}
                              className="h-7 w-full rounded-t4d border border-line px-1 text-[12px]"
                            />
                          </TD>
                          <TD>
                            <span
                              className={
                                row.confidence >= 0.7
                                  ? 'tnum text-success'
                                  : row.confidence >= 0.4
                                    ? 'tnum text-[#8a5d00]'
                                    : 'tnum text-danger'
                              }
                            >
                              {Math.round(row.confidence * 100)}%
                            </span>
                          </TD>
                          <TD>
                            <Badge tone={status?.tone ?? 'neutral'}>{status?.label}</Badge>
                            {row.warnings.length > 0 && (
                              <ul className="mt-0.5 space-y-0.5">
                                {row.warnings.map((w, i) => (
                                  <li key={i} className="text-[11px] text-[#8a5d00]">
                                    ⚠ {w}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </TD>
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2">
                <p className="text-[11px] text-ink-muted">
                  確定すると Data Point 台帳へ反映されます（既存データがある場合は新しい Version
                  が追加されます）。AI の推定は候補であり、確定は人が行います。
                </p>
                <Button type="submit" size="sm">
                  <Check aria-hidden="true" />
                  選択した行を確定
                </Button>
              </div>
            </form>
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
