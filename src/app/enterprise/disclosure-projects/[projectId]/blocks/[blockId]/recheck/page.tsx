import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AlertTriangle, ArrowRight, CheckCircle2, History, Info, Tag, Undo2 } from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CollapsibleSection } from '@/components/ui/collapsible';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { formatJst } from '@/lib/format/datetime';
import {
  EVIDENCE_NEXT_STEP,
  getRecheckView,
  type RecheckView,
} from '@/lib/services/disclosure-recheck';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { BlockStatusBadge, FreshnessBadge } from '../../status-badges';
import { RecheckForms } from './recheck-forms';

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
                <Badge tone="outline">
                  <Tag className="size-3" aria-hidden="true" />
                  {item.refKindLabel}
                </Badge>
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
                  <Badge tone="neutral">
                    <Undo2 className="size-3" aria-hidden="true" />
                    担当者へ差戻し済み
                  </Badge>
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
                        <Link
                          href={`${blockHref}#para-${p.id}`}
                          className="ml-2 whitespace-nowrap text-[12px] text-brand-800 underline"
                        >
                          この段落を原稿で開く
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {item.refKind === 'evidence' && (
                <p
                  role="note"
                  className="mt-2 flex items-start gap-1 rounded-t4d border border-warning/40 bg-warning-soft px-2 py-1.5 text-[12px] text-ink"
                >
                  <Info className="mt-0.5 size-3.5 shrink-0 text-[#8a5d00]" aria-hidden="true" />
                  <span>
                    <span className="font-medium">次にすること:</span> {EVIDENCE_NEXT_STEP}
                  </span>
                </p>
              )}

              {view.canDecide && item.refKind !== 'evidence' && (
                <RecheckForms
                  projectId={projectId}
                  blockId={blockId}
                  refKind={item.refKind}
                  oldRefId={item.oldRefId}
                  decisions={item.decisions}
                />
              )}
            </Card>
          ))
        )}

        {/* 判断の記録（履歴）は既定で閉じる。判断した直後はフラッシュが指す記録なので開いて描く（§10.4） */}
        <CollapsibleSection
          id="recheck-decisions"
          title={`判断の記録（${view.decisions.length}）`}
          summary={`これまでの判断（${view.decisions.length} 件）`}
          open={sp.flash === 'recheckDecided' || undefined}
          // 記録が無いことは空状態として見せる（空状態は閉じない）
          defaultOpen={view.decisions.length === 0}
          bodyClassName="px-0 pb-0"
        >
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
        </CollapsibleSection>

        <Button variant="outline" size="sm" asChild>
          <Link href={blockHref}>原稿へ戻る</Link>
        </Button>
      </div>
    </>
  );
}
