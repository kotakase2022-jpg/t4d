-- ======================================================================
-- 0007 Disclosure（指示書 10.6）
-- ----------------------------------------------------------------------
-- フレームワーク（CDP / SSBJ 等）はテナント横断のマスターとして持ち、
-- 回答（disclosure_responses）だけがテナントデータになる。
-- ======================================================================

create table disclosure_frameworks (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key in ('cdp', 'ssbj', 'msci', 'ftse')),
  name text not null,
  description text not null default ''
);

create table disclosure_framework_versions (
  id uuid primary key default gen_random_uuid(),
  framework_id uuid not null references disclosure_frameworks (id) on delete cascade,
  year integer not null,
  label text not null,
  status text not null default 'draft' check (status in ('draft', 'published', 'superseded')),
  -- 正式マスター未入手のため架空データである旨を UI へ必ず出す
  is_fixture boolean not null default true,
  created_at timestamptz not null default now(),
  constraint disclosure_framework_versions_unique unique (framework_id, year)
);

create table disclosure_items (
  id uuid primary key default gen_random_uuid(),
  framework_version_id uuid not null
    references disclosure_framework_versions (id) on delete cascade,
  code text not null,
  section text not null,
  sort_order integer not null default 0,
  question_text text not null,
  guidance text not null default '',
  answer_type text not null
    check (answer_type in ('text', 'numeric', 'single_choice', 'multi_choice', 'table')),
  options text[] not null default '{}',
  required boolean not null default false,
  parent_code text,
  change_type text not null default 'carry_forward'
    check (change_type in ('new', 'changed', 'carry_forward', 'retired')),
  previous_item_code text,
  created_at timestamptz not null default now(),
  constraint disclosure_items_unique unique (framework_version_id, code)
);

create table disclosure_item_conditions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references disclosure_items (id) on delete cascade,
  depends_on_item_code text not null,
  operator text not null check (operator in ('equals', 'not_equals', 'in', 'exists')),
  value text not null
);

create table applicability_results (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  item_id uuid not null references disclosure_items (id) on delete cascade,
  reporting_period_id uuid not null references reporting_periods (id) on delete cascade,
  applicability text not null
    check (applicability in ('applicable', 'not_applicable', 'needs_check')),
  reason text not null default '',
  evaluated_at timestamptz not null default now(),
  constraint applicability_results_unique unique (organization_id, item_id, reporting_period_id)
);

create table disclosure_responses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  item_id uuid not null references disclosure_items (id) on delete restrict,
  reporting_period_id uuid not null references reporting_periods (id) on delete cascade,
  status text not null default 'not_started'
    check (status in ('not_started', 'draft', 'in_review', 'returned', 'approved')),
  current_version_id uuid,
  answer_text text,
  answer_numeric numeric,
  answer_choice text[] not null default '{}',
  owner_user_id uuid references profiles (id),
  reviewer_user_id uuid references profiles (id),
  approved_at timestamptz,
  approved_by uuid references profiles (id),
  previous_response_id uuid references disclosure_responses (id) on delete set null,
  carry_forward_decision text check (carry_forward_decision in ('reuse', 'update', 'new')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  constraint disclosure_responses_unique unique (organization_id, item_id, reporting_period_id)
);

create table disclosure_response_versions (
  id uuid primary key default gen_random_uuid(),
  response_id uuid not null references disclosure_responses (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  version_no integer not null check (version_no > 0),
  answer_text text,
  answer_numeric numeric,
  answer_choice text[] not null default '{}',
  status text not null,
  -- AI 由来かどうか。AI がそのまま approved になることは禁止（0013 のトリガで担保）。
  originated_from_ai_run_id uuid,
  change_reason text,
  content_hash text not null,
  created_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  constraint disclosure_response_versions_unique unique (response_id, version_no)
);

alter table disclosure_responses
  add constraint disclosure_responses_current_version_fk
  foreign key (current_version_id)
  references disclosure_response_versions (id) deferrable initially deferred;

create table disclosure_mappings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  item_id uuid not null references disclosure_items (id) on delete cascade,
  metric_id uuid not null references metric_definitions (id) on delete cascade,
  unit_id uuid references organization_units (id) on delete cascade,
  transform text,
  mapping_source text not null default 'manual' check (mapping_source in ('manual', 'ai_suggested')),
  ai_run_id uuid,
  confirmed_by uuid references profiles (id),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  constraint disclosure_mappings_unique unique (organization_id, item_id, metric_id, unit_id)
);

create table response_evidence_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  response_id uuid not null references disclosure_responses (id) on delete cascade,
  evidence_link_id uuid not null references evidence_links (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint response_evidence_links_unique unique (response_id, evidence_link_id)
);

create trigger disclosure_responses_set_updated_at
  before update on disclosure_responses
  for each row execute function t4d.set_updated_at();
create trigger disclosure_mappings_set_updated_at
  before update on disclosure_mappings
  for each row execute function t4d.set_updated_at();
