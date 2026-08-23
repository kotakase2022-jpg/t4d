import { ShieldCheck, UserPlus } from 'lucide-react';
import { PageHeader, SectionTitle } from '@/components/shared/page-header';
import { EmptyState, PermissionDeniedState } from '@/components/shared/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { FlashMessage } from '@/components/shared/flash';
import { can } from '@/lib/authorization/can';
import { roleLabel } from '@/lib/authorization/roles';
import { Input } from '@/components/ui/input';
import { formatJst, formatJstDate } from '@/lib/format/datetime';
import { getAppMode } from '@/lib/config';
import { loadEnterpriseShell } from '@/lib/services/shell';
import { MfaEnrollCard } from './security-card';
import {
  createInvitationAction,
  issueResetLinkAction,
  revokeInvitationAction,
  createGrantAction,
  toggleGrantAction,
} from '../actions';

export const metadata = { title: '設定' };

const SUBJECT_LABEL: Record<string, string> = {
  metric: '指標',
  organization_unit: '組織・拠点',
  reporting_period: '報告期間',
  evidence_category: 'Evidence 区分',
  disclosure_item: '開示項目',
};

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

  // 権限がない場合は 403 相当（URL 直打ちでも閲覧不可）
  if (!can(ctx, 'enterprise.org.manage')) {
    return (
      <>
        <PageHeader
          title="設定"
          breadcrumbs={[{ label: '企業ワークスペース' }, { label: '設定' }]}
        />
        <PermissionDeniedState description="設定画面は企業管理者のみ閲覧できます。" />
      </>
    );
  }

  const supabaseMode = getAppMode() === 'supabase';
  const organizationId = ctx.workspace.organizationId;
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

  const canManageGrants = can(ctx, 'enterprise.grant.manage');

  return (
    <>
      <PageHeader
        title="設定"
        description="組織・ユーザー・監査法人へのアクセス許諾を管理します。"
        breadcrumbs={[{ label: '企業ワークスペース' }, { label: '設定' }]}
      />

      <div className="px-4 pt-3">
        <FlashMessage searchParams={params} />
      </div>
      <div className="space-y-3 p-4">
        <Card className="overflow-hidden">
          <SectionTitle title={`メンバー（${memberships.length}）`} />
          <Table>
            <THead>
              <TR>
                <TH>氏名</TH>
                <TH>メールアドレス</TH>
                <TH>ロール</TH>
                <TH>担当範囲</TH>
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
                    <TD className="text-[12px]">
                      {membership.unitScopeIds.length === 0
                        ? '全社'
                        : membership.unitScopeIds
                            .map((id) => unitById.get(id)?.name ?? id)
                            .join(' / ')}
                    </TD>
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

        <Card className="overflow-hidden">
          <SectionTitle
            title={`メンバー招待（${invitations.filter((i) => i.status === 'pending').length} 件が有効）`}
          />
          <div className="space-y-2 p-3">
            <p className="rounded-t4d bg-brand-50 px-2 py-1.5 text-[12px] text-brand-900">
              招待メールは送信しません（運用制約）。作成した
              <strong>招待リンクをコピーして 社内チャット等で本人へ渡して</strong>
              ください。リンクを開いた本人が氏名を入力すると 参加が完了します（有効期限 14 日）。
            </p>
            <form action={createInvitationAction} className="flex flex-wrap items-end gap-2">
              <label className="text-[12px] text-ink-muted">
                メールアドレス
                <Input
                  name="email"
                  type="email"
                  required
                  placeholder="new-hire@demo.local"
                  className="mt-0.5 w-64"
                />
              </label>
              <fieldset className="text-[12px] text-ink-muted">
                <legend>ロール</legend>
                <div className="mt-0.5 flex flex-wrap gap-2">
                  {(
                    [
                      'sustainability_manager',
                      'site_contributor',
                      'reviewer',
                      'approver',
                      'viewer',
                    ] as const
                  ).map((role) => (
                    <label key={role} className="flex items-center gap-1 text-[12px] text-ink">
                      <input type="checkbox" name="roleKeys" value={role} className="size-3.5" />
                      {roleLabel(role)}
                    </label>
                  ))}
                </div>
              </fieldset>
              <Button type="submit" size="sm">
                <UserPlus aria-hidden="true" />
                招待リンクを発行
              </Button>
            </form>

            {invitations.length > 0 && (
              <Table>
                <THead>
                  <TR>
                    <TH>メールアドレス</TH>
                    <TH>ロール</TH>
                    <TH>状態</TH>
                    <TH>期限</TH>
                    <TH>招待リンク</TH>
                    <TH className="w-16" aria-label="操作" />
                  </TR>
                </THead>
                <TBody>
                  {invitations.map((inv) => (
                    <TR key={inv.id}>
                      <TD className="text-[12px]">{inv.email}</TD>
                      <TD className="text-[12px]">
                        {inv.roleKeys.map((r) => roleLabel(r)).join(' / ')}
                      </TD>
                      <TD>
                        <Badge
                          tone={
                            inv.status === 'pending'
                              ? 'brand'
                              : inv.status === 'accepted'
                                ? 'success'
                                : 'neutral'
                          }
                        >
                          {inv.status === 'pending'
                            ? '有効'
                            : inv.status === 'accepted'
                              ? '受諾済み'
                              : inv.status === 'revoked'
                                ? '失効'
                                : '期限切れ'}
                        </Badge>
                      </TD>
                      <TD className="text-[12px] text-ink-muted">{formatJstDate(inv.expiresAt)}</TD>
                      <TD>
                        {inv.status === 'pending' ? (
                          <code className="block max-w-[260px] truncate rounded bg-surface-muted px-1.5 py-0.5 text-[11px]">
                            {`/invite/${inv.id}`}
                          </code>
                        ) : (
                          '—'
                        )}
                      </TD>
                      <TD>
                        {inv.status === 'pending' && (
                          <form action={revokeInvitationAction}>
                            <input type="hidden" name="invitationId" value={inv.id} />
                            <Button type="submit" size="xs" variant="outline">
                              失効
                            </Button>
                          </form>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </div>
        </Card>

        <Card className="overflow-hidden">
          <SectionTitle title="セキュリティ（パスワード再設定・MFA）" />
          <div className="px-3 pt-2 text-[12px] text-ink-muted">
            パスワード再設定はリンク発行方式（メール送信なし）。発行したリンクを本人へ手渡してください。
          </div>
          {supabaseMode && (
            <form action={issueResetLinkAction} className="flex items-end gap-2 px-3 pt-2">
              <label className="text-[12px] text-ink-muted">
                対象メンバーのメールアドレス
                <Input name="email" type="email" required className="mt-0.5 w-64" />
              </label>
              <Button type="submit" size="sm" variant="outline">
                再設定リンクを発行
              </Button>
            </form>
          )}
          {resetIssued && (
            <div className="px-3 pt-1.5">
              <p className="text-[12px] text-brand-900">
                再設定リンクを発行しました（有効 2 分・メールは送信していません）。
                下のリンクをコピーして本人へ手渡してください。
              </p>
              {resetLink && (
                <code className="mt-1 block break-all rounded bg-surface-muted px-2 py-1 font-mono text-[11px]">
                  {resetLink}
                </code>
              )}
            </div>
          )}
          <MfaEnrollCard supabaseMode={supabaseMode} />
        </Card>

        <Card className="overflow-hidden">
          <SectionTitle
            title={`監査法人へのアクセス許諾（${grants.length}）`}
            action={
              <span className="text-[11px] text-ink-muted">
                取り消すと監査法人側から即座に不可視になります
              </span>
            }
          />
          {engagements.length === 0 ? (
            <EmptyState
              title="保証契約がありません"
              icon={<ShieldCheck className="size-5" aria-hidden="true" />}
            />
          ) : (
            <>
              <div className="border-b border-line bg-surface-muted px-3 py-2">
                {engagements.map((engagement) => (
                  <div key={engagement.id} className="text-[12px] text-ink">
                    <span className="font-medium">{engagement.code}</span> {engagement.name} ／
                    監査法人: {firms.find((f) => f.id === engagement.assuranceFirmId)?.name ?? '—'}{' '}
                    ／ 保証水準:{' '}
                    {engagement.assuranceLevel === 'limited' ? '限定的保証' : '合理的保証'}
                  </div>
                ))}
              </div>
              {canManageGrants && (
                <form
                  action={createGrantAction}
                  className="grid grid-cols-12 items-end gap-2 border-b border-line px-3 py-2"
                >
                  <label className="col-span-3 text-[12px] text-ink-muted">
                    保証契約
                    <select
                      name="engagementId"
                      required
                      className="mt-0.5 block h-7 w-full rounded-t4d border border-line bg-surface px-2 text-[13px]"
                    >
                      {engagements.map((engagement) => (
                        <option key={engagement.id} value={engagement.id}>
                          {engagement.code}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="col-span-2 text-[12px] text-ink-muted">
                    種別
                    <select
                      name="subjectType"
                      required
                      className="mt-0.5 block h-7 w-full rounded-t4d border border-line bg-surface px-2 text-[13px]"
                    >
                      <option value="metric">指標</option>
                      <option value="organization_unit">組織・拠点</option>
                      <option value="reporting_period">報告期間</option>
                    </select>
                  </label>
                  {/*
                    種別ごとに対象の選択肢が変わるが、サーバー描画のみで完結させるため
                    3 種類をまとめて 1 つのセレクトに並べ、value に ID を持たせる。
                    種別と対象の整合はサーバー側（createGrantAction）で確認する。
                  */}
                  <label className="col-span-5 text-[12px] text-ink-muted">
                    対象
                    <select
                      name="subjectId"
                      required
                      className="mt-0.5 block h-7 w-full rounded-t4d border border-line bg-surface px-2 text-[13px]"
                    >
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
                    </select>
                  </label>
                  <label className="col-span-1 flex items-center gap-1 text-[12px] text-ink-muted">
                    <input type="checkbox" name="includesEvidence" className="size-3.5" />
                    Evidence
                  </label>
                  <div className="col-span-1">
                    <Button type="submit" size="sm">
                      許諾する
                    </Button>
                  </div>
                </form>
              )}
              <Table>
                <THead>
                  <TR>
                    <TH>種別</TH>
                    <TH>対象</TH>
                    <TH>Evidence 共有</TH>
                    <TH>付与</TH>
                    <TH>状態</TH>
                    <TH className="w-24" aria-label="操作" />
                  </TR>
                </THead>
                <TBody>
                  {grants.map((grant) => (
                    <TR key={grant.id}>
                      <TD>{SUBJECT_LABEL[grant.subjectType] ?? grant.subjectType}</TD>
                      <TD className="font-medium">
                        {subjectLabel(grant.subjectType, grant.subjectId)}
                      </TD>
                      <TD>{grant.includesEvidence ? <Badge tone="brand">あり</Badge> : '—'}</TD>
                      <TD className="text-[11px] text-ink-muted">{formatJst(grant.grantedAt)}</TD>
                      <TD>
                        {grant.revokedAt ? (
                          <Badge tone="danger">取消済み（{formatJst(grant.revokedAt)}）</Badge>
                        ) : (
                          <Badge tone="success">有効</Badge>
                        )}
                      </TD>
                      <TD>
                        {canManageGrants && (
                          <form action={toggleGrantAction}>
                            <input type="hidden" name="grantId" value={grant.id} />
                            <input
                              type="hidden"
                              name="revoke"
                              value={grant.revokedAt ? 'false' : 'true'}
                            />
                            <Button
                              type="submit"
                              size="xs"
                              variant={grant.revokedAt ? 'outline' : 'danger'}
                            >
                              {grant.revokedAt ? '再付与' : '取消'}
                            </Button>
                          </form>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </>
          )}
        </Card>
      </div>
    </>
  );
}
