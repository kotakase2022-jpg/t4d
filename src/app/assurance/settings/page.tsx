import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
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
        <PageHeader
          title="設定"
          breadcrumbs={[{ label: '監査法人ワークスペース' }, { label: '設定' }]}
        />
        <PermissionDeniedState description="設定画面は監査法人管理者のみ閲覧できます。" />
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
        breadcrumbs={[{ label: '監査法人ワークスペース' }, { label: '設定' }]}
      />

      <div className="space-y-3 p-4">
        <Card className="border-warning/40 bg-warning-soft">
          <p className="px-3 py-2 text-[12px] text-[#8a5d00]">
            監査法人管理者は法人テナントとユーザーを管理しますが、
            <strong>未アサイン案件のクライアントデータを閲覧する権限は持ちません</strong>
            （アプリ層と RLS の両方で遮断しています）。 現在アサインされている案件: {
              assignedCount
            }{' '}
            件。
          </p>
        </Card>

        <Card className="overflow-hidden">
          <SectionTitle title={`法人メンバー（${memberships.length}）`} />
          <Table>
            <THead>
              <TR>
                <TH>氏名</TH>
                <TH>メールアドレス</TH>
                <TH>ロール</TH>
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
                    <TD className="text-[12px] text-ink-muted">{profile?.email}</TD>
                    <TD>{memberRoles.map((r) => roleLabel(r.roleKey)).join(' / ')}</TD>
                    <TD>
                      <Badge tone={membership.status === 'active' ? 'success' : 'neutral'}>
                        {membership.status}
                      </Badge>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </Card>
      </div>
    </>
  );
}
