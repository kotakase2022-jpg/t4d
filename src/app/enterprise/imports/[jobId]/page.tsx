import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAppMode } from '@/lib/config';
import { ArrowRight, FileText } from 'lucide-react';
import { JobStatusBadge } from '@/components/shared/badges';
import { DemoSimulationNotice } from '@/components/shared/demo-simulation-notice';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { Notice } from '@/components/shared/notice';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { SemanticBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/states';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { formatEstimatedCostUsd, formatJst } from '@/lib/format/datetime';
import { displayRunConfidence, withDisplayConfidence } from '@/lib/imports/demo-display';
import { loadEnterpriseShell } from '@/lib/services/shell';
import type { StatusSemantic } from '@/lib/ui/status/registry';
import type { IngestionJobFile } from '@/types/domain';
import { JobPoller } from './job-poller';
import { ImportPreviewTable } from '../preview-table';
import { importJobTitle } from '../job-title';
import { ImportPreviewFallback } from './preview-fallback';

export const metadata = { title: '取込の確認' };

/** ファイルの解析の状態（ラベル＋アイコン。色だけにしない） */
const PARSE_STATUS: Record<
  IngestionJobFile['parseStatus'],
  { label: string; semantic: StatusSemantic }
> = {
  parsed: { label: '解析済み', semantic: 'done' },
  needs_ocr: { label: 'OCR／AI解析要確認', semantic: 'pending' },
  failed: { label: '失敗', semantic: 'error' },
  pending: { label: '待機中', semantic: 'todo' },
};

/** 取込のあとの次の工程（開示ドラフト）。毎回は使わないので「その他」へ（plan S15） */
const MORE_ACTIONS = [
  {
    kind: 'link' as const,
    id: 'ssbj-draft',
    label: 'SSBJ 開示ドラフト',
    icon: <FileText className="size-3.5" aria-hidden="true" />,
    href: '/enterprise/disclosures/ssbj/draft',
  },
];

/**
 * 取込の確認（旧「取込ジョブ {ID}」。plan S15）。見出しは「{ファイル名} の取込確認」。
 *
 * - 状態で primary を決める: 要確認の行があるときは表の「選択した行を確定」が primary（行内編集の表は
 *   そのまま。最良の一括編集 UI）。すべて処理したあとは「次へ: 非財務データで確認」
 * - AI の実行記録（提供元・モデル・プロンプトの版など）は閉じた節（L2。§1.17 の語）
 * - デモであること・AI の推定は候補であることは見出しの近くに常に見せる
 */
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
          title="取込の確認"
          description="このタブが保持している取込内容を表示しています"
          breadcrumbs={[
            { label: '企業ワークスペース' },
            { label: 'データ取込', href: '/enterprise/imports' },
            { label: '取込の確認' },
          ]}
          actions={<PageActions more={MORE_ACTIONS} />}
        />
        <div className="space-y-3 p-4">
          <DemoSimulationNotice />
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
  const title = `${importJobTitle(jobFiles.map((f) => f.originalName))} の取込確認`;

  return (
    <>
      <PageHeader
        title={title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <JobStatusBadge status={job.status} />
            {/* AI の推定は候補（確定は人）。デモでは Mock の出力であることを隠さない */}
            {aiRun && (
              <HonestyBadge kind={aiRun.provider === 'mock' ? 'mock-ai' : 'ai-candidate'} />
            )}
            <span>
              {period?.label} ／ {jobFiles.length} ファイル ／ {rows.length} 行
            </span>
          </span>
        }
        breadcrumbs={[
          { label: '企業ワークスペース' },
          { label: 'データ取込', href: '/enterprise/imports' },
          { label: title },
        ]}
        actions={<PageActions more={MORE_ACTIONS} />}
      />

      <div className="space-y-3 px-4 pb-4 pt-3">
        {getAppMode() === 'demo' && <DemoSimulationNotice />}
        <JobPoller
          jobId={job.id}
          initialStatus={job.status}
          initialProgress={job.progressPercent}
        />

        {job.status === 'failed' && (
          <Notice tone="danger" title="取込に失敗しました">
            <p>{job.errorMessage}</p>
            <p className="mt-0.5 text-ink-muted">
              ファイルの形式・内容を確かめて、もう一度取り込んでください。続く場合は識別子「
              {job.errorCode}」を添えて管理者へ連絡してください（再試行回数: {job.retryCount}）。
            </p>
          </Notice>
        )}

        <Section title="ファイル解析結果">
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
              {jobFiles.map((file) => {
                const parse = PARSE_STATUS[file.parseStatus];
                return (
                  <TR key={file.id}>
                    <TD className="font-medium">{file.originalName}</TD>
                    <TD>
                      <SemanticBadge semantic={parse.semantic} label={parse.label} />
                    </TD>
                    <TD>{file.sheetName ?? '—'}</TD>
                    <TD>{file.detectedEncoding ?? '—'}</TD>
                    <TD className="text-caption text-ink-muted">{file.parseMessage ?? '—'}</TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </Section>

        <Section
          title={`取込プレビュー（${pendingRows.length} 行）`}
          summary={confirmed > 0 ? `${confirmed} 行を確定済み` : undefined}
        >
          {pendingRows.length === 0 ? (
            rows.length === 0 ? (
              <EmptyState
                kind="not-applicable"
                size="compact"
                title="取り込める表データがありません"
                description="PDF のみの取込では表データは生成されません。抽出テキストは資料として利用できます。"
                action={
                  <Link
                    href="/enterprise/evidence"
                    className="text-small font-medium text-brand-700 hover:underline"
                  >
                    資料を見る
                  </Link>
                }
              />
            ) : (
              // すべて処理済み: 次の工程（非財務データで確認）へ。開示ドラフトは「その他」
              <Notice
                tone="success"
                title="すべての行を処理しました"
                action={
                  <Link
                    href="/enterprise/data"
                    className="inline-flex items-center gap-1 text-small font-medium text-brand-800 underline"
                  >
                    次へ: 非財務データで確認
                    <ArrowRight className="size-3.5" aria-hidden="true" />
                  </Link>
                }
              >
                確定した行は非財務データ（台帳）に反映されています。
              </Notice>
            )
          ) : (
            <div className="rounded-t4d-lg border border-line bg-surface">
              <ImportPreviewTable
                jobId={job.id}
                reportingPeriodId={job.reportingPeriodId}
                rows={withDisplayConfidence(
                  pendingRows.map((row) => ({
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
                  })),
                )}
                metrics={shell.metrics.map((m) => ({ id: m.id, name: m.name }))}
                units={editableUnits.map((u) => ({ id: u.id, name: u.name }))}
              />
            </div>
          )}
        </Section>

        {aiRun && (
          <Section
            id="ai-run"
            collapsible
            title="AI の実行記録"
            summary={`提供元・モデル・プロンプトの版・応答時間など（実行 ${formatJst(aiRun.createdAt)}）`}
          >
            <div className="grid grid-cols-4 gap-x-6 text-small">
              <Meta
                label="提供元"
                value={aiRun.provider === 'mock' ? 'デモ生成（Mock）' : 'OpenAI'}
              />
              <Meta label="モデル" value={aiRun.model} />
              <Meta label="プロンプトの版" value={aiRun.promptVersion} />
              {(() => {
                const run = displayRunConfidence(aiRun.id, aiRun.confidence);
                return (
                  <Meta
                    label="確信度"
                    value={`${Math.round((run.displayConfidence ?? aiRun.confidence) * 100)}%`}
                    hint={
                      run.confidenceSource === 'demo_simulated'
                        ? `実測スコア ${Math.round(aiRun.confidence * 100)}%（表示はデモ用シミュレーション）`
                        : getAppMode() === 'demo'
                          ? '実測値（指標を特定できず取り込み対象外へ畳んだ行を含む全行平均）'
                          : undefined
                    }
                  />
                );
              })()}
              <Meta label="応答時間" value={`${aiRun.latencyMs} ms`} />
              <Meta label="トークン数" value={`${aiRun.tokenUsage.total}`} />
              <Meta label="推定コスト" value={formatEstimatedCostUsd(aiRun.estimatedCostUsd)} />
              <Meta label="実行日時" value={formatJst(aiRun.createdAt)} />
            </div>
            {aiRun.warnings.length > 0 && (
              <ul className="mt-1 border-t border-line pt-1">
                {aiRun.warnings.map((w, i) => (
                  <li key={i} className="text-caption text-warning-ink">
                    <span aria-hidden="true">⚠</span> {w}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}
      </div>
    </>
  );
}

function Meta({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border-b border-line py-1">
      <div className="flex justify-between gap-2">
        <span className="text-ink-muted">{label}</span>
        <span className="truncate text-ink">{value}</span>
      </div>
      {/* 補足は title= に入れない（マウスでしか読めない）。文字で出す */}
      {hint && <p className="text-caption text-ink-muted">{hint}</p>}
    </div>
  );
}
