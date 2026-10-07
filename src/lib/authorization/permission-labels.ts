import { ROLE_DEFINITIONS, ROLE_PERMISSIONS } from './roles';
import { PERMISSION_KEYS, type PermissionKey, type RoleKey } from '@/types/domain';

/**
 * 権限キーの表示名（plan §1.17・§4 B4）。文字列のデータだけで、権限そのもの（roles.ts・0002_identity.sql）
 * は変えない。
 *
 * 画面とエラー文に `enterprise.data.read` のような権限キーを出すと、利用者は何を誰に頼めばよいか
 * 分からない。既存の画面の言い方（「開示の閲覧権限」「指標の管理権限」）に揃えた名前と、その権限を
 * 持つ役割（＝依頼する相手）を返す。
 */

const LABELS: Record<PermissionKey, string> = {
  'enterprise.org.manage': '組織の管理',
  'enterprise.period.manage': '報告期間の管理',
  'enterprise.metric.manage': '指標の管理',
  'enterprise.member.manage': 'メンバーの管理',
  'enterprise.data.read': 'データの閲覧',
  'enterprise.data.write': 'データの入力',
  'enterprise.data.submit': 'データの提出',
  'enterprise.data.review': 'データのレビュー',
  'enterprise.data.approve': 'データの承認',
  'enterprise.evidence.read': '資料の閲覧',
  'enterprise.evidence.write': '資料の登録',
  'enterprise.import.run': 'データの取込',
  'enterprise.disclosure.read': '開示の閲覧',
  'enterprise.disclosure.write': '開示の編集',
  'enterprise.disclosure.approve': '開示の承認',
  'enterprise.export.run': '出力',
  'enterprise.ai.run': 'AI の実行',
  'enterprise.grant.manage': '監査法人へのアクセス許諾',
  'enterprise.pbc.respond': '資料依頼（PBC）への回答',
  'assurance.firm.manage': '監査法人の管理',
  'assurance.engagement.manage': '案件の管理',
  'assurance.engagement.read': '案件の閲覧',
  'assurance.scope.manage': '対象範囲の管理',
  'assurance.snapshot.create': 'Snapshot の作成',
  'assurance.population.manage': '母集団の管理',
  'assurance.sampling.run': 'サンプリングの実行',
  'assurance.testing.write': '保証手続・調書の作成',
  'assurance.pbc.manage': '資料依頼（PBC）の管理',
  'assurance.issue.manage': '指摘の管理',
  'assurance.review.write': 'レビューNote の作成',
  'assurance.signoff.prepared': 'Sign-off（作成）',
  'assurance.signoff.reviewed': 'Sign-off（レビュー）',
  'assurance.signoff.partner': 'Sign-off（契約責任者承認）',
  'assurance.export.run': '調書の出力',
  'assurance.ai.run': 'AI の実行（監査法人）',
  'common.audit.read': '監査ログの閲覧',
};

/** 依頼先として名前を挙げる役割の数の上限（多すぎると読めない。残りは「など」） */
const MAX_HOLDERS = 3;

function holdersOf(permission: PermissionKey): string {
  const roles = (Object.keys(ROLE_PERMISSIONS) as RoleKey[]).filter(
    (role) => role !== 'platform_admin' && ROLE_PERMISSIONS[role].includes(permission),
  );
  const names = roles.map(
    (role) => ROLE_DEFINITIONS.find((definition) => definition.key === role)?.name ?? role,
  );
  if (names.length === 0) return '管理者';
  return names.length > MAX_HOLDERS
    ? `${names.slice(0, MAX_HOLDERS).join('・')} など`
    : names.join('・');
}

export interface PermissionLabel {
  /** 権限の名前（例: 開示の閲覧） */
  label: string;
  /** その権限を持つ役割（依頼先。例: 企業管理者・本社サステナビリティ担当） */
  holders: string;
}

export const PERMISSION_LABELS: Readonly<Record<PermissionKey, PermissionLabel>> =
  Object.fromEntries(
    PERMISSION_KEYS.map((key) => [key, { label: LABELS[key], holders: holdersOf(key) }]),
  ) as Record<PermissionKey, PermissionLabel>;

export function permissionLabel(permission: PermissionKey): string {
  return PERMISSION_LABELS[permission].label;
}

/** 権限が無いときの文（何が足りないか・誰に頼むか。「権限」の語を必ず含む） */
export function permissionRequiredMessage(permission: PermissionKey): string {
  const { label, holders } = PERMISSION_LABELS[permission];
  return `この操作には「${label}」の権限が必要です。${holders}に依頼してください。`;
}
