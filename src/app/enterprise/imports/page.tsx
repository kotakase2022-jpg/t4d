import Link from 'next/link';
import { Calculator, ChevronRight, ClipboardPaste, FileSpreadsheet, FileText } from 'lucide-react';
import { JobStatusBadge } from '@/components/shared/badges';
import { UploadForm } from './upload-form';
import { DemoSimulationNotice } from '@/components/shared/demo-simulation-notice';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { SubmitButton } from '@/components/ui/submit-button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { getAppMode } from '@/lib/config';
import { formatJst } from '@/lib/format/datetime';
import { isDisclosureFirstEnabled } from '@/lib/services/feature-settings';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { pasteImportAction } from '../actions';

export const metadata = { title: 'データ取込' };

export default async function ImportsPage() {
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;

  const [jobs, disclosureFirst] = await Promise.all([
    db.select('ingestionJobs', {
      where: { organizationId: ctx.workspace.organizationId },
      orderBy: { column: 'createdAt', dir: 'desc' },
      limit: 30,
    }),
    isDisclosureFirstEnabled(db, ctx),
  ]);

  const unitById = new Map(shell.units.map((u) => [u.id, u]));
  const periodById = new Map(shell.periods.map((p) => [p.id, p]));
  const editableUnits = shell.units.filter(
    (u) =>
      u.unitType !== 'supplier' &&
      (ctx.workspace.unitScopeIds.length === 0 || ctx.workspace.unitScopeIds.includes(u.id)),
  );

  return (
    <>
      {/* 名称は「データ取込」。開示対応側の「SSBJ データ収集」と役割が紛れないようにする */}
      <PageHeader
        title="データ取込"
        description="Excel / CSV / PDF を取り込み、AI が組織・期間・指標・単位・値・根拠箇所を推定します。取込は非同期ジョブとして実行されます。"
        breadcrumbs={[{ label: '企業ワークスペース' }, { label: 'データ取込' }]}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/enterprise/disclosures/ssbj/draft">
              <FileText aria-hidden="true" />
              SSBJ 開示ドラフト
            </Link>
          </Button>
        }
      />

      <div className="space-y-3 p-4">
        {/* 情報取り込みの入り口は 2 つ（§6.4）。数値は決まった形で登録し、定性情報は資料として登録する。
            開示優先モードが OFF の組織は従来の画面のまま（入り口の追加は開示優先モードの構成。A39） */}
        {disclosureFirst && (
          <nav aria-label="登録の入り口" className="grid gap-3 md:grid-cols-2">
            {[
              {
                href: '/enterprise/imports/standard',
                title: '数値を登録（CSV・手入力）',
                description:
                  '標準 CSV・貼り付け・手入力で登録します。検証 → 差分の確認 → 登録確定の順に進みます。',
                Icon: Calculator,
              },
              {
                href: '/enterprise/evidence?purpose=qualitative',
                title: '定性情報の資料を登録',
                description:
                  '方針・体制・リスクの説明などの資料を、利用目的（当年度の根拠・過年度の記載など）を指定して登録します。',
                Icon: FileText,
              },
            ].map((entry) => (
              <Link
                key={entry.href}
                href={entry.href}
                className="group flex items-start gap-3 rounded-t4d-lg border border-line bg-surface px-4 py-3 transition-colors hover:border-brand-300 hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-100"
              >
                <entry.Icon className="mt-0.5 size-5 shrink-0 text-brand-600" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold text-ink">{entry.title}</span>
                  <span className="mt-0.5 block text-[12px] text-ink-muted">
                    {entry.description}
                  </span>
                </span>
                <ChevronRight
                  className="mt-1 size-4 shrink-0 text-ink-muted group-hover:text-brand-700"
                  aria-hidden="true"
                />
              </Link>
            ))}
          </nav>
        )}

        {getAppMode() === 'demo' && <DemoSimulationNotice />}
        {can(ctx, 'enterprise.import.run') && (
          <Card>
            <SectionTitle
              title="ファイルを取り込む"
              action={
                <Button variant="outline" size="xs" asChild>
                  <a href={`/api/exports/template?period=${shell.currentPeriod.id}`} download>
                    <FileSpreadsheet aria-hidden="true" />
                    標準テンプレートをダウンロード
                  </a>
                </Button>
              }
            />
            <UploadForm
              reportingPeriodId={shell.currentPeriod.id}
              reportingPeriodLabel={shell.currentPeriod.label}
              units={editableUnits.map((u) => ({ id: u.id, name: u.name }))}
            />
          </Card>
        )}

        {can(ctx, 'enterprise.import.run') && (
          <Card>
            <SectionTitle title="コピペ表入力（Excel からそのまま貼り付け）" />
            <form action={pasteImportAction} className="space-y-2 p-3">
              <Textarea
                name="pasted"
                rows={5}
                required
                placeholder={
                  'Excel で範囲をコピーして、ここへ貼り付けてください（タブ区切りのまま）。\n例:\n拠点\t項目\t値\t単位\n東日本工場\t電力使用量\t18234.5\tMWh'
                }
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-ink-muted">
                  ファイルと同じ経路（AI 仕分け → プレビュー → 確定）で取り込まれます。
                </span>
                <SubmitButton
                  size="sm"
                  icon={<ClipboardPaste aria-hidden="true" />}
                  pendingLabel="解析中…"
                >
                  貼り付け内容を取り込む
                </SubmitButton>
              </div>
            </form>
          </Card>
        )}

        <Card className="overflow-hidden">
          <SectionTitle title={`取込ジョブ（${jobs.length}）`} />
          {jobs.length === 0 ? (
            <EmptyState
              title="取込ジョブがありません"
              description="上のフォームからファイルを取り込んでください。"
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>ジョブ</TH>
                  <TH>対象</TH>
                  <TH>状態</TH>
                  <TH className="w-[140px]">進捗</TH>
                  <TH align="right">総行数</TH>
                  <TH align="right">要確認</TH>
                  <TH>開始</TH>
                  <TH className="w-16" aria-label="操作" />
                </TR>
              </THead>
              <TBody>
                {jobs.map((job) => (
                  <TR key={job.id}>
                    <TD>
                      <Link
                        href={`/enterprise/imports/${job.id}`}
                        className="font-mono text-[12px] text-brand-700 hover:underline"
                      >
                        {job.id.slice(0, 8)}
                      </Link>
                      {job.errorMessage && (
                        <div className="text-[11px] text-danger">{job.errorMessage}</div>
                      )}
                    </TD>
                    <TD>
                      {job.unitId ? (unitById.get(job.unitId)?.name ?? '—') : '自動判定'}
                      <span className="ml-1 text-[11px] text-ink-muted">
                        {periodById.get(job.reportingPeriodId)?.code}
                      </span>
                    </TD>
                    <TD>
                      <JobStatusBadge status={job.status} />
                    </TD>
                    <TD>
                      <Progress
                        value={job.progressPercent}
                        label={`ジョブ ${job.id.slice(0, 8)} の進捗`}
                        tone={job.status === 'failed' ? 'danger' : 'brand'}
                      />
                    </TD>
                    <TD align="right">{job.totalRows}</TD>
                    <TD align="right">
                      {job.warningRows > 0 ? (
                        <span className="font-medium text-[#8a5d00]">{job.warningRows}</span>
                      ) : (
                        0
                      )}
                    </TD>
                    <TD className="whitespace-nowrap text-[11px] text-ink-muted">
                      {formatJst(job.createdAt)}
                    </TD>
                    <TD>
                      <Button variant="ghost" size="xs" asChild>
                        <Link href={`/enterprise/imports/${job.id}`}>開く</Link>
                      </Button>
                    </TD>
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
