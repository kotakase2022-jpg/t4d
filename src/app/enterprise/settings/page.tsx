import Link from 'next/link';
import { KeyRound, LayoutPanelLeft, ShieldCheck, Undo2, UserPlus } from 'lucide-react';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { FlashMessage } from '@/components/shared/flash';
import { NavTabs } from '@/components/shared/nav-tabs';
import { Notice } from '@/components/shared/notice';
import { PageActions } from '@/components/shared/page-actions';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { SemanticBadge, StatusBadge } from '@/components/shared/status-badge';
import { Field, RequirementTag } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { MoreInfo } from '@/components/ui/more-info';
import { NativeCheckbox } from '@/components/ui/native-checkbox';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/ui/submit-button';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { can } from '@/lib/authorization/can';
import { roleLabel } from '@/lib/authorization/roles';
import { formatJst, formatJstDate } from '@/lib/format/datetime';
import { getAppMode } from '@/lib/config';
import { getFeatureSettings } from '@/lib/services/feature-settings';
import { loadEnterpriseShell } from '@/lib/services/shell';
import type { StatusSemantic } from '@/lib/ui/status/registry';
import type { Invitation, OrganizationMembership, RoleKey } from '@/types/domain';
import { setDisclosureFirstAction } from './actions';
import { CopyLinkButton } from './copy-link-button';
import { MfaEnrollCard } from './security-card';
import {
  createInvitationAction,
  issueResetLinkAction,
  revokeInvitationAction,
  createGrantAction,
  toggleGrantAction,
} from '../actions';

export const metadata = { title: '設定' };

const BASE = '/enterprise/settings';

const SUBJECT_LABEL: Record<string, string> = {
  metric: '指標',
  organization_unit: '組織・拠点',
  reporting_period: '報告期間',
  evidence_category: '資料の区分',
  disclosure_item: '開示項目',
};

/** 招待で選べる役割（企業テナントの役割。サーバーも同じ範囲に限る） */
const INVITABLE_ROLES: readonly RoleKey[] = [
  'sustainability_manager',
  'site_contributor',
  'reviewer',
  'approver',
  'viewer',
];

const INVITATION_STATUS: Record<Invitation['status'], { label: string; semantic: StatusSemantic }> =
  {
    pending: { label: '有効', semantic: 'in_review' },
    accepted: { label: '受諾済み', semantic: 'done' },
    revoked: { label: '失効', semantic: 'excluded' },
    expired: { label: '期限切れ', semantic: 'excluded' },
  };

/**
 * 設定の節（plan S17: NavTabs で 1 画面 1 仕事に分ける）。
 * よく見るメンバーを既定にし、組織全体の構成を変える機能設定（L3）は右端に置く。
 * キーはタスク動詞・パレット（src/lib/ui/palette.ts）が指す ?tab= と同じ
 */
const TABS = ['members', 'invitations', 'grants', 'security', 'features'] as const;
type SettingsTab = (typeof TABS)[number];

function resolveTab(
  params: Record<string, string | string[] | undefined>,
  allowed: readonly SettingsTab[],
): SettingsTab {
  const requested = typeof params.tab === 'string' ? params.tab : null;
  const pick = (tab: SettingsTab | null): SettingsTab | null =>
    tab && allowed.includes(tab) ? tab : null;
  const fallback = allowed[0] ?? 'members';
  if (requested && (TABS as readonly string[]).includes(requested)) {
    return pick(requested as SettingsTab) ?? fallback;
  }
  // 操作の結果で戻ってきたときは、その操作の節を開く（?tab= を持たない戻り先: 再設定リンクの発行・開示優先モードの切替）
  if (params.reset === 'issued') return pick('security') ?? fallback;
  if (params.flash === 'disclosureFirstChanged') return pick('features') ?? fallback;
  return pick('members') ?? fallback;
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const resetIssued = params.reset === 'issued';
  // リンク本体は httpOnly Cookie（JS から読めない）。表示はサーバー側で読んで行う。
  const { cookies } = await import('next/headers');
  const resetLink = resetIssued ? ((await cookies()).get('t4d.reset-link')?.value ?? null) : null;
  const shell = await loadEnterpriseShell();
  const { db, ctx } = shell;

  // 画面の入口は従来どおり企業管理者（enterprise.org.manage）だけ。UI 再設計では権限の挙動を変えない
  // （指示書 §30。作成担当を許諾の節に入れる案〔R1・plan Q6〕は発注者の判断待ちで見送り）。
  // 節（タブ）は管理者の中でさらに権限で出し分ける
  const canManageGrants = can(ctx, 'enterprise.grant.manage');
  const canManageMembers = can(ctx, 'enterprise.member.manage');
  // 権限がない場合は 403 相当（URL 直打ちでも閲覧不可）
  if (!can(ctx, 'enterprise.org.manage')) {
    return (
      <>
        <PageHeader title="設定" autoBreadcrumbs />
        <PermissionDeniedState
          permission="enterprise.org.manage"
          description="設定画面は企業管理者のみ閲覧できます。"
        />
      </>
    );
  }
  const allowedTabs = TABS.filter((key) =>
    key === 'members' || key === 'invitations'
      ? canManageMembers
      : key === 'grants'
        ? canManageGrants
        : true,
  );

  const tab = resolveTab(params, allowedTabs);
  const panelOpen = isCreatePanelOpen(params);
  const tabHref = (key: SettingsTab, extra?: Record<string, string>) => {
    const next = new URLSearchParams({ tab: key, ...extra });
    return `${BASE}?${next.toString()}`;
  };

  const supabaseMode = getAppMode() === 'supabase';
  const organizationId = ctx.workspace.organizationId;
  const featureSettings = await getFeatureSettings(db, ctx);
  const [memberships, engagements, grants, invitations] = await Promise.all([
    db.select('memberships', { where: { organizationId } }),
    db.select('engagements', { where: { clientOrganizationId: organizationId } }),
    db.select('grants', { where: { clientOrganizationId: organizationId } }),
    db.select('invitations', {
      where: { organizationId },
      orderBy: { column: 'createdAt', dir: 'desc' },
    }),
  ]);

  const profiles =
    memberships.length > 0
      ? await db.select('profiles', { where: { id: { in: memberships.map((m) => m.userId) } } })
      : [];
  const roles =
    memberships.length > 0
      ? await db.select('membershipRoles', {
          where: { membershipId: { in: memberships.map((m) => m.id) } },
        })
      : [];

  const firms =
    engagements.length > 0
      ? await db.select('organizations', {
          where: { id: { in: engagements.map((e) => e.assuranceFirmId) } },
        })
      : [];

  const metricById = new Map(shell.metrics.map((m) => [m.id, m]));
  const unitById = new Map(shell.units.map((u) => [u.id, u]));
  const periodById = new Map(shell.periods.map((p) => [p.id, p]));

  const subjectLabel = (subjectType: string, subjectId: string) => {
    if (subjectType === 'metric') return metricById.get(subjectId)?.name ?? subjectId;
    if (subjectType === 'organization_unit') return unitById.get(subjectId)?.name ?? subjectId;
    if (subjectType === 'reporting_period') return periodById.get(subjectId)?.code ?? subjectId;
    return subjectId;
  };

  const pendingInvitations = invitations.filter((i) => i.status === 'pending').length;

  // 取消の結果の通知に「元に戻す」（同じ許諾の再付与）を置く（plan §1.16 区分 3）。
  // 対象がこの組織の許諾で、まだ取り消されたままのときだけ出す（URL の ID をそのまま信じない）
  const undoGrantId = typeof params.grantId === 'string' ? params.grantId : null;
  const undoGrant =
    canManageGrants && params.flash === 'grantRevoked' && undoGrantId
      ? grants.find((g) => g.id === undoGrantId && g.revokedAt)
      : undefined;
  const grantUndo = undoGrant
    ? {
        grantRevoked: (
          <form action={toggleGrantAction}>
            <input type="hidden" name="grantId" value={undoGrant.id} />
            <input type="hidden" name="revoke" value="false" />
            <SubmitButton size="xs" variant="secondary" icon={<Undo2 aria-hidden="true" />}>
              元に戻す
            </SubmitButton>
          </form>
        ),
      }
    : undefined;
  const activeGrants = grants.filter((g) => !g.revokedAt).length;

  // 見出しの主操作は節ごとに 1 つ。作成欄を開いているときは、欄の中の送信が主操作（同時に 2 つ出さない）
  const headerPrimary =
    tab === 'members' || tab === 'invitations'
      ? {
          kind: 'link' as const,
          id: 'invite-member',
          shortcut: 'new' as const,
          label: 'メンバーを招待',
          icon: <UserPlus aria-hidden="true" />,
          href: tabHref('invitations', { new: '1' }),
          hidden: !canManageMembers || (tab === 'invitations' && panelOpen),
        }
      : tab === 'grants'
        ? {
            kind: 'link' as const,
            id: 'add-grant',
            shortcut: 'new' as const,
            label: 'アクセス許諾を追加',
            icon: <ShieldCheck aria-hidden="true" />,
            href: tabHref('grants', { new: '1' }),
            hidden: !canManageGrants || engagements.length === 0 || panelOpen,
          }
        : undefined;

  const memberColumns: DataTableColumn<OrganizationMembership>[] = [
    {
      key: 'name',
      header: '氏名',
      importance: 'primary',
      lockVisible: true,
      cell: (membership) => (
        <span className="font-medium">
          {profiles.find((p) => p.id === membership.userId)?.displayName ?? '—'}
        </span>
      ),
    },
    {
      key: 'email',
      header: 'メールアドレス',
      importance: 'primary',
      cell: (membership) => (
        <span className="text-small text-ink-muted">
          {profiles.find((p) => p.id === membership.userId)?.email}
        </span>
      ),
    },
    {
      key: 'roles',
      header: '役割',
      importance: 'primary',
      cell: (membership) =>
        roles
          .filter((r) => r.membershipId === membership.id)
          .map((r) => roleLabel(r.roleKey))
          .join(' / '),
    },
    {
      key: 'scope',
      header: '担当範囲',
      importance: 'secondary',
      cell: (membership) => (
        <span className="text-small">
          {membership.unitScopeIds.length === 0
            ? '全社'
            : membership.unitScopeIds.map((id) => unitById.get(id)?.name ?? id).join(' / ')}
        </span>
      ),
    },
    {
      key: 'status',
      header: '状態',
      importance: 'primary',
      cell: (membership) => <StatusBadge domain="membership" value={membership.status} />,
    },
  ];

  const memberQuery = typeof params.q === 'string' ? params.q.trim().toLowerCase() : '';
  const memberStatus = typeof params.status === 'string' ? params.status : null;
  const memberRows = memberships
    .filter((m) => (memberStatus ? m.status === memberStatus : true))
    .filter((m) => {
      if (memberQuery === '') return true;
      const profile = profiles.find((p) => p.id === m.userId);
      return `${profile?.displayName ?? ''} ${profile?.email ?? ''}`
        .toLowerCase()
        .includes(memberQuery);
    });

  return (
    <>
      <PageHeader
        title="設定"
        description="メンバー・招待・監査法人へのアクセス許諾・セキュリティ・機能を管理します。"
        autoBreadcrumbs
        actions={headerPrimary ? <PageActions primary={headerPrimary} /> : undefined}
      />

      <NavTabs
        ariaLabel="設定の節"
        current={tab}
        items={[
          {
            key: 'members',
            label: 'メンバー',
            href: tabHref('members'),
            count: memberships.length,
            hidden: !allowedTabs.includes('members'),
          },
          {
            key: 'invitations',
            label: '招待',
            href: tabHref('invitations'),
            count: pendingInvitations,
            hidden: !allowedTabs.includes('invitations'),
          },
          {
            key: 'grants',
            label: 'アクセス許諾',
            href: tabHref('grants'),
            count: activeGrants,
            hidden: !allowedTabs.includes('grants'),
          },
          {
            key: 'security',
            label: 'セキュリティ',
            href: tabHref('security'),
            hidden: !allowedTabs.includes('security'),
          },
          {
            key: 'features',
            label: '機能設定',
            href: tabHref('features'),
            hidden: !allowedTabs.includes('features'),
          },
        ]}
      />

      <div className="space-y-3 p-4">
        <FlashMessage searchParams={params} undo={grantUndo} />

        {tab === 'members' && (
          <Section title={`メンバー（${memberships.length}）`} divider="none">
            <DataTable<OrganizationMembership>
              id="settings-members"
              caption="メンバー"
              columns={memberColumns}
              rows={memberRows}
              getRowId={(membership) => membership.id}
              getRowLabel={(membership) =>
                profiles.find((p) => p.id === membership.userId)?.displayName ?? 'メンバー'
              }
              searchParams={params}
              basePath={BASE}
              search={{ placeholder: '氏名・メールアドレスで検索' }}
              filters={[
                {
                  key: 'status',
                  label: '状態',
                  options: [
                    { value: 'active', label: '有効' },
                    { value: 'invited', label: '招待中' },
                    { value: 'suspended', label: '停止中' },
                  ],
                },
              ]}
              empty={{
                noData: {
                  title: 'メンバーがいません',
                  description: '招待リンクを発行し、本人が参加するとメンバーに加わります。',
                  action: (
                    <Link
                      href={tabHref('invitations', { new: '1' })}
                      className="text-small text-brand-700 hover:underline"
                    >
                      メンバーを招待
                    </Link>
                  ),
                },
              }}
            />
          </Section>
        )}

        {tab === 'invitations' && (
          <>
            {/* 運用制約（メールを送らない）は安全の注記。折りたたまない */}
            <Notice tone="info">
              招待メールは送信しません（運用制約）。作成した
              <strong>招待リンクをコピーして 社内チャット等で本人へ渡して</strong>
              ください。リンクを開いた本人が氏名を入力すると 参加が完了します（有効期限 14 日）。
            </Notice>

            {canManageMembers && (
              <CreatePanel
                id="create-invitation"
                title="メンバーを招待"
                searchParams={params}
                closeHref={createPanelHref(BASE, params, { open: false })}
              >
                <form action={createInvitationAction} className="space-y-2">
                  <Field label="メールアドレス" name="email" required className="w-field-lg">
                    {(p) => (
                      <Input {...p} name="email" type="email" placeholder="new-hire@demo.local" />
                    )}
                  </Field>
                  <fieldset className="space-y-1">
                    <legend className="flex items-center gap-1.5 text-small font-medium text-ink">
                      役割（1 つ以上）
                      <RequirementTag required />
                    </legend>
                    <div className="flex flex-wrap gap-3">
                      {INVITABLE_ROLES.map((role) => (
                        <NativeCheckbox
                          key={role}
                          name="roleKeys"
                          value={role}
                          label={roleLabel(role)}
                        />
                      ))}
                    </div>
                  </fieldset>
                  <SubmitButton
                    variant="primary"
                    size="sm"
                    icon={<UserPlus aria-hidden="true" />}
                    pendingLabel="発行中…"
                  >
                    招待リンクを発行
                  </SubmitButton>
                </form>
              </CreatePanel>
            )}

            <Section
              title={`招待（${invitations.length}）`}
              summary={`有効 ${pendingInvitations} 件`}
              divider="none"
            >
              {invitations.length === 0 ? (
                <EmptyState
                  kind="no-data"
                  size="compact"
                  title="招待はまだありません"
                  description="招待リンクを発行すると、ここで状態と期限を確認できます。"
                  action={
                    <Link
                      href={tabHref('invitations', { new: '1' })}
                      className="text-small text-brand-700 hover:underline"
                    >
                      メンバーを招待
                    </Link>
                  }
                />
              ) : (
                <div className="t4d-scroll-x rounded-t4d border border-line">
                  <Table>
                    <THead>
                      <TR>
                        <TH>メールアドレス</TH>
                        <TH>役割</TH>
                        <TH>状態</TH>
                        <TH>期限</TH>
                        <TH>招待リンク</TH>
                        <TH align="right">
                          <span className="sr-only">操作</span>
                        </TH>
                      </TR>
                    </THead>
                    <TBody>
                      {invitations.map((inv) => {
                        const status = INVITATION_STATUS[inv.status];
                        const formId = `revoke-invitation-${inv.id}`;
                        return (
                          <TR key={inv.id} data-t4d-record="">
                            <TD className="text-small">{inv.email}</TD>
                            <TD className="text-small">
                              {inv.roleKeys.map((r) => roleLabel(r)).join(' / ')}
                            </TD>
                            <TD>
                              <SemanticBadge
                                semantic={status.semantic}
                                label={status.label}
                                dataAttributes={{ 'data-invitation-status': inv.status }}
                              />
                            </TD>
                            <TD className="text-small text-ink-muted">
                              {formatJstDate(inv.expiresAt)}
                            </TD>
                            <TD>
                              {inv.status === 'pending' ? (
                                <span className="flex items-center gap-1">
                                  <code className="block max-w-col-md truncate rounded-t4d-sm bg-surface-muted px-1.5 py-0.5 text-caption">
                                    {`/invite/${inv.id}`}
                                  </code>
                                  <CopyLinkButton path={`/invite/${inv.id}`} label={inv.email} />
                                </span>
                              ) : (
                                '—'
                              )}
                            </TD>
                            <TD align="right">
                              {inv.status === 'pending' && canManageMembers && (
                                <>
                                  <form id={formId} action={revokeInvitationAction} hidden>
                                    <input type="hidden" name="invitationId" value={inv.id} />
                                  </form>
                                  {/* 失効には逆操作が無い（plan §1.16: 確認ダイアログ） */}
                                  <ConfirmDialog
                                    tier="irreversible"
                                    title="この招待を失効させますか"
                                    scope={`${inv.email} への招待リンク`}
                                    consequences={[
                                      'リンクは使えなくなります（元に戻せません）。',
                                      '必要なら、あらためて招待リンクを発行します。',
                                    ]}
                                    confirmLabel="失効させる"
                                    formId={formId}
                                    trigger={{ label: '失効…', size: 'xs', variant: 'secondary' }}
                                  />
                                </>
                              )}
                            </TD>
                          </TR>
                        );
                      })}
                    </TBody>
                  </Table>
                </div>
              )}
            </Section>
          </>
        )}

        {tab === 'grants' && (
          <>
            <Section
              title={`監査法人へのアクセス許諾（${grants.length}）`}
              summary="取り消すと監査法人側から即座に不可視になります"
              divider="none"
            >
              {engagements.length === 0 ? (
                <EmptyState
                  kind="not-applicable"
                  size="compact"
                  title="保証契約がありません"
                  description="監査法人が保証契約を起票すると、ここでデータの共有（アクセス許諾）を付与できます。"
                  icon={<ShieldCheck className="size-5" aria-hidden="true" />}
                />
              ) : (
                <div className="space-y-2">
                  <ul className="rounded-t4d border border-line bg-surface-muted px-3 py-1.5">
                    {engagements.map((engagement) => (
                      <li key={engagement.id} className="text-small text-ink">
                        <span className="font-medium">{engagement.code}</span> {engagement.name} ／
                        監査法人:{' '}
                        {firms.find((f) => f.id === engagement.assuranceFirmId)?.name ?? '—'} ／
                        保証水準:{' '}
                        {engagement.assuranceLevel === 'limited' ? '限定的保証' : '合理的保証'}
                      </li>
                    ))}
                  </ul>

                  {canManageGrants && (
                    <CreatePanel
                      id="create-grant"
                      title="アクセス許諾を追加"
                      searchParams={params}
                      closeHref={createPanelHref(BASE, params, { open: false })}
                      description="許諾した範囲の承認済みデータだけが、監査法人の Data Room に読み取り専用で表示されます。"
                    >
                      <form action={createGrantAction} className="space-y-2">
                        <div className="grid grid-cols-12 items-end gap-2">
                          <Field
                            label="保証契約"
                            name="engagementId"
                            required
                            className="col-span-3"
                          >
                            {(p) => (
                              <NativeSelect {...p} name="engagementId">
                                {engagements.map((engagement) => (
                                  <option key={engagement.id} value={engagement.id}>
                                    {engagement.code}
                                  </option>
                                ))}
                              </NativeSelect>
                            )}
                          </Field>
                          <Field label="種別" name="subjectType" required className="col-span-2">
                            {(p) => (
                              <NativeSelect {...p} name="subjectType">
                                <option value="metric">指標</option>
                                <option value="organization_unit">組織・拠点</option>
                                <option value="reporting_period">報告期間</option>
                              </NativeSelect>
                            )}
                          </Field>
                          {/*
                            種別ごとに対象の選択肢が変わるが、サーバー描画のみで完結させるため
                            3 種類をまとめて 1 つのセレクトに並べ、value に ID を持たせる。
                            種別と対象の整合はサーバー側（createGrantAction）で確認する。
                          */}
                          <Field
                            label="対象"
                            name="subjectId"
                            required
                            hint="種別と同じ区分から選びます"
                            className="col-span-5"
                          >
                            {(p) => (
                              <NativeSelect {...p} name="subjectId">
                                <optgroup label="指標">
                                  {shell.metrics.map((metric) => (
                                    <option key={metric.id} value={metric.id}>
                                      {metric.name}
                                    </option>
                                  ))}
                                </optgroup>
                                <optgroup label="組織・拠点">
                                  {shell.units.map((unit) => (
                                    <option key={unit.id} value={unit.id}>
                                      {unit.name}
                                    </option>
                                  ))}
                                </optgroup>
                                <optgroup label="報告期間">
                                  {shell.periods.map((period) => (
                                    <option key={period.id} value={period.id}>
                                      {period.code}
                                    </option>
                                  ))}
                                </optgroup>
                              </NativeSelect>
                            )}
                          </Field>
                          <div className="col-span-2 pb-1">
                            <NativeCheckbox
                              name="includesEvidence"
                              label="資料（Evidence）も共有"
                            />
                          </div>
                        </div>
                        <SubmitButton variant="primary" size="sm" pendingLabel="許諾中…">
                          許諾する
                        </SubmitButton>
                      </form>
                    </CreatePanel>
                  )}

                  {grants.length === 0 ? (
                    <EmptyState
                      kind={canManageGrants ? 'no-data' : 'not-applicable'}
                      size="compact"
                      title="アクセス許諾はまだありません"
                      description="許諾を追加すると、監査法人がその範囲のデータを Data Room で確認できます。"
                      action={
                        canManageGrants ? (
                          <Link
                            href={tabHref('grants', { new: '1' })}
                            className="text-small text-brand-700 hover:underline"
                          >
                            アクセス許諾を追加
                          </Link>
                        ) : (
                          <Link
                            href={tabHref('members')}
                            className="text-small text-brand-700 hover:underline"
                          >
                            メンバーを確認
                          </Link>
                        )
                      }
                    />
                  ) : (
                    <div className="t4d-scroll-x rounded-t4d border border-line">
                      <Table>
                        <THead>
                          <TR>
                            <TH>種別</TH>
                            <TH>対象</TH>
                            <TH>資料の共有</TH>
                            <TH>付与</TH>
                            <TH>状態</TH>
                            <TH align="right">
                              <span className="sr-only">操作</span>
                            </TH>
                          </TR>
                        </THead>
                        <TBody>
                          {grants.map((grant) => {
                            const label = subjectLabel(grant.subjectType, grant.subjectId);
                            const formId = `revoke-grant-${grant.id}`;
                            return (
                              <TR key={grant.id} data-t4d-record="">
                                <TD>{SUBJECT_LABEL[grant.subjectType] ?? '対象'}</TD>
                                <TD className="font-medium">{label}</TD>
                                <TD>{grant.includesEvidence ? 'あり' : '—'}</TD>
                                <TD className="text-caption text-ink-muted">
                                  {formatJst(grant.grantedAt)}
                                </TD>
                                <TD>
                                  {grant.revokedAt ? (
                                    <SemanticBadge
                                      semantic="excluded"
                                      label={`取消済み（${formatJst(grant.revokedAt)}）`}
                                    />
                                  ) : (
                                    <SemanticBadge semantic="done" label="有効" />
                                  )}
                                </TD>
                                <TD align="right">
                                  {canManageGrants &&
                                    (grant.revokedAt ? (
                                      // 取消の逆操作（元に戻す）。1 回で戻せる
                                      <form action={toggleGrantAction}>
                                        <input type="hidden" name="grantId" value={grant.id} />
                                        <input type="hidden" name="revoke" value="false" />
                                        <SubmitButton size="xs" variant="secondary">
                                          再付与
                                        </SubmitButton>
                                      </form>
                                    ) : (
                                      <>
                                        <form id={formId} action={toggleGrantAction} hidden>
                                          <input type="hidden" name="grantId" value={grant.id} />
                                          <input type="hidden" name="revoke" value="true" />
                                        </form>
                                        {/* 取り消すと即座に監査法人から見えなくなる。範囲を確かめ、戻し方を本文に示す（plan §1.16） */}
                                        <ConfirmDialog
                                          tier="reversible"
                                          title="アクセス許諾を取り消しますか"
                                          scope={`${SUBJECT_LABEL[grant.subjectType] ?? '対象'}「${label}」の共有`}
                                          consequences={[
                                            '監査法人側から即座に見えなくなります（Snapshot 後の変更として記録されます）。',
                                            '元に戻すときは、結果の通知の「元に戻す」か、この一覧の「再付与」を押します。',
                                          ]}
                                          confirmLabel="取り消す"
                                          formId={formId}
                                          trigger={{
                                            label: '取消…',
                                            size: 'xs',
                                            variant: 'secondary',
                                          }}
                                        />
                                      </>
                                    ))}
                                </TD>
                              </TR>
                            );
                          })}
                        </TBody>
                      </Table>
                    </div>
                  )}
                </div>
              )}
            </Section>
          </>
        )}

        {tab === 'security' && (
          <Section title="セキュリティ（パスワード再設定・MFA）" divider="none">
            <div className="space-y-2">
              <p className="flex items-start gap-1.5 text-small text-ink-muted">
                <KeyRound className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                パスワード再設定はリンク発行方式（メール送信なし）。発行したリンクを本人へ手渡してください。
              </p>
              {supabaseMode && (
                <form action={issueResetLinkAction} className="flex items-end gap-2">
                  <Field
                    label="対象メンバーのメールアドレス"
                    name="email"
                    required
                    className="w-field-lg"
                  >
                    {(p) => <Input {...p} name="email" type="email" />}
                  </Field>
                  <SubmitButton size="sm" variant="secondary" pendingLabel="発行中…">
                    再設定リンクを発行
                  </SubmitButton>
                </form>
              )}
              {resetIssued && (
                <Notice tone="success" role="status">
                  <p>
                    再設定リンクを発行しました（有効 2 分・メールは送信していません）。
                    下のリンクをコピーして本人へ手渡してください。
                  </p>
                  {resetLink && (
                    <code className="mt-1 block break-all rounded-t4d-sm bg-surface px-2 py-1 font-mono text-caption">
                      {resetLink}
                    </code>
                  )}
                </Notice>
              )}
              <MfaEnrollCard supabaseMode={supabaseMode} />
            </div>
          </Section>
        )}

        {tab === 'features' && (
          <Section
            title="機能設定（開示優先モード）"
            divider="none"
            actions={
              featureSettings.disclosureFirst ? (
                <SemanticBadge semantic="done" label="有効" />
              ) : (
                <SemanticBadge semantic="excluded" label="無効（従来の構成）" />
              )
            }
          >
            <form
              id="disclosure-first-form"
              action={setDisclosureFirstAction}
              className="space-y-2"
            >
              <p className="flex items-start gap-1.5 text-small text-ink-muted">
                <LayoutPanelLeft className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>
                  左メニューとホームを開示業務中心の構成に切り替えます（組織の全メンバーに反映）。
                  {/* デモで他の閲覧者にも影響することは隠さない（折りたたみに入れない） */}
                  {shell.ctx.demo &&
                    ' デモ環境では、同じサーバーで表示している他の閲覧者にも反映される場合があります。'}
                </span>
              </p>
              <MoreInfo label="開示優先モードで変わること" className="pl-5">
                <p>
                  有効にすると、左メニューとホームが開示業務を中心とした構成（開示プロジェクト／情報・根拠／ESG経営／タスク・承認）に切り替わります。
                  既存の画面はすべてメニューから開け、URL
                  も変わりません。設定は組織単位で、この組織の全メンバーに反映されます。
                </p>
              </MoreInfo>
              <fieldset className="flex flex-wrap items-center gap-3 text-small text-ink">
                <legend className="sr-only">開示優先モード</legend>
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    name="disclosureFirst"
                    value="on"
                    defaultChecked={featureSettings.disclosureFirst}
                    className="size-3.5 accent-brand-700"
                  />
                  有効にする
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    name="disclosureFirst"
                    value="off"
                    defaultChecked={!featureSettings.disclosureFirst}
                    className="size-3.5 accent-brand-700"
                  />
                  無効にする（従来の構成）
                </label>
                {/* 組織の全員のメニューとホームが変わる。範囲を確かめてから保存する（plan §1.16 区分 1） */}
                <ConfirmDialog
                  tier="irreversible"
                  destructive={false}
                  title="開示優先モードを切り替えますか"
                  scope={`この組織の全メンバーの左メニューとホームが、選んだ構成に変わります（現在: ${featureSettings.disclosureFirst ? '有効' : '無効（従来の構成）'}）。`}
                  consequences={[
                    '既存の画面の URL は変わりません。いつでもこの画面で元の構成に戻せます。',
                    ...(shell.ctx.demo
                      ? [
                          'デモ環境では、同じサーバーで表示している他の閲覧者にも反映される場合があります。',
                        ]
                      : []),
                  ]}
                  confirmLabel="切り替える"
                  formId="disclosure-first-form"
                  trigger={{ label: '保存', size: 'sm', variant: 'primary' }}
                />
              </fieldset>
            </form>
          </Section>
        )}
      </div>
    </>
  );
}
