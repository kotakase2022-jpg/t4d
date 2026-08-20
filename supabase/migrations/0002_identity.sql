-- ======================================================================
-- 0002 Identity / Tenant（指示書 10.1）
-- ======================================================================

create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  display_name text not null,
  job_title text,
  locale text not null default 'ja' check (locale in ('ja', 'en')),
  timezone text not null default 'Asia/Tokyo',
  created_at timestamptz not null default now()
);

create table organizations (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('enterprise', 'assurance_firm', 'platform_admin')),
  name text not null,
  legal_name text,
  code text not null unique,
  country_code text not null default 'JP',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  deleted_at timestamptz
);

create table roles (
  key text primary key,
  organization_type text not null
    check (organization_type in ('enterprise', 'assurance_firm', 'platform_admin')),
  name text not null,
  description text not null
);

create table permissions (
  key text primary key,
  description text not null
);

create table role_permissions (
  role_key text not null references roles (key) on delete cascade,
  permission_key text not null references permissions (key) on delete cascade,
  primary key (role_key, permission_key)
);

create table organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  status text not null default 'invited' check (status in ('invited', 'active', 'suspended')),
  -- 企業側の担当 Unit 制限。空 = 全社スコープ。
  unit_scope_ids uuid[] not null default '{}',
  invited_by uuid references profiles (id),
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  constraint organization_memberships_unique unique (organization_id, user_id)
);

create index organization_memberships_user_idx on organization_memberships (user_id, status);

create table membership_roles (
  membership_id uuid not null references organization_memberships (id) on delete cascade,
  role_key text not null references roles (key),
  granted_at timestamptz not null default now(),
  granted_by uuid references profiles (id),
  primary key (membership_id, role_key)
);

create table invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  email text not null,
  role_keys text[] not null default '{}',
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id)
);

create table organization_relationships (
  id uuid primary key default gen_random_uuid(),
  client_organization_id uuid not null references organizations (id) on delete cascade,
  provider_organization_id uuid not null references organizations (id) on delete cascade,
  relationship_type text not null check (relationship_type in ('assurance', 'advisory')),
  status text not null default 'pending'
    check (status in ('pending', 'active', 'suspended', 'terminated')),
  started_at date not null,
  ended_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  constraint organization_relationships_distinct check (client_organization_id <> provider_organization_id),
  constraint organization_relationships_unique
    unique (client_organization_id, provider_organization_id, relationship_type)
);

create table user_preferences (
  user_id uuid primary key references profiles (id) on delete cascade,
  density text not null default 'compact' check (density in ('compact', 'standard')),
  default_workspace_organization_id uuid references organizations (id),
  saved_views jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create trigger organizations_set_updated_at
  before update on organizations
  for each row execute function t4d.set_updated_at();

create trigger organization_memberships_set_updated_at
  before update on organization_memberships
  for each row execute function t4d.set_updated_at();

create trigger organization_relationships_set_updated_at
  before update on organization_relationships
  for each row execute function t4d.set_updated_at();

create trigger invitations_set_updated_at
  before update on invitations
  for each row execute function t4d.set_updated_at();

-- ----------------------------------------------------------------------
-- ロール・権限マスター
-- src/lib/authorization/roles.ts と一致させること。
-- tests/unit/authorization-parity.test.ts が本ファイルを解析して検証する。
-- ----------------------------------------------------------------------

insert into roles (key, organization_type, name, description) values
  ('enterprise_admin', 'enterprise', '企業管理者', 'テナント・組織・ユーザー・権限・基準・年度・連携の管理'),
  ('sustainability_manager', 'enterprise', '本社サステナビリティ担当', '収集、集計、レビュー、開示回答、全社進捗'),
  ('site_contributor', 'enterprise', '拠点・グループ会社担当', '担当範囲の入力、Evidence 提出、差戻し対応'),
  ('supplier_contributor', 'enterprise', 'サプライヤー担当', '指定調査・データ・Evidence 提出'),
  ('reviewer', 'enterprise', 'レビュー担当', 'レビュー、コメント、差戻し、一次承認'),
  ('approver', 'enterprise', '最終承認者', 'データ、回答、開示原稿の最終承認'),
  ('external_advisor', 'enterprise', '外部支援者', '明示された範囲の作成・レビュー'),
  ('viewer', 'enterprise', '閲覧者', '指定範囲の Read-only'),
  ('assurance_admin', 'assurance_firm', '監査法人管理者', '法人テナント・ユーザー・標準テンプレート管理。未アサイン案件のクライアントデータ閲覧権限は持たない'),
  ('engagement_partner', 'assurance_firm', '契約責任者', '案件設定、担当割当、最終レビュー、Sign-off'),
  ('assurance_manager', 'assurance_firm', 'マネージャー', 'スコープ、計画、進捗、レビュー Note、指摘統制'),
  ('assurance_staff', 'assurance_firm', '担当者', '母集団確認、サンプリング、手続実施、調書作成'),
  ('specialist', 'assurance_firm', '専門家', '指定テーマ・指標だけの閲覧、専門家メモ'),
  ('assurance_viewer', 'assurance_firm', '閲覧者', '指定範囲の Read-only'),
  ('platform_admin', 'platform_admin', 'プラットフォーム管理者', 'プラットフォーム運用。クライアントデータへのアクセス権は持たない');

insert into permissions (key, description) values
  ('enterprise.org.manage', '組織階層・テナント設定の管理'),
  ('enterprise.period.manage', '報告期間・収集キャンペーンの管理'),
  ('enterprise.metric.manage', '指標マスターの管理'),
  ('enterprise.member.manage', 'ユーザー・ロールの管理'),
  ('enterprise.data.read', 'Data Point の閲覧'),
  ('enterprise.data.write', 'Data Point の入力・更新'),
  ('enterprise.data.submit', 'Data Point の提出'),
  ('enterprise.data.review', 'Data Point のレビュー・差戻し'),
  ('enterprise.data.approve', 'Data Point の最終承認'),
  ('enterprise.evidence.read', 'Evidence の閲覧'),
  ('enterprise.evidence.write', 'Evidence の登録・紐付け'),
  ('enterprise.import.run', '取込ジョブの実行'),
  ('enterprise.disclosure.read', '開示回答の閲覧'),
  ('enterprise.disclosure.write', '開示回答の作成・編集'),
  ('enterprise.disclosure.approve', '開示回答の最終承認'),
  ('enterprise.export.run', 'Export の実行'),
  ('enterprise.ai.run', 'AI 機能の実行'),
  ('enterprise.grant.manage', '監査法人へのアクセス許諾の付与・取消'),
  ('enterprise.pbc.respond', 'PBC 依頼への回答'),
  ('assurance.firm.manage', '監査法人テナント・ユーザーの管理'),
  ('assurance.engagement.manage', '案件設定・担当割当'),
  ('assurance.engagement.read', '案件の閲覧'),
  ('assurance.scope.manage', '保証スコープの管理'),
  ('assurance.snapshot.create', 'Snapshot の作成'),
  ('assurance.population.manage', '母集団の作成・完全性手続'),
  ('assurance.sampling.run', 'サンプリングの実行'),
  ('assurance.testing.write', '保証手続・調書の記録'),
  ('assurance.pbc.manage', 'PBC 依頼の管理'),
  ('assurance.issue.manage', '指摘の管理'),
  ('assurance.review.write', 'レビュー Note の記録'),
  ('assurance.signoff.prepared', 'Prepared Sign-off'),
  ('assurance.signoff.reviewed', 'Reviewed Sign-off'),
  ('assurance.signoff.partner', 'Partner Sign-off'),
  ('assurance.export.run', '案件 Export の実行'),
  ('assurance.ai.run', '監査 AI 支援の実行'),
  ('common.audit.read', '監査ログの閲覧');

insert into role_permissions (role_key, permission_key)
select r.role_key, unnest(r.perms)
from (values
  ('enterprise_admin', array[
    'enterprise.org.manage','enterprise.period.manage','enterprise.metric.manage',
    'enterprise.member.manage','enterprise.data.read','enterprise.data.write',
    'enterprise.data.submit','enterprise.data.review','enterprise.evidence.read',
    'enterprise.evidence.write','enterprise.import.run','enterprise.disclosure.read',
    'enterprise.disclosure.write','enterprise.export.run','enterprise.ai.run',
    'enterprise.grant.manage','enterprise.pbc.respond','common.audit.read']),
  ('sustainability_manager', array[
    'enterprise.period.manage','enterprise.metric.manage','enterprise.data.read',
    'enterprise.data.write','enterprise.data.submit','enterprise.data.review',
    'enterprise.evidence.read','enterprise.evidence.write','enterprise.import.run',
    'enterprise.disclosure.read','enterprise.disclosure.write','enterprise.export.run',
    'enterprise.ai.run','enterprise.grant.manage','enterprise.pbc.respond']),
  ('site_contributor', array[
    'enterprise.data.read','enterprise.data.write','enterprise.data.submit',
    'enterprise.evidence.read','enterprise.evidence.write','enterprise.import.run',
    'enterprise.pbc.respond']),
  ('supplier_contributor', array[
    'enterprise.data.read','enterprise.data.write','enterprise.data.submit',
    'enterprise.evidence.write']),
  ('reviewer', array[
    'enterprise.data.read','enterprise.data.review','enterprise.evidence.read',
    'enterprise.disclosure.read','enterprise.disclosure.write']),
  ('approver', array[
    'enterprise.data.read','enterprise.data.review','enterprise.data.approve',
    'enterprise.evidence.read','enterprise.disclosure.read','enterprise.disclosure.approve',
    'enterprise.export.run']),
  ('external_advisor', array[
    'enterprise.data.read','enterprise.evidence.read','enterprise.disclosure.read']),
  ('viewer', array[
    'enterprise.data.read','enterprise.evidence.read','enterprise.disclosure.read']),
  ('assurance_admin', array[
    'assurance.firm.manage','common.audit.read']),
  ('engagement_partner', array[
    'assurance.engagement.manage','assurance.engagement.read','assurance.scope.manage',
    'assurance.snapshot.create','assurance.population.manage','assurance.sampling.run',
    'assurance.testing.write','assurance.pbc.manage','assurance.issue.manage',
    'assurance.review.write','assurance.signoff.reviewed','assurance.signoff.partner',
    'assurance.export.run','assurance.ai.run','common.audit.read']),
  ('assurance_manager', array[
    'assurance.engagement.manage','assurance.engagement.read','assurance.scope.manage',
    'assurance.snapshot.create','assurance.population.manage','assurance.sampling.run',
    'assurance.testing.write','assurance.pbc.manage','assurance.issue.manage',
    'assurance.review.write','assurance.signoff.prepared','assurance.signoff.reviewed',
    'assurance.export.run','assurance.ai.run','common.audit.read']),
  ('assurance_staff', array[
    'assurance.engagement.read','assurance.population.manage','assurance.sampling.run',
    'assurance.testing.write','assurance.pbc.manage','assurance.issue.manage',
    'assurance.signoff.prepared','assurance.ai.run']),
  ('specialist', array[
    'assurance.engagement.read','assurance.testing.write','assurance.ai.run']),
  ('assurance_viewer', array[
    'assurance.engagement.read']),
  ('platform_admin', array[
    'common.audit.read'])
) as r(role_key, perms);
