-- ----------------------------------------------------------------------
-- 管理: 担当拠点つきの招待・データ取扱条件・過年度確定値の承認経路・返却用のバケット
-- （トライアル対応 2026-10: NF-25・NF-28・NF-29・NF-44）
--
-- 1. invitations.unit_scope_ids: 招待の時点で担当拠点を決め、受諾で organization_memberships.unit_scope_ids へ写す
--    （これまで受諾時は常に全社スコープになっていた）。空配列は全社。
-- 2. organization_data_terms（追記専用）: 合意したデータ取扱条件の版。未合意の項目は空のまま（推測で埋めない）。
-- 3. approval_routes.purpose: 過年度確定値の承認経路を既定の経路と分けて持つ（既定は default）。
-- 4. 返却用の非公開 Storage バケット（tenant-exports-private）。生成はサーバー（Service Role）だけが行い、
--    読み取りは組織の管理者（enterprise.org.manage）の署名 URL だけ（0015 と同じ形）。
-- ロールバック方針は docs/known-limitations.md §6。
-- ----------------------------------------------------------------------

alter table invitations
  add column unit_scope_ids uuid[] not null default '{}';

comment on column invitations.unit_scope_ids is
  '招待で決めた担当拠点。受諾で organization_memberships.unit_scope_ids へ写す。空は全社。';

-- 担当拠点は招待した組織の拠点だけ
create or replace function t4d.invitation_unit_scope_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if cardinality(new.unit_scope_ids) = 0 then
    return new;
  end if;
  if exists (
    select 1 from unnest(new.unit_scope_ids) as u(unit_id)
     where not exists (
       select 1 from organization_units ou
        where ou.id = u.unit_id and ou.organization_id = new.organization_id
     )
  ) then
    raise exception 'T4D_TENANT_SCOPE: 別の組織の拠点は担当拠点にできません'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger invitations_unit_scope_guard
  before insert or update of unit_scope_ids on invitations
  for each row execute function t4d.invitation_unit_scope_guard();

create table organization_data_terms (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  version_no integer not null check (version_no > 0),
  nda_status text not null default 'undecided' check (nda_status in ('signed', 'pending', 'undecided')),
  processing_terms_ref text not null default '',
  storage_location text not null default '',
  retention_policy text not null default '',
  ai_training_use text not null default 'undecided'
    check (ai_training_use in ('not_allowed', 'allowed', 'undecided')),
  ai_provider_storage text not null default 'undecided'
    check (ai_provider_storage in ('none', 'provider_default', 'undecided')),
  /** 再委託先（名称・役割・所在地）。空配列は未合意 */
  subprocessors jsonb not null default '[]'::jsonb check (jsonb_typeof(subprocessors) = 'array'),
  return_method text not null default '',
  deletion_method text not null default '',
  agreed_on date,
  agreed_by_label text not null default '',
  note text not null default '' check (length(note) <= 2000),
  created_by uuid not null references profiles (id),
  created_at timestamptz not null default now(),
  constraint organization_data_terms_unique unique (organization_id, version_no)
);

comment on table organization_data_terms is
  '合意したデータ取扱条件の版（追記専用）。空の項目・undecided は「未合意」として表示する（推測で埋めない）。';

create trigger organization_data_terms_immutable
  before update or delete on organization_data_terms
  for each row execute function t4d.forbid_mutation();

alter table approval_routes
  add column purpose text not null default 'default' check (purpose in ('default', 'prior_year_final'));

comment on column approval_routes.purpose is
  '経路の用途。default＝通常のデータ、prior_year_final＝過年度確定値の登録（既定 1 段階）。';

alter table organization_data_terms enable row level security;

create policy organization_data_terms_select on organization_data_terms for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy organization_data_terms_insert on organization_data_terms for insert to authenticated
  with check (
    created_by = auth.uid()
    and t4d.has_permission(organization_id, 'enterprise.org.manage')
  );

-- ----------------------------------------------------------------------
-- 返却用の非公開バケット（storage スキーマの無い環境では何もしない。0015 と同じ）
-- ----------------------------------------------------------------------

do $$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'T4D: storage スキーマが存在しないため返却用バケットをスキップしました。';
    return;
  end if;

  insert into storage.buckets (id, name, public)
  values ('tenant-exports-private', 'tenant-exports-private', false)
  on conflict (id) do update set public = false;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 't4d_tenant_exports_read_admin'
  ) then
    -- 読み取りは組織の管理者だけ（パスの 2 番目のセグメントが組織 ID）。書込ポリシーは作らない（Service Role が生成）
    execute $pol$
      create policy "t4d_tenant_exports_read_admin" on storage.objects
        for select to authenticated
        using (
          bucket_id = 'tenant-exports-private'
          and array_length(string_to_array(name, '/'), 1) >= 3
          and t4d.has_permission((string_to_array(name, '/'))[2]::uuid, 'enterprise.org.manage')
        );
    $pol$;
  end if;
end
$$;
