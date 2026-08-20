-- ======================================================================
-- 0003 Organization / Period / Master（指示書 10.2）
-- ======================================================================

create table organization_units (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  parent_id uuid references organization_units (id) on delete set null,
  code text not null,
  name text not null,
  unit_type text not null
    check (unit_type in ('headquarters', 'division', 'site', 'subsidiary', 'supplier')),
  country_code text not null default 'JP',
  currency_code text not null default 'JPY',
  timezone text not null default 'Asia/Tokyo',
  consolidation_method text not null default 'full'
    check (consolidation_method in ('full', 'proportionate', 'equity', 'excluded')),
  ownership_percent numeric(6, 3) not null default 100
    check (ownership_percent >= 0 and ownership_percent <= 100),
  exclusion_reason text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  deleted_at timestamptz,
  constraint organization_units_code_unique unique (organization_id, code)
);

create index organization_units_org_idx on organization_units (organization_id, sort_order);

create table reporting_periods (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  code text not null,
  label text not null,
  start_date date not null,
  end_date date not null,
  status text not null default 'planning'
    check (status in ('planning', 'collecting', 'reviewing', 'closed')),
  submission_due_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  constraint reporting_periods_code_unique unique (organization_id, code),
  constraint reporting_periods_range check (end_date > start_date)
);

create table collection_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  reporting_period_id uuid not null references reporting_periods (id) on delete cascade,
  name text not null,
  status text not null default 'draft' check (status in ('draft', 'open', 'closed')),
  due_date date not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id)
);

create table metric_definitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  code text not null,
  name text not null,
  description text not null default '',
  category text not null
    check (category in ('ghg', 'energy', 'water', 'waste', 'human_capital', 'governance')),
  unit text not null,
  base_unit text not null,
  data_type text not null check (data_type in ('number', 'integer', 'ratio', 'text', 'boolean')),
  aggregation_method text not null
    check (aggregation_method in ('sum', 'average', 'weighted_average', 'ratio', 'latest', 'none')),
  numerator_metric_code text,
  denominator_metric_code text,
  formula text,
  requires_evidence boolean not null default false,
  materiality text not null default 'medium' check (materiality in ('high', 'medium', 'low')),
  reporting_frequency text not null default 'annual'
    check (reporting_frequency in ('annual', 'quarterly', 'monthly')),
  responsible_department text,
  yoy_warning_ratio numeric(6, 3),
  min_value numeric,
  max_value numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  deleted_at timestamptz,
  constraint metric_definitions_code_unique unique (organization_id, code)
);

create table campaign_scopes (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references collection_campaigns (id) on delete cascade,
  unit_id uuid not null references organization_units (id) on delete cascade,
  metric_id uuid not null references metric_definitions (id) on delete cascade,
  owner_user_id uuid references profiles (id),
  due_date date not null,
  constraint campaign_scopes_unique unique (campaign_id, unit_id, metric_id)
);

create table metric_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  metric_id uuid not null references metric_definitions (id) on delete cascade,
  unit_id uuid not null references organization_units (id) on delete cascade,
  reporting_period_id uuid not null references reporting_periods (id) on delete cascade,
  owner_user_id uuid references profiles (id),
  reviewer_user_id uuid references profiles (id),
  due_date date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  constraint metric_assignments_unique unique (metric_id, unit_id, reporting_period_id)
);

create table emission_factors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  code text not null,
  name text not null,
  category text not null,
  factor_value numeric not null,
  factor_unit text not null,
  activity_unit text not null,
  factor_year integer not null,
  -- Fixture 由来の架空値である旨を必ず保持する
  factor_source text not null,
  created_at timestamptz not null default now(),
  constraint emission_factors_code_unique unique (organization_id, code, factor_year)
);

create trigger organization_units_set_updated_at
  before update on organization_units
  for each row execute function t4d.set_updated_at();
create trigger reporting_periods_set_updated_at
  before update on reporting_periods
  for each row execute function t4d.set_updated_at();
create trigger collection_campaigns_set_updated_at
  before update on collection_campaigns
  for each row execute function t4d.set_updated_at();
create trigger metric_definitions_set_updated_at
  before update on metric_definitions
  for each row execute function t4d.set_updated_at();
create trigger metric_assignments_set_updated_at
  before update on metric_assignments
  for each row execute function t4d.set_updated_at();
