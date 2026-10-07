import Link from 'next/link';
import { FileText, FolderOpen, Lock, Upload } from 'lucide-react';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { FlashMessage } from '@/components/shared/flash';
import { Notice } from '@/components/shared/notice';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { ScanStatusBadge } from '@/components/shared/scan-status-badge';
import { Section } from '@/components/shared/section';
import { Badge } from '@/components/ui/badge';
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
import { parsePage, parsePageSize } from '@/lib/table/columns';
import { cn } from '@/lib/utils';
import { EVIDENCE_USAGE_PURPOSE_LABELS } from '@/lib/domain/disclosure-status';
import { EVIDENCE_USAGE_PURPOSES, type FileObject, type FileVersion } from '@/types/domain';
import { EvidenceUploadForm } from './evidence-upload-form';
import { evidenceTitles } from './titles';

export async function generateMetadata() {
  // 開示優先モードが OFF の組織は、メニューと同じ従来の画面名（A39）
  return { title: (await evidenceTitles()).list };
}

type SearchParams = Record<string, string | string[] | undefined>;

const BASE_PATH = '/enterprise/evidence';
/** 資料は登録が多く一度に見渡したい一覧なので、表示件数の既定を 50 にする（25／50／100 から選べる） */
const PAGE_SIZES = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 50;

/** 保管場所（バケット名を画面に出さない） */
function storageLabel(bucket: string): string {
  if (bucket.startsWith('evidence')) return '資料（非公開の保管領域）';
  if (bucket.startsWith('import')) return '取込ファイル（非公開の保管領域）';
  return '非公開の保管領域';
}

interface EvidenceRow {
  file: FileObject;
  version: FileVersion | undefined;
  periodCode: string;
  linkCount: number;
  fragments: { extracted: number; manual: number } | undefined;
}

/**
 * 資料・証跡（従来メニューでは「Evidence」）。plan S23。
 *
 * 原本は非公開の保管領域に置き、取得は短時間の署名付き URL のみ。
 * 一覧が主（DataTable。検索・用途の絞り込み・列の切替・ページ送り）。登録は見出しの primary
 * 「資料を登録」から開く作成パネル（?new=1）。一覧の上に登録フォームを常設しない。
 *
 * 「定性情報の資料を登録」（§6.4 の 2 つ目の入口、?purpose=qualitative）では利用目的を必須にし、
 * 当年度の事実の根拠／過年度の記載／文体の参考を区別する。テキストを抽出できない資料は
 * 抽出成功に見せず、資料の画面で手動抜粋を登録するよう案内する。
 *
 * 登録だけの権限（取引先の入力担当。資料の閲覧権限なし）には一覧を読み込まず、作成パネルを開いて描く
 * （権限なしの表示を先頭に出さない。R5）。
 */
export default async function EvidencePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
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
  // 資料の一覧（ファイル名・機密区分・抽出件数）は資料の中身の一部。登録だけの権限（取引先の入力担当）
  // には一覧を読み込まず、登録フォームだけを出す（資料の画面・実体の取得と同じ規則。§13 資料の ACL）
  const canReadEvidence = can(ctx, 'enterprise.evidence.read');
  const canWriteEvidence = can(ctx, 'enterprise.evidence.write');

  const [allFiles, links] = canReadEvidence
    ? await Promise.all([
        db.select('files', {
          where: { organizationId, deletedAt: { isNull: true } },
          orderBy: { column: 'createdAt', dir: 'desc' },
          limit: 1000,
        }),
        db.select('evidenceLinks', { where: { organizationId } }),
      ])
    : [[], []];

  // 絞り込み（定性情報の資料・用途）と検索（資料名・文書種別）はサーバー側で行い、並べてからページで切る
  const purposeFilter = typeof query.usage === 'string' ? query.usage : null;
  const search = typeof query.q === 'string' ? query.q.trim().toLowerCase() : '';
  const sortKey = query.sort === 'name' ? 'name' : 'created';
  const sortDir = query.dir === 'asc' ? 'asc' : query.dir === 'desc' ? 'desc' : null;
  let files = qualitative ? allFiles.filter((f) => f.usagePurpose !== null) : allFiles;
  if (purposeFilter === 'none') files = files.filter((f) => f.usagePurpose === null);
  else if (purposeFilter) files = files.filter((f) => f.usagePurpose === purposeFilter);
  if (search) {
    files = files.filter((f) =>
      [f.originalName, f.documentType ?? ''].some((text) => text.toLowerCase().includes(search)),
    );
  }
  if (sortKey === 'name') {
    files = [...files].sort((a, b) => a.originalName.localeCompare(b.originalName, 'ja'));
    if (sortDir === 'desc') files.reverse();
  } else if (sortDir === 'asc') {
    files = [...files].reverse();
  }
  const pageSize = parsePageSize(query.size, PAGE_SIZES, DEFAULT_PAGE_SIZE);
  const total = files.length;
  const page = Math.min(parsePage(query.page), Math.max(1, Math.ceil(total / pageSize)));
  const pageFiles = files.slice((page - 1) * pageSize, page * pageSize);

  const versionIds = pageFiles
    .map((f) => f.currentVersionId)
    .filter((v): v is string => Boolean(v));
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
  const rows: EvidenceRow[] = pageFiles.map((file) => {
    const version = versions.find((v) => v.id === file.currentVersionId);
    return {
      file,
      version,
      periodCode: file.reportingPeriodId
        ? (periodById.get(file.reportingPeriodId)?.code ?? '—')
        : '—',
      linkCount: version ? (linkCountByVersion.get(version.id) ?? 0) : 0,
      fragments: version ? fragmentCounts.get(version.id) : undefined,
    };
  });

  // 抽出件数・手動抜粋への案内は開示優先の機能。OFF の組織の従来画面には出さない（REG-2）。
  // 手動抜粋の入力先（資料の画面）を開けない人にも案内しない
  const needsManualFile =
    full && canReadEvidence && query.extraction === 'needs_manual' && typeof query.file === 'string'
      ? query.file
      : null;
  const flashParams = full ? query : { ...query, extraction: undefined, count: undefined };

  // 作成パネル: ?new=1 で開く。登録だけの権限の利用者には、一覧の代わりに最初から開いて描く
  const panelOpen = canWriteEvidence && (isCreatePanelOpen(query) || !canReadEvidence);
  const createTitle = qualitative
    ? '定性情報の資料を登録'
    : disclosureFirst
      ? '資料・証跡を登録'
      : 'Evidence を登録';
  const openHref = `${createPanelHref(BASE_PATH, query, { open: true })}#evidence-create`;
  const closeHref = createPanelHref(BASE_PATH, query, { open: false });

  const uploadForm = (
    <EvidenceUploadForm
      qualitative={qualitative}
      disclosureFirst={disclosureFirst}
      periods={shell.periods.map((p) => ({ id: p.id, code: p.code }))}
      currentPeriodId={shell.currentPeriod.id}
      extensions={EVIDENCE_EXTENSIONS}
      confidentialityLabels={CONFIDENTIALITY_LABELS}
    />
  );

  const confidentialityBadge = ({ file }: EvidenceRow) => (
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
  );

  const nameCell = (row: EvidenceRow) => (
    <span className="block max-w-[260px] truncate font-medium text-ink">
      {row.file.originalName}
    </span>
  );
  const sizeCell = (row: EvidenceRow) =>
    row.version ? `${Math.round(row.version.sizeBytes / 1024)} KB` : '—';
  const createdCell = (row: EvidenceRow) => (
    <span className="whitespace-nowrap text-caption text-ink-muted">
      {formatJst(row.file.createdAt)}
    </span>
  );

  // 開示優先モード（または定性情報の資料）の列。拡張前（OFF）の組織は従来と同じ列（REG-F7）
  const columns: DataTableColumn<EvidenceRow>[] = full
    ? [
        {
          key: 'name',
          header: '資料名',
          importance: 'primary',
          lockVisible: true,
          pinned: 'left',
          sortKey: 'name',
          cell: nameCell,
        },
        {
          key: 'documentType',
          header: '文書種別',
          importance: 'primary',
          cell: (row) => <span className="text-small">{row.file.documentType ?? '—'}</span>,
        },
        {
          key: 'period',
          header: '対象年度',
          importance: 'primary',
          cell: (row) => <span className="text-small">{row.periodCode}</span>,
        },
        {
          key: 'usage',
          header: '利用目的',
          importance: 'primary',
          cell: (row) => (
            <span
              className={cn(
                'whitespace-nowrap text-small',
                row.file.usagePurpose === null && 'text-ink-muted',
              )}
            >
              {usagePurposeLabel(row.file.usagePurpose)}
            </span>
          ),
        },
        {
          key: 'links',
          header: '紐付け',
          importance: 'secondary',
          align: 'right',
          cell: (row) => row.linkCount,
        },
        {
          key: 'edition',
          header: '版・発行日',
          importance: 'detail',
          cell: (row) => (
            <span className="text-small">
              {row.file.editionLabel ?? '—'}
              {row.file.issuedOn && (
                <span className="block text-caption text-ink-muted">
                  発行 {formatJstDate(row.file.issuedOn)}
                </span>
              )}
            </span>
          ),
        },
        {
          key: 'confidentiality',
          header: '機密区分',
          importance: 'detail',
          cell: confidentialityBadge,
        },
        {
          key: 'fragments',
          header: '引用できる箇所',
          importance: 'detail',
          cell: (row) => (
            <span className="whitespace-nowrap text-small">
              {row.fragments
                ? `${row.fragments.extracted} 箇所${row.fragments.manual > 0 ? `（手動抜粋 ${row.fragments.manual}）` : ''}`
                : '—'}
            </span>
          ),
        },
        { key: 'size', header: 'サイズ', importance: 'detail', align: 'right', cell: sizeCell },
        {
          key: 'created',
          header: '登録日時',
          importance: 'detail',
          sortKey: 'created',
          cell: createdCell,
        },
      ]
    : [
        {
          key: 'name',
          header: 'ファイル名',
          importance: 'primary',
          lockVisible: true,
          pinned: 'left',
          sortKey: 'name',
          cell: nameCell,
        },
        {
          key: 'documentType',
          header: '文書種別',
          importance: 'primary',
          cell: (row) => <span className="text-small">{row.file.documentType ?? '—'}</span>,
        },
        {
          key: 'period',
          header: '対象期間',
          importance: 'primary',
          cell: (row) => <span className="text-small">{row.periodCode}</span>,
        },
        {
          key: 'links',
          header: '紐付け',
          importance: 'secondary',
          align: 'right',
          cell: (row) => row.linkCount,
        },
        {
          key: 'scan',
          header: 'スキャン',
          importance: 'secondary',
          cell: (row) => <ScanStatusBadge status={row.file.scanStatus} />,
        },
        {
          key: 'confidentiality',
          header: '機密区分',
          importance: 'detail',
          cell: confidentialityBadge,
        },
        {
          key: 'storage',
          header: '保管場所',
          importance: 'detail',
          cell: (row) => <span className="text-caption">{storageLabel(row.file.bucket)}</span>,
        },
        { key: 'size', header: 'サイズ', importance: 'detail', align: 'right', cell: sizeCell },
        {
          key: 'created',
          header: '登録日時',
          importance: 'detail',
          sortKey: 'created',
          cell: createdCell,
        },
      ];

  return (
    <>
      <PageHeader
        title={pageTitle}
        description="原本は非公開で保管し、閲覧・ダウンロードは監査ログに残ります"
        help={
          <p>
            原本は非公開の保管領域に保存し、ダウンロードは短時間だけ有効な署名付きリンク経由です。閲覧・ダウンロードは監査ログへ記録されます。
          </p>
        }
        breadcrumbs={[{ label: '企業ワークスペース' }, { label: pageTitle }]}
        actions={
          <PageActions
            // 作成パネルを開いている間は、パネルの「登録」がこの画面の primary
            primary={{
              kind: 'link',
              id: 'create',
              shortcut: 'new',
              label: qualitative ? '定性情報の資料を登録' : '資料を登録',
              icon: <Upload aria-hidden="true" />,
              href: openHref,
              hidden: !canWriteEvidence || panelOpen,
            }}
            secondary={[
              // 開示優先モードの 2 つ目の入口（定性情報の資料）と、そこから証憑へ戻る道
              qualitative
                ? {
                    kind: 'link',
                    id: 'as-evidence',
                    label: '証憑として登録する（利用目的なし）',
                    href: '/enterprise/evidence',
                    hidden: !canWriteEvidence,
                  }
                : {
                    kind: 'link',
                    id: 'as-qualitative',
                    label: '定性情報の資料として登録する',
                    href: '/enterprise/evidence?purpose=qualitative&new=1#evidence-create',
                    hidden: !canWriteEvidence || !disclosureFirst,
                  },
            ]}
          />
        }
      />

      <div className="space-y-3 px-4 pb-4 pt-3">
        <FlashMessage searchParams={flashParams} />
        {needsManualFile && (
          <Notice
            tone="warning"
            role="alert"
            action={
              <Link
                href={`/enterprise/evidence/${needsManualFile}#manual-excerpt`}
                className="text-small text-brand-800 underline"
              >
                手動抜粋の入力へ
              </Link>
            }
          >
            テキストを抽出できませんでした（抽出の成功としては扱っていません）。引用に使う箇所は手動抜粋で登録してください。
          </Notice>
        )}

        {panelOpen &&
          (canReadEvidence ? (
            <CreatePanel
              id="evidence-create"
              title={createTitle}
              searchParams={query}
              closeHref={closeHref}
            >
              {uploadForm}
            </CreatePanel>
          ) : (
            // 登録だけの権限の利用者には一覧が無いので、登録欄そのものがこの画面の仕事（閉じる操作を置かない）
            <Section id="evidence-create" title={createTitle} divider="none">
              {uploadForm}
            </Section>
          ))}

        {!canReadEvidence ? (
          // 権限なしの表示を先頭に出さない（R5）。登録した資料の行き先だけを 1 行で伝える
          <p className="text-small text-ink-muted">
            登録した資料の一覧と内容は、資料の閲覧権限を持つ担当者（管理者・作成担当など）が確認します。
          </p>
        ) : (
          <div className="rounded-t4d-lg border border-line bg-surface">
            <DataTable<EvidenceRow>
              id="evidence"
              caption={
                qualitative
                  ? '定性情報の資料'
                  : disclosureFirst
                    ? '資料・証跡の一覧'
                    : 'Evidence の一覧'
              }
              columns={columns}
              rows={rows}
              getRowId={(row) => row.file.id}
              getRowLabel={(row) => row.file.originalName}
              searchParams={query}
              basePath={BASE_PATH}
              search={{ placeholder: '資料名・文書種別で検索' }}
              filters={
                full
                  ? [
                      {
                        key: 'usage',
                        label: '利用目的',
                        multiple: false,
                        options: [
                          ...EVIDENCE_USAGE_PURPOSES.map((purpose) => ({
                            value: purpose,
                            label: EVIDENCE_USAGE_PURPOSE_LABELS[purpose],
                          })),
                          ...(qualitative ? [] : [{ value: 'none', label: '未設定（証憑）' }]),
                        ],
                      },
                    ]
                  : []
              }
              userViews
              page={{ page, pageSize, total, sizes: PAGE_SIZES }}
              rowActions={(row) =>
                row.version
                  ? {
                      rowLabel: row.file.originalName,
                      primary: {
                        kind: 'link',
                        id: `open-${row.file.id}`,
                        label: '画面内で開く',
                        icon: <FileText aria-hidden="true" />,
                        href: `/enterprise/evidence/${row.file.id}`,
                      },
                    }
                  : null
              }
              empty={{
                noData: {
                  title: qualitative
                    ? 'まだ定性情報の資料がありません'
                    : disclosureFirst
                      ? 'まだ資料・証跡がありません'
                      : 'まだ Evidence がありません',
                  description:
                    '請求書・検針票・議事録などを登録すると、データの根拠として紐付けたり、原稿で引用したりできます。',
                  action: canWriteEvidence ? (
                    <Link
                      href={openHref}
                      className="inline-flex items-center gap-1 text-small font-medium text-brand-700 hover:underline"
                    >
                      <FolderOpen className="size-3.5" aria-hidden="true" />
                      最初の資料を登録
                    </Link>
                  ) : (
                    <Link
                      href="/enterprise/dashboard"
                      className="text-small font-medium text-brand-700 hover:underline"
                    >
                      ホームへ戻る
                    </Link>
                  ),
                },
                filtered: { title: '条件に一致する資料がありません' },
              }}
            />
          </div>
        )}
      </div>
    </>
  );
}
