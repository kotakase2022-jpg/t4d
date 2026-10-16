-- ----------------------------------------------------------------------
-- 算定方針（丸め・換算・改良トンキロ法の組織の設定）と区分規則（2026-10-16 の要望 ②③。CR-03・04・06・07）
--
-- 1. ghg_calculation_policies: 期間ごとの版（追記専用・forbid_mutation）。丸め（段・桁・kg/t・方式）・
--    組織の単位換算（from・to・倍率・出典）・改良トンキロ法の組織の設定（式の形・積載率の下限・100% 超の扱い・
--    最大積載量の範囲と扱い・海外拠点・原単位の丸め）。書けるのは enterprise.metric.manage。
-- 2. ghg_classification_rules: 既定区分（GHG プロトコル）と異なる報告区分にする組織の算定ルール。根拠は必須。
--    提案は enterprise.metric.manage かつ本人名義（proposed_by = auth.uid()）・状態 proposed。
--    UPDATE は状態の遷移だけ（トリガ）: 承認は enterprise.data.approve かつ本人名義（approved_by = auth.uid()）、
--    取り下げは metric.manage か data.approve。提案者と承認者は別人（CHECK・トリガ・RLS・サービスの 4 重）。
--    内容の変更は「取り下げて新しく提案」。DELETE のポリシーは作らない。
-- 3. t4d.ghg_stamp_created_by(): 利用者の JWT の書込で created_by を auth.uid() に固定する（0062〜0065 の表で使う）。
--
-- ロールバック: 表・関数は残して使わなくする（DROP しない）。docs/known-limitations.md §6。
-- ----------------------------------------------------------------------

create or replace function t4d.ghg_stamp_created_by()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

comment on function t4d.ghg_stamp_created_by() is
  '利用者の JWT の書込で created_by を auth.uid() に固定する（なりすましの作成者を残さない）。';

-- ----------------------------------------------------------------------
-- 算定方針
-- ----------------------------------------------------------------------

create table ghg_calculation_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  reporting_period_id uuid not null,
  version_no integer not null check (version_no > 0),
  rounding jsonb not null default '[]'::jsonb
    check (jsonb_typeof(rounding) = 'array' and jsonb_array_length(rounding) <= 5),
  conversions jsonb not null default '[]'::jsonb
    check (jsonb_typeof(conversions) = 'array' and jsonb_array_length(conversions) <= 50),
  tonkm jsonb not null check (jsonb_typeof(tonkm) = 'object'),
  notes text not null default '' check (length(notes) <= 2000),
  created_at timestamptz not null default now(),
  created_by uuid references profiles (id),

  constraint ghg_calculation_policies_period_matches
    foreign key (reporting_period_id, organization_id)
    references reporting_periods (id, organization_id) on delete restrict,
  constraint ghg_calculation_policies_version_unique
    unique (organization_id, reporting_period_id, version_no),
  constraint ghg_calculation_policies_id_org_unique unique (id, organization_id)
);

comment on table ghg_calculation_policies is
  '算定方針の版（追記専用）。丸め・組織の単位換算・改良トンキロ法の組織の設定。確認できなかった扱いは組織が決める。';

create trigger ghg_calculation_policies_stamp
  before insert on ghg_calculation_policies
  for each row execute function t4d.ghg_stamp_created_by();

create trigger ghg_calculation_policies_immutable
  before update or delete on ghg_calculation_policies
  for each row execute function t4d.forbid_mutation();

alter table ghg_calculation_policies enable row level security;

create policy ghg_calculation_policies_select on ghg_calculation_policies
  for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy ghg_calculation_policies_insert on ghg_calculation_policies
  for insert to authenticated
  with check (t4d.has_permission(organization_id, 'enterprise.metric.manage'));

-- ----------------------------------------------------------------------
-- 区分規則
-- ----------------------------------------------------------------------

create table ghg_classification_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  code text not null check (btrim(code) <> '' and length(code) <= 40),
  name text not null check (btrim(name) <> '' and length(name) <= 200),
  match jsonb not null default '{}'::jsonb check (jsonb_typeof(match) = 'object'),
  protocol_scope text not null
    check (protocol_scope in ('scope1', 'scope2', 'scope2_location', 'scope3_cat4')),
  reported_scope text not null
    check (reported_scope in ('scope1', 'scope2', 'scope2_location', 'scope3_cat4')),
  rationale text not null check (btrim(rationale) <> '' and length(rationale) <= 2000),
  disclosure_note text not null default '' check (length(disclosure_note) <= 2000),
  effective_from_period_id uuid,
  effective_to_period_id uuid,
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'withdrawn')),
  proposed_by uuid not null references profiles (id),
  approved_by uuid references profiles (id),
  approved_at timestamptz,
  withdrawn_by uuid references profiles (id),
  withdrawn_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ghg_classification_rules_from_matches
    foreign key (effective_from_period_id, organization_id)
    references reporting_periods (id, organization_id) on delete restrict,
  constraint ghg_classification_rules_to_matches
    foreign key (effective_to_period_id, organization_id)
    references reporting_periods (id, organization_id) on delete restrict,
  constraint ghg_classification_rules_id_org_unique unique (id, organization_id),
  -- 職務分離: 提案者は承認者になれない
  constraint ghg_classification_rules_sod check (approved_by is distinct from proposed_by),
  constraint ghg_classification_rules_approval_pair
    check ((approved_by is null) = (approved_at is null)),
  constraint ghg_classification_rules_withdrawal_pair
    check ((withdrawn_by is null) = (withdrawn_at is null)),
  constraint ghg_classification_rules_status_consistent check (
    (status = 'proposed' and approved_by is null and withdrawn_by is null)
    or (status = 'approved' and approved_by is not null and withdrawn_by is null)
    or (status = 'withdrawn' and withdrawn_by is not null)
  ),
  constraint ghg_classification_rules_moves check (protocol_scope <> reported_scope)
);

create unique index ghg_classification_rules_code_unique
  on ghg_classification_rules (organization_id, code) where status <> 'withdrawn';

comment on table ghg_classification_rules is
  '区分規則（組織の算定ルール）。既定区分と異なる報告区分にする。根拠必須・提案者≠承認者・内容は変えない（取り下げて新しく提案）。';

create trigger ghg_classification_rules_set_updated_at
  before update on ghg_classification_rules
  for each row execute function t4d.set_updated_at();

create or replace function t4d.ghg_classification_rule_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fixed text[] := array['status', 'approved_by', 'approved_at', 'withdrawn_by', 'withdrawn_at', 'updated_at'];
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null and (new.status <> 'proposed' or new.proposed_by <> auth.uid()) then
      raise exception 'T4D_ACTOR_MUST_BE_SELF: 区分規則は本人の名義で提案します（提案と同時に承認しない）'
        using errcode = '42501';
    end if;
    return new;
  end if;
  -- 内容（条件・区分・根拠・適用期間・提案者）は変えない
  if (to_jsonb(new) - v_fixed) is distinct from (to_jsonb(old) - v_fixed) then
    raise exception 'T4D_IMMUTABLE: 区分規則の内容は変更できません（取り下げて新しく提案してください）'
      using errcode = '42501';
  end if;
  if new.status = old.status then
    if new.approved_by is distinct from old.approved_by or new.withdrawn_by is distinct from old.withdrawn_by
       or new.approved_at is distinct from old.approved_at or new.withdrawn_at is distinct from old.withdrawn_at then
      raise exception 'T4D_RULE_STATE: 承認・取り下げの記録は変更できません'
        using errcode = '42501';
    end if;
    return new;
  end if;
  if old.status = 'proposed' and new.status = 'approved' then
    if auth.uid() is not null and new.approved_by is distinct from auth.uid() then
      raise exception 'T4D_ACTOR_MUST_BE_SELF: 承認は本人の名義で記録します'
        using errcode = '42501';
    end if;
    if new.approved_by = old.proposed_by then
      raise exception 'T4D_RULE_SOD: 提案者は承認できません'
        using errcode = '42501';
    end if;
    return new;
  end if;
  if old.status in ('proposed', 'approved') and new.status = 'withdrawn' then
    if new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at then
      raise exception 'T4D_RULE_STATE: 取り下げで承認の記録は変えません'
        using errcode = '42501';
    end if;
    if auth.uid() is not null and new.withdrawn_by is distinct from auth.uid() then
      raise exception 'T4D_ACTOR_MUST_BE_SELF: 取り下げは本人の名義で記録します'
        using errcode = '42501';
    end if;
    return new;
  end if;
  raise exception 'T4D_RULE_STATE: 区分規則の状態は 提案 → 承認 → 取り下げ の順にだけ進みます'
    using errcode = '23514';
end;
$$;

create trigger ghg_classification_rules_guard
  before insert or update on ghg_classification_rules
  for each row execute function t4d.ghg_classification_rule_guard();

alter table ghg_classification_rules enable row level security;

create policy ghg_classification_rules_select on ghg_classification_rules
  for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy ghg_classification_rules_insert on ghg_classification_rules
  for insert to authenticated
  with check (
    t4d.has_permission(organization_id, 'enterprise.metric.manage')
    and proposed_by = auth.uid()
    and status = 'proposed'
  );
create policy ghg_classification_rules_update on ghg_classification_rules
  for update to authenticated
  using (
    t4d.has_permission(organization_id, 'enterprise.metric.manage')
    or t4d.has_permission(organization_id, 'enterprise.data.approve')
  )
  with check (
    (
      status = 'approved'
      and approved_by = auth.uid()
      and t4d.has_permission(organization_id, 'enterprise.data.approve')
    )
    or (
      status = 'withdrawn'
      and withdrawn_by = auth.uid()
      and (
        t4d.has_permission(organization_id, 'enterprise.metric.manage')
        or t4d.has_permission(organization_id, 'enterprise.data.approve')
      )
    )
  );
