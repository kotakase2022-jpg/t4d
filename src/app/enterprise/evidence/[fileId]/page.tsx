import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Download, Eye, FileText, Highlighter, Lock, PenLine, Tag } from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { Notice } from '@/components/shared/notice';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { DocumentPreview } from '@/components/shared/document-preview';
import { ScanStatusBadge } from '@/components/shared/scan-status-badge';
import { Section } from '@/components/shared/section';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { fileTypeLabel } from '@/lib/domain/evidence-limits';
import { formatJst, formatJstDate } from '@/lib/format/datetime';
import { parseUploadedFile } from '@/lib/imports/parsers';
import { isDisclosureFirstEnabled } from '@/lib/services/feature-settings';
import { loadEnterpriseShell } from '@/lib/services/shell';
import {
  CONFIDENTIALITY_LABELS,
  isManualExcerpt,
  listAnchorUsagesForFile,
  usagePurposeLabel,
} from '@/lib/services/source-anchor';
import { readEvidenceFileBytes } from '@/lib/storage';
import { evidenceTitles } from '../titles';
import { ManualExcerptForm } from './manual-excerpt-form';

export async function generateMetadata() {
  // 「資料の詳細」（plan §1.17）
  return { title: (await evidenceTitles()).viewer };
}

/**
 * 資料の詳細（旧 Evidence Viewer。EVID-P0-002・plan S23）。
 *
 * PDF / 画像 / 表を**画面内に**表示し、該当箇所（ページ・セル）のハイライトと、
 * 引用できる箇所を同じ画面で確認できるようにする（L1）。手動抜粋・メタデータ・関連データ・
 * 引用の利用先・版の履歴は見出しを残して閉じた節（L2）。テキストを抽出できなかった資料は、
 * 手動抜粋の節を開いて描き、空状態から誘導する。
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
  const disclosureFirst = await isDisclosureFirstEnabled(db, ctx);
  const listLabel = disclosureFirst ? '資料・証跡' : 'Evidence';

  // 資料の中身（抽出テキスト・実体・紐付け）は資料の閲覧権限が要る。登録だけの権限（取引先の入力担当）
  // には、所有組織が同じでも見せない（実体の API・署名付きリンクと同じ規則。§13 資料の ACL）
  if (!can(ctx, 'enterprise.evidence.read')) {
    return (
      <>
        <PageHeader
          title="資料の詳細"
          breadcrumbs={[
            { label: '企業ワークスペース' },
            { label: listLabel, href: '/enterprise/evidence' },
          ]}
        />
        <div className="p-4">
          <PermissionDeniedState
            permission="enterprise.evidence.read"
            description="資料の内容の閲覧には、資料の閲覧権限が必要です。"
          />
        </div>
      </>
    );
  }

  const file = await db.findById('files', fileId);
  if (!file || file.deletedAt || file.organizationId !== ctx.workspace.organizationId) notFound();
  // 開示優先の機能（利用目的・手動抜粋・引用の利用先）は、ON の組織か、定性情報の資料として
  // 登録した資料（利用目的あり）だけに出す。OFF の組織の証憑は拡張前の画面のまま（REG-2）
  const full = disclosureFirst || file.usagePurpose !== null;

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
  const stored = await readEvidenceFileBytes(db, ctx, current.id);
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

  // 引用の利用先（定性情報・原稿）の逆引きと、手動抜粋の可否
  const anchorUsages = full ? await listAnchorUsagesForFile(db, ctx, file.id) : [];
  const canWriteEvidence = can(ctx, 'enterprise.evidence.write');
  // 引用の利用先（定性情報・原稿の題名）は開示の内容。開示の閲覧権限が無い人には欄ごと出さない
  const canReadDisclosure = can(ctx, 'enterprise.disclosure.read');
  const manualCount = fragments.filter((f) => isManualExcerpt(f)).length;
  const extractedCount = fragments.length - manualCount;
  const periodCode = shell.periods.find((p) => p.id === file.reportingPeriodId)?.code ?? '—';
  const typeLabel = fileTypeLabel(file.mimeType, file.originalName);

  /** 列番号・行番号 → "C12" 形式。表ハイライトの照合に使う（データ行はヘッダーの次＝2 行目から） */
  const cellOf = (colIndex: number, rowIndex: number) =>
    `${String.fromCharCode(65 + colIndex)}${rowIndex + 2}`;

  return (
    <>
      <PageHeader
        title={file.originalName}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {/* MIME 型（application/vnd.openxmlformats-… など）は出さず、形式の名前で示す */}
            <Badge tone="neutral">
              <FileText className="size-3" aria-hidden="true" />
              {typeLabel}
            </Badge>
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
            {full && (
              <Badge tone={file.usagePurpose === 'current_fact' ? 'success' : 'neutral'}>
                <Tag className="size-3" aria-hidden="true" />
                利用目的: {usagePurposeLabel(file.usagePurpose)}
              </Badge>
            )}
            <span>版 {current.versionNo}</span>
          </span>
        }
        breadcrumbs={[
          { label: '企業ワークスペース' },
          { label: listLabel, href: '/enterprise/evidence' },
          { label: file.originalName },
        ]}
        actions={
          <PageActions
            secondary={[
              {
                kind: 'link',
                id: 'download',
                label: 'ダウンロード',
                icon: <Download aria-hidden="true" />,
                href: `/api/files/signed-url?fileVersionId=${current.id}`,
                external: true,
              },
            ]}
          />
        }
      />

      {(typeof query.flash === 'string' || typeof query.error === 'string') && (
        <div className="px-4 pt-3">
          <FlashMessage searchParams={query} />
        </div>
      )}

      <div className="grid grid-cols-[1fr_360px] gap-x-4 gap-y-3 px-4 pb-4 pt-3">
        {/* 左: プレビュー・該当箇所・引用できる箇所（L1） */}
        <div className="min-w-0 space-y-3">
          <Section title="プレビュー" divider="none">
            <div className="rounded-t4d-lg border border-line bg-surface">
              {!stored ? (
                <div>
                  {/* 実体が無いことは隠さない（誠実さの注記。閉じない） */}
                  <Notice tone="warning" className="mb-0 rounded-none border-x-0 border-t-0">
                    原本ファイルの実体はこの環境に保管されていません（Demo Mode の Fixture）。
                    下は取込時に抽出した内容を紙面として再構成したものです。
                  </Notice>
                  {fragments.length === 0 ? (
                    <EmptyState
                      kind="not-applicable"
                      size="compact"
                      title="抽出テキストもありません"
                      description="ダウンロードして確認してください。"
                    />
                  ) : (
                    <>
                      {/* 表示するページ: ?page=N が指定されていればそのページ */}
                      {(() => {
                        const shown =
                          fragments.find((f) => f.page === (activePage ?? fragments[0]?.page)) ??
                          fragments[0]!;
                        const isLinked = links.some((l) => l.fragmentId === shown.id);
                        // 資料への紐付けが指すセル参照は紙面上でも強調する
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
                        <nav
                          aria-label="ページ"
                          className="flex flex-wrap items-center gap-1.5 border-t border-line px-3 py-2"
                        >
                          <span className="text-caption text-ink-muted">ページ:</span>
                          {fragments.map((f) => {
                            const active = (activePage ?? fragments[0]?.page) === f.page;
                            return (
                              <Button
                                key={f.id}
                                size="xs"
                                variant={active ? 'quiet' : 'secondary'}
                                asChild
                              >
                                <Link
                                  href={`?page=${f.page}`}
                                  aria-current={active ? 'page' : undefined}
                                >
                                  {f.page}
                                </Link>
                              </Button>
                            );
                          })}
                        </nav>
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
                    <p className="flex items-center gap-1 px-1 py-1.5 text-caption text-ink-muted">
                      <Highlighter className="size-3" aria-hidden="true" />
                      ハイライト = 資料・証跡への紐付けで参照されているセル（
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
                  kind="no-data"
                  size="compact"
                  title="この形式は画面内表示に対応していません"
                  description="ダウンロードして確認してください。"
                  action={
                    <a
                      href={`/api/files/signed-url?fileVersionId=${current.id}`}
                      className="inline-flex items-center gap-1 text-small font-medium text-brand-700 hover:underline"
                    >
                      <Download className="size-3.5" aria-hidden="true" />
                      ダウンロード
                    </a>
                  }
                />
              )}
            </div>
          </Section>

          {isPdf && pdfPages.length > 0 && (
            <Section title="該当箇所（リンク済みページ）">
              <div className="flex flex-wrap gap-1.5">
                {pdfPages.map((p) => (
                  <Button
                    key={p}
                    size="xs"
                    variant={activePage === p ? 'quiet' : 'secondary'}
                    asChild
                  >
                    <Link href={`?page=${p}`}>p.{p} を表示</Link>
                  </Button>
                ))}
              </div>
            </Section>
          )}

          {/* 抽出した内容は資料そのものの情報なので、開示優先モードの ON/OFF によらず示す */}
          <Section
            id="extracted"
            title={`引用できる箇所（抽出 ${extractedCount} ／ 手動抜粋 ${manualCount}）`}
            className="scroll-mt-4"
          >
            {fragments.length === 0 ? (
              <p className="text-small text-ink-muted">
                テキストを抽出できた箇所がありません（抽出の成功としては扱っていません）。
                {full && canWriteEvidence ? (
                  <>
                    引用に使う箇所は、
                    <Link href="#manual-excerpt" className="text-brand-700 underline">
                      手動抜粋を登録
                    </Link>
                    で文言を写して登録してください。
                  </>
                ) : (
                  ''
                )}
              </p>
            ) : (
              <ol className="max-h-[420px] divide-y divide-line overflow-y-auto">
                {fragments.map((f) => (
                  <li key={f.id} className="py-1.5 text-small">
                    <p className="flex items-center gap-1 text-caption font-medium text-ink-muted">
                      {f.locator ?? `p.${f.page}`}
                      {isManualExcerpt(f) && (
                        <Badge tone="neutral">
                          <PenLine className="size-3" aria-hidden="true" />
                          手動の抜粋
                        </Badge>
                      )}
                    </p>
                    <p className="line-clamp-3 whitespace-pre-wrap text-ink">{f.text}</p>
                  </li>
                ))}
              </ol>
            )}
          </Section>

          {full && canWriteEvidence && (
            <Section
              id="manual-excerpt"
              collapsible
              title="手動抜粋を登録"
              summary="抽出できないページの文言を手で写して登録する"
              // 抽出できた箇所が無い資料は、引用に使うために手動抜粋が要る（開いて描く）
              open={fragments.length === 0 ? true : undefined}
              className="scroll-mt-4"
            >
              <ManualExcerptForm fileId={file.id} />
            </Section>
          )}
        </div>

        {/* 右: メタデータ・関連・版（L2。見出しは常に見せる） */}
        <div className="space-y-3">
          <Section
            id="evidence-metadata"
            collapsible
            title="メタデータ"
            summary={`${file.documentType ?? '種別未設定'} ・ ${periodCode} ・ ${Math.round(current.sizeBytes / 1024)} KB`}
          >
            <dl className="space-y-1 text-small">
              <div className="flex justify-between gap-2">
                <dt className="text-ink-muted">種別</dt>
                <dd className="text-ink">{file.documentType ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-muted">対象期間</dt>
                <dd className="text-ink">{periodCode}</dd>
              </div>
              {full && (
                <>
                  <div className="flex justify-between gap-2">
                    <dt className="text-ink-muted">版</dt>
                    <dd className="text-right text-ink">{file.editionLabel ?? '—'}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-ink-muted">発行日</dt>
                    <dd className="text-ink">{formatJstDate(file.issuedOn)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-ink-muted">利用目的</dt>
                    <dd className="text-ink">{usagePurposeLabel(file.usagePurpose)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-ink-muted">機密区分</dt>
                    <dd className="text-ink">{CONFIDENTIALITY_LABELS[file.confidentiality]}</dd>
                  </div>
                </>
              )}
              <div className="flex justify-between gap-2">
                <dt className="text-ink-muted">形式</dt>
                <dd className="text-right text-ink">
                  {typeLabel}
                  <span className="block break-all text-caption text-ink-muted">
                    {file.mimeType}
                  </span>
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-muted">サイズ</dt>
                <dd className="tnum text-ink">{Math.round(current.sizeBytes / 1024)} KB</dd>
              </div>
              <div className="flex justify-between gap-2">
                {/* 改ざん検知の値（監査法人が照合する）。省略せず全桁を出す */}
                <dt className="shrink-0 text-ink-muted">ファイルのハッシュ（SHA-256）</dt>
                <dd className="min-w-0 break-all text-right font-mono text-caption text-ink">
                  {current.sha256}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-ink-muted">登録日時</dt>
                <dd className="text-ink">{formatJst(current.createdAt)}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-ink-muted">ウイルススキャン</dt>
                <dd>
                  <ScanStatusBadge status={file.scanStatus} />
                </dd>
              </div>
            </dl>
          </Section>

          <Section
            id="evidence-links"
            collapsible
            title={`関連データ（${links.length}）`}
            summary={
              links.length === 0
                ? 'まだ紐付けられていません'
                : `この資料を根拠にしているデータ ${links.length} 件`
            }
          >
            {links.length === 0 ? (
              <EmptyState
                kind="not-applicable"
                size="compact"
                title="まだ紐付けられていません"
                description="データの詳細の「根拠資料」から、この資料を紐付けられます。"
              />
            ) : (
              <ul className="divide-y divide-line">
                {links.map((link) => (
                  <li key={link.id} className="py-1.5 text-small">
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
                    <div className="text-caption text-ink-muted">
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
          </Section>

          {full && canReadDisclosure && (
            <Section
              id="anchor-usages"
              collapsible
              title={`引用の利用先（${anchorUsages.length} 箇所）`}
              summary={
                anchorUsages.length === 0
                  ? '引用している定性情報・原稿はありません'
                  : `定性情報・原稿 ${anchorUsages.length} 箇所`
              }
            >
              {anchorUsages.length === 0 ? (
                <p className="text-small text-ink-muted">
                  この資料を引用している定性情報・原稿はありません。
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {anchorUsages.map((u) => (
                    <li key={u.anchorId} className="py-1.5 text-small">
                      <p className="text-caption font-medium text-ink-muted">{u.locationLabel}</p>
                      <p className="line-clamp-2 text-ink">「{u.quoteText}」</p>
                      <ul className="mt-0.5 space-y-0.5 text-caption">
                        {u.narratives.map((n) => (
                          <li key={n.recordId}>
                            定性情報:{' '}
                            <Link
                              href={`/enterprise/narratives/${n.recordId}`}
                              className="text-brand-800 underline"
                            >
                              {n.title}
                            </Link>
                            （版 {n.versionNos.join('・')}）
                          </li>
                        ))}
                        {u.blocks.map((b) => (
                          <li key={b.blockId}>
                            原稿:{' '}
                            <Link
                              href={`/enterprise/disclosure-projects/${b.projectId}/blocks/${b.blockId}`}
                              className="text-brand-800 underline"
                            >
                              {b.title}
                            </Link>
                            （版 {b.versionNos.join('・')}）
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}

          {/* 履歴は既定で閉じる（見出しは常に見せる。docs/disclosure-first.md §10.4 B6） */}
          <Section
            id="evidence-versions"
            collapsible
            title={`版の履歴（${versions.length}）`}
            summary={`版の一覧（${versions.length} 版・表示中 v${current.versionNo}）`}
          >
            <ul className="divide-y divide-line">
              {versions.map((v) => (
                <li key={v.id} className="flex items-center justify-between py-1.5 text-small">
                  <span className="flex items-center gap-1.5">
                    <FileText className="size-3.5 text-ink-muted" aria-hidden="true" />v
                    {v.versionNo}
                    {v.id === current.id && (
                      <Badge tone="brand">
                        <Eye className="size-3" aria-hidden="true" />
                        表示中
                      </Badge>
                    )}
                  </span>
                  <span className="text-caption text-ink-muted">{formatJst(v.createdAt)}</span>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
    </>
  );
}
