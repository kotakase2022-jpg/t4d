import { CircleCheck } from 'lucide-react';
import { HonestyBadge } from '@/components/shared/honesty-badge';
import { PageHeader } from '@/components/shared/page-header';
import { Section } from '@/components/shared/section';
import { requireSession } from '@/lib/auth/session';
import { permissionsFor } from '@/lib/authorization/can';
import { PERMISSION_LABELS } from '@/lib/authorization/permission-labels';
import { roleLabel } from '@/lib/authorization/roles';
import { getAppMode, DEFAULT_TIMEZONE } from '@/lib/config';
import { formatJst } from '@/lib/format/datetime';
import { getDb } from '@/lib/repositories';
import { PERMISSION_KEYS } from '@/types/domain';

export const metadata = { title: 'プロフィール' };

export default async function ProfilePage() {
  const session = await requireSession();
  const ctx = session.context;
  const db = await getDb();

  const units =
    ctx.workspace.unitScopeIds.length > 0
      ? await db.select('units', { where: { id: { in: ctx.workspace.unitScopeIds } } })
      : [];

  // 権限キー（enterprise.data.read など）は出さず、権限の名前＝「できること」で示す（plan §1.17）。
  // 並びは権限の定義順（関連する権限が隣り合う）
  const held = permissionsFor(ctx.workspace.roleKeys);
  const abilities = PERMISSION_KEYS.filter((key) => held.has(key)).map(
    (key) => PERMISSION_LABELS[key].label,
  );
  const demo = getAppMode() === 'demo';

  return (
    <>
      <PageHeader title="プロフィール" autoBreadcrumbs />
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 p-4">
        <Section title="アカウント" divider="none">
          <dl className="divide-y divide-line text-body">
            <Row label="表示名" value={session.profile.displayName} />
            <Row label="メールアドレス" value={session.profile.email} />
            <Row label="役職" value={session.profile.jobTitle ?? '—'} />
            <Row label="タイムゾーン" value={`${DEFAULT_TIMEZONE}（表示は日本時間）`} />
            <Row label="言語" value="日本語" />
            <Row label="登録日" value={formatJst(session.profile.createdAt)} />
            <div className="flex items-center justify-between gap-4 py-1.5">
              <dt className="shrink-0 text-ink-muted">動作モード</dt>
              <dd className="flex items-center gap-1.5 text-right text-ink">
                {demo ? (
                  <>
                    <HonestyBadge kind="demo-data" />
                    デモ（架空のデータ）
                  </>
                ) : (
                  '本番の認証とデータ'
                )}
              </dd>
            </div>
          </dl>
        </Section>

        <Section title="現在のワークスペースと権限" divider="none">
          <dl className="divide-y divide-line text-body">
            <Row label="組織" value={ctx.workspace.organizationName} />
            <Row
              label="種別"
              value={ctx.workspace.organizationType === 'enterprise' ? '企業' : '監査法人'}
            />
            <Row label="役割" value={ctx.workspace.roleKeys.map(roleLabel).join(' / ')} />
            <Row
              label="担当範囲"
              value={
                units.length === 0 ? '全社（拠点の制限なし）' : units.map((u) => u.name).join(' / ')
              }
            />
            {ctx.workspace.organizationType === 'assurance_firm' && (
              <Row label="アサイン案件数" value={`${ctx.engagementIds.length} 件`} />
            )}
          </dl>
          <h3 className="mb-1 mt-3 text-small font-semibold text-ink">
            できること（{abilities.length}）
          </h3>
          <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            {abilities.map((label) => (
              <li key={label} className="flex items-center gap-1.5 text-small text-ink">
                <CircleCheck className="size-3.5 shrink-0 text-success" aria-hidden="true" />
                {label}
              </li>
            ))}
          </ul>
        </Section>
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
