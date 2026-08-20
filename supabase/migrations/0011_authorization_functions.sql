-- ======================================================================
-- 0011 認可ヘルパー関数
-- ----------------------------------------------------------------------
-- すべて SECURITY DEFINER。RLS ポリシー内から membership 等を引くため、
-- 参照先テーブルの RLS を再帰的に評価させないことが目的。
-- search_path を固定し、検索パス汚染による権限昇格を防ぐ。
-- ======================================================================

create or replace function t4d.current_user_id()
returns uuid
language sql
stable
as $$
  select auth.uid();
$$;

create or replace function t4d.is_org_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from organization_memberships m
    where m.organization_id = p_organization_id
      and m.user_id = auth.uid()
      and m.status = 'active'
  );
$$;

create or replace function t4d.has_permission(p_organization_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from organization_memberships m
    join membership_roles mr on mr.membership_id = m.id
    join role_permissions rp on rp.role_key = mr.role_key
    where m.organization_id = p_organization_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and rp.permission_key = p_permission
  );
$$;

-- 企業側 Unit スコープ。空配列 = 全社スコープ。
create or replace function t4d.unit_in_scope(p_organization_id uuid, p_unit_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from organization_memberships m
    where m.organization_id = p_organization_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and (cardinality(m.unit_scope_ids) = 0 or p_unit_id = any (m.unit_scope_ids))
  );
$$;

-- 監査法人: その案件の Engagement Member であるか。
-- assurance_admin であっても、メンバーでなければ false（指示書 6.4 / 11-6）。
create or replace function t4d.is_engagement_member(p_engagement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from engagement_members em
    where em.engagement_id = p_engagement_id
      and em.user_id = auth.uid()
      and em.removed_at is null
  );
$$;

-- 企業側: 自社がクライアントである案件か。
create or replace function t4d.is_engagement_client(p_engagement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from engagements e
    join organization_memberships m
      on m.organization_id = e.client_organization_id
    where e.id = p_engagement_id
      and m.user_id = auth.uid()
      and m.status = 'active'
  );
$$;

-- 案件に対して有効な（取消されていない）許諾が存在するか。
create or replace function t4d.grant_exists(
  p_engagement_id uuid,
  p_subject_type text,
  p_subject_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from client_access_grants g
    where g.engagement_id = p_engagement_id
      and g.subject_type = p_subject_type
      and g.subject_id = p_subject_id
      and g.revoked_at is null
  );
$$;

-- Data Point が「いずれかのアサイン済み案件の許諾範囲内」かどうか。
-- 指標・組織・期間の 3 つすべてが許諾されており、かつ企業側で承認済みであることを要求する。
create or replace function t4d.assurance_can_read_data_point(p_data_point_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from data_points dp
    join engagements e
      on e.client_organization_id = dp.organization_id
    join engagement_members em
      on em.engagement_id = e.id
     and em.user_id = auth.uid()
     and em.removed_at is null
    where dp.id = p_data_point_id
      and dp.status = 'approved'
      and dp.deleted_at is null
      and t4d.grant_exists(e.id, 'metric', dp.metric_id)
      and t4d.grant_exists(e.id, 'organization_unit', dp.unit_id)
      and t4d.grant_exists(e.id, 'reporting_period', dp.reporting_period_id)
  );
$$;

comment on function t4d.assurance_can_read_data_point(uuid) is
  '監査法人ユーザーが Data Point を閲覧できるか。Engagement Member かつ 指標／組織／期間 すべての許諾が有効で、企業側承認済みであることを要求する。';

-- Evidence（file_version）を監査法人が読めるか。
-- 許諾された Data Point に紐付いており、かつ Evidence を含む許諾であること。
create or replace function t4d.assurance_can_read_file_version(p_file_version_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from evidence_links el
    join data_points dp on dp.id = el.target_id and el.target_type = 'data_point'
    join engagements e on e.client_organization_id = dp.organization_id
    join engagement_members em
      on em.engagement_id = e.id
     and em.user_id = auth.uid()
     and em.removed_at is null
    join client_access_grants g
      on g.engagement_id = e.id
     and g.subject_type = 'metric'
     and g.subject_id = dp.metric_id
     and g.revoked_at is null
     and g.includes_evidence = true
    where el.file_version_id = p_file_version_id
      and dp.status = 'approved'
      and t4d.grant_exists(e.id, 'organization_unit', dp.unit_id)
      and t4d.grant_exists(e.id, 'reporting_period', dp.reporting_period_id)
  );
$$;

-- 監査法人テナントに属し、かつ当該案件のメンバーである（調書系テーブルの共通条件）。
create or replace function t4d.can_write_engagement_workpaper(
  p_engagement_id uuid,
  p_assurance_firm_id uuid,
  p_permission text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t4d.is_engagement_member(p_engagement_id)
     and t4d.has_permission(p_assurance_firm_id, p_permission);
$$;

-- Service Role 以外からの実行を制限したい処理向け。
create or replace function t4d.is_service_role()
returns boolean
language sql
stable
as $$
  select coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '') = 'service_role';
$$;
