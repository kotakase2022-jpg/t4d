import Link from 'next/link';
import { ClipboardPaste, FileSpreadsheet, FileUp, Upload } from 'lucide-react';
import { JobStatusBadge } from '@/components/shared/badges';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { formatJst } from '@/lib/format/datetime';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { pasteImportAction, uploadFilesAction } from '../actions';

export const metadata = { title: 'データ収集' };

export default async function ImportsPage() {
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;

  const jobs = await db.select('ingestionJobs', {
    where: { organizationId: ctx.workspace.organizationId },
    orderBy: { column: 'createdAt', dir: 'desc' },
    limit: 30,
  });

  const unitById = new Map(shell.units.map((u) => [u.id, u]));
  const periodById = new Map(shell.periods.map((p) => [p.id, p]));
  const editableUnits = shell.units.filter(
    (u) =>
      u.unitType !== 'supplier' &&
      (ctx.workspace.unitScopeIds.length === 0 || ctx.workspace.unitScopeIds.includes(u.id)),
  );

  return (
    <>
      <PageHeader
        title="データ収集"
        description="Excel / CSV / PDF を取り込み、AI が組織・期間・指標・単位・値・根拠箇所を推定します。取込は非同期ジョブとして実行されます。"
        breadcrumbs={[{ label: '企業ワークスペース' }, { label: 'データ収集' }]}
      />

      <div className="space-y-3 p-4">
        {can(ctx, 'enterprise.import.run') && (
          <Card>
            <SectionTitle
              title="ファイルを取り込む"
              action={
                <Button variant="outline" size="xs" asChild>
                  <a href="/api/exports/template" download>
                    <FileSpreadsheet aria-hidden="true" />
                    標準テンプレートをダウンロード
                  </a>
                </Button>
              }
            />
            <form action={uploadFilesAction} className="space-y-3 p-3">
              <input type="hidden" name="reportingPeriodId" value={shell.currentPeriod.id} />

              <div className="flex items-end gap-3">
                <label className="text-[12px] text-ink-muted">
                  対象組織・拠点
                  <select
                    name="unitId"
                    defaultValue={editableUnits[0]?.id ?? 'auto'}
                    className="mt-0.5 block h-7 w-[220px] rounded-t4d border border-line bg-surface px-2 text-[13px]"
                  >
                    <option value="auto">ファイル内容から自動判定</option>
                    {editableUnits.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="pb-1 text-[12px] text-ink-muted">
                  対象期間: <span className="text-ink">{shell.currentPeriod.label}</span>
                </p>
              </div>

              <label
                htmlFor="import-files"
                className="flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-t4d-lg border-2 border-dashed border-line bg-surface-muted px-4 py-8 text-center transition-colors hover:border-brand-400 hover:bg-brand-50"
              >
                <FileUp className="size-6 text-brand-600" aria-hidden="true" />
                <span className="text-[13px] font-medium text-ink">
                  クリックしてファイルを選択（複数可）
                </span>
                <span className="text-[11px] text-ink-muted">
                  対応形式: .csv / .tsv / .xlsx / .xlsm / .pdf / .docx ／ 1 ファイル 25MB まで
                </span>
                <input
                  id="import-files"
                  type="file"
                  name="files"
                  multiple
                  accept=".csv,.tsv,.xlsx,.xlsm,.pdf,.docx,text/csv,text/tab-separated-values,application/pdf"
                  className="sr-only"
                />
              </label>

              <div className="flex items-center gap-2">
                <Button type="submit" size="sm">
                  <Upload aria-hidden="true" />
                  取込を開始
                </Button>
                <span className="text-[11px] text-ink-muted">
                  アップロード後は取込ジョブ画面へ移動し、進捗が表示されます。
                  テンプレートに記入したファイルもここへドロップしてください。
                </span>
              </div>
            </form>
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
                <Button type="submit" size="sm">
                  <ClipboardPaste aria-hidden="true" />
                  貼り付け内容を取り込む
                </Button>
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
