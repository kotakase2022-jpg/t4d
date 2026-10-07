import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AlertTriangle, ArrowLeft, CheckCircle2, Info, Tag, Undo2 } from 'lucide-react';
import { FlashMessage } from '@/components/shared/flash';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleSection } from '@/components/ui/collapsible';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { AuthorizationError, NotFoundError } from '@/lib/authorization/can';
import { formatJst } from '@/lib/format/datetime';
import {
  EVIDENCE_NEXT_STEP,
  getRecheckView,
  type RecheckView,
  type RecheckViewItem,
} from '@/lib/services/disclosure-recheck';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { BlockStatusBadge, FreshnessBadge } from '../../status-badges';
import { RecheckForms } from './recheck-forms';

export const metadata = { title: '引用先の再確認' };

const COLUMN_COUNT = 5;

/**
 * 上流の変更の再確認（指示書 §10.3。plan §2.26 E41）。旧版・新版・変更理由・影響する段落を表に並べ、
 * 「新しい版を採用」「引用中の版を維持（理由付き）」「担当者へ差戻し」を選ぶ。
 * 過去に承認した版・スナップショットは変えない。
 *
 * 引用ごとのカードを表＋展開行にした。判断がまだの引用は展開行を開いて描き、3 つの判断（どれも副操作。
 * どれが正しいかは内容次第のため、1 つを主操作として勧めない）をその場で選べるようにする。
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
    if (error instanceof AuthorizationError) {
      return (
        <PermissionDeniedState
          description="引用先の再確認を見るには、開示の閲覧権限が必要です。"
          permission="enterprise.disclosure.read"
        />
      );
    }
    throw error;
  }
  if (view.block.projectId !== projectId) notFound();

  const blockHref = `/enterprise/disclosure-projects/${projectId}/blocks/${blockId}`;
  const pending = view.items.filter((item) => !item.keptOld).length;

  return (
    <>
      <PageHeader
        title={`引用先の再確認: ${view.block.title}`}
        breadcrumbs={[
          { label: 'ホーム', href: '/enterprise/dashboard' },
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
          <p className="flex items-start gap-1 rounded-t4d border border-warning/40 bg-warning-soft px-2 py-1.5 text-small text-ink">
            <AlertTriangle
              className="mt-0.5 size-3.5 shrink-0 text-warning-ink"
              aria-hidden="true"
            />
            {view.lockedReason}
          </p>
        )}

        {view.items.length === 0 ? (
          <EmptyState
            kind="done"
            title="再確認が必要な引用はありません"
            description="引用している数値・定性情報はすべて現在の版です。"
            action={
              <Button variant="secondary" size="sm" asChild>
                <Link href={blockHref}>原稿へ戻る</Link>
              </Button>
            }
          />
        ) : (
          <Section
            title={`再確認する引用（${view.items.length} 件）`}
            summary={pending > 0 ? `判断が必要 ${pending} 件` : 'すべて判断済み'}
            divider="none"
          >
            <div className="t4d-scroll-x rounded-t4d-lg border border-line bg-surface">
              <Table>
                <caption className="sr-only">再確認する引用と、旧版・新版・変更理由</caption>
                <THead>
                  <TR>
                    <TH>種別</TH>
                    <TH>引用</TH>
                    <TH>状態</TH>
                    <TH>本文が引用している版（旧版）</TH>
                    <TH>現在の版（新版）</TH>
                  </TR>
                </THead>
                <TBody>
                  {view.items.map((item) => (
                    <RecheckRows
                      key={`${item.refKind}-${item.oldRefId}`}
                      item={item}
                      projectId={projectId}
                      blockId={blockId}
                      blockHref={blockHref}
                      canDecide={view.canDecide}
                    />
                  ))}
                </TBody>
              </Table>
            </div>
          </Section>
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
              kind="not-applicable"
              size="compact"
              title="判断の記録はまだありません"
              description="上の表で判断すると、理由・判断者・日時がここに残ります。"
            />
          ) : (
            <ul className="divide-y divide-line text-small">
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

        <Button variant="secondary" size="sm" asChild>
          <Link href={blockHref}>
            <ArrowLeft aria-hidden="true" />
            原稿へ戻る
          </Link>
        </Button>
      </div>
    </>
  );
}

/** 引用 1 件の行と展開行（影響する本文・次にすること・判断） */
function RecheckRows({
  item,
  projectId,
  blockId,
  blockHref,
  canDecide,
}: {
  item: RecheckViewItem;
  projectId: string;
  blockId: string;
  blockHref: string;
  canDecide: boolean;
}) {
  const decidable = canDecide && item.refKind !== 'evidence';
  return (
    <>
      <TR className="align-top" data-t4d-record="">
        <TD className="whitespace-nowrap align-top">
          <Badge tone="outline">
            <Tag className="size-3" aria-hidden="true" />
            {item.refKindLabel}
          </Badge>
        </TD>
        <TD className="min-w-[200px] align-top">
          <h3 className="text-body font-semibold text-ink">{item.label}</h3>
        </TD>
        <TD className="align-top">
          <div className="flex flex-col items-start gap-1">
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
        </TD>
        <TD className="min-w-[180px] align-top">
          <p className="tnum whitespace-pre-wrap text-small text-ink">{item.oldDisplay}</p>
        </TD>
        <TD className="min-w-[220px] align-top">
          <p className="tnum whitespace-pre-wrap text-small text-ink">{item.newDisplay ?? '—'}</p>
          {item.refKind !== 'evidence' && (
            <p className="mt-0.5 text-caption text-ink-muted">
              {item.newApproved ? '承認・確認済みの版' : '未承認・未確認の版'}
            </p>
          )}
          <p className="mt-0.5 text-small text-ink">
            変更理由: {item.changeReason ?? '（記録なし）'}
          </p>
        </TD>
      </TR>
      <tr data-row-detail={`${item.refKind}-${item.oldRefId}`}>
        <td colSpan={COLUMN_COUNT} className="border-b border-line bg-surface-muted px-3 py-2">
          <Collapsible
            variant="plain"
            defaultOpen={!item.keptOld}
            summary={
              decidable
                ? `影響する本文（${item.paragraphs.length} 段落）と判断`
                : `影響する本文（${item.paragraphs.length} 段落）`
            }
          >
            <div className="space-y-2">
              {item.paragraphs.length === 0 ? (
                <p className="text-small text-ink-muted">現在の本文に該当する段落はありません。</p>
              ) : (
                <ul className="space-y-1">
                  {item.paragraphs.map((p) => (
                    <li
                      key={p.id}
                      className="rounded-t4d border border-line bg-surface p-1.5 text-small text-ink"
                    >
                      {p.text}
                      <Link
                        href={`${blockHref}#para-${p.id}`}
                        className="ml-2 whitespace-nowrap text-small text-brand-800 underline"
                      >
                        この段落を原稿で開く
                      </Link>
                    </li>
                  ))}
                </ul>
              )}

              {item.refKind === 'evidence' && (
                <p
                  role="note"
                  className="flex items-start gap-1 rounded-t4d border border-warning/40 bg-warning-soft px-2 py-1.5 text-small text-ink"
                >
                  <Info className="mt-0.5 size-3.5 shrink-0 text-warning-ink" aria-hidden="true" />
                  <span>
                    <span className="font-medium">次にすること:</span> {EVIDENCE_NEXT_STEP}
                  </span>
                </p>
              )}

              {decidable && item.refKind !== 'evidence' && (
                <RecheckForms
                  projectId={projectId}
                  blockId={blockId}
                  refKind={item.refKind}
                  oldRefId={item.oldRefId}
                  decisions={item.decisions}
                />
              )}
            </div>
          </Collapsible>
        </td>
      </tr>
    </>
  );
}
