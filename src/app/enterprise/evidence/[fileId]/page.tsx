import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Download, FileText, Highlighter } from 'lucide-react';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { DocumentPreview } from '@/components/shared/document-preview';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { formatJst } from '@/lib/format/datetime';
import { parseUploadedFile } from '@/lib/imports/parsers';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { readOwnedFileBytes } from '@/lib/storage';

export const metadata = { title: 'Evidence Viewer' };

/**
 * Evidence Viewer（EVID-P0-002）。
 *
 * PDF / 画像 / 表を**画面内に**表示し、該当箇所（ページ・セル）のハイライトと、
 * メタデータ・関連指標・Version を同じ画面で確認できるようにする。
 *
 * - 実体は同一オリジンの /api/files/inline から取得（CSP・認可の観点）。
 * - Demo Mode の Fixture ファイルは実体を持たないため、抽出済み Fragment を表示する
 *   （「動いているように見えるだけ」を避け、実体が無いことは明示する）。
 */
export default async function EvidenceViewerPage({
  params,
  searchParams,
}: {
  params: Promise<{ fileId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { fileId } = await params;
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;

  const file = await db.findById('files', fileId);
  if (!file || file.deletedAt || file.organizationId !== ctx.workspace.organizationId) notFound();

  const versions = await db.select('fileVersions', {
    where: { fileId: file.id },
    orderBy: { column: 'versionNo', dir: 'desc' },
  });
  const current = versions.find((v) => v.id === file.currentVersionId) ?? versions[0];
  if (!current) notFound();

  const [links, fragments] = await Promise.all([
    db.select('evidenceLinks', {
      where: { fileVersionId: { in: versions.map((v) => v.id) } },
    }),
    db.select('fragments', {
      where: { fileVersionId: current.id },
      orderBy: { column: 'page' },
    }),
  ]);

  // リンク先（指標）のラベル解決
  const dpIds = links.filter((l) => l.targetType === 'data_point').map((l) => l.targetId);
  const dataPoints =
    dpIds.length > 0 ? await db.select('dataPoints', { where: { id: { in: dpIds } } }) : [];
  const metricById = new Map(shell.metrics.map((m) => [m.id, m]));
  const dpLabel = new Map(
    dataPoints.map((dp) => [dp.id, metricById.get(dp.metricId)?.name ?? 'データ']),
  );

  // ハイライト対象: ?page=N（PDF）と、リンクに含まれる cellRef（表）
  const activePage = typeof query.page === 'string' ? Number(query.page) : null;
  const highlightCells = new Set(
    links
      .map((l) => l.cellRef)
      .filter((c): c is string => Boolean(c))
      .map((c) => c.split('!').pop() ?? c),
  );

  // 実体の取得（無ければ Fragment 表示へフォールバック）
  const stored = await readOwnedFileBytes(db, ctx, current.id);
  const isImage = stored ? stored.mimeType.startsWith('image/') : false;
  const isPdf = stored ? stored.mimeType === 'application/pdf' : false;
  // .txt は表のことも自由記述のこともあり、拡張子だけでは決まらない。
  // 解析させてみて、表として読めたかどうかで表示を切り替える。
  const isParseable = stored
    ? /\.(csv|tsv|txt|xlsx|xlsm)$/i.test(file.originalName) ||
      stored.mimeType.includes('csv') ||
      stored.mimeType.startsWith('text/') ||
      stored.mimeType.includes('spreadsheet')
    : false;

  let tableData: { headers: string[]; rows: Array<Record<string, string>> } | null = null;
  let textData: string | null = null;
  if (stored && isParseable) {
    const parsed = await parseUploadedFile(file.originalName, stored.mimeType, stored.bytes);
    if (parsed.kind === 'table') {
      tableData = { headers: parsed.table.headers, rows: parsed.table.rows.slice(0, 50) };
    } else if (parsed.kind === 'text') {
      textData = parsed.text.pages[0]?.text ?? null;
    }
  }

  const inlineSrc = `/api/files/inline?fileVersionId=${current.id}`;
  const pdfPages = [...new Set(links.map((l) => l.page).filter((p): p is number => p !== null))];

  /** 列番号・行番号 → "C12" 形式。表ハイライトの照合に使う（データ行はヘッダーの次＝2 行目から） */
  const cellOf = (colIndex: number, rowIndex: number) =>
    `${String.fromCharCode(65 + colIndex)}${rowIndex + 2}`;

  return (
    <>
      <PageHeader
        title={file.originalName}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{file.mimeType}</Badge>
            <Badge tone={file.confidentiality === 'confidential' ? 'warning' : 'neutral'}>
              {file.confidentiality}
            </Badge>
            <span>Version {current.versionNo}</span>
          </span>
        }
        breadcrumbs={[
          { label: '企業ワークスペース' },
          { label: 'Evidence', href: '/enterprise/evidence' },
          { label: file.originalName },
        ]}
        actions={
          <Button variant="outline" size="sm" asChild>
            <a href={`/api/files/signed-url?fileVersionId=${current.id}`}>
              <Download aria-hidden="true" />
              ダウンロード
            </a>
          </Button>
        }
      />

      <div className="grid grid-cols-[1fr_360px] gap-3 p-4">
        {/* 左: ビューア本体 */}
        <div className="space-y-3">
          <Card className="overflow-hidden">
            <SectionTitle title="プレビュー" />
            {!stored ? (
              <div>
                <p className="border-b border-line bg-warning-soft px-3 py-1.5 text-[12px] text-[#8a5d00]">
                  原本ファイルの実体はこの環境に保管されていません（Demo Mode の Fixture）。
                  下は取込時に抽出した内容を紙面として再構成したものです。
                </p>
                {fragments.length === 0 ? (
                  <EmptyState title="抽出テキストもありません" />
                ) : (
                  <>
                    {/* 表示するページ: ?page=N が指定されていればそのページ */}
                    {(() => {
                      const shown =
                        fragments.find((f) => f.page === (activePage ?? fragments[0]?.page)) ??
                        fragments[0]!;
                      const isLinked = links.some((l) => l.fragmentId === shown.id);
                      // Evidence リンクが指すセル参照は紙面上でも強調する
                      const marks = [...highlightCells];
                      return (
                        <DocumentPreview
                          text={shown.text}
                          title={`${file.originalName}（${shown.locator ?? ''}）`}
                          page={shown.page}
                          totalPages={fragments.length}
                          highlight={marks}
                          linked={isLinked}
                        />
                      );
                    })()}
                    {fragments.length > 1 && (
                      <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-3 py-2">
                        <span className="text-[11px] text-ink-muted">ページ:</span>
                        {fragments.map((f) => (
                          <Button
                            key={f.id}
                            size="xs"
                            variant={
                              (activePage ?? fragments[0]?.page) === f.page
                                ? 'secondary'
                                : 'outline'
                            }
                            asChild
                          >
                            <Link href={`?page=${f.page}`}>{f.page}</Link>
                          </Button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : isImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={inlineSrc}
                alt={`${file.originalName} のプレビュー`}
                className="max-h-[70vh] w-full object-contain p-2"
              />
            ) : isPdf ? (
              <iframe
                src={`${inlineSrc}#page=${activePage ?? 1}`}
                title={`${file.originalName} のプレビュー`}
                className="h-[70vh] w-full border-0"
              />
            ) : tableData ? (
              <div className="t4d-scroll-x p-2">
                <Table>
                  <THead>
                    <TR>
                      {tableData.headers.map((h) => (
                        <TH key={h}>{h}</TH>
                      ))}
                    </TR>
                  </THead>
                  <TBody>
                    {tableData.rows.map((row, ri) => (
                      <TR key={ri}>
                        {tableData.headers.map((h, ci) => (
                          <TD
                            key={h}
                            className={
                              highlightCells.has(cellOf(ci, ri))
                                ? 'bg-brand-100 font-medium text-brand-900'
                                : undefined
                            }
                          >
                            {row[h]}
                          </TD>
                        ))}
                      </TR>
                    ))}
                  </TBody>
                </Table>
                {highlightCells.size > 0 && (
                  <p className="flex items-center gap-1 px-1 py-1.5 text-[11px] text-ink-muted">
                    <Highlighter className="size-3" aria-hidden="true" />
                    ハイライト = Evidence リンクで参照されているセル（
                    {[...highlightCells].join(', ')}）
                  </p>
                )}
              </div>
            ) : textData ? (
              <DocumentPreview
                text={textData}
                title={file.originalName}
                page={1}
                totalPages={1}
                highlight={[...highlightCells]}
                linked={links.length > 0}
              />
            ) : (
              <EmptyState
                title="この形式は画面内表示に対応していません"
                description="ダウンロードして確認してください。"
              />
            )}
          </Card>

          {isPdf && pdfPages.length > 0 && (
            <Card>
              <SectionTitle title="該当箇所（リンク済みページ）" />
              <div className="flex flex-wrap gap-1.5 p-3">
                {pdfPages.map((p) => (
                  <Button
                    key={p}
                    size="xs"
                    variant={activePage === p ? 'secondary' : 'outline'}
                    asChild
                  >
                    <Link href={`?page=${p}`}>p.{p} を表示</Link>
                  </Button>
                ))}
              </div>
            </Card>
          )}
        </div>

        {/* 右: メタデータ・関連・Version */}
        <div className="space-y-3">
          <Card>
            <SectionTitle title="メタデータ" />
            <dl className="space-y-1 px-3 pb-3 text-[12px]">
              <div className="flex justify-between gap-2">
                <dt className="text-ink-muted">種別</dt>
                <dd className="text-ink">{file.documentType ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-muted">対象期間</dt>
                <dd className="text-ink">
                  {shell.periods.find((p) => p.id === file.reportingPeriodId)?.code ?? '—'}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-muted">サイズ</dt>
                <dd className="tnum text-ink">{Math.round(current.sizeBytes / 1024)} KB</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-muted">SHA-256</dt>
                <dd className="truncate font-mono text-[10px] text-ink" title={current.sha256}>
                  {current.sha256.slice(0, 16)}…
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-muted">登録日時</dt>
                <dd className="text-ink">{formatJst(current.createdAt)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-muted">ウイルススキャン</dt>
                <dd className="text-ink">{file.scanStatus}</dd>
              </div>
            </dl>
          </Card>

          <Card>
            <SectionTitle title={`関連データ（${links.length}）`} />
            {links.length === 0 ? (
              <EmptyState title="まだ紐付けられていません" />
            ) : (
              <ul className="divide-y divide-line">
                {links.map((link) => (
                  <li key={link.id} className="px-3 py-1.5 text-[12px]">
                    {link.targetType === 'data_point' ? (
                      <Link
                        href={`/enterprise/data/${link.targetId}`}
                        className="font-medium text-brand-800 hover:underline"
                      >
                        {dpLabel.get(link.targetId) ?? 'データ'}
                      </Link>
                    ) : (
                      <span className="text-ink">開示回答</span>
                    )}
                    <div className="text-[11px] text-ink-muted">
                      {link.page !== null && (
                        <Link href={`?page=${link.page}`} className="underline">
                          p.{link.page}
                        </Link>
                      )}
                      {link.cellRef && <span className="ml-1">{link.cellRef}</span>}
                      {link.note && <span className="ml-1">／ {link.note}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <SectionTitle title={`Version（${versions.length}）`} />
            <ul className="divide-y divide-line">
              {versions.map((v) => (
                <li
                  key={v.id}
                  className="flex items-center justify-between px-3 py-1.5 text-[12px]"
                >
                  <span className="flex items-center gap-1.5">
                    <FileText className="size-3.5 text-ink-muted" aria-hidden="true" />v
                    {v.versionNo}
                    {v.id === current.id && <Badge tone="brand">表示中</Badge>}
                  </span>
                  <span className="text-[11px] text-ink-muted">{formatJst(v.createdAt)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
