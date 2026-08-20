import { PenLine } from 'lucide-react';
import { SectionTitle } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { requireAssuranceContext } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import { formatJst } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import { loadEngagementOr404 } from '@/lib/services/assurance';
import { clearReviewNoteAction, createReviewNoteAction } from '../../../actions';
import { EngagementHeader } from '../engagement-header';

export const metadata = { title: 'レビューNote' };

export default async function ReviewNotesPage({
  params,
}: {
  params: Promise<{ engagementId: string }>;
}) {
  const { engagementId } = await params;
  const ctx = await requireAssuranceContext();
  const db = await getDb();
  const context = await loadEngagementOr404(db, ctx, engagementId);

  const notes = await db.select('reviewNotes', {
    where: { engagementId },
    orderBy: { column: 'createdAt', dir: 'desc' },
  });
  const members = await db.select('engagementMembers', { where: { engagementId } });
  const profileIds = [
    ...new Set([...members.map((m) => m.userId), ...notes.map((n) => n.raisedBy)]),
  ];
  const profiles =
    profileIds.length > 0 ? await db.select('profiles', { where: { id: { in: profileIds } } }) : [];
  const nameOf = (id: string | null) =>
    id ? (profiles.find((p) => p.id === id)?.displayName ?? '—') : '—';

  const canWrite = can(ctx, 'assurance.review.write');

  return (
    <>
      <EngagementHeader context={context} page="レビューNote" />

      <div className="space-y-3 p-4">
        <Card className="border-brand-200 bg-brand-50">
          <p className="px-3 py-2 text-[12px] text-brand-900">
            レビュー Note は<strong>既定で監査法人内部限定</strong>です。「クライアントへ共有」を
            明示的に有効にしたものだけが企業側から閲覧できます（DB の RLS
            でも同じ条件で制御しています）。
          </p>
        </Card>

        {canWrite && (
          <Card>
            <SectionTitle title="レビュー Note を追加" />
            <form action={createReviewNoteAction} className="grid grid-cols-6 gap-2 p-3">
              <input type="hidden" name="engagementId" value={engagementId} />
              <label className="col-span-5 text-[12px] text-ink-muted">
                内容
                <Textarea name="body" rows={2} required className="mt-0.5" />
              </label>
              <label className="col-span-1 text-[12px] text-ink-muted">
                担当
                <select
                  name="assignedTo"
                  className="mt-0.5 block h-7 w-full rounded-t4d border border-line bg-surface px-2 text-[13px]"
                >
                  <option value="">（未割当）</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.userId}>
                      {nameOf(m.userId)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="col-span-6 flex items-center gap-1.5 text-[12px] text-ink">
                <input type="checkbox" name="sharedWithClient" className="accent-[#0b57a4]" />
                クライアントへ共有する（既定は内部限定）
              </label>
              <div className="col-span-6">
                <Button type="submit" size="sm">
                  <PenLine aria-hidden="true" />
                  追加
                </Button>
              </div>
            </form>
          </Card>
        )}

        <Card>
          <SectionTitle title={`レビュー Note（${notes.length}）`} />
          {notes.length === 0 ? (
            <EmptyState title="レビュー Note はありません" />
          ) : (
            <ul className="divide-y divide-line">
              {notes.map((note) => (
                <li key={note.id} className="p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      tone={
                        note.status === 'cleared'
                          ? 'success'
                          : note.status === 'responded'
                            ? 'brand'
                            : 'warning'
                      }
                    >
                      {note.status}
                    </Badge>
                    {note.sharedWithClient ? (
                      <Badge tone="brand">クライアント共有</Badge>
                    ) : (
                      <Badge tone="neutral">法人内部限定</Badge>
                    )}
                    <span className="ml-auto text-[11px] text-ink-muted">
                      {nameOf(note.raisedBy)} ／ {formatJst(note.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1 text-[12px] text-ink">{note.body}</p>
                  {note.assignedTo && (
                    <p className="text-[11px] text-ink-muted">担当: {nameOf(note.assignedTo)}</p>
                  )}
                  {note.resolutionComment && (
                    <p className="mt-1 text-[12px] text-success">対応: {note.resolutionComment}</p>
                  )}

                  {canWrite && note.status !== 'cleared' && (
                    <form action={clearReviewNoteAction} className="mt-2 flex items-end gap-2">
                      <input type="hidden" name="engagementId" value={engagementId} />
                      <input type="hidden" name="noteId" value={note.id} />
                      <label className="flex-1 text-[11px] text-ink-muted">
                        対応内容
                        <Input name="resolutionComment" required className="mt-0.5" />
                      </label>
                      <Button type="submit" size="xs" variant="outline">
                        クリア
                      </Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
