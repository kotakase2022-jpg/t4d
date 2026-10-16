import Link from 'next/link';
import { isFyReportingUnit } from '@/lib/domain/boundaries';
import {
  Calculator,
  ChevronRight,
  ClipboardPaste,
  FileSpreadsheet,
  FileText,
  Truck,
} from 'lucide-react';
import { JobStatusBadge } from '@/components/shared/badges';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { DemoSimulationNotice } from '@/components/shared/demo-simulation-notice';
import { FlashMessage } from '@/components/shared/flash';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { ROUTE_CATALOG, canOpenRoute } from '@/components/shared/route-catalog';
import { Section } from '@/components/shared/section';
import { SubmitButton } from '@/components/ui/submit-button';
import { CollapsibleSection } from '@/components/ui/collapsible';
import { Textarea } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { can } from '@/lib/authorization/can';
import { getAppMode } from '@/lib/config';
import { formatJst } from '@/lib/format/datetime';
import { isDisclosureFirstEnabled } from '@/lib/services/feature-settings';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { parsePage, parsePageSize } from '@/lib/table/columns';
import { canFor } from '@/lib/ui/home-profile';
import { importJobRowAction } from '@/lib/ui/state-actions';
import { statusLabel, statusOptions } from '@/lib/ui/status/registry';
import type { IngestionJob, JobStatus } from '@/types/domain';
import { pasteImportAction } from '../actions';
import { importJobTitle } from './job-title';
import { UploadForm } from './upload-form';

export const metadata = { title: 'データ取込' };

type SearchParams = Record<string, string | string[] | undefined>;

const BASE_PATH = '/enterprise/imports';

interface JobRow {
  job: IngestionJob;
  fileNames: string[];
  unitName: string;
  periodCode: string;
}

/**
 * データ取込（plan §2.26 E11）。
 *
 * - 入口は業務の動詞 3 つ（ファイルを取り込む＝この画面／標準 CSV で登録する／Scope3 サプライヤー）。
 *   標準 CSV の入口は従来モードでも出す（取込とデータ入力の権限があるとき）
 * - この画面の primary は「取込を開始」1 つ。貼り付けは閉じた節（既存）
 * - 取込の一覧は DataTable。行の操作は状態で変える（進捗を見る／確認して確定／結果を見る／エラーを見る。§1.15）
 * - 「確認待ち」の絞り込み（?job=needs_review）はホーム・パレットの「取込を確認する」の行き先
 */
export default async function ImportsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const userCan = canFor(ctx);

  const [allJobs, disclosureFirst] = await Promise.all([
    db.select('ingestionJobs', {
      where: { organizationId: ctx.workspace.organizationId },
      orderBy: { column: 'createdAt', dir: 'desc' },
      limit: 200,
    }),
    isDisclosureFirstEnabled(db, ctx),
  ]);

  // 絞り込み（状態）と検索（ファイル名）はサーバー側で行い、ページで切る
  const statusFilter = (Array.isArray(params.job) ? params.job : params.job ? [params.job] : [])
    .filter(Boolean)
    .map(String) as JobStatus[];
  const jobs =
    statusFilter.length > 0 ? allJobs.filter((j) => statusFilter.includes(j.status)) : allJobs;
  const jobFiles =
    jobs.length > 0
      ? await db.select('ingestionJobFiles', { where: { jobId: { in: jobs.map((j) => j.id) } } })
      : [];
  const unitById = new Map(shell.units.map((u) => [u.id, u]));
  const periodById = new Map(shell.periods.map((p) => [p.id, p]));
  const search = typeof params.q === 'string' ? params.q.trim().toLowerCase() : '';
  const rows: JobRow[] = jobs
    .map((job) => ({
      job,
      fileNames: jobFiles.filter((f) => f.jobId === job.id).map((f) => f.originalName),
      unitName: job.unitId ? (unitById.get(job.unitId)?.name ?? '—') : '自動判定',
      periodCode: periodById.get(job.reportingPeriodId)?.code ?? '—',
    }))
    .filter((row) => !search || row.fileNames.some((name) => name.toLowerCase().includes(search)));
  const pageSize = parsePageSize(params.size);
  const page = Math.min(parsePage(params.page), Math.max(1, Math.ceil(rows.length / pageSize)));
  const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);

  // 取込の拠点の候補は年度のデータを集める拠点（入力テンプレートと同じ。plan §2.6）
  const editableUnits = shell.units.filter(
    (u) =>
      isFyReportingUnit(u) &&
      (ctx.workspace.unitScopeIds.length === 0 || ctx.workspace.unitScopeIds.includes(u.id)),
  );
  const canImport = can(ctx, 'enterprise.import.run');
  // 標準 CSV の画面のゲート（取込とデータ入力の両方）と同じ条件で入口を出す
  const canStandard = canImport && can(ctx, 'enterprise.data.write');
  const suppliersRoute = ROUTE_CATALOG.find((e) => e.pattern === '/enterprise/ghg/suppliers');
  const canSuppliers = suppliersRoute ? canOpenRoute(suppliersRoute, userCan) : false;

  // 登録の入口（業務の動詞）。この画面のファイル取込のほかに、決まった形の数値・定性情報の資料・Scope3
  const entries = [
    canStandard && {
      href: '/enterprise/imports/standard',
      title: '数値を登録（CSV・手入力）',
      description: '標準 CSV・貼り付け・手入力。検証 → 差分の確認 → 登録確定の順に進みます。',
      Icon: Calculator,
    },
    disclosureFirst &&
      can(ctx, 'enterprise.evidence.write') && {
        href: '/enterprise/evidence?purpose=qualitative&new=1#evidence-create',
        title: '定性情報の資料を登録',
        description: '方針・体制・リスクの説明などの資料を、利用目的を指定して登録します。',
        Icon: FileText,
      },
    canSuppliers && {
      href: '/enterprise/ghg/suppliers',
      title: 'Scope3 サプライヤーの一次データ',
      description: 'サプライヤーから届いた排出量を取り込み、カテゴリー1 を算定します。',
      Icon: Truck,
    },
  ].filter((entry): entry is Exclude<typeof entry, false> => Boolean(entry));

  const columns: DataTableColumn<JobRow>[] = [
    {
      key: 'files',
      header: '取込（ファイル）',
      importance: 'primary',
      lockVisible: true,
      pinned: 'left',
      cell: (row) => (
        <>
          <span className="block max-w-[320px] truncate font-medium text-ink">
            {importJobTitle(row.fileNames)}
          </span>
          {row.job.errorMessage && (
            <span className="block text-caption text-danger">{row.job.errorMessage}</span>
          )}
        </>
      ),
    },
    {
      key: 'target',
      header: '対象',
      importance: 'primary',
      cell: (row) => (
        <>
          {row.unitName}
          <span className="ml-1 text-caption text-ink-muted">{row.periodCode}</span>
        </>
      ),
    },
    {
      key: 'status',
      header: '状態',
      importance: 'primary',
      cell: (row) => <JobStatusBadge status={row.job.status} />,
    },
    {
      key: 'progress',
      header: '進捗',
      importance: 'secondary',
      width: 'sm',
      cell: (row) => (
        <Progress
          value={row.job.progressPercent}
          label={`${importJobTitle(row.fileNames)} の進捗`}
          tone={row.job.status === 'failed' ? 'danger' : 'brand'}
        />
      ),
    },
    {
      key: 'warnings',
      header: '要確認',
      importance: 'secondary',
      align: 'right',
      cell: (row) =>
        row.job.warningRows > 0 ? (
          <span className="font-medium text-warning-ink">{row.job.warningRows} 行</span>
        ) : (
          '0'
        ),
    },
    {
      key: 'started',
      header: '開始',
      importance: 'secondary',
      cell: (row) => (
        <span className="whitespace-nowrap text-caption text-ink-muted">
          {formatJst(row.job.createdAt)}
        </span>
      ),
    },
    {
      key: 'total',
      header: '総行数',
      importance: 'detail',
      align: 'right',
      cell: (row) => row.job.totalRows,
    },
  ];

  return (
    <>
      {/* 名称は「データ取込」。開示対応側の「SSBJ データ収集」と役割が紛れないようにする */}
      <PageHeader
        title="データ取込"
        description="Excel / CSV / PDF を取り込み、AI が仕分けの候補を作ります"
        help={
          <p>
            AI
            が組織・期間・指標・単位・値・根拠箇所を推定し、プレビューで人が確かめてから確定します（確定するまで台帳は変わりません）。取込は非同期ジョブとして実行されます。
          </p>
        }
        autoBreadcrumbs
        actions={
          <PageActions
            more={[
              {
                // 取込のあとの開示ドラフトへの道（次の工程）。毎回は使わないので「その他」へ（plan E11）
                kind: 'link',
                id: 'ssbj-draft',
                label: 'SSBJ 開示ドラフト',
                icon: <FileText className="size-3.5" aria-hidden="true" />,
                href: '/enterprise/disclosures/ssbj/draft',
              },
            ]}
          />
        }
      />

      <div className="space-y-3 px-4 pb-4 pt-3">
        <FlashMessage searchParams={params} />
        {entries.length > 0 && (
          <nav aria-label="登録の入り口" className="grid gap-2 md:grid-cols-3">
            {entries.map((entry) => (
              <Link
                key={entry.href}
                href={entry.href}
                className="group flex items-start gap-2 rounded-t4d-lg border border-line bg-surface px-3 py-2 transition-colors hover:border-brand-300 hover:bg-brand-50"
              >
                <entry.Icon className="mt-0.5 size-4 shrink-0 text-brand-600" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-body font-semibold text-ink">{entry.title}</span>
                  <span className="mt-0.5 block text-caption text-ink-muted">
                    {entry.description}
                  </span>
                </span>
                <ChevronRight
                  className="mt-0.5 size-4 shrink-0 text-ink-muted group-hover:text-brand-700"
                  aria-hidden="true"
                />
              </Link>
            ))}
          </nav>
        )}

        {getAppMode() === 'demo' && <DemoSimulationNotice />}
        {canImport && (
          <Section
            title="ファイルを取り込む"
            actions={
              <a
                href={`/api/exports/template?period=${shell.currentPeriod.id}`}
                download
                className="inline-flex items-center gap-1 text-small text-brand-700 hover:underline"
              >
                <FileSpreadsheet className="size-3.5" aria-hidden="true" />
                標準テンプレートをダウンロード
              </a>
            }
          >
            <UploadForm
              reportingPeriodId={shell.currentPeriod.id}
              reportingPeriodLabel={shell.currentPeriod.label}
              units={editableUnits.map((u) => ({ id: u.id, name: u.name }))}
            />
          </Section>
        )}

        {/* 貼り付けはファイル取込の補助の入口。見出しは常に見せ、入力欄は既定で閉じる（§10.4 B6） */}
        {canImport && (
          <CollapsibleSection
            id="paste-import"
            title="コピペ表入力（Excel からそのまま貼り付け）"
            summary="表を貼り付けて取り込む（タブ区切りのまま）"
          >
            <form action={pasteImportAction} className="space-y-2 pt-1">
              <Textarea
                name="pasted"
                rows={5}
                required
                aria-label="貼り付ける表"
                placeholder={
                  'Excel で範囲をコピーして、ここへ貼り付けてください（タブ区切りのまま）。\n例:\n拠点\t項目\t値\t単位\n東日本工場\t電力使用量\t18234.5\tMWh'
                }
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-caption text-ink-muted">
                  ファイルと同じ経路（AI 仕分け → プレビュー → 確定）で取り込まれます。
                </span>
                {/* この節を開いたときの送信。画面の primary は「取込を開始」なので secondary */}
                <SubmitButton
                  variant="secondary"
                  size="sm"
                  icon={<ClipboardPaste aria-hidden="true" />}
                  pendingLabel="解析中…"
                >
                  貼り付け内容を取り込む
                </SubmitButton>
              </div>
            </form>
          </CollapsibleSection>
        )}

        <Section title={`取込の一覧（${allJobs.length}）`}>
          <div className="rounded-t4d-lg border border-line bg-surface">
            <DataTable<JobRow>
              id="import-jobs"
              caption="取込の一覧"
              columns={columns}
              rows={pageRows}
              getRowId={(row) => row.job.id}
              getRowLabel={(row) => importJobTitle(row.fileNames)}
              getRowStatus={(row) => statusLabel('job', row.job.status)}
              searchParams={params}
              basePath={BASE_PATH}
              search={{ placeholder: 'ファイル名で検索' }}
              filters={[{ key: 'job', label: '状態', options: statusOptions('job') }]}
              page={{ page, pageSize, total: rows.length, sizes: [25, 50, 100] }}
              rowActions={(row) => {
                const action = importJobRowAction(row.job.status, userCan);
                return {
                  rowLabel: importJobTitle(row.fileNames),
                  primary: {
                    kind: 'link',
                    id: `${action.id}-${row.job.id}`,
                    label: action.label,
                    href: `/enterprise/imports/${row.job.id}`,
                  },
                };
              }}
              empty={{
                noData: {
                  title: 'まだ取込はありません',
                  description: canImport
                    ? '上の「ファイルを取り込む」からファイルを選ぶか、ここへドロップしてください。'
                    : '取込は、取込の権限を持つ担当者（拠点担当・作成担当など）が行います。',
                  action: canImport ? (
                    <Link
                      href="#import-files"
                      className="text-small font-medium text-brand-700 hover:underline"
                    >
                      ファイルを選ぶ
                    </Link>
                  ) : (
                    <Link
                      href="/enterprise/data"
                      className="text-small font-medium text-brand-700 hover:underline"
                    >
                      非財務データを見る
                    </Link>
                  ),
                },
                filtered: { title: '条件に一致する取込はありません' },
              }}
            />
          </div>
        </Section>
      </div>
    </>
  );
}
