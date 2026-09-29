import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AlertTriangle, ArrowRight, CheckCircle2, History } from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { formatJst } from '@/lib/format/datetime';
import { getRecheckView, type RecheckView } from '@/lib/services/disclosure-recheck';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { decideRecheckAction } from '../../actions';
import { BlockStatusBadge, FreshnessBadge } from '../../status-badges';

export const metadata = { title: '引用先の再確認' };

/**
 * 上流の変更の再確認（指示書 §10.3）。旧版・新版・変更理由・影響する段落を並べ、
 * 「新しい版を採用」「引用中の版を維持（理由付き）」「担当者へ差戻し」を選ぶ。
 * 過去に承認した版・スナップショットは変えない。
 */
export default async function RecheckPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; blockId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId, blockId } = await params;
  const sp = await searchParams;
  const { db, ctx } = await loadEnterpriseShell();

  let view: RecheckView;
  try {
    view = await getRecheckView(db, ctx, blockId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof AuthorizationError) return <PermissionDeniedState />;
    throw error;
  }
  if (view.block.projectId !== projectId) notFound();

  const blockHref = `/enterprise/disclosure-projects/${projectId}/blocks/${blockId}`;

  return (
    <>
      <PageHeader
        title={`引用先の再確認: ${view.block.title}`}
        breadcrumbs={[
          { label: '企業ワークスペース' },
          { label: '開示プロジェクト', href: '/enterprise/disclosure-projects' },
          { label: '原稿', href: `/enterprise/disclosure-projects/${projectId}?tab=manuscripts` },
          { label: view.block.title, href: blockHref },
          { label: '再確認' },
        ]}
        description={
          <span>
            承認済みの版（版 {view.block.approvedVersionNo ?? '—'}
            ）と過去のスナップショットは変わりません。 判断は現在の原稿（版{' '}
            {view.block.currentVersionNo ?? '—'}）に対して行います。
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            <BlockStatusBadge status={view.block.status} />
            <FreshnessBadge status={view.freshness.status} />
          </div>
        }
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={sp} />
        {view.lockedReason && (
          <p className="flex items-start gap-1 rounded-t4d border border-warning/40 bg-warning-soft px-2 py-1.5 text-[12px] text-ink">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[#8a5d00]" aria-hidden="true" />
            {view.lockedReason}
          </p>
        )}

        {view.items.length === 0 ? (
          <Card>
            <EmptyState
              title="再確認が必要な引用はありません"
              description="引用している数値・定性情報はすべて現在の版です。"
              icon={<CheckCircle2 className="size-5" aria-hidden="true" />}
              action={
                <Button variant="outline" size="sm" asChild>
                  <Link href={blockHref}>原稿へ戻る</Link>
                </Button>
              }
            />
          </Card>
        ) : (
          view.items.map((item) => (
            <Card key={`${item.refKind}-${item.oldRefId}`} className="p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="outline">{item.refKindLabel}</Badge>
                <h2 className="text-[13px] font-semibold text-ink">{item.label}</h2>
                {item.keptOld ? (
                  <Badge tone="neutral">
                    <CheckCircle2 className="size-3" aria-hidden="true" />
                    引用中の版を維持と判断済み
                  </Badge>
                ) : item.refKind === 'evidence' ? (
                  <Badge tone="danger">
                    <AlertTriangle className="size-3" aria-hidden="true" />
                    根拠失効
                  </Badge>
                ) : (
                  <Badge tone="warning">
                    <AlertTriangle className="size-3" aria-hidden="true" />
                    再確認が必要
                  </Badge>
                )}
                {item.returnedToOwner && !item.keptOld && (
                  <Badge tone="neutral">担当者へ差戻し済み</Badge>
                )}
              </div>

              <div className="mt-2 grid gap-2 text-[12px] min-[900px]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
                <div className="rounded-t4d border border-line p-2">
                  <div className="text-[11px] text-ink-muted">本文が引用している版（旧版）</div>
                  <p className="tnum mt-0.5 whitespace-pre-wrap text-ink">{item.oldDisplay}</p>
                </div>
                <ArrowRight
                  className="hidden size-4 self-center text-ink-muted min-[900px]:block"
                  aria-hidden="true"
                />
                <div className="rounded-t4d border border-line p-2">
                  <div className="text-[11px] text-ink-muted">現在の版（新版）</div>
                  <p className="tnum mt-0.5 whitespace-pre-wrap text-ink">
                    {item.newDisplay ?? '—'}
                  </p>
                  {item.refKind !== 'evidence' && (
                    <p className="mt-0.5 text-[11px] text-ink-muted">
                      {item.newApproved ? '承認・確認済みの版' : '未承認・未確認の版'}
                    </p>
                  )}
                </div>
              </div>
              <p className="mt-1 text-[12px] text-ink">
                変更理由: {item.changeReason ?? '（記録なし）'}
              </p>

              <div className="mt-2">
                <h3 className="text-[12px] font-semibold text-ink">影響する本文</h3>
                {item.paragraphs.length === 0 ? (
                  <p className="text-[12px] text-ink-muted">
                    現在の本文に該当する段落はありません。
                  </p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {item.paragraphs.map((p) => (
                      <li
                        key={p.id}
                        className="rounded-t4d border border-line p-1.5 text-[12px] text-ink"
                      >
                        <span className="mr-1 font-mono text-[10px] text-ink-muted">{p.id}</span>
                        {p.text}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {view.canDecide && item.refKind !== 'evidence' && (
                <div className="mt-3 grid gap-2 min-[1100px]:grid-cols-3">
                  <form
                    action={decideRecheckAction}
                    className="space-y-1 rounded-t4d border border-line p-2"
                  >
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="blockId" value={blockId} />
                    <input type="hidden" name="refKind" value={item.refKind} />
                    <input type="hidden" name="oldRefId" value={item.oldRefId} />
                    <input type="hidden" name="decision" value="adopt_new" />
                    <p className="text-[12px] text-ink">
                      新しい版で本文を書き換えた次の版を作ります（節は下書きに戻り、再レビューが必要です）。
                    </p>
                    <label htmlFor={`adopt-${item.oldRefId}`} className="sr-only">
                      変更理由（任意）
                    </label>
                    <Textarea
                      id={`adopt-${item.oldRefId}`}
                      name="reason"
                      rows={1}
                      placeholder="変更理由（任意）"
                    />
                    <Button type="submit" size="sm">
                      新しい版を採用
                    </Button>
                  </form>
                  <form
                    action={decideRecheckAction}
                    className="space-y-1 rounded-t4d border border-line p-2"
                  >
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="blockId" value={blockId} />
                    <input type="hidden" name="refKind" value={item.refKind} />
                    <input type="hidden" name="oldRefId" value={item.oldRefId} />
                    <input type="hidden" name="decision" value="keep_old" />
                    <label htmlFor={`keep-${item.oldRefId}`} className="block text-[12px] text-ink">
                      引用中の版を維持する理由（必須）
                    </label>
                    <Textarea id={`keep-${item.oldRefId}`} name="reason" rows={2} required />
                    <p className="text-[11px] text-ink-muted">
                      承認された版に限り選べます。失効した資料・削除された数値には使えません。
                    </p>
                    <Button type="submit" size="sm" variant="outline">
                      引用中の版を維持
                    </Button>
                  </form>
                  <form
                    action={decideRecheckAction}
                    className="space-y-1 rounded-t4d border border-line p-2"
                  >
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="blockId" value={blockId} />
                    <input type="hidden" name="refKind" value={item.refKind} />
                    <input type="hidden" name="oldRefId" value={item.oldRefId} />
                    <input type="hidden" name="decision" value="return_to_owner" />
                    <label
                      htmlFor={`return-${item.oldRefId}`}
                      className="block text-[12px] text-ink"
                    >
                      担当者へ差し戻す理由（必須）
                    </label>
                    <Textarea id={`return-${item.oldRefId}`} name="reason" rows={2} required />
                    <Button type="submit" size="sm" variant="ghost">
                      担当者へ差戻し
                    </Button>
                  </form>
                </div>
              )}
            </Card>
          ))
        )}

        <Card>
          <SectionTitle title={`判断の記録（${view.decisions.length}）`} />
          {view.decisions.length === 0 ? (
            <EmptyState
              title="判断の記録はまだありません"
              icon={<History className="size-5" aria-hidden="true" />}
            />
          ) : (
            <ul className="divide-y divide-line text-[12px]">
              {view.decisions.map((d) => (
                <li key={d.id} className="px-3 py-2">
                  <span className="font-medium text-ink">{d.decisionLabel}</span>
                  <span className="ml-2 text-ink-muted">
                    {d.refKindLabel} ／ {d.decidedByName} ／ {formatJst(d.decidedAt)}
                  </span>
                  <p className="text-ink">{d.reason}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Button variant="outline" size="sm" asChild>
          <Link href={blockHref}>原稿へ戻る</Link>
        </Button>
      </div>
    </>
  );
}
