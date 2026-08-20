import { PageHeader } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireSession } from '@/lib/auth/session';
import { permissionsFor } from '@/lib/authorization/can';
import { roleLabel } from '@/lib/authorization/roles';
import { getAppMode, DEFAULT_TIMEZONE } from '@/lib/config';
import { formatJst } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';

export const metadata = { title: 'プロフィール' };

export default async function ProfilePage() {
  const session = await requireSession();
  const ctx = session.context;
  const db = await getDb();

  const units =
    ctx.workspace.unitScopeIds.length > 0
      ? await db.select('units', { where: { id: { in: ctx.workspace.unitScopeIds } } })
      : [];

  const permissions = [...permissionsFor(ctx.workspace.roleKeys)].sort();

  return (
    <>
      <PageHeader
        title="プロフィール"
        breadcrumbs={[{ label: 'ホーム', href: '/workspace' }, { label: 'プロフィール' }]}
      />
      <div className="grid grid-cols-2 gap-3 p-4">
        <Card>
          <CardHeader>
            <CardTitle>アカウント</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-line text-[13px]">
              <Row label="表示名" value={session.profile.displayName} />
              <Row label="メールアドレス" value={session.profile.email} />
              <Row label="役職" value={session.profile.jobTitle ?? '—'} />
              <Row label="タイムゾーン" value={`${DEFAULT_TIMEZONE}（表示は JST 固定）`} />
              <Row label="言語" value="日本語" />
              <Row label="登録日" value={formatJst(session.profile.createdAt)} />
              <Row
                label="動作モード"
                value={getAppMode() === 'demo' ? 'Demo / Fixture Mode' : 'Supabase Mode'}
              />
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>現在のワークスペースと権限</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <dl className="divide-y divide-line text-[13px]">
              <Row label="組織" value={ctx.workspace.organizationName} />
              <Row
                label="種別"
                value={ctx.workspace.organizationType === 'enterprise' ? '企業' : '監査法人'}
              />
              <Row label="ロール" value={ctx.workspace.roleKeys.map(roleLabel).join(' / ')} />
              <Row
                label="担当範囲"
                value={
                  units.length === 0
                    ? '全社（Unit 制限なし）'
                    : units.map((u) => u.name).join(' / ')
                }
              />
              {ctx.workspace.organizationType === 'assurance_firm' && (
                <Row label="アサイン案件数" value={`${ctx.engagementIds.length} 件`} />
              )}
            </dl>
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                有効な権限（{permissions.length}）
              </div>
              <ul className="flex flex-wrap gap-1">
                {permissions.map((p) => (
                  <li key={p}>
                    <Badge tone="outline">{p}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-ink-muted">{label}</dt>
      <dd className="truncate text-right text-ink">{value}</dd>
    </div>
  );
}
