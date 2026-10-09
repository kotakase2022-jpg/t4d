import Link from 'next/link';
import {
  FileClock,
  KeyRound,
  LayoutPanelLeft,
  ListChecks,
  ShieldCheck,
  Undo2,
  UserPlus,
} from 'lucide-react';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { CreatePanel, createPanelHref, isCreatePanelOpen } from '@/components/shared/create-panel';
import { DataTable, type DataTableColumn } from '@/components/shared/data-table';
import { FlashMessage } from '@/components/shared/flash';
import { NavTabs } from '@/components/shared/nav-tabs';
import { Notice } from '@/components/shared/notice';
import { PageActions } from '@/components/shared/page-actions';
import type { MenuActionSpec } from '@/lib/ui/actions';
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
import { loadApprovalRoutes } from '@/lib/services/approval-route';
import { memberActivity } from '@/lib/services/audit-log';
import { dataTermsTextLimit, loadDataTerms, systemFacts } from '@/lib/services/data-terms';
import { listSharedDataPoints } from '@/lib/services/data-room-sync';
import { getFeatureSettings } from '@/lib/services/feature-settings';
import { isProtectedDemoMember, listMemberAssignments } from '@/lib/services/identity';
import { cdpOptionState } from '@/lib/services/organization-options';
import { listSharedReportsForClient } from '@/lib/services/report-share';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { planTenantExport } from '@/lib/services/tenant-export';
import type { StatusSemantic } from '@/lib/ui/status/registry';
import type { Invitation, OrganizationMembership, RoleKey, Uuid } from '@/types/domain';
import { setDisclosureFirstAction, setMembershipStatusAction } from './actions';
import { CopyLinkButton } from './copy-link-button';
import { MfaEnrollCard } from './security-card';
import { UnitScopeFields } from './_components/unit-scope-fields';
import { enterpriseRoleMatrix, roleMemberCounts } from './_lib/role-matrix';
import { ApprovalTab, approvalTabHref } from './_tabs/approval';
import { DataHandlingTab, dataHandlingHref } from './_tabs/data-handling';
import { HandoverPanel, MemberEditPanel, membersHref } from './_tabs/member-panels';
import { RolesTab } from './_tabs/roles';
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
 * キーはタスク動詞・パレット（src/lib/ui/palette.ts）が指す ?tab= と同じ。
 * トライアル対応（K3）で承認ルート・役割と権限・データの取扱いを足した（既存のキー・ラベルは変えない）
 */
const TABS = [
  'members',
  'invitations',
  'grants',
  'approval',
  'roles',
  'security',
  'data-handling',
  'features',
] as const;
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

  const demoMode = db.mode === 'demo';
  const canReadAudit = can(ctx, 'common.audit.read');
  const canExport = can(ctx, 'enterprise.export.run');
  const profileOf = (userId: Uuid) => profiles.find((p) => p.id === userId);
  const nameOf = (membership: OrganizationMembership) =>
    profileOf(membership.userId)?.displayName ?? 'メンバー';
  const rolesOf = (membership: OrganizationMembership) =>
    roles.filter((r) => r.membershipId === membership.id).map((r) => r.roleKey);

  // ---- メンバー: 利用状況（監査ログを読める人だけ。NF-37）・役割と担当拠点の変更・引継ぎ（NF-25）
  const activity = tab === 'members' ? await memberActivity(db, ctx) : null;
  const editId = tab === 'members' && typeof params.edit === 'string' ? params.edit : null;
  const editMembership = editId ? memberships.find((m) => m.id === editId) : undefined;
  const handoverId =
    tab === 'members' && typeof params.handover === 'string' ? params.handover : null;
  const handover =
    handoverId && canManageMembers && memberships.some((m) => m.id === handoverId)
      ? await listMemberAssignments(db, ctx, handoverId)
      : null;
  // 停止の結果の通知に「元に戻す」（再開）を置く。この組織の、停止中のメンバーのときだけ（URL の ID をそのまま信じない）
  const undoMemberId = typeof params.member === 'string' ? params.member : null;
  const undoMember =
    canManageMembers && params.flash === 'membershipSuspended' && undoMemberId
      ? memberships.find((m) => m.id === undoMemberId && m.status === 'suspended')
      : undefined;
  const memberUndo = undoMember
    ? {
        membershipSuspended: (
          <form action={setMembershipStatusAction}>
            <input type="hidden" name="membershipId" value={undoMember.id} />
            <input type="hidden" name="status" value="active" />
            <SubmitButton size="xs" variant="secondary" icon={<Undo2 aria-hidden="true" />}>
              元に戻す
            </SubmitButton>
          </form>
        ),
      }
    : undefined;

  // ---- アクセス許諾: この許諾で共有中の承認済みデータの件数（NF-22。読み取り時に導出）・共有中のレポート（NF-20）
  const sharedCountByGrant = new Map<Uuid, number>();
  if (tab === 'grants') {
    for (const engagement of engagements) {
      for (const row of await listSharedDataPoints(db, engagement.id)) {
        for (const grantId of new Set(row.grantIds)) {
          sharedCountByGrant.set(grantId, (sharedCountByGrant.get(grantId) ?? 0) + 1);
        }
      }
    }
  }
  const sharedReports =
    tab === 'grants' && canManageGrants ? await listSharedReportsForClient(db, ctx, {}) : [];
  const sharedSnapshots =
    sharedReports.length > 0
      ? await db.select('reportSnapshots', {
          where: {
            organizationId,
            id: { in: [...new Set(sharedReports.map((r) => r.copy.snapshotId))] },
          },
        })
      : [];

  // ---- 承認ルート（NF-24・NF-44）・役割と権限（NF-27）・データの取扱い（NF-28・NF-29）・機能設定（NF-38）
  const approvalRoutes = tab === 'approval' ? await loadApprovalRoutes(db, ctx) : [];
  const dataTerms = tab === 'data-handling' ? await loadDataTerms(db, ctx) : null;
  const exportPlan =
    tab === 'data-handling' && params.confirm === 'tenant-export' && canExport
      ? await planTenantExport(db, ctx)
      : null;
  const cdp = tab === 'features' ? await cdpOptionState(db, ctx) : null;

  // 見出しの主操作は節ごとに 1 つ。作成欄を開いているときは、欄の中の送信が主操作（同時に 2 つ出さない）
  const approvalEditing = tab === 'approval' && typeof params.edit === 'string';
  const headerPrimary =
    tab === 'members' || tab === 'invitations'
      ? {
          kind: 'link' as const,
          id: 'invite-member',
          shortcut: 'new' as const,
          label: 'メンバーを招待',
          icon: <UserPlus aria-hidden="true" />,
          href: tabHref('invitations', { new: '1' }),
          hidden:
            !canManageMembers ||
            (tab === 'invitations' && panelOpen) ||
            (tab === 'members' && editMembership !== undefined),
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
        : tab === 'approval'
          ? {
              kind: 'link' as const,
              id: 'add-approval-route',
              shortcut: 'new' as const,
              label: '承認ルートを追加',
              icon: <ListChecks aria-hidden="true" />,
              href: approvalTabHref({ edit: 'new' }),
              hidden: approvalEditing,
            }
          : tab === 'data-handling'
            ? {
                kind: 'link' as const,
                id: 'record-data-terms',
                shortcut: 'new' as const,
                label: '条件の版を記録',
                icon: <FileClock aria-hidden="true" />,
                href: dataHandlingHref({ new: '1' }),
                hidden: panelOpen,
              }
            : undefined;
  // 承認ルートのひな形は編集の欄に値を入れるだけ（保存は欄の中の主操作）
  const headerSecondary =
    tab === 'approval' && !approvalEditing
      ? [
          {
            kind: 'link' as const,
            id: 'approval-template-three',
            label: '3 段階のひな形を入れる',
            href: approvalTabHref({ edit: 'new', template: 'three' }),
          },
          {
            kind: 'link' as const,
            id: 'approval-template-prior-year',
            label: '過年度確定値のひな形を入れる',
            href: approvalTabHref({ edit: 'new', template: 'prior-year' }),
          },
        ]
      : undefined;
  // 頻度の低い操作（L3）: 監査ログ（common.audit.read）・全データの書き出し（返却用。出力の権限も要る）
  const headerMore: MenuActionSpec[] = [
    {
      kind: 'link',
      id: 'open-audit-log',
      label: '監査ログを開く',
      href: '/enterprise/audit-log',
      group: 'advanced',
      hidden: !canReadAudit,
    },
    {
      kind: 'link',
      id: 'tenant-export',
      label: '全データを書き出す（返却用）…',
      href: dataHandlingHref({ confirm: 'tenant-export' }),
      group: 'export',
      hidden: tab !== 'data-handling' || !canExport,
    },
  ];

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
    // 利用状況（NF-37）は監査ログを読める人だけ。列 ▾ から出す L2 の列（既定では隠す）
    ...(activity
      ? ([
          {
            key: 'lastActive',
            header: '最終ログイン',
            importance: 'detail',
            cell: (membership) => {
              const at = activity.get(membership.userId)?.lastActiveAt ?? null;
              return (
                <span className="text-caption text-ink-muted">
                  {at ? formatJst(at) : '記録なし'}
                </span>
              );
            },
          },
          {
            key: 'actions30d',
            header: '直近 30 日の操作数',
            importance: 'detail',
            align: 'right',
            cell: (membership) => (
              <span className="tnum">{activity.get(membership.userId)?.actions30d ?? 0}</span>
            ),
          },
        ] satisfies DataTableColumn<OrganizationMembership>[])
      : []),
  ];

  /** メンバーの行の操作（NF-25）。Demo のログイン利用者・自分自身の停止は理由を出して押せなくする */
  const memberRowActions = (membership: OrganizationMembership) => {
    if (!canManageMembers) return null;
    const name = nameOf(membership);
    const protectedMember = isProtectedDemoMember(db.mode, profileOf(membership.userId)?.email);
    const protectedReason = protectedMember ? 'デモの利用者は変更できません' : undefined;
    const self = membership.userId === ctx.userId;
    return {
      rowLabel: name,
      items: [
        {
          kind: 'link' as const,
          id: `edit-member-${membership.id}`,
          label: '役割・担当拠点を変更…',
          href: membersHref({ edit: membership.id }),
          disabledReason: protectedReason,
        },
        {
          kind: 'link' as const,
          id: `handover-${membership.id}`,
          label: '担当の一覧（引継ぎ）',
          href: membersHref({ handover: membership.id }),
        },
        membership.status === 'suspended'
          ? {
              kind: 'submit' as const,
              id: `resume-member-${membership.id}`,
              label: '利用を再開',
              action: setMembershipStatusAction,
              fields: { membershipId: membership.id, status: 'active' },
              disabledReason: protectedReason,
            }
          : {
              kind: 'confirm' as const,
              id: `suspend-member-${membership.id}`,
              label: '利用を停止…',
              destructive: true,
              action: setMembershipStatusAction,
              fields: { membershipId: membership.id, status: 'suspended' },
              disabledReason:
                protectedReason ?? (self ? '自分自身の利用は停止できません' : undefined),
              confirm: {
                tier: 'reversible' as const,
                title: 'このメンバーの利用を停止しますか',
                scope: `${name}（${profileOf(membership.userId)?.email ?? 'メールアドレス不明'}）`,
                consequences: [
                  'この人はこの組織のワークスペースに入れなくなります（これまでの記録は消えません）。',
                  '元に戻すときは、結果の通知の「元に戻す」か、行の「利用を再開」を押します。',
                ],
                confirmLabel: '停止する',
              },
            },
      ],
    };
  };

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
        description="メンバー・招待・監査法人へのアクセス許諾・承認ルート・役割と権限・セキュリティ・データの取扱い・機能を管理します。"
        autoBreadcrumbs
        actions={
          <PageActions primary={headerPrimary} secondary={headerSecondary} more={headerMore} />
        }
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
            key: 'approval',
            label: '承認ルート',
            href: tabHref('approval'),
            hidden: !allowedTabs.includes('approval'),
          },
          {
            key: 'roles',
            label: '役割と権限',
            href: tabHref('roles'),
            hidden: !allowedTabs.includes('roles'),
          },
          {
            key: 'security',
            label: 'セキュリティ',
            href: tabHref('security'),
            hidden: !allowedTabs.includes('security'),
          },
          {
            key: 'data-handling',
            label: 'データの取扱い',
            href: tabHref('data-handling'),
            hidden: !allowedTabs.includes('data-handling'),
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
        <FlashMessage searchParams={params} undo={{ ...grantUndo, ...memberUndo }} />

        {tab === 'members' && editId && !editMembership && (
          <Notice tone="warning" role="alert">
            指定のメンバーが見つかりません。一覧から選び直してください。
          </Notice>
        )}
        {tab === 'members' && editMembership && canManageMembers && (
          <MemberEditPanel
            membership={editMembership}
            displayName={nameOf(editMembership)}
            roleKeys={rolesOf(editMembership)}
            units={shell.units}
            protectedMember={isProtectedDemoMember(
              db.mode,
              profileOf(editMembership.userId)?.email,
            )}
            demo={demoMode}
          />
        )}
        {tab === 'members' && handover && <HandoverPanel params={params} assignments={handover} />}

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
              rowActions={memberRowActions}
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
                  {/* 担当拠点（NF-25）。受諾したときにメンバーの担当範囲へ写る。未選択は全社 */}
                  <fieldset className="space-y-1">
                    <legend className="flex items-center gap-1.5 text-small font-medium text-ink">
                      担当拠点（選ばなければ全社）
                      <RequirementTag required={false} />
                    </legend>
                    <UnitScopeFields units={shell.units} />
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
                        <TH>担当拠点</TH>
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
                            <TD className="text-small">
                              {(inv.unitScopeIds ?? []).length === 0
                                ? '全社'
                                : (inv.unitScopeIds ?? [])
                                    .map((id) => unitById.get(id)?.name ?? '（削除した拠点）')
                                    .join(' / ')}
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
                            <TH>共有中の承認済みデータ</TH>
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
                                <TD className="tnum text-small">
                                  {grant.revokedAt
                                    ? '—'
                                    : `${sharedCountByGrant.get(grant.id) ?? 0} 件`}
                                </TD>
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

            {/* 共有中のレポート（NF-20）。共有・取り下げは開示プロジェクトの「出力」タブで行う */}
            {canManageGrants && (
              <Section
                title={`保証側へ共有したレポート（${sharedReports.length}）`}
                summary="写しは変更されません。取り下げると保証側から見えなくなります"
              >
                {sharedReports.length === 0 ? (
                  <EmptyState
                    kind="not-applicable"
                    size="compact"
                    title="共有したレポートはありません"
                    description="開示プロジェクトの「出力」タブで、承認済みのスナップショットを案件へ共有できます。"
                  />
                ) : (
                  <div className="t4d-scroll-x rounded-t4d border border-line">
                    <Table>
                      <THead>
                        <TR>
                          <TH>案件</TH>
                          <TH>スナップショット</TH>
                          <TH>内容ハッシュ</TH>
                          <TH>共有日時</TH>
                          <TH>状態</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {sharedReports.map(({ copy, withdrawn }) => {
                          const engagement = engagements.find((e) => e.id === copy.engagementId);
                          const snapshot = sharedSnapshots.find((x) => x.id === copy.snapshotId);
                          return (
                            <TR key={copy.id} data-t4d-record="">
                              <TD className="text-small">{engagement?.code ?? '案件'}</TD>
                              <TD className="text-small">
                                {snapshot ? (
                                  <Link
                                    href={`/enterprise/disclosure-projects/${snapshot.projectId}?tab=outputs`}
                                    className="text-brand-700 hover:underline"
                                  >
                                    No.{snapshot.snapshotNo} {snapshot.label}
                                  </Link>
                                ) : (
                                  '—'
                                )}
                              </TD>
                              <TD className="font-mono text-caption">
                                {copy.snapshotContentHash.slice(0, 12)}
                              </TD>
                              <TD className="text-caption text-ink-muted">
                                {formatJst(copy.sharedAt)}
                              </TD>
                              <TD>
                                <StatusBadge
                                  domain="sharedReport"
                                  value={withdrawn ? 'withdrawn' : 'active'}
                                />
                              </TD>
                            </TR>
                          );
                        })}
                      </TBody>
                    </Table>
                  </div>
                )}
              </Section>
            )}
          </>
        )}

        {tab === 'approval' && <ApprovalTab params={params} routes={approvalRoutes} />}

        {tab === 'roles' && (
          <RolesTab
            params={params}
            matrix={enterpriseRoleMatrix()}
            counts={roleMemberCounts(memberships, roles)}
          />
        )}

        {tab === 'data-handling' && dataTerms && (
          <DataHandlingTab
            params={params}
            facts={systemFacts()}
            terms={dataTerms}
            textLimit={dataTermsTextLimit(db)}
            creatorNames={new Map(profiles.map((p) => [p.id, p.displayName]))}
            demo={demoMode}
            exportPlan={exportPlan}
            canExport={canExport}
          />
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

        {tab === 'features' && cdp && (
          <Section
            title="契約オプション"
            actions={<StatusBadge domain="cdpOption" value={cdp.state} />}
          >
            {/* 契約で開く有償の機能（NF-38）。顧客の管理者が自分で開けないことを隠さない（折りたたまない） */}
            <dl className="grid gap-x-3 gap-y-1 text-small md:grid-cols-[minmax(10rem,auto)_1fr]">
              <dt className="font-medium text-ink">CDP 対応（オプション）</dt>
              <dd className="text-ink">
                {cdp.state === 'contracted'
                  ? `契約あり${cdp.option?.validFrom ? `（${cdp.option.validFrom} から${cdp.option.validTo ? ` ${cdp.option.validTo} まで` : ''}）` : ''}`
                  : '契約なし（CDP の画面・出力・AI の草案は使えません）'}
              </dd>
            </dl>
            <p className="mt-1.5 text-caption text-ink-muted">
              オプションの有効・無効は契約に基づいて運営が設定します。この画面からは変更できません。
            </p>
          </Section>
        )}
      </div>
    </>
  );
}
