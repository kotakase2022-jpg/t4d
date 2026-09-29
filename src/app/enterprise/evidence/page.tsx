import Link from 'next/link';
import { AlertTriangle, FolderOpen, Lock, Upload } from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { EVIDENCE_USAGE_PURPOSE_LABELS } from '@/lib/domain/disclosure-status';
import { formatJst, formatJstDate } from '@/lib/format/datetime';
import { isDisclosureFirstEnabled } from '@/lib/services/feature-settings';
import { loadEnterpriseShell } from '@/lib/services/shell';
import {
  CONFIDENTIALITY_LABELS,
  EVIDENCE_EXTENSIONS,
  isManualExcerpt,
  usagePurposeLabel,
} from '@/lib/services/source-anchor';
import { cn } from '@/lib/utils';
import { CONFIDENTIALITY_LEVELS, EVIDENCE_USAGE_PURPOSES } from '@/types/domain';
import { uploadEvidenceDocumentAction } from './actions';

export const metadata = { title: '資料・証跡' };

const selectClass =
  'mt-0.5 block h-7 w-full rounded-t4d border border-line bg-surface px-2 text-[13px] focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-100';

/**
 * 資料・証跡（Evidence）。原本は非公開の保管領域に置き、取得は短時間の署名付き URL のみ。
 *
 * 「定性情報の資料を登録」（§6.4 の 2 つ目の入口、?purpose=qualitative）では利用目的を必須にし、
 * 当年度の事実の根拠／過年度の記載／文体の参考を区別する。テキストを抽出できない資料は
 * 抽出成功に見せず、資料の画面で手動抜粋を登録するよう案内する。
 */
export default async function EvidencePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const organizationId = ctx.workspace.organizationId;
  const qualitative = query.purpose === 'qualitative';
  // 開示優先モードが OFF の組織は従来の画面名のまま（メニューの「Evidence」と食い違わせない。A39）
  const disclosureFirst = await isDisclosureFirstEnabled(db, ctx);
  const pageTitle = disclosureFirst ? '資料・証跡' : 'Evidence';

  const [allFiles, links] = await Promise.all([
    db.select('files', {
      where: { organizationId, deletedAt: { isNull: true } },
      orderBy: { column: 'createdAt', dir: 'desc' },
      limit: 100,
    }),
    db.select('evidenceLinks', { where: { organizationId } }),
  ]);
  const files = qualitative ? allFiles.filter((f) => f.usagePurpose !== null) : allFiles;

  const versionIds = files.map((f) => f.currentVersionId).filter((v): v is string => Boolean(v));
  const [versions, fragments] =
    versionIds.length > 0
      ? await Promise.all([
          db.select('fileVersions', { where: { id: { in: versionIds } } }),
          db.select('fragments', { where: { fileVersionId: { in: versionIds } } }),
        ])
      : [[], []];

  const linkCountByVersion = new Map<string, number>();
  for (const link of links) {
    linkCountByVersion.set(
      link.fileVersionId,
      (linkCountByVersion.get(link.fileVersionId) ?? 0) + 1,
    );
  }
  const fragmentCounts = new Map<string, { extracted: number; manual: number }>();
  for (const f of fragments) {
    const entry = fragmentCounts.get(f.fileVersionId) ?? { extracted: 0, manual: 0 };
    if (isManualExcerpt(f)) entry.manual += 1;
    else entry.extracted += 1;
    fragmentCounts.set(f.fileVersionId, entry);
  }

  const periodById = new Map(shell.periods.map((p) => [p.id, p]));
  const needsManualFile =
    query.extraction === 'needs_manual' && typeof query.file === 'string' ? query.file : null;

  return (
    <>
      <PageHeader
        title={pageTitle}
        description="原本は非公開の保管領域に保存し、ダウンロードは短時間だけ有効な署名付きリンク経由です。閲覧・ダウンロードは監査ログへ記録されます。"
        breadcrumbs={[{ label: '企業ワークスペース' }, { label: pageTitle }]}
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />
        {needsManualFile && (
          <p
            role="alert"
            className="flex flex-wrap items-center gap-1.5 rounded-t4d border border-warning/40 bg-warning-soft px-3 py-1.5 text-[12px] text-ink"
          >
            <AlertTriangle className="size-3.5 text-[#8a5d00]" aria-hidden="true" />
            テキストを抽出できませんでした（抽出の成功としては扱っていません）。引用に使う箇所は手動抜粋で登録してください。
            <Link
              href={`/enterprise/evidence/${needsManualFile}#manual-excerpt`}
              className="text-brand-800 underline"
            >
              手動抜粋の入力へ
            </Link>
          </p>
        )}

        {can(ctx, 'enterprise.evidence.write') && (
          <Card>
            <SectionTitle
              title={
                qualitative
                  ? '定性情報の資料を登録'
                  : disclosureFirst
                    ? '資料・証跡を登録'
                    : 'Evidence を登録'
              }
              action={
                qualitative ? (
                  <Link
                    href="/enterprise/evidence"
                    className="text-[12px] text-brand-800 underline"
                  >
                    証憑として登録する（利用目的なし）
                  </Link>
                ) : (
                  <Link
                    href="/enterprise/evidence?purpose=qualitative"
                    className="text-[12px] text-brand-800 underline"
                  >
                    定性情報の資料として登録する
                  </Link>
                )
              }
            />
            <form action={uploadEvidenceDocumentAction} className="space-y-2 px-3 pb-3">
              <input type="hidden" name="kind" value={qualitative ? 'qualitative' : 'evidence'} />
              {qualitative && (
                <p className="text-[12px] text-ink-muted">
                  利用目的は必須です。「当年度の根拠」以外（過年度の記載・文体の参考）は、当年度の事実の根拠として扱いません。
                  資料を登録しただけでは、要求事項は対応済みになりません。
                </p>
              )}
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                <div className="sm:col-span-2">
                  <label htmlFor="ev-file" className="block text-[12px] text-ink-muted">
                    {qualitative
                      ? `ファイル（${EVIDENCE_EXTENSIONS.join(' ')}）`
                      : 'ファイル（形式は問いません。本文を抽出できる形式は引用にも使えます）'}
                  </label>
                  <input
                    id="ev-file"
                    type="file"
                    name="file"
                    required
                    accept={qualitative ? EVIDENCE_EXTENSIONS.join(',') : undefined}
                    className="mt-0.5 block text-[12px] file:mr-2 file:rounded-t4d file:border file:border-line file:bg-surface file:px-2 file:py-1 file:text-[12px]"
                  />
                </div>
                <div>
                  <label htmlFor="ev-title" className="block text-[12px] text-ink-muted">
                    資料名
                  </label>
                  <Input
                    id="ev-title"
                    name="title"
                    placeholder="空欄ならファイル名"
                    className="mt-0.5"
                  />
                </div>
                <div>
                  <label htmlFor="ev-period" className="block text-[12px] text-ink-muted">
                    対象年度
                  </label>
                  <select
                    id="ev-period"
                    name="reportingPeriodId"
                    defaultValue={shell.currentPeriod.id}
                    className={selectClass}
                  >
                    <option value="">指定しない</option>
                    {shell.periods.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.code}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="ev-edition" className="block text-[12px] text-ink-muted">
                    版
                  </label>
                  <Input
                    id="ev-edition"
                    name="editionLabel"
                    placeholder="例: 2026年6月 第2版"
                    className="mt-0.5"
                  />
                </div>
                <div>
                  <label htmlFor="ev-issued" className="block text-[12px] text-ink-muted">
                    発行日
                  </label>
                  <Input id="ev-issued" name="issuedOn" type="date" className="mt-0.5" />
                </div>
                <div>
                  <label htmlFor="ev-type" className="block text-[12px] text-ink-muted">
                    文書種別
                  </label>
                  <Input
                    id="ev-type"
                    name="documentType"
                    placeholder="例: 議事録・請求書"
                    className="mt-0.5"
                  />
                </div>
                <div>
                  <label htmlFor="ev-conf" className="block text-[12px] text-ink-muted">
                    機密区分
                  </label>
                  <select
                    id="ev-conf"
                    name="confidentiality"
                    defaultValue="confidential"
                    className={selectClass}
                  >
                    {CONFIDENTIALITY_LEVELS.map((c) => (
                      <option key={c} value={c}>
                        {CONFIDENTIALITY_LABELS[c]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="ev-purpose" className="block text-[12px] text-ink-muted">
                    利用目的{qualitative ? '（必須）' : ''}
                  </label>
                  <select
                    id="ev-purpose"
                    name="usagePurpose"
                    required={qualitative}
                    defaultValue={qualitative ? 'current_fact' : ''}
                    className={selectClass}
                  >
                    {!qualitative && <option value="">未設定（証憑）</option>}
                    {EVIDENCE_USAGE_PURPOSES.map((p) => (
                      <option key={p} value={p}>
                        {EVIDENCE_USAGE_PURPOSE_LABELS[p]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" size="sm">
                  <Upload aria-hidden="true" />
                  登録
                </Button>
                <span className="text-[11px] text-ink-muted">
                  PDF・Word・テキストは段落・ページ単位で引用できる箇所を抽出します。機密区分の既定は「機密」です。
                </span>
              </div>
            </form>
          </Card>
        )}

        <Card className="overflow-hidden">
          <SectionTitle
            title={`${qualitative ? '定性情報の資料' : disclosureFirst ? '資料・証跡の一覧' : 'Evidence Library'}（${files.length}）`}
          />
          {files.length === 0 ? (
            <EmptyState
              title={
                qualitative
                  ? '定性情報の資料がありません'
                  : disclosureFirst
                    ? '資料・証跡がありません'
                    : 'Evidence がありません'
              }
              icon={<FolderOpen className="size-5" aria-hidden="true" />}
            />
          ) : (
            <div className="t4d-scroll-x">
              <Table>
                <THead>
                  <TR>
                    <TH>資料名</TH>
                    <TH>文書種別</TH>
                    <TH>対象年度</TH>
                    <TH>版・発行日</TH>
                    <TH>利用目的</TH>
                    <TH>機密区分</TH>
                    <TH>引用できる箇所</TH>
                    <TH align="right">サイズ</TH>
                    <TH align="right">紐付け</TH>
                    <TH>登録日時</TH>
                    <TH className="w-16" aria-label="操作" />
                  </TR>
                </THead>
                <TBody>
                  {files.map((file) => {
                    const version = versions.find((v) => v.id === file.currentVersionId);
                    const counts = version ? fragmentCounts.get(version.id) : undefined;
                    return (
                      <TR key={file.id}>
                        <TD
                          className="max-w-[260px] truncate font-medium"
                          title={file.originalName}
                        >
                          {file.originalName}
                        </TD>
                        <TD className="text-[12px]">{file.documentType ?? '—'}</TD>
                        <TD className="text-[12px]">
                          {file.reportingPeriodId
                            ? (periodById.get(file.reportingPeriodId)?.code ?? '—')
                            : '—'}
                        </TD>
                        <TD className="text-[12px]">
                          {file.editionLabel ?? '—'}
                          {file.issuedOn && (
                            <span className="block text-[11px] text-ink-muted">
                              発行 {formatJstDate(file.issuedOn)}
                            </span>
                          )}
                        </TD>
                        <TD className="whitespace-nowrap text-[12px]">
                          <span className={cn(file.usagePurpose === null && 'text-ink-muted')}>
                            {usagePurposeLabel(file.usagePurpose)}
                          </span>
                        </TD>
                        <TD>
                          <Badge
                            tone={
                              file.confidentiality === 'restricted'
                                ? 'danger'
                                : file.confidentiality === 'confidential'
                                  ? 'warning'
                                  : 'neutral'
                            }
                          >
                            <Lock className="size-3" aria-hidden="true" />
                            {CONFIDENTIALITY_LABELS[file.confidentiality]}
                          </Badge>
                        </TD>
                        <TD className="whitespace-nowrap text-[12px]">
                          {counts
                            ? `${counts.extracted} 箇所${counts.manual > 0 ? `（手動抜粋 ${counts.manual}）` : ''}`
                            : '—'}
                        </TD>
                        <TD align="right">
                          {version ? `${Math.round(version.sizeBytes / 1024)} KB` : '—'}
                        </TD>
                        <TD align="right">
                          {version ? (linkCountByVersion.get(version.id) ?? 0) : 0}
                        </TD>
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
