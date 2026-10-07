import { can } from '@/lib/authorization/can';
import type { AuthorizationContext, PermissionKey } from '@/types/domain';

/**
 * 役割ごとの初期表示（plan §1.3）。React 非依存で、`can()` だけで決める。
 *
 * 役割キー（roleKeys）の名前で分岐すると、役割を足したとき・兼務のときに外れる。権限で決めれば、
 * 権限の 2 層（roles.ts・0002_identity.sql）が正しい限り同じ答えになる。上から最初に当たったものを
 * 採る（兼務は上を優先。キューの中身は保有権限の和で作るので、兼務で作業が消えることはない）。
 */

export const HOME_PROFILES = [
  'approver',
  'preparer',
  'admin',
  'reviewer',
  'contributor',
  'viewer',
] as const;
export type HomeProfile = (typeof HOME_PROFILES)[number];

/** 権限の有無だけを見る関数（ctx からでも、合成した権限の集合からでも作れる） */
export type Can = (permission: PermissionKey) => boolean;

export function homeProfileFor(can: Can): HomeProfile {
  if (can('enterprise.data.approve') || can('enterprise.disclosure.approve')) return 'approver';
  if (
    can('enterprise.disclosure.write') &&
    can('enterprise.import.run') &&
    !can('enterprise.org.manage')
  ) {
    return 'preparer';
  }
  if (can('enterprise.org.manage')) return 'admin';
  if (can('enterprise.data.review')) return 'reviewer';
  if (can('enterprise.data.write')) return 'contributor';
  return 'viewer';
}

export const HOME_PROFILE_LABELS: Record<HomeProfile, string> = {
  approver: '承認する人',
  preparer: '開示を作る人',
  admin: '管理する人',
  reviewer: 'レビューする人',
  contributor: 'データを入力する人',
  viewer: '閲覧する人',
};

/**
 * 開示優先ホームの既定タブ。開示の閲覧権限が無い利用者（拠点担当・サプライヤー担当）に、
 * 最初の表示で「アクセス権限がありません」を出さない（N-04）
 */
export type HomeTab = 'disclosure' | 'esg';

export function defaultHomeTab(can: Can): HomeTab {
  return can('enterprise.disclosure.read') ? 'disclosure' : 'esg';
}

/** URL の ?tab= を優先し、無ければ役割の既定 */
export function resolveHomeTab(requested: unknown, can: Can): HomeTab {
  if (requested === 'esg') return 'esg';
  if (requested === 'disclosure') return 'disclosure';
  return defaultHomeTab(can);
}

// ----------------------------------------------------------------------
// 監査法人
// ----------------------------------------------------------------------

export const ASSURANCE_HOME_PROFILES = [
  'partner',
  'manager',
  'staff',
  'specialist',
  'firm_admin',
  'viewer',
] as const;
export type AssuranceHomeProfile = (typeof ASSURANCE_HOME_PROFILES)[number];

export function assuranceHomeProfileFor(can: Can): AssuranceHomeProfile {
  if (can('assurance.signoff.partner')) return 'partner';
  if (can('assurance.engagement.manage')) return 'manager';
  if (can('assurance.signoff.prepared')) return 'staff';
  if (can('assurance.testing.write')) return 'specialist';
  // 法人管理者は未アサイン案件のクライアントデータを見られない（案件の 11 画面を出さない）
  if (can('assurance.firm.manage') && !can('assurance.engagement.read')) return 'firm_admin';
  return 'viewer';
}

// ----------------------------------------------------------------------
// ctx からの入口
// ----------------------------------------------------------------------

/** ctx の権限を見る Can */
export function canFor(ctx: AuthorizationContext): Can {
  return (permission) => can(ctx, permission);
}

export function homeProfileOf(ctx: AuthorizationContext): HomeProfile {
  return homeProfileFor(canFor(ctx));
}

export function assuranceHomeProfileOf(ctx: AuthorizationContext): AssuranceHomeProfile {
  return assuranceHomeProfileFor(canFor(ctx));
}
