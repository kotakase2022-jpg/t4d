-- ----------------------------------------------------------------------
-- 算定の記録と算定行（2026-10-16 の要望 ①②③。CR-08）
--
-- 1. ghg_calculation_runs: 算定の記録（追記専用）。期間・拠点・方針・係数のセット・区分規則・活動量のバッチ・
--    入力ハッシュ・エンジンの版・要約（拠点×区分×見方〔報告・既定〕の未丸め・丸め後・再分類分・警告件数）。
--    INSERT は enterprise.data.write かつ拠点がすべて担当拠点（t4d.all_units_in_scope）。作成者は本人（トリガ）。
-- 2. ghg_calculation_lines: 算定行（追記専用）。各段の値（活動量→換算後・換算の段・係数のスナップショット・
--    解決の経路・方法の詳細・未丸め・丸め後・既定区分・報告区分・警告）。44 拠点・月次で数万行になりうるため
--    別表にする（JSONB にまとめない）。INSERT は記録の作成者本人のときだけ。
--
-- 算定は Data Point を直接確定しない（下書きの版として積み、既存の承認フローで確定する。plan K4）。
-- ロールバック: 表は残して使わなくする（DROP しない）。docs/known-limitations.md §6。
-- ----------------------------------------------------------------------

create table ghg_calculation_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  reporting_period_id uuid not null,
  unit_ids uuid[] not null check (cardinality(unit_ids) between 1 and 1000),
  policy_id uuid not null,
  factor_set_ids uuid[] not null default '{}',
  rule_ids uuid[] not null default '{}',
  activity_batch_ids uuid[] not null default '{}',
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  engine_version text not null check (btrim(engine_version) <> '' and length(engine_version) <= 60),
  summary jsonb not null check (jsonb_typeof(summary) = 'object'),
  line_count integer not null check (line_count >= 0),
  created_at timestamptz not null default now(),
  created_by uuid not null references profiles (id),

  constraint ghg_calculation_runs_period_matches
    foreign key (reporting_period_id, organization_id)
    references reporting_periods (id, organization_id) on delete restrict,
  constraint ghg_calculation_runs_policy_matches
    foreign key (policy_id, organization_id)
    references ghg_calculation_policies (id, organization_id) on delete restrict,
  constraint ghg_calculation_runs_id_org_unique unique (id, organization_id)
);

create index ghg_calculation_runs_period_idx
  on ghg_calculation_runs (organization_id, reporting_period_id, created_at desc);

comment on table ghg_calculation_runs is
  '算定の記録（追記専用）。入力ハッシュとエンジンの版で、同じ入力から同じ結果を確かめる。';

create trigger ghg_calculation_runs_stamp
  before insert on ghg_calculation_runs
  for each row execute function t4d.ghg_stamp_created_by();

create trigger ghg_calculation_runs_immutable
  before update or delete on ghg_calculation_runs
  for each row execute function t4d.forbid_mutation();

alter table ghg_calculation_runs enable row level security;

create policy ghg_calculation_runs_select on ghg_calculation_runs for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy ghg_calculation_runs_insert on ghg_calculation_runs for insert to authenticated
  with check (
    t4d.has_permission(organization_id, 'enterprise.data.write')
    and t4d.all_units_in_scope(organization_id, unit_ids)
  );

create table ghg_calculation_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  run_id uuid not null,
  unit_id uuid not null,
  month date not null,
  activity_line_id uuid not null,
  activity_kind text not null check (activity_kind in ('fuel', 'electricity', 'gas', 'heat', 'transport')),
  activity_code text not null,
  method text not null check (method in (
    'fuel_combustion', 'electricity_location', 'electricity_market', 'tonkm_improved', 'fuel_method'
  )),
  activity_amount numeric not null,
  activity_unit text not null,
  converted_amount numeric not null,
  converted_unit text not null,
  conversion_steps jsonb not null default '[]'::jsonb check (jsonb_typeof(conversion_steps) = 'array'),
  factor_id uuid not null,
  factor_value numeric not null,
  factor_unit text not null,
  factor_year integer not null,
  factor_set_code text not null,
  factor_set_version text not null,
  resolution_path text not null,
  method_detail jsonb not null default '{}'::jsonb check (jsonb_typeof(method_detail) = 'object'),
  emissions_unrounded numeric not null,
  emissions_rounded numeric not null,
  rounding_applied jsonb check (rounding_applied is null or jsonb_typeof(rounding_applied) = 'object'),
  protocol_scope text not null check (protocol_scope in ('scope1', 'scope2', 'scope2_location', 'scope3_cat4')),
  reported_scope text not null check (reported_scope in ('scope1', 'scope2', 'scope2_location', 'scope3_cat4')),
  classification_rule_id uuid,
  warnings text[] not null default '{}',
  created_at timestamptz not null default now(),

  constraint ghg_calculation_lines_run_matches
    foreign key (run_id, organization_id)
    references ghg_calculation_runs (id, organization_id) on delete restrict,
  constraint ghg_calculation_lines_unit_matches
    foreign key (unit_id, organization_id)
    references organization_units (id, organization_id) on delete restrict,
  constraint ghg_calculation_lines_activity_matches
    foreign key (activity_line_id, organization_id)
    references ghg_activity_lines (id, organization_id) on delete restrict,
  constraint ghg_calculation_lines_factor_matches
    foreign key (factor_id, organization_id)
    references emission_factors (id, organization_id) on delete restrict,
  constraint ghg_calculation_lines_rule_matches
    foreign key (classification_rule_id, organization_id)
    references ghg_classification_rules (id, organization_id) on delete restrict
);

create index ghg_calculation_lines_run_idx on ghg_calculation_lines (run_id, unit_id, month);

comment on table ghg_calculation_lines is
  '算定行（追記専用）。各段の値・係数のスナップショット・既定区分と報告区分を残す。';

create trigger ghg_calculation_lines_immutable
  before update or delete on ghg_calculation_lines
  for each row execute function t4d.forbid_mutation();

alter table ghg_calculation_lines enable row level security;

create policy ghg_calculation_lines_select on ghg_calculation_lines for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy ghg_calculation_lines_insert on ghg_calculation_lines for insert to authenticated
  with check (
    t4d.has_permission(organization_id, 'enterprise.data.write')
    and exists (
      select 1 from ghg_calculation_runs r
       where r.id = run_id
         and r.organization_id = ghg_calculation_lines.organization_id
         and r.created_by = auth.uid()
    )
  );
