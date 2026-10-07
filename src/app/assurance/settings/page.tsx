import { Notice } from '@/components/shared/notice';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { PermissionDeniedState } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { requireAssuranceContext } from '@/lib/auth/session';
import { can } from '@/lib/authorization/can';
import { roleLabel } from '@/lib/authorization/roles';
import { getDb } from '@/lib/repositories';

export const metadata = { title: '設定' };

export default async function AssuranceSettingsPage() {
  const ctx = await requireAssuranceContext();

  if (!can(ctx, 'assurance.firm.manage')) {
    return (
      <>
        <PageHeader title="設定" autoBreadcrumbs />
        <PermissionDeniedState
          permission="assurance.firm.manage"
          description="設定画面は監査法人管理者のみ閲覧できます。"
        />
      </>
    );
  }

  const db = await getDb();
  const organizationId = ctx.workspace.organizationId;

  const memberships = await db.select('memberships', { where: { organizationId } });
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

  // 法人管理者であっても、アサインされていない案件のクライアントデータは取得できない。
  // ここでは「自分がアサインされている案件」のみが取得できることを画面上でも明示する。
  const assignedCount = ctx.engagementIds.length;

  return (
    <>
      <PageHeader
        title="設定"
        description="監査法人テナントのユーザー管理。クライアントデータへのアクセスは含まれません。"
        autoBreadcrumbs
      />

      <div className="space-y-3 p-4">
        {/* 権限の範囲は安全の注記（折りたたまない） */}
        <Notice tone="warning">
          監査法人管理者は法人テナントとユーザーを管理しますが、
          <strong>未アサイン案件のクライアントデータを閲覧する権限は持ちません</strong>
          （アプリ層と RLS の両方で遮断しています）。
          <span className="ml-1">現在アサインされている案件: {assignedCount} 件。</span>
        </Notice>

        <Section title={`法人メンバー（${memberships.length}）`} divider="none">
          <div className="t4d-scroll-x rounded-t4d border border-line">
            <Table>
              <THead>
                <TR>
                  <TH>氏名</TH>
                  <TH>メールアドレス</TH>
                  <TH>役割</TH>
                  <TH>状態</TH>
                </TR>
              </THead>
              <TBody>
                {memberships.map((membership) => {
                  const profile = profiles.find((p) => p.id === membership.userId);
                  const memberRoles = roles.filter((r) => r.membershipId === membership.id);
                  return (
                    <TR key={membership.id}>
                      <TD className="font-medium">{profile?.displayName ?? '—'}</TD>
                      <TD className="text-small text-ink-muted">{profile?.email}</TD>
                      <TD>{memberRoles.map((r) => roleLabel(r.roleKey)).join(' / ')}</TD>
                      <TD>
                        <StatusBadge domain="membership" value={membership.status} />
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>
        </Section>
      </div>
    </>
  );
}
