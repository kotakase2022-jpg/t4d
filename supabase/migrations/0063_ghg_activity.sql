-- ----------------------------------------------------------------------
-- 活動量（電力・燃料・ガス・熱・輸送実績。月次・拠点ごと）（2026-10-16 の要望 ①②。CR-05）
--
-- 1. t4d.all_units_in_scope(org, units[]): 拠点の配列がすべて利用者の担当拠点か（算定の記録の INSERT で使う）。
-- 2. ghg_activity_batches: 取込のまとまり。拠点スコープ（t4d.unit_in_scope）・enterprise.data.write。
--    UPDATE は状態の遷移だけ（draft → confirmed／discarded、confirmed → superseded）。確定は本人名義。
--    確定したバッチが supersedes_batch_id で指す確定済みのバッチは、確定と同時に superseded にする（トリガ）。
-- 3. ghg_activity_lines: 行（追記専用・forbid_mutation）。利用者の INSERT はバッチが draft のときだけ。
--    輸送の行は 重量×距離 か t·km（燃料法なら燃料の量と単位）のどちらかを持つ。最大積載量は kg、積載率は %。
--
-- ロールバック: 表・関数は残して使わなくする（DROP しない）。docs/known-limitations.md §6。
-- ----------------------------------------------------------------------

create or replace function t4d.all_units_in_scope(p_organization_id uuid, p_unit_ids uuid[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(bool_and(t4d.unit_in_scope(p_organization_id, u)), true)
    from unnest(coalesce(p_unit_ids, '{}'::uuid[])) as u;
$$;

comment on function t4d.all_units_in_scope(uuid, uuid[]) is
  '拠点の配列がすべて利用者の担当拠点か（空配列は true）。';

create table ghg_activity_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  reporting_period_id uuid not null,
  unit_id uuid not null,
  kind text not null check (kind in ('energy', 'transport')),
  source text not null default 'upload' check (source in ('upload', 'manual', 'fixture')),
  file_name text not null default '' check (length(file_name) <= 255),
  file_sha256 text check (file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$'),
  row_count integer not null default 0 check (row_count >= 0),
  status text not null default 'draft'
    check (status in ('draft', 'confirmed', 'superseded', 'discarded')),
  confirmed_by uuid references profiles (id),
  confirmed_at timestamptz,
  supersedes_batch_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_at timestamptz not null default now(),

  constraint ghg_activity_batches_period_matches
    foreign key (reporting_period_id, organization_id)
    references reporting_periods (id, organization_id) on delete restrict,
  constraint ghg_activity_batches_unit_matches
    foreign key (unit_id, organization_id)
    references organization_units (id, organization_id) on delete restrict,
  constraint ghg_activity_batches_id_org_unique unique (id, organization_id),
  constraint ghg_activity_batches_supersedes_matches
    foreign key (supersedes_batch_id, organization_id)
    references ghg_activity_batches (id, organization_id) on delete restrict,
  constraint ghg_activity_batches_confirm_pair
    check ((confirmed_by is null) = (confirmed_at is null)),
  constraint ghg_activity_batches_confirmed_has_record
    check (status in ('draft', 'discarded') or confirmed_at is not null)
);

create index ghg_activity_batches_period_unit_idx
  on ghg_activity_batches (organization_id, reporting_period_id, unit_id, status);

comment on table ghg_activity_batches is
  '活動量の取込のまとまり。確定後は行を変えない。差し替えは新しいバッチ（supersedes_batch_id）。';

create trigger ghg_activity_batches_set_updated_at
  before update on ghg_activity_batches
  for each row execute function t4d.set_updated_at();

create or replace function t4d.ghg_activity_batch_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fixed text[] := array['status', 'confirmed_by', 'confirmed_at', 'updated_at'];
  v_prev ghg_activity_batches%rowtype;
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.created_by := auth.uid();
      if new.status <> 'draft' then
        raise exception 'T4D_BATCH_STATE: 活動量のバッチは下書きとして作ってから確定します'
          using errcode = '23514';
      end if;
    end if;
    if new.supersedes_batch_id is not null then
      select * into v_prev from ghg_activity_batches where id = new.supersedes_batch_id;
      if not found or v_prev.unit_id <> new.unit_id
         or v_prev.reporting_period_id <> new.reporting_period_id or v_prev.kind <> new.kind then
        raise exception 'T4D_BATCH_SUPERSEDES: 差し替えられるのは同じ拠点・期間・種類のバッチだけです'
          using errcode = '23514';
      end if;
    end if;
    return new;
  end if;
  if (to_jsonb(new) - v_fixed) is distinct from (to_jsonb(old) - v_fixed) then
    raise exception 'T4D_IMMUTABLE: 活動量のバッチは状態の遷移だけを記録します'
      using errcode = '42501';
  end if;
  if new.status = old.status then
    if new.confirmed_by is distinct from old.confirmed_by or new.confirmed_at is distinct from old.confirmed_at then
      raise exception 'T4D_IMMUTABLE: 確定の記録は変更できません'
        using errcode = '42501';
    end if;
    return new;
  end if;
  if old.status = 'draft' and new.status = 'confirmed' then
    if auth.uid() is not null and new.confirmed_by is distinct from auth.uid() then
      raise exception 'T4D_ACTOR_MUST_BE_SELF: 確定は本人の名義で記録します'
        using errcode = '42501';
    end if;
    return new;
  end if;
  if old.status = 'draft' and new.status = 'discarded' then
    if new.confirmed_by is not null then
      raise exception 'T4D_BATCH_STATE: 破棄したバッチに確定の記録は付けません'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if old.status = 'confirmed' and new.status = 'superseded' then
    if new.confirmed_by is distinct from old.confirmed_by or new.confirmed_at is distinct from old.confirmed_at then
      raise exception 'T4D_IMMUTABLE: 確定の記録は変更できません'
        using errcode = '42501';
    end if;
    if not exists (
      select 1 from ghg_activity_batches b
       where b.supersedes_batch_id = old.id and b.status = 'confirmed'
    ) then
      raise exception 'T4D_BATCH_STATE: 差し替える確定済みのバッチがありません'
        using errcode = '23514';
    end if;
    return new;
  end if;
  raise exception 'T4D_BATCH_STATE: 活動量のバッチの状態は 下書き → 確定／破棄、確定 → 差し替え済み にだけ進みます'
    using errcode = '23514';
end;
$$;

create trigger ghg_activity_batches_guard
  before insert or update on ghg_activity_batches
  for each row execute function t4d.ghg_activity_batch_guard();

-- 確定したら、差し替え元の確定済みのバッチを差し替え済みにする
create or replace function t4d.ghg_activity_batch_supersede()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'confirmed' and old.status = 'draft' and new.supersedes_batch_id is not null then
    update ghg_activity_batches
       set status = 'superseded'
     where id = new.supersedes_batch_id
       and status = 'confirmed';
  end if;
  return new;
end;
$$;

create trigger ghg_activity_batches_supersede
  after update on ghg_activity_batches
  for each row execute function t4d.ghg_activity_batch_supersede();

alter table ghg_activity_batches enable row level security;

create policy ghg_activity_batches_select on ghg_activity_batches for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy ghg_activity_batches_insert on ghg_activity_batches for insert to authenticated
  with check (
    t4d.has_permission(organization_id, 'enterprise.data.write')
    and t4d.unit_in_scope(organization_id, unit_id)
  );
create policy ghg_activity_batches_update on ghg_activity_batches for update to authenticated
  using (
    t4d.has_permission(organization_id, 'enterprise.data.write')
    and t4d.unit_in_scope(organization_id, unit_id)
  )
  with check (
    t4d.has_permission(organization_id, 'enterprise.data.write')
    and t4d.unit_in_scope(organization_id, unit_id)
  );

-- ----------------------------------------------------------------------
-- 活動量の行
-- ----------------------------------------------------------------------

create table ghg_activity_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  batch_id uuid not null,
  line_no integer not null check (line_no > 0),
  month date not null check (extract(day from month) = 1),
  activity_kind text not null check (activity_kind in ('fuel', 'electricity', 'gas', 'heat', 'transport')),
  activity_code text not null check (btrim(activity_code) <> '' and length(activity_code) <= 60),
  amount numeric check (amount is null or amount >= 0),
  unit text check (unit is null or length(unit) <= 20),
  contract_code text check (contract_code is null or length(contract_code) <= 40),
  shipment_ref text check (shipment_ref is null or length(shipment_ref) <= 60),
  cargo_weight_t numeric check (cargo_weight_t is null or cargo_weight_t > 0),
  distance_km numeric check (distance_km is null or distance_km > 0),
  ton_km numeric check (ton_km is null or ton_km > 0),
  fuel_code text check (fuel_code is null or length(fuel_code) <= 40),
  max_payload_kg numeric check (max_payload_kg is null or max_payload_kg > 0),
  load_factor_pct numeric check (load_factor_pct is null or load_factor_pct > 0),
  vehicle_use text check (vehicle_use in ('commercial', 'private')),
  fuel_economy_class text check (fuel_economy_class in ('y2025', 'y2022', 'y2015', 'unverified')),
  carrier_kind text check (carrier_kind in ('own_fleet', 'contracted')),
  cargo_kind text check (cargo_kind is null or length(cargo_kind) <= 40),
  attributes jsonb not null default '{}'::jsonb check (jsonb_typeof(attributes) = 'object'),
  note text not null default '' check (length(note) <= 300),
  created_at timestamptz not null default now(),

  constraint ghg_activity_lines_batch_matches
    foreign key (batch_id, organization_id)
    references ghg_activity_batches (id, organization_id) on delete restrict,
  constraint ghg_activity_lines_line_unique unique (batch_id, line_no),
  constraint ghg_activity_lines_id_org_unique unique (id, organization_id),
  -- 輸送: 重量×距離か t·km（燃料法なら燃料の量と単位）。それ以外: 量と単位
  constraint ghg_activity_lines_amount_present check (
    (activity_kind = 'transport' and (
      ton_km is not null
      or (cargo_weight_t is not null and distance_km is not null)
      or (amount is not null and unit is not null)
    ))
    or (activity_kind <> 'transport' and amount is not null and unit is not null)
  )
);

comment on table ghg_activity_lines is
  '活動量の行（追記専用）。最大積載量は kg、積載率は %（不明なら null。見なし積載率の原単位表で算定）。';

create or replace function t4d.ghg_activity_line_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  -- 利用者の書込では、行を足せるのは下書きのバッチだけ（確定後は不変）
  if auth.uid() is not null then
    select status into v_status from ghg_activity_batches
     where id = new.batch_id and organization_id = new.organization_id;
    if v_status is distinct from 'draft' then
      raise exception 'T4D_IMMUTABLE: 確定・破棄したバッチには行を足せません'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger ghg_activity_lines_guard
  before insert on ghg_activity_lines
  for each row execute function t4d.ghg_activity_line_guard();

create trigger ghg_activity_lines_immutable
  before update or delete on ghg_activity_lines
  for each row execute function t4d.forbid_mutation();

alter table ghg_activity_lines enable row level security;

create policy ghg_activity_lines_select on ghg_activity_lines for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy ghg_activity_lines_insert on ghg_activity_lines for insert to authenticated
  with check (
    t4d.has_permission(organization_id, 'enterprise.data.write')
    and exists (
      select 1 from ghg_activity_batches b
       where b.id = batch_id
         and b.organization_id = ghg_activity_lines.organization_id
         and b.status = 'draft'
         and t4d.unit_in_scope(b.organization_id, b.unit_id)
    )
  );
