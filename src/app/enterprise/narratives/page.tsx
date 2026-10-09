import Link from 'next/link';
import {
  AlertTriangle,
  Banknote,
  Compass,
  FilePlus2,
  FileText,
  History,
  Landmark,
  Quote,
  Tag,
  Target,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { StatusBreakdown } from '@/components/charts/status-breakdown';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { FlashMessage } from '@/components/shared/flash';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { PermissionDeniedState } from '@/components/shared/states';
import { STATUS_ICON_COMPONENTS } from '@/components/shared/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MoreInfo } from '@/components/ui/more-info';
import { AuthorizationError, can } from '@/lib/authorization/can';
import { NARRATIVE_STATUS_LABELS, NARRATIVE_THEME_LABELS } from '@/lib/domain/disclosure-status';
import { formatJst } from '@/lib/format/datetime';
import {
  isNarrativeStatus,
  isNarrativeTheme,
  listNarratives,
  type NarrativeListRow,
} from '@/lib/services/narrative';
import {
  CONTENT_COVERAGE_FILTERS,
  CONTENT_COVERAGE_FILTER_LABELS,
  coverageSummaryText,
  isContentCoverageFilter,
  loadContentCoverageSummaries,
  matchesCoverageFilter,
  type ContentCoverageSummary,
} from '@/lib/services/content-coverage';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { DEFAULT_PAGE_SIZES, parsePage, parsePageSize } from '@/lib/table/columns';
import { statusEntry, statusStyle } from '@/lib/ui/status/registry';
import { NARRATIVE_STATUSES, NARRATIVE_THEMES, type NarrativeTheme } from '@/types/domain';
import { carryForwardNarrativeAction } from './actions';
import { CandidateBadge, NarrativeStatusBadge } from './_components/narrative-badges';

export const metadata = { title: '定性情報' };

const BASE_PATH = '/enterprise/narratives';
const NEW_PATH = `${BASE_PATH}/new`;

const NARRATIVE_THEME_ICONS: Record<NarrativeTheme, LucideIcon> = {
  risk_opportunity: TriangleAlert,
  financial_impact: Banknote,
  governance: Landmark,
  strategy: Compass,
  policy_other: FileText,
};

/** 内訳の帯の状態アイコン（状態バッジと同じ登録簿のアイコン。色だけで区別しない） */
function narrativeStatusIcon(status: (typeof NARRATIVE_STATUSES)[number]): LucideIcon {
  return STATUS_ICON_COMPONENTS[statusStyle(statusEntry('narrative', status).semantic).icon];
}

/**
 * 定性情報の一覧（§6.5。plan §2.26 E42）。原稿とは別の、再利用できる記録。
 *
 * - 主操作は「新しく登録」。「資料から候補を作成」は「その他」（頻度が低い）
 * - 一覧は DataTable（検索・情報種別と状態の絞り込みは URL）。責任者は「列 ▾」で出す
 * - 前年から引継ぎ（新年度の下書き。確認は引き継がない）は行の「操作 ▾」
 * - 列「基準別の状況」（トライアル対応 NF-06）: 要求事項タブと同じ 5 区分を基準ごとに数える（書き込まない）。
 *   絞り込み ?coverage=（区分ごと・要求事項との対応なし）は「絞り込み ▾」
 */
export default async function NarrativesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;
  const theme = isNarrativeTheme(query.theme) ? query.theme : null;
  const status = isNarrativeStatus(query.status) ? query.status : null;
  const q = typeof query.q === 'string' ? query.q : '';
  const coverageFilter = isContentCoverageFilter(query.coverage) ? query.coverage : null;

  let rows: NarrativeListRow[];
  try {
    rows = await listNarratives(db, ctx, { theme, status, q });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return (
        <>
          <PageHeader title="定性情報" autoBreadcrumbs />
          <PermissionDeniedState
            description="定性情報を見るには、開示の閲覧権限が必要です。"
            permission="enterprise.disclosure.read"
          />
        </>
      );
    }
    throw error;
  }
  const canWrite = can(ctx, 'enterprise.disclosure.write');
  const target = shell.currentPeriod;
  // 状態別・種別の内訳は絞り込みに関係なく全件で数える（絞り込むと内訳が 1 区分だけになるため）
  const allRows =
    theme !== null || status !== null || q !== '' ? await listNarratives(db, ctx, {}) : rows;
  // 基準別の状況（NF-06）。要求事項タブと同じ区分を、全件まとめて 1 回で数える（書き込まない）
  const coverage: Map<string, ContentCoverageSummary> = await loadContentCoverageSummaries(
    db,
    ctx,
    allRows.map((row) => row.record),
  );
  if (coverageFilter) {
    rows = rows.filter((row) => matchesCoverageFilter(coverage.get(row.record.id), coverageFilter));
  }
  const pageSize = parsePageSize(query.size);
  const page = Math.min(parsePage(query.page), Math.max(1, Math.ceil(rows.length / pageSize)));
  const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);

  const columns: DataTableColumn<NarrativeListRow>[] = [
    {
      key: 'title',
      header: '題名',
      importance: 'primary',
      lockVisible: true,
      pinned: 'left',
      width: 'lg',
      cell: (row) => (
        <>
          <Link
            href={`${BASE_PATH}/${row.record.id}`}
            className="font-medium text-brand-800 hover:underline"
          >
            {row.record.title}
          </Link>
          <span className="mt-0.5 flex flex-wrap gap-1">
            {row.isCandidate && <CandidateBadge />}
            {row.carried && (
              <Badge tone="neutral">
                <History className="size-3" aria-hidden="true" />
                前年から引継ぎ
              </Badge>
            )}
            {row.record.tags.map((t) => (
              <Badge key={t} tone="outline">
                <Tag className="size-3" aria-hidden="true" />
                {t}
              </Badge>
            ))}
          </span>
          {row.missingFieldCount > 0 && (
            <span className="mt-0.5 flex items-center gap-1 text-caption text-warning-ink">
              <AlertTriangle className="size-3" aria-hidden="true" />
              未記入の項目 {row.missingFieldCount} 件
            </span>
          )}
        </>
      ),
    },
    {
      key: 'theme',
      header: '情報種別',
      importance: 'primary',
      cell: (row) => <span className="whitespace-nowrap text-small">{row.themeLabel}</span>,
    },
    {
      key: 'status',
      header: '状態',
      importance: 'primary',
      cell: (row) => <NarrativeStatusBadge status={row.record.status} />,
    },
    {
      key: 'period',
      header: '年度・対象範囲',
      importance: 'secondary',
      cell: (row) => (
        <span className="text-small">
          {row.period?.code ?? '—'}
          <span className="block text-caption text-ink-muted">
            {row.scopeNote || '（対象範囲の記載なし）'}
          </span>
          {row.currentVersion === null && row.record.currentVersionId !== null && (
            <span className="flex items-center gap-1 text-caption text-danger">
              <AlertTriangle className="size-3" aria-hidden="true" />
              版が見つかりません（デモ環境の再起動で失われた可能性）
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'confirmedAt',
      header: '最新確認日',
      importance: 'secondary',
      cell: (row) => (
        <span className="whitespace-nowrap text-small">
          {row.confirmedAt ? formatJst(row.confirmedAt) : '未確認'}
          {row.confirmedAt && !row.confirmedIsCurrent && (
            <span className="block text-caption text-ink-muted">（前の版を確認）</span>
          )}
        </span>
      ),
    },
    {
      key: 'evidence',
      header: '根拠件数',
      importance: 'secondary',
      align: 'right',
      cell: (row) => <span className="text-small">{row.evidenceCount}</span>,
    },
    {
      key: 'usage',
      header: '利用先原稿',
      importance: 'secondary',
      width: 'md',
      cell: (row) =>
        row.usage.length === 0 ? (
          <span className="text-small text-ink-muted">なし</span>
        ) : (
          <ul className="space-y-0.5 text-small">
            {row.usage.map((u) => (
              <li key={u.blockId}>
                <Link
                  href={`/enterprise/disclosure-projects/${u.projectId}/blocks/${u.blockId}`}
                  className="text-brand-800 hover:underline"
                >
                  {u.blockTitle}
                </Link>
                <span className="text-caption text-ink-muted">（{u.blockStatusLabel}）</span>
                {!u.citesCurrent && (
                  <span className="block text-caption text-warning-ink">
                    引用中の版 {u.citedVersionNo ?? '—'} は最新ではありません
                  </span>
                )}
              </li>
            ))}
          </ul>
        ),
    },
    {
      key: 'coverage',
      header: '基準別の状況',
      importance: 'secondary',
      width: 'md',
      cell: (row) => {
        const summary = coverage.get(row.record.id);
        return (
          <span className="text-small" data-coverage-summary="">
            {summary && !summary.unmapped ? (
              coverageSummaryText(summary)
            ) : (
              <span className="text-ink-muted">{coverageSummaryText(summary)}</span>
            )}
          </span>
        );
      },
    },
    {
      key: 'owner',
      header: '責任者',
      importance: 'detail',
      cell: (row) => (
        <span className="text-small">
          {row.ownerName ?? '—'}
          {row.record.ownerDepartment && (
            <span className="block text-caption text-ink-muted">{row.record.ownerDepartment}</span>
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="定性情報"
        description="原稿とは別に管理する、再利用できる定性情報の記録"
        help={
          <p>
            リスク・機会、ガバナンス、戦略・対応策、方針などを、原稿とは別の再利用できる記録として管理します。原稿は引用した時点の版を持ち、ここを更新しても原稿は自動では書き換わりません。
          </p>
        }
        autoBreadcrumbs
        actions={
          <PageActions
            primary={{
              kind: 'link',
              id: 'new-narrative',
              shortcut: 'new',
              label: '新しく登録',
              href: NEW_PATH,
              icon: <FilePlus2 aria-hidden="true" />,
              hidden: !canWrite,
            }}
            more={[
              {
                kind: 'link',
                id: 'narrative-from-documents',
                label: '資料から候補を作成',
                href: `${NEW_PATH}?mode=documents`,
                icon: <Quote aria-hidden="true" />,
                hidden: !canWrite,
              },
              {
                kind: 'link',
                id: 'impact-ledger',
                label: 'インパクト・リスク・機会の台帳',
                href: '/enterprise/disclosures/impacts',
                icon: <Target aria-hidden="true" />,
              },
            ]}
          />
        }
      />
      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        {allRows.length > 0 && (
          <div className="grid gap-3 rounded-t4d-lg border border-line bg-surface px-3 py-2 md:grid-cols-2">
            {/* ラベルは絞り込みの選択肢と同じ文言。リンクにはしない（同じ名前のリンクを重ねない） */}
            <StatusBreakdown
              label={`状態別（全 ${allRows.length} 件）`}
              items={NARRATIVE_STATUSES.map((s) => ({
                key: s,
                label: NARRATIVE_STATUS_LABELS[s],
                count: allRows.filter((row) => row.record.status === s).length,
                icon: narrativeStatusIcon(s),
              }))}
            />
            <StatusBreakdown
              label={`情報種別別（全 ${allRows.length} 件）`}
              items={NARRATIVE_THEMES.map((t) => ({
                key: t,
                label: NARRATIVE_THEME_LABELS[t],
                count: allRows.filter((row) => row.record.theme === t).length,
                icon: NARRATIVE_THEME_ICONS[t],
              }))}
            />
          </div>
        )}

        <DataTable
          id="narratives"
          caption="定性情報"
          columns={columns}
          rows={pageRows}
          getRowId={(row) => row.record.id}
          getRowLabel={(row) => row.record.title}
          getRowStatus={(row) => row.record.status}
          searchParams={query}
          basePath={BASE_PATH}
          search={{ placeholder: '題名・タグ・本文で検索' }}
          filters={[
            {
              key: 'theme',
              label: '情報種別',
              multiple: false,
              options: NARRATIVE_THEMES.map((t) => ({
                value: t,
                label: NARRATIVE_THEME_LABELS[t],
              })),
            },
            {
              key: 'status',
              label: '状態',
              multiple: false,
              options: NARRATIVE_STATUSES.map((s) => ({
                value: s,
                label: NARRATIVE_STATUS_LABELS[s],
              })),
            },
          ]}
          overflowFilters={[
            {
              key: 'coverage',
              label: '基準別の状況',
              multiple: false,
              options: CONTENT_COVERAGE_FILTERS.map((f) => ({
                value: f,
                label: CONTENT_COVERAGE_FILTER_LABELS[f],
              })),
            },
          ]}
          page={{ page, pageSize, total: rows.length, sizes: DEFAULT_PAGE_SIZES }}
          className="rounded-t4d-lg border border-line bg-surface"
          rowActions={(row) => {
            const canCarry =
              canWrite &&
              row.currentVersion !== null &&
              row.period !== null &&
              row.period.startDate < target.startDate;
            return canCarry
              ? {
                  rowLabel: row.record.title,
                  items: [
                    {
                      kind: 'submit',
                      id: `carry-${row.record.id}`,
                      label: `前年から引継ぎ（${target.code} へ）`,
                      icon: <History aria-hidden="true" />,
                      action: carryForwardNarrativeAction,
                      fields: { narrativeId: row.record.id, targetPeriodId: target.id },
                    },
                  ],
                }
              : null;
          }}
          empty={{
            noData: {
              title: '定性情報はまだありません',
              description: canWrite
                ? '新しく登録するか、登録した資料の抜粋から候補を作成してください。'
                : '定性情報は作成担当（開示の編集権限を持つ人）が登録します。登録されるとここに並びます。',
              action: canWrite ? (
                <Button variant="secondary" size="sm" asChild>
                  <Link href={NEW_PATH}>
                    <FilePlus2 aria-hidden="true" />
                    新しく登録
                  </Link>
                </Button>
              ) : (
                <Button variant="secondary" size="sm" asChild>
                  <Link href="/enterprise/dashboard">ホームへ戻る</Link>
                </Button>
              ),
            },
            filtered: { title: '該当する定性情報はありません' },
          }}
        />
        <MoreInfo label="前年から引継ぎについて">
          <p>
            前年から引継ぎは {target.code}{' '}
            の下書きの版を作ります。前年の確認（承認）や前年の資料の引用は引き継がず、当年度の根拠を改めて付けます。各行の「操作」から選びます。
          </p>
        </MoreInfo>
      </div>
    </>
  );
}
