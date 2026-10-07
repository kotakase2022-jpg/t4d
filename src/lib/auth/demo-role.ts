import 'server-only';

import { AuthorizationError } from '@/lib/authorization/can';
import { roleLabel } from '@/lib/authorization/roles';
import { getAppMode, type AppMode } from '@/lib/config';
import type { DbClient } from '@/lib/repositories/types';
import type { AuthorizationContext, RoleKey, Uuid } from '@/types/domain';

/**
 * デモ専用の役割切替（指示書 §14.1「役割切替はデモ専用機構を利用し、本番の認可を弱めない」）。
 *
 * これまでは作成担当 → レビュアー → 最終承認者を見せるたびに、ログアウト → ログイン画面 →
 * ワークスペース選択を往復していた。ヘッダーから同じ組織のデモ利用者へ直接切り替える。
 *
 * 本番の認可を弱めないための制約（すべてサーバー側で検査する）:
 *  - Demo Mode（かつ ctx.demo）でのみ有効。Supabase Mode では候補を返さず、切替も拒否する
 *  - 切替先は @demo.local のアカウントに限る
 *  - 切替先は「いま開いている組織」の有効なメンバーに限る（別テナントへは移れない）
 * 権限そのものは切替先ユーザーのロールから通常どおり解決する（ここで権限を付け足さない）。
 */

export const DEMO_EMAIL_SUFFIX = '@demo.local';

export interface DemoRoleChoice {
  userId: Uuid;
  email: string;
  displayName: string;
  jobTitle: string | null;
  roleKeys: RoleKey[];
  /** デモの筋書き上の役割（作成担当・レビュアー・最終承認者など） */
  demoRole: string;
  /** ロール名の一覧（例: 最終承認者 / レビュー担当） */
  roleLabels: string;
  current: boolean;
}

/**
 * 実演の順に並べるための順位。企業は 作成 → レビュー → 最終承認 → 管理 → 拠点、
 * 監査法人は 契約責任者 → マネージャー → 担当者 → 法人管理者（plan §1.4 N-18。監査法人でも役割を
 * 切り替えて Sign-off の 3 段階を実演できるように）。組織をまたいで切り替えることは無い（検査は従来どおり）
 */
const DEMO_ROLE_ORDER: ReadonlyArray<[RoleKey, string]> = [
  ['sustainability_manager', '作成担当'],
  ['reviewer', 'レビュアー'],
  ['approver', '最終承認者'],
  ['enterprise_admin', '管理者'],
  ['site_contributor', '拠点担当'],
  ['engagement_partner', '契約責任者'],
  ['assurance_manager', 'マネージャー'],
  ['assurance_staff', '担当者'],
  ['assurance_admin', '法人管理者'],
];

/**
 * 筋書き上の役割名。最終承認者はレビュー担当も兼ねているため、承認者を優先して名付ける
 * （同じ人がレビューと最終承認を兼ねられないことは review_events のトリガと Service が守る）。
 */
export function demoRoleOf(roleKeys: readonly RoleKey[]): { label: string; rank: number } {
  if (roleKeys.includes('approver')) return { label: '最終承認者', rank: 2 };
  for (const [index, [key, label]] of DEMO_ROLE_ORDER.entries()) {
    if (roleKeys.includes(key)) return { label, rank: index };
  }
  const first = roleKeys[0];
  return { label: first ? roleLabel(first) : '—', rank: DEMO_ROLE_ORDER.length };
}

function isDemoAvailable(ctx: AuthorizationContext, mode: AppMode): boolean {
  return mode === 'demo' && ctx.demo;
}

/** 切替候補（同じ組織の有効なメンバーのうち @demo.local のもの）。Demo Mode 以外は常に空 */
export async function listDemoRoleChoices(
  db: DbClient,
  ctx: AuthorizationContext,
  mode: AppMode = getAppMode(),
): Promise<DemoRoleChoice[]> {
  if (!isDemoAvailable(ctx, mode)) return [];

  const memberships = await db.select('memberships', {
    where: { organizationId: ctx.workspace.organizationId, status: 'active' },
  });
  if (memberships.length === 0) return [];

  const [profiles, roles] = await Promise.all([
    db.select('profiles', { where: { id: { in: memberships.map((m) => m.userId) } } }),
    db.select('membershipRoles', {
      where: { membershipId: { in: memberships.map((m) => m.id) } },
    }),
  ]);

  const choices: Array<DemoRoleChoice & { rank: number }> = [];
  for (const membership of memberships) {
    const profile = profiles.find((p) => p.id === membership.userId);
    if (!profile || !profile.email.endsWith(DEMO_EMAIL_SUFFIX)) continue;
    const roleKeys = roles.filter((r) => r.membershipId === membership.id).map((r) => r.roleKey);
    const role = demoRoleOf(roleKeys);
    choices.push({
      userId: profile.id,
      email: profile.email,
      displayName: profile.displayName,
      jobTitle: profile.jobTitle,
      roleKeys,
      demoRole: role.label,
      roleLabels: roleKeys.map(roleLabel).join(' / '),
      current: profile.id === ctx.userId,
      rank: role.rank,
    });
  }

  return choices
    .sort((a, b) => a.rank - b.rank || a.displayName.localeCompare(b.displayName, 'ja'))
    .map(({ rank: _rank, ...choice }) => choice);
}

/**
 * 切替先を検証して返す。条件を満たさなければ AuthorizationError（存在の有無は区別して伝えない）。
 * Cookie の書き換えは呼び出し側（Server Action）が行う。
 */
export async function resolveDemoRoleSwitch(
  db: DbClient,
  ctx: AuthorizationContext,
  email: string,
  mode: AppMode = getAppMode(),
): Promise<DemoRoleChoice> {
  if (!isDemoAvailable(ctx, mode)) {
    throw new AuthorizationError('役割の切替はデモ環境でのみ利用できます。');
  }
  const normalized = email.trim().toLowerCase();
  if (!normalized.endsWith(DEMO_EMAIL_SUFFIX)) {
    throw new AuthorizationError('デモアカウント（@demo.local）以外へは切り替えられません。');
  }
  const choices = await listDemoRoleChoices(db, ctx, mode);
  const target = choices.find((c) => c.email.toLowerCase() === normalized);
  if (!target) {
    throw new AuthorizationError('同じ組織のデモアカウントにのみ切り替えられます。');
  }
  return target;
}
