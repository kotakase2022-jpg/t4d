import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Info, MessageSquare, Plus, User } from 'lucide-react';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { MoreMenu } from '@/components/shared/more-menu';
import { SegmentedFilter } from '@/components/shared/nav-tabs';
import { PageActions } from '@/components/shared/page-actions';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { AuthorizationError } from '@/lib/authorization/can';
import { getReferenceDate } from '@/lib/clock';
import { daysUntilJst, formatJstDate, isOverdue } from '@/lib/format/datetime';
import {
  MANUSCRIPT_FILTERS,
  MANUSCRIPT_FILTER_LABELS,
  listProjectBlocks,
  type ManuscriptFilter,
  type ManuscriptList,
  type ManuscriptRow,
} from '@/lib/services/disclosure-block';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { DEFAULT_PAGE_SIZES, parsePage, parsePageSize } from '@/lib/table/columns';
import type { MenuActionSpec } from '@/lib/ui/actions';
import { cn } from '@/lib/utils';
import { AddBlockForm } from './add-block-form';
import { BlockStatusBadge, FreshnessBadge } from '../blocks/status-badges';

function isFilter(value: unknown): value is ManuscriptFilter {
  return typeof value === 'string' && (MANUSCRIPT_FILTERS as readonly string[]).includes(value);
}

/** 常に見せる絞り込み（plan S1: すべて／自分の担当／差戻し）。残りは「その他の絞り込み ▾」 */
const PRIMARY_FILTERS: readonly ManuscriptFilter[] = ['mine', 'returned'];

/**
 * 原稿タブ: 節ごとの本文状態・参照の鮮度・阻害条件・担当・期限（plan S1）。
 *
 * - 絞り込みは URL（?tab=manuscripts&filter=...）に持ち、共有・戻る操作で同じ一覧に戻れるようにする。
 *   既定は「すべて」のまま（担当で絞ると、ほかの節の阻害条件が見えなくなるため）
 * - 「節を追加」は主操作（開示の編集権限があるときだけ）。フォームは ?new=1 で開く CreatePanel
 * - 一覧は DataTable（節の名前のセルが主リンク）
 */
export async function ManuscriptsTab({
  projectId,
  searchParams,
}: {
  projectId: string;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const { db, ctx } = await loadEnterpriseShell();
  const filter = isFilter(searchParams.filter) ? searchParams.filter : null;

  let list: ManuscriptList;
  try {
    list = await listProjectBlocks(db, ctx, projectId, filter);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return (
        <PermissionDeniedState
          description="原稿を見るには、開示の閲覧権限が必要です。"
          permission="enterprise.disclosure.read"
        />
      );
    }
    throw error;
  }

  const today = getReferenceDate();
  const projectPath = `/enterprise/disclosure-projects/${projectId}`;
  const base = `${projectPath}?tab=manuscripts`;
  const filterHref = (f: ManuscriptFilter | null) => (f ? `${base}&filter=${f}` : base);
  const canAdd = list.canWrite && list.frameworks.length > 0;
  const panelOpen = canAdd && isCreatePanelOpen(searchParams);
  const pageSize = parsePageSize(searchParams.size);
  const page = Math.min(
    parsePage(searchParams.page),
    Math.max(1, Math.ceil(list.rows.length / pageSize)),
  );
  const pageRows = list.rows.slice((page - 1) * pageSize, page * pageSize);

  const overflowFilters = MANUSCRIPT_FILTERS.filter((f) => !PRIMARY_FILTERS.includes(f));
  const segmentItems = [
    { key: 'all', label: 'すべて', href: filterHref(null), count: list.total },
    ...PRIMARY_FILTERS.map((f) => ({
      key: f,
      label: MANUSCRIPT_FILTER_LABELS[f],
      href: filterHref(f),
      count: list.counts[f],
    })),
    // その他の絞り込みで選んでいるときは、いまの条件を見える位置に出す（どこで絞っているか分かるように）
    ...(filter && !PRIMARY_FILTERS.includes(filter)
      ? [
          {
            key: filter,
            label: MANUSCRIPT_FILTER_LABELS[filter],
            href: filterHref(filter),
            count: list.counts[filter],
          },
        ]
      : []),
  ];
  const overflowItems: MenuActionSpec[] = overflowFilters.map((f) => ({
    kind: 'link',
    id: `filter-${f}`,
    label: `${MANUSCRIPT_FILTER_LABELS[f]}（${list.counts[f]}）`,
    href: filterHref(f),
  }));

  const columns: DataTableColumn<ManuscriptRow>[] = [
    {
      key: 'title',
      header: '節',
      importance: 'primary',
      lockVisible: true,
      pinned: 'left',
      width: 'md',
      cell: (row) => (
        <>
          <Link
            href={`${projectPath}/blocks/${row.id}`}
            className="font-medium text-brand-700 underline-offset-2 hover:underline"
          >
            {row.title}
          </Link>
          <div className="text-caption text-ink-muted">
            {row.frameworkLabel}
            {row.frameworkIsDraft ? '（草案）' : ''} ／ {row.languageLabel}
            {row.translationOfTitle ? ` ／ 翻訳元: ${row.translationOfTitle}` : ''}
          </div>
        </>
      ),
    },
    {
      key: 'status',
      header: '本文状態',
      importance: 'primary',
      cell: (row) => (
        <>
          <BlockStatusBadge status={row.status} />
          <div className="mt-0.5 text-caption text-ink-muted">
            {row.hasBody ? `版 ${row.currentVersionNo ?? '—'}` : '本文なし'}
            {row.approvedVersionNo !== null ? ` ／ 承認済み 版 ${row.approvedVersionNo}` : ''}
          </div>
        </>
      ),
    },
    {
      key: 'freshness',
      header: '参照',
      importance: 'primary',
      cell: (row) => (
        <>
          <FreshnessBadge status={row.freshness} />
          {row.freshness !== 'current' && (
            <Link
              href={`${projectPath}/blocks/${row.id}/recheck`}
              className="mt-0.5 block text-caption text-brand-700 underline-offset-2 hover:underline"
            >
              再確認する
            </Link>
          )}
        </>
      ),
    },
    {
      key: 'blockers',
      header: '阻害条件',
      importance: 'secondary',
      width: 'lg',
      cell: (row) => <Blockers row={row} />,
    },
    {
      key: 'owner',
      header: '担当',
      importance: 'primary',
      cell: (row) => (
        <span className="whitespace-nowrap">
          {row.ownerName}
          {row.ownerUserId === ctx.userId && (
            <Badge tone="brand" className="ml-1">
              <User className="size-3" aria-hidden="true" />
              自分
            </Badge>
          )}
        </span>
      ),
    },
    {
      key: 'due',
      header: '期限',
      importance: 'primary',
      cell: (row) => {
        const remaining = daysUntilJst(row.dueDate, today);
        const overdue = isOverdue(row.dueDate, today) && row.status !== 'approved';
        return (
          <span className="whitespace-nowrap">
            <span className={cn(overdue && 'font-medium text-danger')}>
              {overdue && (
                <AlertTriangle className="mr-0.5 inline size-3 align-[-2px]" aria-hidden="true" />
              )}
              {formatJstDate(row.dueDate)}
            </span>
            {remaining !== null && row.status !== 'approved' && (
              <span className="block text-caption text-ink-muted">
                {overdue ? `${Math.abs(remaining)} 日超過` : `あと ${remaining} 日`}
              </span>
            )}
          </span>
        );
      },
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedFilter
          ariaLabel="原稿の絞り込み"
          current={filter ?? 'all'}
          items={segmentItems}
        />
        <MoreMenu label="その他の絞り込み" items={overflowItems} align="start" triggerSize="xs" />
        <div className="ml-auto">
          {/* 作成パネルを開いている間は、パネルの送信ボタンが主操作（主操作を 2 つ並べない） */}
          <PageActions
            primary={{
              kind: 'link',
              id: 'add-block',
              shortcut: 'new',
              label: '節を追加',
              href: createPanelHref(projectPath, searchParams, { open: true }),
              icon: <Plus aria-hidden="true" />,
              hidden: !canAdd || panelOpen,
            }}
          />
        </div>
      </div>

      {canAdd && (
        <CreatePanel
          id="add-block"
          title="節を追加（新しい節・翻訳版）"
          searchParams={searchParams}
          closeHref={createPanelHref(projectPath, searchParams, { open: false })}
        >
          <AddBlockForm
            projectId={projectId}
            frameworks={list.frameworks.map((f) => ({ versionId: f.versionId, label: f.label }))}
            rows={list.rows.map((row) => ({
              id: row.id,
              title: row.title,
              languageLabel: row.languageLabel,
            }))}
          />
        </CreatePanel>
      )}

      {list.rows.length === 0 && filter ? (
        <EmptyState
          kind="filtered"
          size="compact"
          title={`「${MANUSCRIPT_FILTER_LABELS[filter]}」に当たる節はありません`}
          description={`絞り込みを外すと、すべての節（${list.total} 節）を表示します。`}
          resetHref={base}
        />
      ) : (
        <DataTable
          id="project-manuscripts"
          caption={`原稿（${list.rows.length} / ${list.total} 節）`}
          columns={columns}
          rows={pageRows}
          getRowId={(row) => row.id}
          getRowLabel={(row) => row.title}
          getRowStatus={(row) => row.status}
          searchParams={searchParams}
          basePath={projectPath}
          search={false}
          page={{ page, pageSize, total: list.rows.length, sizes: DEFAULT_PAGE_SIZES }}
          className="rounded-t4d-lg border border-line bg-surface"
          empty={{
            noData: {
              title: '節がまだありません',
              description: canAdd
                ? '「節を追加」から、基準の版を選んで節を作ってください。'
                : '節は作成担当（開示の編集権限を持つ人）が追加します。基準が登録されていない場合は「設定」タブで確認できます。',
              action: canAdd ? (
                <Link
                  href={createPanelHref(projectPath, searchParams, { open: true })}
                  className="text-small text-brand-800 underline"
                >
                  節を追加
                </Link>
              ) : (
                <Link
                  href={`${projectPath}?tab=settings`}
                  className="text-small text-brand-800 underline"
                >
                  設定タブを開く
                </Link>
              ),
            },
          }}
        />
      )}
    </div>
  );
}

/** 阻害条件（レビュー依頼の前に解消が必要なこと）。不足ではない補足も判断材料として並べる */
function Blockers({ row }: { row: ManuscriptRow }) {
  const none = row.blockers.length === 0 && row.narrativeGaps.length === 0;
  return (
    <>
      {none ? (
        <span className="inline-flex items-center gap-1 text-small text-success">
          <CheckCircle2 className="size-3.5" aria-hidden="true" />
          なし
        </span>
      ) : (
        <ul className="space-y-0.5 text-small text-ink">
          {row.blockers.map((b, i) => (
            <li key={`${b.code}-${i}`} className="flex items-start gap-1">
              <AlertTriangle
                className="mt-0.5 size-3 shrink-0 text-warning-ink"
                aria-hidden="true"
              />
              {b.message}
            </li>
          ))}
          {/* 本文は書けていても、引用した定性情報に未記入があれば未解決の必須情報 */}
          {row.narrativeGaps.map((gap) => (
            <li key={`gap-${gap.title}`} className="flex items-start gap-1">
              <AlertTriangle
                className="mt-0.5 size-3 shrink-0 text-warning-ink"
                aria-hidden="true"
              />
              引用した定性情報「{gap.title}」に未記入: {gap.fields.join('・')}
            </li>
          ))}
        </ul>
      )}
      {/* 不足ではないが、本文の判断材料として示す（財務的影響を定量化しない理由など） */}
      {row.narrativeNotes.length > 0 && (
        <ul className="mt-0.5 space-y-0.5 text-caption text-ink-muted">
          {row.narrativeNotes.map((note) => (
            <li key={`note-${note.title}`} className="flex items-start gap-1">
              <Info className="mt-0.5 size-3 shrink-0" aria-hidden="true" />「{note.title}」:{' '}
              {note.note}
            </li>
          ))}
        </ul>
      )}
      {row.unresolvedComments > 0 && (
        <span className="mt-0.5 inline-flex items-center gap-1 text-caption text-ink-muted">
          <MessageSquare className="size-3" aria-hidden="true" />
          未解決のコメント {row.unresolvedComments}
        </span>
      )}
    </>
  );
}
