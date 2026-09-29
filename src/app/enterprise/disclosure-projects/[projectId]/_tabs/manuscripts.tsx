import Link from 'next/link';
import { AlertTriangle, CheckCircle2, FileText, Info, MessageSquare, User } from 'lucide-react';
import { SectionTitle } from '@/components/shared/page-header';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { AuthorizationError } from '@/lib/authorization/can';
import { getReferenceDate } from '@/lib/clock';
import { daysUntilJst, formatJstDate, isOverdue } from '@/lib/format/datetime';
import {
  MANUSCRIPT_FILTERS,
  MANUSCRIPT_FILTER_LABELS,
  listProjectBlocks,
  type ManuscriptFilter,
  type ManuscriptList,
} from '@/lib/services/disclosure-block';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { AddBlockForm } from './add-block-form';
import { BlockStatusBadge, FreshnessBadge } from '../blocks/status-badges';

function isFilter(value: unknown): value is ManuscriptFilter {
  return typeof value === 'string' && (MANUSCRIPT_FILTERS as readonly string[]).includes(value);
}

/**
 * 原稿タブ: 節ごとの本文状態・参照の鮮度・阻害条件・担当・期限。
 * 絞り込みは URL（?tab=manuscripts&filter=...）に持ち、共有・戻る操作で同じ一覧に戻れるようにする。
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
      return <PermissionDeniedState description="原稿を見るには、開示の閲覧権限が必要です。" />;
    }
    throw error;
  }

  const today = getReferenceDate();
  const base = `/enterprise/disclosure-projects/${projectId}?tab=manuscripts`;

  return (
    <div className="space-y-3">
      <nav aria-label="原稿の絞り込み" className="flex flex-wrap items-center gap-1.5">
        <Link
          href={base}
          aria-current={filter === null ? 'page' : undefined}
          className={`rounded-t4d border px-2 py-1 text-[12px] ${
            filter === null
              ? 'border-brand-300 bg-brand-100 font-medium text-brand-900'
              : 'border-line text-ink hover:bg-brand-50'
          }`}
        >
          すべて（{list.total}）
        </Link>
        {MANUSCRIPT_FILTERS.map((f) => (
          <Link
            key={f}
            href={`${base}&filter=${f}`}
            aria-current={filter === f ? 'page' : undefined}
            className={`rounded-t4d border px-2 py-1 text-[12px] ${
              filter === f
                ? 'border-brand-300 bg-brand-100 font-medium text-brand-900'
                : 'border-line text-ink hover:bg-brand-50'
            }`}
          >
            {MANUSCRIPT_FILTER_LABELS[f]}（{list.counts[f]}）
          </Link>
        ))}
      </nav>

      <Card className="overflow-hidden">
        <SectionTitle title={`原稿（${list.rows.length} / ${list.total} 節）`} />
        {list.rows.length === 0 ? (
          <EmptyState
            title={filter ? '条件に合う節はありません' : '節がまだありません'}
            description={
              filter
                ? '絞り込みを外すと、すべての節を表示します。'
                : '下の「節を追加」から、基準の版を選んで節を作ってください。'
            }
            icon={<FileText className="size-5" aria-hidden="true" />}
            action={
              filter ? (
                <Button variant="outline" size="sm" asChild>
                  <Link href={base}>すべて表示</Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="max-h-[70vh] overflow-auto">
            {/* 長い一覧でも列見出しを固定する（縦にスクロールする枠の中で sticky にする） */}
            <Table>
              <THead className="sticky top-0 z-10 bg-surface">
                <TR>
                  <TH>節</TH>
                  <TH>本文状態</TH>
                  <TH>参照</TH>
                  <TH>阻害条件</TH>
                  <TH>担当</TH>
                  <TH>期限</TH>
                </TR>
              </THead>
              <TBody>
                {list.rows.map((row) => {
                  const remaining = daysUntilJst(row.dueDate, today);
                  const overdue = isOverdue(row.dueDate, today) && row.status !== 'approved';
                  return (
                    <TR key={row.id}>
                      <TD>
                        <Link
                          href={`/enterprise/disclosure-projects/${projectId}/blocks/${row.id}`}
                          className="font-medium text-brand-700 underline-offset-2 hover:underline"
                        >
                          {row.title}
                        </Link>
                        <div className="text-[11px] text-ink-muted">
                          {row.frameworkLabel}
                          {row.frameworkIsDraft ? '（草案）' : ''} ／ {row.languageLabel}
                          {row.translationOfTitle ? ` ／ 翻訳元: ${row.translationOfTitle}` : ''}
                        </div>
                      </TD>
                      <TD>
                        <BlockStatusBadge status={row.status} />
                        <div className="mt-0.5 text-[11px] text-ink-muted">
                          {row.hasBody ? `版 ${row.currentVersionNo ?? '—'}` : '本文なし'}
                          {row.approvedVersionNo !== null
                            ? ` ／ 承認済み 版 ${row.approvedVersionNo}`
                            : ''}
                        </div>
                      </TD>
                      <TD>
                        <FreshnessBadge status={row.freshness} />
                        {row.freshness !== 'current' && (
                          <Link
                            href={`/enterprise/disclosure-projects/${projectId}/blocks/${row.id}/recheck`}
                            className="mt-0.5 block text-[11px] text-brand-700 underline-offset-2 hover:underline"
                          >
                            再確認する
                          </Link>
                        )}
                      </TD>
                      <TD className="max-w-[320px]">
                        {row.blockers.length === 0 && row.narrativeGaps.length === 0 ? (
                          <span className="inline-flex items-center gap-1 text-[12px] text-success">
                            <CheckCircle2 className="size-3.5" aria-hidden="true" />
                            なし
                          </span>
                        ) : null}
                        {row.blockers.length === 0 && row.narrativeGaps.length === 0 ? null : (
                          <ul className="space-y-0.5 text-[12px] text-ink">
                            {row.blockers.map((b, i) => (
                              <li key={`${b.code}-${i}`} className="flex items-start gap-1">
                                <AlertTriangle
                                  className="mt-0.5 size-3 shrink-0 text-[#8a5d00]"
                                  aria-hidden="true"
                                />
                                {b.message}
                              </li>
                            ))}
                            {/* 本文は書けていても、引用した定性情報に未記入があれば未解決の必須情報 */}
                            {row.narrativeGaps.map((gap) => (
                              <li key={`gap-${gap.title}`} className="flex items-start gap-1">
                                <AlertTriangle
                                  className="mt-0.5 size-3 shrink-0 text-[#8a5d00]"
                                  aria-hidden="true"
                                />
                                引用した定性情報「{gap.title}」に未記入: {gap.fields.join('・')}
                              </li>
                            ))}
                          </ul>
                        )}
                        {/* 不足ではないが、本文の判断材料として示す（財務的影響を定量化しない理由など） */}
                        {row.narrativeNotes.length > 0 && (
                          <ul className="mt-0.5 space-y-0.5 text-[11px] text-ink-muted">
                            {row.narrativeNotes.map((note) => (
                              <li key={`note-${note.title}`} className="flex items-start gap-1">
                                <Info className="mt-0.5 size-3 shrink-0" aria-hidden="true" />「
                                {note.title}」: {note.note}
                              </li>
                            ))}
                          </ul>
                        )}
                        {row.unresolvedComments > 0 && (
                          <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-ink-muted">
                            <MessageSquare className="size-3" aria-hidden="true" />
                            未解決のコメント {row.unresolvedComments}
                          </span>
                        )}
                      </TD>
                      <TD>
                        {row.ownerName}
                        {row.ownerUserId === ctx.userId && (
                          <Badge tone="brand" className="ml-1">
                            <User className="size-3" aria-hidden="true" />
                            自分
                          </Badge>
                        )}
                      </TD>
                      <TD>
                        <span className={overdue ? 'font-medium text-danger' : ''}>
                          {formatJstDate(row.dueDate)}
                        </span>
                        {remaining !== null && row.status !== 'approved' && (
                          <span className="block text-[11px] text-ink-muted">
                            {overdue ? `${Math.abs(remaining)} 日超過` : `あと ${remaining} 日`}
                          </span>
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

      {list.canWrite && list.frameworks.length > 0 && (
        <Card>
          <AddBlockForm
            projectId={projectId}
            frameworks={list.frameworks.map((f) => ({ versionId: f.versionId, label: f.label }))}
            rows={list.rows.map((row) => ({
              id: row.id,
              title: row.title,
              languageLabel: row.languageLabel,
            }))}
          />
        </Card>
      )}
    </div>
  );
}
