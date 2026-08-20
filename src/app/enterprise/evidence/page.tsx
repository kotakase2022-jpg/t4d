import Link from 'next/link';
import { FolderOpen, Upload } from 'lucide-react';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { formatJst } from '@/lib/format/datetime';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { uploadEvidenceAction } from '../actions';

export const metadata = { title: 'Evidence' };

export default async function EvidencePage() {
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const organizationId = ctx.workspace.organizationId;

  const [files, links] = await Promise.all([
    db.select('files', {
      where: { organizationId, deletedAt: { isNull: true } },
      orderBy: { column: 'createdAt', dir: 'desc' },
      limit: 100,
    }),
    db.select('evidenceLinks', { where: { organizationId } }),
  ]);

  const versionIds = files.map((f) => f.currentVersionId).filter((v): v is string => Boolean(v));
  const versions =
    versionIds.length > 0
      ? await db.select('fileVersions', { where: { id: { in: versionIds } } })
      : [];

  const linkCountByVersion = new Map<string, number>();
  for (const link of links) {
    linkCountByVersion.set(
      link.fileVersionId,
      (linkCountByVersion.get(link.fileVersionId) ?? 0) + 1,
    );
  }

  const periodById = new Map(shell.periods.map((p) => [p.id, p]));

  return (
    <>
      <PageHeader
        title="Evidence"
        description="Private Bucket に保存され、Download は短時間 Signed URL 経由のみです。閲覧・Download は監査ログへ記録されます。"
        breadcrumbs={[{ label: '企業ワークスペース' }, { label: 'Evidence' }]}
      />

      <div className="space-y-3 p-4">
        {can(ctx, 'enterprise.evidence.write') && (
          <Card>
            <SectionTitle title="Evidence を登録" />
            <form action={uploadEvidenceAction} className="flex flex-wrap items-end gap-3 p-3">
              <label className="text-[12px] text-ink-muted">
                ファイル
                <input
                  type="file"
                  name="file"
                  required
                  className="mt-0.5 block text-[12px] file:mr-2 file:rounded-t4d file:border file:border-line file:bg-surface file:px-2 file:py-1 file:text-[12px]"
                />
              </label>
              <label className="text-[12px] text-ink-muted">
                文書種別
                <Input name="documentType" placeholder="例: 請求書" className="mt-0.5 w-40" />
              </label>
              <label className="text-[12px] text-ink-muted">
                対象期間
                <select
                  name="reportingPeriodId"
                  defaultValue={shell.currentPeriod.id}
                  className="mt-0.5 block h-7 w-40 rounded-t4d border border-line bg-surface px-2 text-[13px]"
                >
                  {shell.periods.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.code}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit" size="sm">
                <Upload aria-hidden="true" />
                登録
              </Button>
            </form>
          </Card>
        )}

        <Card className="overflow-hidden">
          <SectionTitle title={`Evidence Library（${files.length}）`} />
          {files.length === 0 ? (
            <EmptyState
              title="Evidence がありません"
              icon={<FolderOpen className="size-5" aria-hidden="true" />}
            />
          ) : (
            <div className="t4d-scroll-x">
              <Table>
                <THead>
                  <TR>
                    <TH>ファイル名</TH>
                    <TH>文書種別</TH>
                    <TH>対象期間</TH>
                    <TH>機密区分</TH>
                    <TH>Bucket</TH>
                    <TH align="right">サイズ</TH>
                    <TH align="right">紐付け</TH>
                    <TH>スキャン</TH>
                    <TH>登録日時</TH>
                    <TH className="w-16" aria-label="操作" />
                  </TR>
                </THead>
                <TBody>
                  {files.map((file) => {
                    const version = versions.find((v) => v.id === file.currentVersionId);
                    return (
                      <TR key={file.id}>
                        <TD className="max-w-[260px] truncate font-medium">{file.originalName}</TD>
                        <TD>{file.documentType ?? '—'}</TD>
                        <TD>
                          {file.reportingPeriodId
                            ? (periodById.get(file.reportingPeriodId)?.code ?? '—')
                            : '—'}
                        </TD>
                        <TD>
                          <Badge
                            tone={file.confidentiality === 'restricted' ? 'danger' : 'neutral'}
                          >
                            {file.confidentiality}
                          </Badge>
                        </TD>
                        <TD className="text-[11px]">{file.bucket}</TD>
                        <TD align="right">
                          {version ? `${Math.round(version.sizeBytes / 1024)} KB` : '—'}
                        </TD>
                        <TD align="right">
                          {version ? (linkCountByVersion.get(version.id) ?? 0) : 0}
                        </TD>
                        <TD className="text-[11px] text-ink-muted">{file.scanStatus}</TD>
                        <TD className="whitespace-nowrap text-[11px] text-ink-muted">
                          {formatJst(file.createdAt)}
                        </TD>
                        <TD>
                          {version && (
                            <Button variant="ghost" size="xs" asChild>
                              <Link href={`/enterprise/evidence/${file.id}`}>画面内で開く</Link>
                            </Button>
                          )}
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
