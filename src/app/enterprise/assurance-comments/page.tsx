import Link from 'next/link';
import { Reply } from 'lucide-react';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { PreservingForm } from '@/components/shared/preserving-form';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { FlashMessage } from '@/components/shared/flash';
import { Notice } from '@/components/shared/notice';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import { requireEnterpriseContext } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import { formatJst } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import { loadClientAssuranceComments, type ClientCommentRow } from '@/lib/services/assurance';
import { noteBodyLimit } from '@/lib/services/assurance-notes';
import { statusLabel } from '@/lib/ui/status/registry';
import { CLIENT_NOTE_STATES, type ClientNoteState } from '@/lib/ui/status/clientNote';
import { respondToAssuranceNoteAction } from './actions';

export const metadata = { title: '保証側のコメント' };

type SearchParams = Record<string, string | string[] | undefined>;

const BASE = '/enterprise/assurance-comments';

function param(query: SearchParams, key: string): string | null {
  const value = query[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function isState(value: string | null): value is ClientNoteState {
  return value !== null && (CLIENT_NOTE_STATES as readonly string[]).includes(value);
}

/** 対象の 1 行（開示レポートの段落・数値。案件全体へのコメントは「案件全体」） */
function targetText(row: ClientCommentRow): string {
  if (!row.target) return '案件全体';
  const kind = row.target.kind === 'report_paragraph' ? '段落' : '数値';
  return `開示レポート ${row.target.reportLabel ?? '（写しを読めません）'} ／ ${kind}「${row.target.place}」`;
}

/**
 * 保証側のコメント（トライアル対応 NF-21 の企業側）。監査法人が「クライアントへ共有」したコメントだけを並べ、
 * 行の主操作「回答する」で回答する（追記。監査法人の行は企業が更新しない）。
 *
 * 状態（未回答／回答済み／クリア）は回答の有無と保証側の状態から導く。対象は共有した開示レポートの
 * 写しの段落・数値（追跡番号付き）。開示プロジェクトの「レビュー・承認」タブ・ワークフローから届く。
 */
export default async function AssuranceCommentsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const query = await searchParams;
  const ctx = await requireEnterpriseContext();
  if (!can(ctx, 'enterprise.disclosure.read')) {
    return (
      <>
        <PageHeader title="保証側のコメント" autoBreadcrumbs />
        <PermissionDeniedState
          description="保証側のコメントを見るには、開示の閲覧権限が必要です。"
          permission="enterprise.disclosure.read"
        />
      </>
    );
  }
  const db = await getDb();
  const all = await loadClientAssuranceComments(db, ctx);
  const canRespond = can(ctx, 'enterprise.disclosure.write');
  const limit = noteBodyLimit(ctx);

  const state = param(query, 'state');
  const engagement = param(query, 'engagement');
  const project = param(query, 'project');
  const search = param(query, 'q')?.trim().toLowerCase() ?? '';
  const rows = all
    .filter((r) => (isState(state) ? r.state === state : true))
    .filter((r) => (engagement ? r.engagement.id === engagement : true))
    .filter((r) => (project ? r.projectId === project : true))
    .filter((r) =>
      search === ''
        ? true
        : `${r.note.body} ${targetText(r)} ${r.engagement.code} ${r.engagement.name}`
            .toLowerCase()
            .includes(search),
    );
  const unanswered = all.filter((r) => r.state === 'unanswered').length;

  // 回答欄（?new=1&note=）。回答できるのは共有中・未クリアのコメントだけ
  const respondTarget = all.find((r) => r.note.id === param(query, 'note')) ?? null;
  const panelOpen =
    canRespond &&
    isCreatePanelOpen(query) &&
    respondTarget !== null &&
    respondTarget.state !== 'cleared';
  const respondHref = (row: ClientCommentRow) =>
    `${createPanelHref(BASE, { ...query, note: row.note.id }, { open: true })}#respond-note`;

  const engagements = [...new Map(all.map((r) => [r.engagement.id, r.engagement])).values()];
  const projects = [
    ...new Map(
      all
        .filter((r) => r.projectId !== null)
        .map((r) => [r.projectId!, r.projectName ?? '開示プロジェクト']),
    ),
  ];

  const columns: DataTableColumn<ClientCommentRow>[] = [
    {
      key: 'target',
      header: '対象',
      importance: 'primary',
      lockVisible: true,
      pinned: 'left',
      cell: (row) => (
        <span className="block min-w-0">
          <span className="block text-small text-ink">{targetText(row)}</span>
          {row.target?.traceId && (
            <span className="font-mono text-caption text-ink-muted">{row.target.traceId}</span>
          )}
        </span>
      ),
    },
    {
      key: 'body',
      header: 'コメント',
      importance: 'primary',
      cell: (row) => <span className="line-clamp-2 text-small text-ink">{row.note.body}</span>,
    },
    {
      key: 'state',
      header: '状態',
      importance: 'primary',
      cell: (row) => <StatusBadge domain="clientNote" value={row.state} />,
    },
    {
      key: 'engagement',
      header: '案件',
      importance: 'secondary',
      cell: (row) => (
        <span className="text-small">
          <span className="font-mono">{row.engagement.code}</span>
          <span className="ml-1 text-ink-muted">{row.engagement.name}</span>
        </span>
      ),
    },
    {
      key: 'createdAt',
      header: '起票日',
      importance: 'secondary',
      cell: (row) => (
        <span className="whitespace-nowrap text-small">{formatJst(row.note.createdAt)}</span>
      ),
    },
    {
      key: 'responses',
      header: '回答',
      importance: 'detail',
      align: 'right',
      cell: (row) => <span className="tnum">{row.responses.length}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="保証側のコメント"
        description="監査法人がクライアントへ共有したコメントと回答"
        autoBreadcrumbs
      />

      <div className="space-y-3 px-4 pb-4 pt-3">
        <FlashMessage searchParams={query} />
        {param(query, 'result') === 'responded' && (
          <Notice tone="success" role="status">
            回答を送りました。保証側の画面に回答が表示されます（回答は追記で残り、取り消せません）。
          </Notice>
        )}
        {/* 範囲と取り扱いの注記（折りたたまない） */}
        <Notice tone="info">
          監査法人が「クライアントへ共有」したコメントだけを表示します（法人内部限定のコメントは表示されません）。コメントは監査法人の記録で、企業側からは変更できません。回答は追記で残り、取り消せません。
        </Notice>

        {panelOpen && respondTarget && (
          <CreatePanel
            id="respond-note"
            title="回答する"
            searchParams={query}
            closeHref={createPanelHref(BASE, query, { open: false })}
            description="回答は保証側の画面に表示されます。送った回答は取り消せません。"
          >
            <div className="mb-2 space-y-0.5 rounded-t4d bg-surface-muted px-3 py-2 text-small">
              <p className="text-caption text-ink-muted">
                {respondTarget.engagement.code} ／ {targetText(respondTarget)}
              </p>
              {respondTarget.target?.excerpt && (
                <p className="border-l-2 border-line pl-2 text-caption text-ink-muted">
                  {respondTarget.target.excerpt}
                </p>
              )}
              <p className="text-ink">{respondTarget.note.body}</p>
            </div>
            <PreservingForm action={respondToAssuranceNoteAction} className="space-y-2">
              <input type="hidden" name="noteId" value={respondTarget.note.id} />
              <Field label="回答" name="body" required hint={`${limit} 字まで`}>
                {(p) => <Textarea {...p} name="body" rows={3} maxLength={limit} />}
              </Field>
              <SubmitButton
                variant="primary"
                size="sm"
                icon={<Reply aria-hidden="true" />}
                pendingLabel="送信中…"
              >
                回答を送る
              </SubmitButton>
            </PreservingForm>
          </CreatePanel>
        )}

        <Section
          title={`保証側のコメント（${all.length}）`}
          summary={unanswered > 0 ? `未回答 ${unanswered} 件` : undefined}
        >
          {all.length === 0 ? (
            <EmptyState
              kind="not-applicable"
              size="page"
              title="保証側からのコメントはありません"
              description="監査法人が共有した開示レポートの段落・数値にコメントし、クライアントへ共有すると、ここに並びます。"
              action={
                <Link
                  href="/enterprise/workflows"
                  className="text-small text-brand-700 hover:underline"
                >
                  ワークフローへ戻る
                </Link>
              }
            />
          ) : (
            <DataTable<ClientCommentRow>
              id="assurance-comments"
              caption="保証側のコメント"
              columns={columns}
              rows={rows}
              getRowId={(row) => row.note.id}
              getRowLabel={(row) => `${row.engagement.code} ${targetText(row)}`}
              getRowStatus={(row) => statusLabel('clientNote', row.state)}
              searchParams={query}
              basePath={BASE}
              search={{ placeholder: 'コメント・対象・案件で検索' }}
              filters={[
                {
                  key: 'state',
                  label: '状態',
                  options: CLIENT_NOTE_STATES.map((s) => ({
                    value: s,
                    label: statusLabel('clientNote', s),
                  })),
                },
              ]}
              overflowFilters={[
                ...(engagements.length > 1
                  ? [
                      {
                        key: 'engagement',
                        label: '案件',
                        options: engagements.map((e) => ({
                          value: e.id,
                          label: `${e.code} ${e.name}`,
                        })),
                      },
                    ]
                  : []),
                ...(projects.length > 0
                  ? [
                      {
                        key: 'project',
                        label: '開示プロジェクト',
                        options: projects.map(([id, name]) => ({ value: id, label: name })),
                      },
                    ]
                  : []),
              ]}
              rowActions={(row) => ({
                rowLabel: `${row.engagement.code} ${targetText(row)}`,
                primary: {
                  kind: 'link',
                  id: `respond-${row.note.id}`,
                  label: row.state === 'answered' ? '追加で回答する' : '回答する',
                  icon: <Reply aria-hidden="true" />,
                  href: respondHref(row),
                  hidden: !canRespond || row.state === 'cleared',
                },
              })}
              expand={(row) => (
                <div className="space-y-1 text-small">
                  <p className="whitespace-pre-wrap text-ink">{row.note.body}</p>
                  {row.target?.excerpt && (
                    <p className="border-l-2 border-line pl-2 text-caption text-ink-muted">
                      対象の本文: {row.target.excerpt}
                    </p>
                  )}
                  {row.responses.length === 0 ? (
                    <p className="text-caption text-ink-muted">回答はまだありません。</p>
                  ) : (
                    <ul className="space-y-0.5" aria-label="回答">
                      {row.responses.map((r) => (
                        <li key={r.id}>
                          <span className="text-caption text-ink-muted">
                            回答 {formatJst(r.respondedAt)}
                          </span>
                          <p className="text-ink">{r.body}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              empty={{
                noData: {
                  title: '保証側からのコメントはありません',
                  action: (
                    <Link
                      href="/enterprise/workflows"
                      className="text-small text-brand-700 hover:underline"
                    >
                      ワークフローへ戻る
                    </Link>
                  ),
                },
              }}
            />
          )}
        </Section>
      </div>
    </>
  );
}
