import {
  ASSURANCE_ROLES,
  ENTERPRISE_ROLES,
  type AssuranceRole,
  type EnterpriseRole,
  type OrganizationType,
  type PermissionKey,
  type RoleDefinition,
  type RoleKey,
} from '@/types/domain';

/**
 * ロール → 権限のマッピング。
 *
 * ここはアプリ層の認可であり、**RLS の代替ではない**。
 * 同じ意味の制約を `supabase/migrations/0009_rls_*.sql` にも書き、
 * 二重で防御する（docs/authorization.md / docs/rls-matrix.md）。
 */

const ENTERPRISE_ROLE_PERMISSIONS: Record<EnterpriseRole, PermissionKey[]> = {
  enterprise_admin: [
    'enterprise.org.manage',
    'enterprise.period.manage',
    'enterprise.metric.manage',
    'enterprise.member.manage',
    'enterprise.data.read',
    'enterprise.data.write',
    'enterprise.data.submit',
    'enterprise.data.review',
    'enterprise.evidence.read',
    'enterprise.evidence.write',
    'enterprise.import.run',
    'enterprise.disclosure.read',
    'enterprise.disclosure.write',
    'enterprise.export.run',
    'enterprise.ai.run',
    'enterprise.grant.manage',
    'enterprise.pbc.respond',
    'common.audit.read',
  ],
  sustainability_manager: [
    'enterprise.period.manage',
    'enterprise.metric.manage',
    'enterprise.data.read',
    'enterprise.data.write',
    'enterprise.data.submit',
    'enterprise.data.review',
    'enterprise.evidence.read',
    'enterprise.evidence.write',
    'enterprise.import.run',
    'enterprise.disclosure.read',
    'enterprise.disclosure.write',
    'enterprise.export.run',
    'enterprise.ai.run',
    'enterprise.grant.manage',
    'enterprise.pbc.respond',
  ],
  site_contributor: [
    'enterprise.data.read',
    'enterprise.data.write',
    'enterprise.data.submit',
    'enterprise.evidence.read',
    'enterprise.evidence.write',
    'enterprise.import.run',
    'enterprise.pbc.respond',
  ],
  supplier_contributor: [
    'enterprise.data.read',
    'enterprise.data.write',
    'enterprise.data.submit',
    'enterprise.evidence.write',
  ],
  reviewer: [
    'enterprise.data.read',
    'enterprise.data.review',
    'enterprise.evidence.read',
    'enterprise.disclosure.read',
    'enterprise.disclosure.write',
  ],
  approver: [
    'enterprise.data.read',
    'enterprise.data.review',
    'enterprise.data.approve',
    'enterprise.evidence.read',
    'enterprise.disclosure.read',
    'enterprise.disclosure.approve',
    'enterprise.export.run',
  ],
  external_advisor: [
    'enterprise.data.read',
    'enterprise.evidence.read',
    'enterprise.disclosure.read',
  ],
  viewer: ['enterprise.data.read', 'enterprise.evidence.read', 'enterprise.disclosure.read'],
};

const ASSURANCE_ROLE_PERMISSIONS: Record<AssuranceRole, PermissionKey[]> = {
  // 法人管理のみ。未アサイン案件のクライアントデータは一切見えない（assumptions C-1）。
  assurance_admin: ['assurance.firm.manage', 'common.audit.read'],
  engagement_partner: [
    'assurance.engagement.manage',
    'assurance.engagement.read',
    'assurance.scope.manage',
    'assurance.snapshot.create',
    'assurance.population.manage',
    'assurance.sampling.run',
    'assurance.testing.write',
    'assurance.pbc.manage',
    'assurance.issue.manage',
    'assurance.review.write',
    'assurance.signoff.reviewed',
    'assurance.signoff.partner',
    'assurance.export.run',
    'assurance.ai.run',
    'common.audit.read',
  ],
  assurance_manager: [
    'assurance.engagement.manage',
    'assurance.engagement.read',
    'assurance.scope.manage',
    'assurance.snapshot.create',
    'assurance.population.manage',
    'assurance.sampling.run',
    'assurance.testing.write',
    'assurance.pbc.manage',
    'assurance.issue.manage',
    'assurance.review.write',
    'assurance.signoff.prepared',
    'assurance.signoff.reviewed',
    'assurance.export.run',
    'assurance.ai.run',
    'common.audit.read',
  ],
  assurance_staff: [
    'assurance.engagement.read',
    'assurance.population.manage',
    'assurance.sampling.run',
    'assurance.testing.write',
    'assurance.pbc.manage',
    'assurance.issue.manage',
    'assurance.signoff.prepared',
    'assurance.ai.run',
  ],
  specialist: ['assurance.engagement.read', 'assurance.testing.write', 'assurance.ai.run'],
  assurance_viewer: ['assurance.engagement.read'],
};

const PLATFORM_ROLE_PERMISSIONS: Record<'platform_admin', PermissionKey[]> = {
  // Phase 1 ではクライアントデータへのアクセス権を持たない（assumptions C-9）。
  platform_admin: ['common.audit.read'],
};

export const ROLE_PERMISSIONS: Record<RoleKey, PermissionKey[]> = {
  ...ENTERPRISE_ROLE_PERMISSIONS,
  ...ASSURANCE_ROLE_PERMISSIONS,
  ...PLATFORM_ROLE_PERMISSIONS,
};

export const ROLE_DEFINITIONS: RoleDefinition[] = [
  {
    key: 'enterprise_admin',
    organizationType: 'enterprise',
    name: '企業管理者',
    description: 'テナント・組織・ユーザー・権限・基準・年度・連携の管理',
  },
  {
    key: 'sustainability_manager',
    organizationType: 'enterprise',
    name: '本社サステナビリティ担当',
    description: '収集、集計、レビュー、開示回答、全社進捗',
  },
  {
    key: 'site_contributor',
    organizationType: 'enterprise',
    name: '拠点・グループ会社担当',
    description: '担当範囲の入力、Evidence 提出、差戻し対応',
  },
  {
    key: 'supplier_contributor',
    organizationType: 'enterprise',
    name: 'サプライヤー担当',
    description: '指定調査・データ・Evidence 提出',
  },
  {
    key: 'reviewer',
    organizationType: 'enterprise',
    name: 'レビュー担当',
    description: 'レビュー、コメント、差戻し、一次承認',
  },
  {
    key: 'approver',
    organizationType: 'enterprise',
    name: '最終承認者',
    description: 'データ、回答、開示原稿の最終承認',
  },
  {
    key: 'external_advisor',
    organizationType: 'enterprise',
    name: '外部支援者',
    description: '明示された範囲の作成・レビュー',
  },
  {
    key: 'viewer',
    organizationType: 'enterprise',
    name: '閲覧者',
    description: '指定範囲の Read-only',
  },
  {
    key: 'assurance_admin',
    organizationType: 'assurance_firm',
    name: '監査法人管理者',
    description:
      '法人テナント・ユーザー・標準テンプレート管理。未アサイン案件のクライアントデータ閲覧権限は持たない',
  },
  {
    key: 'engagement_partner',
    organizationType: 'assurance_firm',
    name: '契約責任者',
    description: '案件設定、担当割当、最終レビュー、Sign-off',
  },
  {
    key: 'assurance_manager',
    organizationType: 'assurance_firm',
    name: 'マネージャー',
    description: 'スコープ、計画、進捗、レビュー Note、指摘統制',
  },
  {
    key: 'assurance_staff',
    organizationType: 'assurance_firm',
    name: '担当者',
    description: '母集団確認、サンプリング、手続実施、調書作成',
  },
  {
    key: 'specialist',
    organizationType: 'assurance_firm',
    name: '専門家',
    description: '指定テーマ・指標だけの閲覧、専門家メモ',
  },
  {
    key: 'assurance_viewer',
    organizationType: 'assurance_firm',
    name: '閲覧者',
    description: '指定範囲の Read-only',
  },
  {
    key: 'platform_admin',
    organizationType: 'platform_admin',
    name: 'プラットフォーム管理者',
    description: 'プラットフォーム運用。クライアントデータへのアクセス権は持たない',
  },
];

export function getRoleDefinition(key: RoleKey): RoleDefinition | undefined {
  return ROLE_DEFINITIONS.find((r) => r.key === key);
}

export function roleLabel(key: RoleKey): string {
  return getRoleDefinition(key)?.name ?? key;
}

export function rolesForOrganizationType(type: OrganizationType): RoleKey[] {
  if (type === 'enterprise') return [...ENTERPRISE_ROLES];
  if (type === 'assurance_firm') return [...ASSURANCE_ROLES];
  return ['platform_admin'];
}
