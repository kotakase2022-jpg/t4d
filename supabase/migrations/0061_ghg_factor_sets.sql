-- ----------------------------------------------------------------------
-- 排出係数のセット・係数の列の追加・割当（2026-10-16 の要望 ③。CR-01・02・16）
--
-- 1. emission_factor_sets: 係数のまとまり（組織指定・公的参照・架空〔デモ〕の区別、版・公表日・基準年）。
--    状態は draft → active → retired だけ。active 以降は status・retired_*・notes 以外を変えない（トリガ）。
--    有効化・取り下げは本人名義（activated_by／retired_by = auth.uid()）。DELETE のポリシーは作らない。
-- 2. emission_factors に列を足す（セット・国・基準・活動の種類とコード・ガス・2 段係数・適用期間・params）。
--    一意制約 emission_factors_code_unique を外し、部分一意索引 2 本（セット無し: 組織×コード×年度／
--    セット有り: 組織×セット×コード×年度）に替える（同じコードの複数年度・複数の版を区別して持つ）。
--    for all のポリシーを INSERT／UPDATE／DELETE に分け、セットに属する行は「セットが draft のときだけ」。
--    トリガでも、draft でないセットの係数の UPDATE・DELETE を止める（終了処理の DELETE だけは通す）。
--    セットに属さない既存の行（Scope3 Cat.1 の係数）は従来どおり（docs/known-limitations.md §6）。
-- 3. emission_factor_assignments: 期間 × 拠点／国／全社 × 活動 → 係数。解決は 拠点 ＞ 国 ＞ 全社既定
--    （src/lib/domain/ghg/factor-resolution.ts）。書けるのは enterprise.metric.manage。期間が closed なら拒否。
--    係数は有効（active）なセットの、同じ組織・同じ活動の種類のもの（トリガ）。割当を外す（DELETE）を許す。
-- 4. data_point_calculations に forbid_mutation（算定記録を後から変えない。Demo のリセットは Demo 限定の経路のまま）。
--
-- ロールバック: 表・列・索引は残して使わなくする（DROP しない）。ポリシーと一意制約を戻す SQL は
-- docs/known-limitations.md §6。
-- ----------------------------------------------------------------------

create table emission_factor_sets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  code text not null check (btrim(code) <> '' and length(code) <= 40),
  name text not null check (btrim(name) <> '' and length(name) <= 200),
  origin text not null check (origin in ('customer_specified', 'public_reference', 'fixture')),
  source_label text not null default '' check (length(source_label) <= 500),
  version_label text not null default '' check (length(version_label) <= 100),
  published_on date,
  reference_year integer check (reference_year is null or reference_year between 1990 and 2100),
  status text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  activated_by uuid references profiles (id),
  activated_at timestamptz,
  retired_by uuid references profiles (id),
  retired_at timestamptz,
  notes text not null default '' check (length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),

  constraint emission_factor_sets_code_unique unique (organization_id, code),
  constraint emission_factor_sets_id_org_unique unique (id, organization_id),
  constraint emission_factor_sets_activation_pair
    check ((activated_at is null) = (activated_by is null)),
  constraint emission_factor_sets_retirement_pair
    check ((retired_at is null) = (retired_by is null)),
  constraint emission_factor_sets_status_consistent check (
    (status = 'draft' and activated_at is null and retired_at is null)
    or (status = 'active' and activated_at is not null and retired_at is null)
    or (status = 'retired' and activated_at is not null and retired_at is not null)
  )
);

comment on table emission_factor_sets is
  '排出係数のセット（組織指定・公的参照・架空）。active 以降は係数を変えない（算定の再現性）。';

create trigger emission_factor_sets_set_updated_at
  before update on emission_factor_sets
  for each row execute function t4d.set_updated_at();

create or replace function t4d.emission_factor_set_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.created_by := auth.uid();
      if new.status <> 'draft' then
        raise exception 'T4D_FACTOR_SET_STATE: 係数のセットは下書きとして作ってから有効にします'
          using errcode = '23514';
      end if;
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.organization_id is distinct from old.organization_id
     or new.created_at is distinct from old.created_at
     or new.created_by is distinct from old.created_by then
    raise exception 'T4D_IMMUTABLE: 係数のセットの組織・作成者は変更できません'
      using errcode = '42501';
  end if;

  if old.status = 'draft' then
    if new.status not in ('draft', 'active') then
      raise exception 'T4D_FACTOR_SET_STATE: 下書きのセットは有効にするだけです（取り下げは有効にした後）'
        using errcode = '23514';
    end if;
    if new.status = 'active' and auth.uid() is not null
       and new.activated_by is distinct from auth.uid() then
      raise exception 'T4D_ACTOR_MUST_BE_SELF: 有効化は本人の名義で記録します'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- active・retired: 状態（active → retired だけ）・取り下げの記録・メモ以外を変えない
  if (to_jsonb(new) - array['status', 'retired_by', 'retired_at', 'notes', 'updated_at', 'updated_by'])
     is distinct from
     (to_jsonb(old) - array['status', 'retired_by', 'retired_at', 'notes', 'updated_at', 'updated_by']) then
    raise exception 'T4D_IMMUTABLE: 有効にした係数のセットは変更できません（新しいセットを作ってください）'
      using errcode = '42501';
  end if;
  if old.status = 'retired' and (new.status <> 'retired'
     or new.retired_by is distinct from old.retired_by
     or new.retired_at is distinct from old.retired_at) then
    raise exception 'T4D_FACTOR_SET_STATE: 取り下げたセットは戻せません'
      using errcode = '23514';
  end if;
  if old.status = 'active' and new.status = 'retired' and auth.uid() is not null
     and new.retired_by is distinct from auth.uid() then
    raise exception 'T4D_ACTOR_MUST_BE_SELF: 取り下げは本人の名義で記録します'
      using errcode = '42501';
  end if;
  if old.status = 'active' and new.status not in ('active', 'retired') then
    raise exception 'T4D_FACTOR_SET_STATE: 有効なセットは取り下げるだけです'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger emission_factor_sets_guard
  before insert or update on emission_factor_sets
  for each row execute function t4d.emission_factor_set_guard();

alter table emission_factor_sets enable row level security;

create policy emission_factor_sets_select on emission_factor_sets for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy emission_factor_sets_insert on emission_factor_sets for insert to authenticated
  with check (t4d.has_permission(organization_id, 'enterprise.metric.manage'));
create policy emission_factor_sets_update on emission_factor_sets for update to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.metric.manage'))
  with check (t4d.has_permission(organization_id, 'enterprise.metric.manage'));

-- ----------------------------------------------------------------------
-- 係数の列
-- ----------------------------------------------------------------------

alter table emission_factors
  add column factor_set_id uuid,
  add column country_code text check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  add column region_label text check (region_label is null or length(region_label) <= 100),
  add column basis text check (basis in ('location', 'market')),
  add column activity_kind text
    check (activity_kind in ('fuel', 'electricity', 'gas', 'heat', 'transport_formula', 'transport_default')),
  add column activity_code text
    check (activity_code is null or (btrim(activity_code) <> '' and length(activity_code) <= 60)),
  add column gas text not null default 'co2e' check (gas in ('co2e', 'co2')),
  add column calorific_value numeric check (calorific_value is null or calorific_value > 0),
  add column calorific_unit text,
  add column carbon_factor numeric check (carbon_factor is null or carbon_factor > 0),
  add column carbon_factor_unit text,
  add column valid_from date,
  add column valid_to date,
  add column params jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object');

alter table emission_factors
  add constraint emission_factors_id_org_unique unique (id, organization_id),
  add constraint emission_factors_set_matches
    foreign key (factor_set_id, organization_id)
    references emission_factor_sets (id, organization_id) on delete restrict,
  add constraint emission_factors_two_stage_pair
    check ((calorific_value is null) = (carbon_factor is null)),
  add constraint emission_factors_valid_order
    check (valid_from is null or valid_to is null or valid_from <= valid_to),
  add constraint emission_factors_set_kind
    check (factor_set_id is null or (activity_kind is not null and activity_code is not null));

alter table emission_factors drop constraint emission_factors_code_unique;
create unique index emission_factors_code_unique_noset
  on emission_factors (organization_id, code, factor_year) where factor_set_id is null;
create unique index emission_factors_code_unique_set
  on emission_factors (organization_id, factor_set_id, code, factor_year) where factor_set_id is not null;

comment on column emission_factors.params is
  '種類ごとの追加の値（改良トンキロ法の式の係数・燃費区分・最大積載量の区間、見なし積載率の原単位表）。コードに固定しない。';

-- セットに属する係数は、セットが下書きのときだけ変えられる（終了処理の DELETE は通す）
create or replace function t4d.emission_factor_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_set_id uuid;
  v_status text;
begin
  if tg_op = 'DELETE' then
    if t4d.is_offboarding_delete(to_jsonb(old)) then
      return old;
    end if;
    v_set_id := old.factor_set_id;
  else
    v_set_id := old.factor_set_id;
    if new.factor_set_id is distinct from old.factor_set_id then
      raise exception 'T4D_IMMUTABLE: 係数のセットは付け替えられません'
        using errcode = '42501';
    end if;
  end if;
  if v_set_id is not null then
    select status into v_status from emission_factor_sets where id = v_set_id;
    if v_status is distinct from 'draft' then
      raise exception 'T4D_IMMUTABLE: 有効にした係数のセットの係数は変更できません'
        using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger emission_factors_guard
  before update or delete on emission_factors
  for each row execute function t4d.emission_factor_guard();

drop policy emission_factors_write on emission_factors;
create policy emission_factors_insert on emission_factors for insert to authenticated
  with check (
    t4d.has_permission(organization_id, 'enterprise.metric.manage')
    and (
      factor_set_id is null
      or exists (
        select 1 from emission_factor_sets s
         where s.id = factor_set_id
           and s.organization_id = emission_factors.organization_id
           and s.status = 'draft'
      )
    )
  );
create policy emission_factors_update on emission_factors for update to authenticated
  using (
    t4d.has_permission(organization_id, 'enterprise.metric.manage')
    and (
      factor_set_id is null
      or exists (
        select 1 from emission_factor_sets s
         where s.id = factor_set_id
           and s.organization_id = emission_factors.organization_id
           and s.status = 'draft'
      )
    )
  )
  with check (t4d.has_permission(organization_id, 'enterprise.metric.manage'));
create policy emission_factors_delete on emission_factors for delete to authenticated
  using (
    t4d.has_permission(organization_id, 'enterprise.metric.manage')
    and (
      factor_set_id is null
      or exists (
        select 1 from emission_factor_sets s
         where s.id = factor_set_id
           and s.organization_id = emission_factors.organization_id
           and s.status = 'draft'
      )
    )
  );

-- ----------------------------------------------------------------------
-- 係数の割当
-- ----------------------------------------------------------------------

create table emission_factor_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  reporting_period_id uuid not null,
  unit_id uuid,
  country_code text check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  activity_kind text not null
    check (activity_kind in ('fuel', 'electricity', 'gas', 'heat', 'transport_formula', 'transport_default')),
  activity_code text not null check (btrim(activity_code) <> '' and length(activity_code) <= 60),
  basis text check (basis in ('location', 'market')),
  factor_id uuid not null,
  reason text not null default '' check (length(reason) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),

  constraint emission_factor_assignments_period_matches
    foreign key (reporting_period_id, organization_id)
    references reporting_periods (id, organization_id) on delete cascade,
  constraint emission_factor_assignments_unit_matches
    foreign key (unit_id, organization_id)
    references organization_units (id, organization_id) on delete cascade,
  constraint emission_factor_assignments_factor_matches
    foreign key (factor_id, organization_id)
    references emission_factors (id, organization_id) on delete restrict,
  constraint emission_factor_assignments_level check (unit_id is null or country_code is null)
);

create unique index emission_factor_assignments_unique on emission_factor_assignments (
  organization_id,
  reporting_period_id,
  coalesce(unit_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(country_code, ''),
  activity_kind,
  activity_code,
  coalesce(basis, '')
);

comment on table emission_factor_assignments is
  '係数の割当（期間 × 拠点／国／全社 × 活動 → 係数）。解決は 拠点 ＞ 国 ＞ 全社既定。代わりを使わない。';

create trigger emission_factor_assignments_set_updated_at
  before update on emission_factor_assignments
  for each row execute function t4d.set_updated_at();

create or replace function t4d.emission_factor_assignment_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_period_status text;
  v_factor emission_factors%rowtype;
  v_set_status text;
begin
  if tg_op = 'DELETE' then
    if t4d.is_offboarding_delete(to_jsonb(old)) then
      return old;
    end if;
    select status into v_period_status from reporting_periods where id = old.reporting_period_id;
    if v_period_status = 'closed' then
      raise exception 'T4D_PERIOD_CLOSED: 締めた期間の係数の割当は変更できません'
        using errcode = '23514';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' and auth.uid() is not null then
    new.created_by := auth.uid();
  end if;
  if tg_op = 'UPDATE' and (new.organization_id is distinct from old.organization_id
     or new.reporting_period_id is distinct from old.reporting_period_id) then
    raise exception 'T4D_IMMUTABLE: 割当の組織・期間は変更できません'
      using errcode = '42501';
  end if;
  select status into v_period_status from reporting_periods where id = new.reporting_period_id;
  if v_period_status = 'closed' then
    raise exception 'T4D_PERIOD_CLOSED: 締めた期間の係数の割当は変更できません'
      using errcode = '23514';
  end if;
  select * into v_factor from emission_factors where id = new.factor_id;
  if not found or v_factor.organization_id <> new.organization_id or v_factor.factor_set_id is null then
    raise exception 'T4D_FACTOR_ASSIGNMENT: 割り当てられるのは係数のセットの係数だけです'
      using errcode = '23514';
  end if;
  select status into v_set_status from emission_factor_sets where id = v_factor.factor_set_id;
  if v_set_status is distinct from 'active' then
    raise exception 'T4D_FACTOR_ASSIGNMENT: 割り当てられるのは有効なセットの係数だけです'
      using errcode = '23514';
  end if;
  if v_factor.activity_kind is distinct from new.activity_kind then
    raise exception 'T4D_FACTOR_ASSIGNMENT: 係数の種類が割当の活動と違います'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger emission_factor_assignments_guard
  before insert or update or delete on emission_factor_assignments
  for each row execute function t4d.emission_factor_assignment_guard();

alter table emission_factor_assignments enable row level security;

create policy emission_factor_assignments_select on emission_factor_assignments
  for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy emission_factor_assignments_insert on emission_factor_assignments
  for insert to authenticated
  with check (t4d.has_permission(organization_id, 'enterprise.metric.manage'));
create policy emission_factor_assignments_update on emission_factor_assignments
  for update to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.metric.manage'))
  with check (t4d.has_permission(organization_id, 'enterprise.metric.manage'));
create policy emission_factor_assignments_delete on emission_factor_assignments
  for delete to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.metric.manage'));

-- 割当を外す（DELETE）は利用者の操作なので、この表だけ DELETE を与える（0014 は既定で DELETE を剥奪している）
grant delete on emission_factor_assignments to authenticated;

-- ----------------------------------------------------------------------
-- 算定記録の不変性
-- ----------------------------------------------------------------------

create trigger data_point_calculations_immutable
  before update or delete on data_point_calculations
  for each row execute function t4d.forbid_mutation();
