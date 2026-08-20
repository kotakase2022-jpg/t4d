-- ======================================================================
-- 0004 Data（指示書 10.3）
-- ======================================================================

create table data_points (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  metric_id uuid not null references metric_definitions (id) on delete restrict,
  unit_id uuid not null references organization_units (id) on delete restrict,
  reporting_period_id uuid not null references reporting_periods (id) on delete restrict,
  boundary text not null default '連結',
  status text not null default 'not_started'
    check (status in ('not_started', 'draft', 'submitted', 'in_review', 'returned', 'approved')),
  current_version_id uuid,
  value numeric,
  text_value text,
  unit_of_measure text not null,
  methodology text,
  owner_user_id uuid references profiles (id),
  reviewer_user_id uuid references profiles (id),
  approved_at timestamptz,
  approved_by uuid references profiles (id),
  changed_after_approval boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  deleted_at timestamptz,
  -- 業務キー: 同一の 組織×指標×拠点×期間×境界 は 1 行のみ（指示書 10 章 Unique 例）
  constraint data_points_business_key
    unique (organization_id, metric_id, unit_id, reporting_period_id, boundary),
  constraint data_points_approved_requires_actor
    check ((status <> 'approved') or (approved_by is not null and approved_at is not null))
);

create index data_points_period_idx on data_points (organization_id, reporting_period_id, status);
create index data_points_unit_idx on data_points (unit_id);
create index data_points_metric_idx on data_points (metric_id);

create table data_point_versions (
  id uuid primary key default gen_random_uuid(),
  data_point_id uuid not null references data_points (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  version_no integer not null check (version_no > 0),
  value numeric,
  text_value text,
  unit_of_measure text not null,
  status text not null,
  source_type text not null
    check (source_type in ('manual', 'import', 'calculation', 'carry_forward')),
  source_reference text,
  change_reason text,
  content_hash text not null,
  created_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  constraint data_point_versions_unique unique (data_point_id, version_no)
);

create index data_point_versions_dp_idx on data_point_versions (data_point_id, version_no desc);

alter table data_points
  add constraint data_points_current_version_fk
  foreign key (current_version_id) references data_point_versions (id) deferrable initially deferred;

create table data_point_calculations (
  id uuid primary key default gen_random_uuid(),
  data_point_id uuid not null references data_points (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  formula text not null,
  inputs jsonb not null default '[]'::jsonb,
  result numeric not null,
  result_unit text not null,
  calculated_at timestamptz not null default now(),
  calculated_by uuid references profiles (id)
);

create table data_point_validation_results (
  id uuid primary key default gen_random_uuid(),
  data_point_id uuid not null references data_points (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  rule_key text not null,
  severity text not null check (severity in ('error', 'warning', 'info')),
  message text not null,
  details jsonb not null default '{}'::jsonb,
  detected_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index data_point_validation_results_dp_idx
  on data_point_validation_results (data_point_id, severity);

create table aggregation_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  metric_id uuid not null references metric_definitions (id) on delete cascade,
  method text not null
    check (method in ('sum', 'average', 'weighted_average', 'ratio', 'latest', 'none')),
  include_unit_types text[] not null default '{}',
  apply_ownership_percent boolean not null default false,
  eliminate_intercompany boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  constraint aggregation_rules_unique unique (organization_id, metric_id)
);

create table aggregation_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  reporting_period_id uuid not null references reporting_periods (id) on delete cascade,
  metric_id uuid not null references metric_definitions (id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed')),
  result_value numeric,
  result_unit text,
  contributing_data_point_ids uuid[] not null default '{}',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error_message text
);

create trigger data_points_set_updated_at
  before update on data_points
  for each row execute function t4d.set_updated_at();
create trigger aggregation_rules_set_updated_at
  before update on aggregation_rules
  for each row execute function t4d.set_updated_at();
