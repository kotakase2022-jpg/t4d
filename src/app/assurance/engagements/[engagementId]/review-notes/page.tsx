import Link from 'next/link';
import { PenLine } from 'lucide-react';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { FlashMessage } from '@/components/shared/flash';
import { SegmentedFilter } from '@/components/shared/nav-tabs';
import { Notice } from '@/components/shared/notice';
import { PageActions } from '@/components/shared/page-actions';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { SemanticBadge, StatusBadge } from '@/components/shared/status-badge';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { requireAssuranceContext } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import { formatJst } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import { loadEngagementOr404 } from '@/lib/services/assurance';
import { clearReviewNoteAction, createReviewNoteAction } from '../../../actions';
import { EngagementHeader } from '../engagement-header';

export const metadata = { title: 'レビューNote' };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function ReviewNotesPage({
  params,
  searchParams,
}: {
  params: Promise<{ engagementId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { engagementId } = await params;
  const query = await searchParams;
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const context = await loadEngagementOr404(db, ctx, engagementId);
  const basePath = `/assurance/engagements/${engagementId}/review-notes`;

  const notes = await db.select('reviewNotes', {
    where: { engagementId },
    orderBy: { column: 'createdAt', dir: 'desc' },
  });
  const members = await db.select('engagementMembers', { where: { engagementId } });
  const team = members.filter((m) => m.removedAt === null);
  const profileIds = [
    ...new Set([...members.map((m) => m.userId), ...notes.map((n) => n.raisedBy)]),
  ];
  const profiles =
    profileIds.length > 0 ? await db.select('profiles', { where: { id: { in: profileIds } } }) : [];
  const nameOf = (id: string | null) =>
    id ? (profiles.find((p) => p.id === id)?.displayName ?? '—') : '—';

  const canWrite = can(ctx, 'assurance.review.write');
  const panelOpen = canWrite && isCreatePanelOpen(query);

  const filter = typeof query.filter === 'string' ? query.filter : 'all';
  const openNotes = notes.filter((n) => n.status !== 'cleared');
  const shown =
    filter === 'open'
      ? openNotes
      : filter === 'cleared'
        ? notes.filter((n) => n.status === 'cleared')
        : notes;
  const filterHref = (key: string) => (key === 'all' ? basePath : `${basePath}?filter=${key}`);

  return (
    <>
      <EngagementHeader
        context={context}
        page="レビューNote"
        actions={
          <PageActions
            primary={{
              kind: 'link',
              id: 'create-review-note',
              shortcut: 'new',
              label: 'レビューNote を追加',
              icon: <PenLine aria-hidden="true" />,
              href: createPanelHref(basePath, query, { open: true }),
              // 追加欄を開いているときは、欄の中の「追加」が主操作
              hidden: !canWrite || panelOpen,
            }}
          />
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        {/* 共有の範囲は安全の注記（折りたたまない） */}
        <Notice tone="info">
          レビュー Note は<strong>既定で監査法人内部限定</strong>です。「クライアントへ共有」を
          明示的に有効にしたものだけが企業側から閲覧できます（DB の RLS
          でも同じ条件で制御しています）。
        </Notice>

        {canWrite && (
          <CreatePanel
            id="create-review-note"
            title="レビューNote を追加"
            searchParams={query}
            closeHref={createPanelHref(basePath, query, { open: false })}
          >
            <form action={createReviewNoteAction} className="space-y-2">
              <input type="hidden" name="engagementId" value={engagementId} />
              <div className="grid grid-cols-6 gap-2">
                <Field label="内容" name="body" required className="col-span-5">
                  {(p) => <Textarea {...p} name="body" rows={2} />}
                </Field>
                <Field label="担当" name="assignedTo" className="col-span-1">
                  {(p) => (
                    <NativeSelect {...p} name="assignedTo" defaultValue="">
                      <option value="">（未割当）</option>
                      {team.map((m) => (
                        <option key={m.id} value={m.userId}>
                          {nameOf(m.userId)}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
              </div>
              <NativeCheckbox
                name="sharedWithClient"
                label="クライアントへ共有する（既定は内部限定）"
              />
              <div>
                <SubmitButton
                  variant="primary"
                  size="sm"
                  icon={<PenLine aria-hidden="true" />}
                  pendingLabel="追加中…"
                >
                  追加
                </SubmitButton>
              </div>
            </form>
          </CreatePanel>
        )}

        <Section
          title={`レビュー Note（${notes.length}）`}
          summary={filter === 'all' ? undefined : `表示 ${shown.length} 件`}
        >
          <SegmentedFilter
            ariaLabel="レビュー Note の状態で絞り込む"
            current={filter === 'open' || filter === 'cleared' ? filter : 'all'}
            className="mb-2"
            items={[
              { key: 'all', label: 'すべて', href: filterHref('all'), count: notes.length },
              {
                key: 'open',
                label: '未クリア',
                href: filterHref('open'),
                count: openNotes.length,
                attention: openNotes.length > 0,
              },
              {
                key: 'cleared',
                label: 'クリア済み',
                href: filterHref('cleared'),
                count: notes.length - openNotes.length,
              },
            ]}
          />

          {notes.length === 0 ? (
            canWrite ? (
              <EmptyState
                kind="no-data"
                size="compact"
                title="レビュー Note はありません"
                description="調書や手続について指摘・質問を残すと、担当者の対応とクリアまでを追跡できます。"
                action={
                  <Link
                    href={createPanelHref(basePath, query, { open: true })}
                    className="text-small text-brand-700 hover:underline"
                  >
                    レビューNote を追加
                  </Link>
                }
              />
            ) : (
              <EmptyState kind="not-applicable" size="compact" title="レビュー Note はありません" />
            )
          ) : shown.length === 0 ? (
            <EmptyState kind="filtered" size="compact" resetHref={filterHref('all')} />
          ) : (
            <ul className="divide-y divide-line rounded-t4d border border-line">
              {shown.map((note) => (
                <li key={note.id} className="p-3" data-t4d-record="">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge domain="reviewNote" value={note.status} />
                    {note.sharedWithClient ? (
                      <SemanticBadge semantic="info" label="クライアント共有" />
                    ) : (
                      <SemanticBadge semantic="excluded" label="法人内部限定" />
                    )}
                    <span className="ml-auto text-caption text-ink-muted">
                      {nameOf(note.raisedBy)} ／ {formatJst(note.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1 text-small text-ink">{note.body}</p>
                  {note.assignedTo && (
                    <p className="text-caption text-ink-muted">担当: {nameOf(note.assignedTo)}</p>
                  )}
                  {note.resolutionComment && (
                    <p className="mt-1 text-small text-success">対応: {note.resolutionComment}</p>
                  )}

                  {canWrite && note.status !== 'cleared' && (
                    <form action={clearReviewNoteAction} className="mt-2 flex items-end gap-2">
                      <input type="hidden" name="engagementId" value={engagementId} />
                      <input type="hidden" name="noteId" value={note.id} />
                      <label className="flex-1 text-caption text-ink-muted">
                        対応内容
                        <Input name="resolutionComment" required className="mt-0.5" />
                      </label>
                      <SubmitButton size="xs" variant="secondary">
                        クリア
                      </SubmitButton>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}
