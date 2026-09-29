import Link from 'next/link';
import { AlertTriangle, FolderOpen, Lock } from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
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
import { EvidenceUploadForm } from './evidence-upload-form';

export const metadata = { title: '資料・証跡' };

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
  /** 開示優先の入力項目・列を出すか（OFF の組織でも ?purpose=qualitative を直接開いたときは出す） */
  const full = disclosureFirst || qualitative;

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
                ) : disclosureFirst ? (
                  <Link
                    href="/enterprise/evidence?purpose=qualitative"
                    className="text-[12px] text-brand-800 underline"
                  >
                    定性情報の資料として登録する
                  </Link>
                ) : undefined
              }
            />
            <EvidenceUploadForm
              qualitative={qualitative}
              disclosureFirst={disclosureFirst}
              periods={shell.periods.map((p) => ({ id: p.id, code: p.code }))}
              currentPeriodId={shell.currentPeriod.id}
              extensions={EVIDENCE_EXTENSIONS}
              confidentialityLabels={CONFIDENTIALITY_LABELS}
            />
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
                  {full ? (
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
                  ) : (
                    // 開示優先モードが OFF の組織は、拡張前の Evidence Library と同じ列（REG-F7）
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
                  )}
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
                        {full && (
                          <>
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
                          </>
                        )}
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
                        {full ? (
                          <TD className="whitespace-nowrap text-[12px]">
                            {counts
                              ? `${counts.extracted} 箇所${counts.manual > 0 ? `（手動抜粋 ${counts.manual}）` : ''}`
                              : '—'}
                          </TD>
                        ) : (
                          <TD className="text-[11px]">{file.bucket}</TD>
                        )}
                        <TD align="right">
                          {version ? `${Math.round(version.sizeBytes / 1024)} KB` : '—'}
                        </TD>
                        <TD align="right">
                          {version ? (linkCountByVersion.get(version.id) ?? 0) : 0}
                        </TD>
                        {!full && <TD className="text-[11px] text-ink-muted">{file.scanStatus}</TD>}
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
