import Link from 'next/link';
import { ArrowRight, Users } from 'lucide-react';
import { ActionButton } from '@/components/shared/action-button';
import { IssueSeverityBadge } from '@/components/shared/badges';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { FlashMessage } from '@/components/shared/flash';
import { MetricStrip, MetricTile } from '@/components/shared/metric-strip';
import { Section } from '@/components/shared/section';
import { EmptyState } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { requireAssuranceContext } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import { roleLabel } from '@/lib/authorization/roles';
import { formatJst, formatJstDate, formatNumber } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import {
  detectSnapshotChanges,
  evaluateSignoffBlockers,
  loadEngagementOr404,
  loadLatestSnapshot,
  loadTestingWorkspace,
} from '@/lib/services/assurance';
import { assuranceHomeProfileOf } from '@/lib/ui/home-profile';
import { ASSURANCE_ROLES } from '@/types/domain';
import { assignEngagementMemberAction } from '../../../actions';
import { assuranceAttention, assuranceWorkItems, engagementBase } from '@/lib/ui/assurance-work';
import { assuranceLevelLabel, auditEventLabel, frameworkLabel } from '../../../_components/labels';
import { loadEngagementWorkRows } from '../../../_components/load-work-counts';
import { AssuranceNextWork } from '@/components/shared/assurance-next-work';
import { EngagementHeader } from '../engagement-header';

export const metadata = { title: '案件の概要' };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function EngagementOverviewPage({
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
  const base = engagementBase(engagementId);

  const [snapshot, testing, pbcRequests, issues, reviewNotes, signoffs, members, activity] =
    await Promise.all([
      loadLatestSnapshot(db, engagementId),
      loadTestingWorkspace(db, ctx, engagementId),
      db.select('pbcRequests', { where: { engagementId } }),
      db.select('issues', { where: { engagementId } }),
      db.select('reviewNotes', { where: { engagementId } }),
      db.select('signoffs', { where: { engagementId } }),
      db.select('engagementMembers', { where: { engagementId } }),
      db.select('auditEvents', {
        where: { engagementId },
        orderBy: { column: 'createdAt', dir: 'desc' },
        limit: 10,
      }),
    ]);

  const changes = snapshot ? await detectSnapshotChanges(db, ctx, snapshot.id) : [];
  const blockers = await evaluateSignoffBlockers(db, ctx, engagementId, 'partner_approved');
  const [workRow] = await loadEngagementWorkRows(db, ctx, [context.engagement]);
  const profile = assuranceHomeProfileOf(ctx);

  // チームは解除されていないメンバーだけ（解除した人を「チーム」に出さない）
  const team = members.filter((m) => m.removedAt === null);
  const canManageTeam = can(ctx, 'assurance.engagement.manage');
  const teamPanelOpen = canManageTeam && isCreatePanelOpen(query, 'team');
  // チームに加えられるのは自法人のメンバー（同じ法人の有効なメンバーシップ）
  const firmMemberships = canManageTeam
    ? await db.select('memberships', {
        where: { organizationId: ctx.workspace.organizationId, status: 'active' },
      })
    : [];
  const profileIds = [
    ...new Set([...members.map((m) => m.userId), ...firmMemberships.map((m) => m.userId)]),
  ];
  const profiles =
    profileIds.length > 0 ? await db.select('profiles', { where: { id: { in: profileIds } } }) : [];
  const nameOf = (userId: string) => profiles.find((p) => p.id === userId)?.displayName ?? '—';
  const candidates = firmMemberships.filter((m) => !team.some((t) => t.userId === m.userId));

  const reviewed = testing.rows.filter((r) => r.status === 'reviewed').length;
  const progress =
    testing.rows.length === 0 ? 0 : Math.round((reviewed / testing.rows.length) * 100);
  const openPbc = pbcRequests.filter(
    (r) => r.status !== 'accepted' && r.status !== 'closed',
  ).length;
  const openIssues = issues.filter((i) => i.status !== 'resolved' && i.status !== 'closed').length;
  const openNotes = reviewNotes.filter((n) => n.status !== 'cleared').length;
  const signoffStages = new Set(signoffs.map((s) => s.signoffStage)).size;

  const attention = [
    ...(blockers.length > 0
      ? [
          {
            key: 'signoff',
            label: '最終 Sign-off の抑止条件',
            count: blockers.length,
            href: `${base}/signoffs`,
            semantic: 'blocked' as const,
          },
        ]
      : []),
    ...(workRow ? assuranceAttention([workRow], () => `${base}/overview`) : []),
  ];

  return (
    <>
      <EngagementHeader context={context} page="案件の概要" />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={query} />

        {/* Attention → Action（役割ごとの作業） */}
        <AssuranceNextWork
          attention={attention}
          items={workRow ? assuranceWorkItems(profile, [workRow]) : []}
          showWork={profile !== 'firm_admin' && profile !== 'viewer'}
        />

        {/* Status: 押すと各画面の絞り込みへ */}
        <MetricStrip label="案件の進み具合">
          <MetricTile
            label="手続の進捗"
            value={progress}
            unit="%"
            hint={`レビュー済み ${reviewed} / ${testing.rows.length} 件`}
            href={`${base}/testing`}
          />
          <MetricTile
            label="未完了の資料依頼"
            value={openPbc}
            unit="件"
            status={openPbc > 0 ? { semantic: 'pending', label: '回答・確認待ち' } : undefined}
            href={`${base}/requests?filter=open`}
          />
          <MetricTile
            label="未解決の指摘"
            value={openIssues}
            unit="件"
            status={openIssues > 0 ? { semantic: 'pending', label: '解消待ち' } : undefined}
            href={`${base}/issues?filter=open`}
          />
          <MetricTile
            label="未クリアのレビューNote"
            value={openNotes}
            unit="件"
            href={`${base}/review-notes?filter=open`}
          />
          <MetricTile
            label="Sign-off の段階"
            value={signoffStages}
            denominator={3}
            status={
              signoffStages >= 3
                ? { semantic: 'done', label: 'すべて完了' }
                : blockers.length > 0
                  ? { semantic: 'blocked', label: `抑止条件 ${blockers.length} 件` }
                  : undefined
            }
            href={`${base}/signoffs`}
          />
        </MetricStrip>

        <Section
          id="signoff-blockers"
          title={`最終 Sign-off の抑止条件（${blockers.length}）`}
          summary={blockers.length === 0 ? 'すべて満たしています' : undefined}
        >
          {blockers.length === 0 ? (
            <p className="text-small text-success">
              すべての抑止条件を満たしています。Sign-off を実行できます。
            </p>
          ) : (
            <ul className="divide-y divide-line rounded-t4d border border-line">
              {blockers.map((blocker) => (
                <li
                  key={blocker.code}
                  className="flex items-start justify-between gap-2 px-3 py-1.5"
                >
                  <span className="text-small text-ink">{blocker.message}</span>
                  {blocker.href && (
                    <Link
                      href={blocker.href}
                      className="inline-flex shrink-0 items-center gap-1 text-caption text-brand-700 hover:underline"
                    >
                      対応する
                      <ArrowRight className="size-3" aria-hidden="true" />
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section id="snapshot" title="Snapshot">
          {snapshot ? (
            <div className="space-y-1.5 text-small">
              <p className="text-ink">
                <span className="font-medium">{snapshot.label}</span>
                <span className="ml-2 text-ink-muted">
                  固定 {formatJst(snapshot.frozenAt)} ／ 対象 {snapshot.itemCount} 件 ／ hash{' '}
                  <span className="font-mono">{snapshot.hash.slice(0, 20)}</span>
                </span>
              </p>
              {changes.length > 0 ? (
                <p className="text-danger">
                  固定後にクライアント側で {changes.length} 件の変更があります。
                  <Link href={`${base}/data-room`} className="ml-1 underline">
                    差分を確認
                  </Link>
                </p>
              ) : (
                <p className="text-ink-muted">固定後の変更はありません。</p>
              )}
            </div>
          ) : (
            <EmptyState
              kind="no-data"
              size="compact"
              title="Snapshot 未作成"
              description="Data Room から保証対象を固定すると、母集団とサンプリングに進めます。"
              action={
                <Button variant="secondary" size="xs" asChild>
                  <Link href={`${base}/data-room`}>Data Room へ</Link>
                </Button>
              }
            />
          )}
        </Section>

        <Section
          id="engagement-info"
          title="案件情報"
          collapsible
          open={teamPanelOpen || undefined}
          summary={`${context.clientName} ／ ${context.periodLabel} ／ チーム ${team.length} 人`}
          actions={
            canManageTeam && !teamPanelOpen ? (
              <Button variant="secondary" size="xs" asChild>
                <Link
                  href={`${createPanelHref(`${base}/overview`, query, { open: true, openParam: 'team' })}#engagement-info`}
                >
                  <Users aria-hidden="true" />
                  チームを変更
                </Link>
              </Button>
            ) : undefined
          }
        >
          <dl className="grid grid-cols-2 gap-x-6 text-body">
            <Row label="クライアント" value={context.clientName} />
            <Row label="対象期間" value={context.periodLabel} />
            <Row label="基準" value={frameworkLabel(context.engagement.frameworkKey)} />
            <Row label="保証水準" value={assuranceLevelLabel(context.engagement.assuranceLevel)} />
            <Row label="開始予定" value={formatJstDate(context.engagement.plannedStartDate)} />
            <Row label="期限" value={formatJstDate(context.engagement.deadlineDate)} />
            <Row
              label="重要性の基準"
              value={
                context.engagement.materialityValue === null
                  ? '未設定'
                  : `${formatNumber(context.engagement.materialityValue)} ${context.engagement.materialityUnit ?? ''}（${context.engagement.materialityBasis ?? ''}）`
              }
            />
            <div className="flex items-start justify-between gap-3 border-b border-line py-1.5 last:border-b-0">
              <dt className="shrink-0 text-ink-muted">状態</dt>
              <dd>
                <StatusBadge domain="engagement" value={context.engagement.status} />
              </dd>
            </div>
          </dl>
          <div className="mt-2">
            <h3 className="mb-1 text-small font-semibold text-ink">チーム（{team.length}）</h3>
            <ul className="flex flex-wrap gap-x-3 gap-y-1 text-small">
              {team.map((member) => (
                <li key={member.id}>
                  {nameOf(member.userId)}
                  <span className="text-ink-muted">（{roleLabel(member.roleKey)}）</span>
                </li>
              ))}
            </ul>
          </div>

          {canManageTeam && (
            <CreatePanel
              id="team"
              title="チームを変更"
              openParam="team"
              searchParams={query}
              closeHref={`${createPanelHref(`${base}/overview`, query, { open: false, openParam: 'team' })}#engagement-info`}
              description="同じ法人のメンバーをこの案件に加える・外すことができます。チームに入っていない人は、この案件のクライアントデータを閲覧できません。"
              className="mt-2"
            >
              <ul className="divide-y divide-line rounded-t4d border border-line">
                {team.map((member) => (
                  <li
                    key={member.id}
                    className="flex items-center justify-between gap-2 px-2 py-1 text-small"
                  >
                    <span>
                      {nameOf(member.userId)}
                      <span className="text-ink-muted">（{roleLabel(member.roleKey)}）</span>
                    </span>
                    <ActionButton
                      size="xs"
                      action={{
                        kind: 'submit',
                        id: `remove-${member.id}`,
                        label: 'チームから外す',
                        action: assignEngagementMemberAction,
                        fields: { engagementId, remove: 'true', memberId: member.id },
                        ...(member.userId === ctx.userId
                          ? { disabledReason: '自分自身をチームから外すことはできません。' }
                          : {}),
                      }}
                    />
                  </li>
                ))}
              </ul>
              {candidates.length === 0 ? (
                <p className="text-small text-ink-muted">
                  加えられる法人メンバーはいません（全員がこの案件のチームに入っています）。
                </p>
              ) : (
                <form
                  action={assignEngagementMemberAction}
                  className="flex flex-wrap items-end gap-2"
                >
                  <input type="hidden" name="engagementId" value={engagementId} />
                  <Field label="担当者" name="userId" required className="w-field-sm">
                    {(p) => (
                      <NativeSelect {...p} name="userId">
                        {candidates.map((m) => (
                          <option key={m.id} value={m.userId}>
                            {nameOf(m.userId)}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  </Field>
                  <Field label="役割" name="roleKey" required className="w-field-sm">
                    {(p) => (
                      <NativeSelect {...p} name="roleKey" defaultValue="assurance_staff">
                        {ASSURANCE_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {roleLabel(role)}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  </Field>
                  <SubmitButton size="sm" pendingLabel="追加中…">
                    チームに加える
                  </SubmitButton>
                </form>
              )}
            </CreatePanel>
          )}
        </Section>

        <Section
          id="recent-work"
          title="手続・資料依頼・指摘（先頭 6 件）"
          collapsible
          summary={`調書 ${testing.rows.length} 件 ／ 資料依頼 ${pbcRequests.length} 件 ／ 指摘 ${issues.length} 件`}
        >
          <div className="grid grid-cols-3 gap-3">
            <MiniList title="調書" href={`${base}/testing`}>
              {testing.rows.slice(0, 6).map((row) => (
                <li key={row.testId} className="flex items-center justify-between gap-2 py-1">
                  <span className="truncate text-small text-ink">
                    {row.unitName} / {row.metricName}
                  </span>
                  <StatusBadge domain="test" value={row.status as never} />
                </li>
              ))}
            </MiniList>
            <MiniList title="資料依頼" href={`${base}/requests`}>
              {pbcRequests.slice(0, 6).map((request) => (
                <li key={request.id} className="flex items-center justify-between gap-2 py-1">
                  <span className="truncate text-small text-ink">
                    {request.code} {request.title}
                  </span>
                  <StatusBadge domain="pbc" value={request.status} />
                </li>
              ))}
            </MiniList>
            <MiniList title="指摘" href={`${base}/issues`}>
              {issues.slice(0, 6).map((issue) => (
                <li key={issue.id} className="flex items-center justify-between gap-2 py-1">
                  <span className="truncate text-small text-ink">
                    {issue.code} {issue.title}
                  </span>
                  <IssueSeverityBadge severity={issue.severity} />
                </li>
              ))}
            </MiniList>
          </div>
        </Section>

        <Section
          id="activity"
          title="直近の記録"
          collapsible
          summary={activity.length === 0 ? '記録なし' : `最新 ${activity.length} 件`}
        >
          {activity.length === 0 ? (
            <p className="text-small text-ink-muted">記録はまだありません。</p>
          ) : (
            <ul className="divide-y divide-line">
              {activity.map((event) => (
                <li key={event.id} className="py-1.5">
                  <div className="text-small text-ink">{auditEventLabel(event.eventType)}</div>
                  {event.afterSummary && (
                    <div className="text-caption text-ink-muted">{event.afterSummary}</div>
                  )}
                  <div className="text-caption text-ink-muted">{formatJst(event.createdAt)}</div>
                </li>
              ))}
            </ul>
          )}
          <Link
            href={`${base}/audit-trail`}
            className="mt-1 inline-flex items-center gap-1 text-small text-brand-700 hover:underline"
          >
            監査ログをすべて見る <ArrowRight className="size-3" aria-hidden="true" />
          </Link>
        </Section>
      </div>
    </>
  );
}

function MiniList({
  title,
  href,
  children,
}: {
  title: string;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-small font-semibold text-ink">{title}</h3>
        <Link href={href} className="text-caption text-brand-700 hover:underline">
          すべて見る
        </Link>
      </div>
      <ul className="divide-y divide-line">{children}</ul>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line py-1.5 last:border-b-0">
      <dt className="shrink-0 text-ink-muted">{label}</dt>
      <dd className="truncate text-right text-ink">{value}</dd>
    </div>
  );
}
