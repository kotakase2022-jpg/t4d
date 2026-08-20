-- ======================================================================
-- 0009 Assurance（指示書 10.8）
-- ----------------------------------------------------------------------
-- 監査法人の作業成果は assurance_firm_id を所有者として持ち、
-- 企業原本（data_points / evidence_links）とは物理的に別テーブルへ保存する。
-- 企業側が監査法人の調書を書き換えることも、その逆も構造的に起こらない。
-- ======================================================================

create table engagements (
  id uuid primary key default gen_random_uuid(),
  assurance_firm_id uuid not null references organizations (id) on delete cascade,
  client_organization_id uuid not null references organizations (id) on delete restrict,
  client_reporting_period_id uuid not null references reporting_periods (id) on delete restrict,
  code text not null,
  name text not null,
  assurance_level text not null check (assurance_level in ('limited', 'reasonable')),
  framework_key text not null,
  status text not null default 'planning'
    check (status in ('planning', 'fieldwork', 'review', 'completed', 'archived')),
  planned_start_date date not null,
  deadline_date date not null,
  partner_user_id uuid references profiles (id),
  manager_user_id uuid references profiles (id),
  materiality_basis text,
  materiality_value numeric,
  materiality_unit text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  constraint engagements_code_unique unique (assurance_firm_id, code),
  constraint engagements_distinct_orgs check (assurance_firm_id <> client_organization_id)
);

create table engagement_members (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements (id) on delete cascade,
  assurance_firm_id uuid not null references organizations (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  role_key text not null references roles (key),
  assigned_at timestamptz not null default now(),
  assigned_by uuid references profiles (id),
  removed_at timestamptz,
  constraint engagement_members_unique unique (engagement_id, user_id)
);

create index engagement_members_user_idx on engagement_members (user_id, removed_at);

create table client_access_grants (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements (id) on delete cascade,
  client_organization_id uuid not null references organizations (id) on delete cascade,
  assurance_firm_id uuid not null references organizations (id) on delete cascade,
  subject_type text not null check (subject_type in (
    'metric', 'organization_unit', 'reporting_period', 'evidence_category', 'disclosure_item'
  )),
  subject_id uuid not null,
  includes_evidence boolean not null default false,
  granted_by uuid not null references profiles (id),
  granted_at timestamptz not null default now(),
  revoked_by uuid references profiles (id),
  revoked_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  constraint client_access_grants_unique unique (engagement_id, subject_type, subject_id)
);

create index client_access_grants_lookup_idx
  on client_access_grants (engagement_id, subject_type, subject_id, revoked_at);

create table engagement_scopes (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements (id) on delete cascade,
  assurance_firm_id uuid not null references organizations (id) on delete cascade,
  unit_id uuid not null references organization_units (id) on delete cascade,
  metric_id uuid not null references metric_definitions (id) on delete cascade,
  reporting_period_id uuid not null references reporting_periods (id) on delete cascade,
  inclusion text not null default 'pending' check (inclusion in ('included', 'excluded', 'pending')),
  risk_tag text not null default 'medium' check (risk_tag in ('high', 'medium', 'low')),
  materiality_flag boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  constraint engagement_scopes_unique unique (engagement_id, unit_id, metric_id, reporting_period_id)
);

create table data_room_items (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements (id) on delete cascade,
  assurance_firm_id uuid not null references organizations (id) on delete cascade,
  client_organization_id uuid not null references organizations (id) on delete cascade,
  source_type text not null check (source_type in ('data_point', 'evidence', 'disclosure_response')),
  source_id uuid not null,
  source_version_id uuid,
  shared_at timestamptz not null default now(),
  shared_by uuid not null references profiles (id),
  client_approval_status text not null default 'n_a',
  withdrawn_at timestamptz,
  constraint data_room_items_unique unique (engagement_id, source_type, source_id)
);

-- ----------------------------------------------------------------------
-- Snapshot（Immutable）
-- ----------------------------------------------------------------------

create table assurance_snapshots (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements (id) on delete cascade,
  assurance_firm_id uuid not null references organizations (id) on delete cascade,
  label text not null,
  frozen_at timestamptz not null default now(),
  frozen_by uuid not null references profiles (id),
  item_count integer not null default 0,
  hash text not null,
  note text
);

create table assurance_snapshot_items (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references assurance_snapshots (id) on delete cascade,
  engagement_id uuid not null references engagements (id) on delete cascade,
  assurance_firm_id uuid not null references organizations (id) on delete cascade,
  source_type text not null check (source_type in ('data_point', 'evidence', 'disclosure_response')),
  source_id uuid not null,
  source_version_id uuid,
  source_data_point_version_id uuid references data_point_versions (id),
  source_file_version_id uuid references file_versions (id),
  -- 固定時点の値のコピー。企業側が変更しても不変。
  value_snapshot jsonb not null default '{}'::jsonb,
  hash text not null,
  frozen_at timestamptz not null default now(),
  frozen_by uuid not null references profiles (id),
  constraint assurance_snapshot_items_unique
    unique (snapshot_id, source_type, source_id, source_version_id)
);

create index assurance_snapshot_items_snapshot_idx on assurance_snapshot_items (snapshot_id);

create table snapshot_changes (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references assurance_snapshots (id) on delete cascade,
  engagement_id uuid not null references engagements (id) on delete cascade,
  assurance_firm_id uuid not null references organizations (id) on delete cascade,
  snapshot_item_id uuid not null references assurance_snapshot_items (id) on delete cascade,
  change_kind text not null
    check (change_kind in ('value_changed', 'version_added', 'evidence_replaced', 'grant_revoked')),
  before_summary text not null,
  after_summary text not null,
  detected_at timestamptz not null default now(),
  assessed_by uuid references profiles (id),
  assessed_at timestamptz,
  assessment text check (assessment in ('no_impact', 'retest_required', 'issue_raised'))
);

-- ----------------------------------------------------------------------
-- 母集団 / サンプル
-- ----------------------------------------------------------------------

create table populations (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements (id) on delete cascade,
  assurance_firm_id uuid not null references organizations (id) on delete cascade,
  snapshot_id uuid not null references assurance_snapshots (id) on delete restrict,
  name text not null,
  version_no integer not null default 1,
  filter jsonb not null default '{}'::jsonb,
  item_count integer not null default 0,
  total_value numeric not null default 0,
  missing_count integer not null default 0,
  duplicate_count integer not null default 0,
  excluded_count integer not null default 0,
  reconciliation_note text,
  completeness_procedure_note text,
  created_at timestamptz not null default now(),
  created_by uuid not null references profiles (id),
  constraint populations_unique unique (engagement_id, name, version_no)
);

create table population_items (
  id uuid primary key default gen_random_uuid(),
  population_id uuid not null references populations (id) on delete cascade,
  engagement_id uuid not null references engagements (id) on delete cascade,
  assurance_firm_id uuid not null references organizations (id) on delete cascade,
  snapshot_item_id uuid not null references assurance_snapshot_items (id) on delete cascade,
  source_data_point_id uuid not null,
  metric_id uuid not null references metric_definitions (id) on delete restrict,
  unit_id uuid not null references organization_units (id) on delete restrict,
  value numeric not null,
  unit_of_measure text not null,
  stratum text,
  excluded boolean not null default false,
  exclusion_reason text,
  constraint population_items_unique unique (population_id, snapshot_item_id)
);

create table samples (
  id uuid primary key default gen_random_uuid(),
  population_id uuid not null references populations (id) on delete cascade,
  engagement_id uuid not null references engagements (id) on delete cascade,
  assurance_firm_id uuid not null references organizations (id) on delete cascade,
  population_version_no integer not null,
  name text not null,
  method text not null check (method in ('random', 'stratified', 'key_item', 'judgmental')),
  -- 同一 Seed で再現可能であること（指示書 16.6）
  seed text not null,
  parameters jsonb not null default '{}'::jsonb,
  size integer not null default 0,
  rationale text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid not null references profiles (id)
);

create table sample_items (
  id uuid primary key default gen_random_uuid(),
  sample_id uuid not null references samples (id) on delete cascade,
  population_item_id uuid not null references population_items (id) on delete cascade,
  engagement_id uuid not null references engagements (id) on delete cascade,
  assurance_firm_id uuid not null references organizations (id) on delete cascade,
  selection_reason text not null default '',
  stratum text,
  sort_order integer not null default 0,
  constraint sample_items_unique unique (sample_id, population_item_id)
);

-- ----------------------------------------------------------------------
-- 手続 / テスト
-- ----------------------------------------------------------------------

create table assurance_procedures (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements (id) on delete cascade,
  assurance_firm_id uuid not null references organizations (id) on delete cascade,
  code text not null,
  title text not null,
  description text not null default '',
  category text not null check (category in (
    'completeness', 'accuracy', 'cutoff', 'recalculation', 'inquiry', 'inspection'
  )),
  required boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  constraint assurance_procedures_unique unique (engagement_id, code)
);

create table assurance_tests (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements (id) on delete cascade,
  assurance_firm_id uuid not null references organizations (id) on delete cascade,
  sample_item_id uuid not null references sample_items (id) on delete cascade,
  status text not null default 'not_started'
    check (status in ('not_started', 'in_progress', 'prepared', 'reviewed', 'exception')),
  conclusion_draft text,
  prepared_by uuid references profiles (id),
  prepared_at timestamptz,
  reviewed_by uuid references profiles (id),
  reviewed_at timestamptz,
  workpaper_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  constraint assurance_tests_unique unique (sample_item_id),
  -- Reviewed には Prepared が先行していなければならない
  constraint assurance_tests_review_requires_prepare
    check (reviewed_by is null or prepared_by is not null),
  -- 自己レビュー禁止
  constraint assurance_tests_no_self_review
    check (reviewed_by is null or reviewed_by <> prepared_by)
);

create table assurance_test_results (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references assurance_tests (id) on delete cascade,
  procedure_id uuid not null references assurance_procedures (id) on delete cascade,
  engagement_id uuid not null references engagements (id) on delete cascade,
  assurance_firm_id uuid not null references organizations (id) on delete cascade,
  result text not null check (result in ('pass', 'exception', 'not_applicable')),
  recalculation_input jsonb,
  recalculation_result numeric,
  recorded_value numeric,
  difference numeric,
  note text,
  completed_by uuid not null references profiles (id),
  completed_at timestamptz not null default now(),
  constraint assurance_test_results_unique unique (test_id, procedure_id)
);

-- ----------------------------------------------------------------------
-- PBC / Issue / Review Note / Sign-off
-- ----------------------------------------------------------------------

create table pbc_requests (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements (id) on delete cascade,
  assurance_firm_id uuid not null references organizations (id) on delete cascade,
  client_organization_id uuid not null references organizations (id) on delete cascade,
  code text not null,
  title text not null,
  description text not null default '',
  target_type text,
  target_id uuid,
  due_date date not null,
  priority text not null default 'medium'
    check (priority in ('critical', 'high', 'medium', 'low')),
  status text not null default 'draft' check (status in (
    'draft', 'sent', 'acknowledged', 'submitted', 'under_review',
    'accepted', 'rejected', 'overdue', 'closed'
  )),
  -- 監査法人内部メモ。企業側からは RLS で不可視。
  internal_note text,
  requested_by uuid not null references profiles (id),
  sent_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  constraint pbc_requests_unique unique (engagement_id, code)
);

create table pbc_request_responses (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references pbc_requests (id) on delete cascade,
  engagement_id uuid not null references engagements (id) on delete cascade,
  client_organization_id uuid not null references organizations (id) on delete cascade,
  body text not null default '',
  file_version_ids uuid[] not null default '{}',
  submitted_by uuid not null references profiles (id),
  submitted_at timestamptz not null default now(),
  decision text check (decision in ('accepted', 'rejected')),
  decided_by uuid references profiles (id),
  decided_at timestamptz,
  reject_reason text
);

create table assurance_issues (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements (id) on delete cascade,
  assurance_firm_id uuid not null references organizations (id) on delete cascade,
  client_organization_id uuid not null references organizations (id) on delete cascade,
  code text not null,
  title text not null,
  description text not null default '',
  affected_metric_id uuid references metric_definitions (id) on delete set null,
  affected_sample_item_id uuid references sample_items (id) on delete set null,
  severity text not null check (severity in ('high', 'medium', 'low')),
  quantitative_impact numeric,
  quantitative_impact_unit text,
  root_cause text,
  status text not null default 'open'
    check (status in ('open', 'management_response', 'resolved', 'closed')),
  resolution text,
  reviewer_user_id uuid references profiles (id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  constraint assurance_issues_unique unique (engagement_id, code),
  constraint assurance_issues_resolved_requires_resolution
    check (status <> 'resolved' or resolution is not null)
);

create table management_responses (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references assurance_issues (id) on delete cascade,
  engagement_id uuid not null references engagements (id) on delete cascade,
  client_organization_id uuid not null references organizations (id) on delete cascade,
  body text not null,
  proposed_correction text,
  responded_by uuid not null references profiles (id),
  responded_at timestamptz not null default now()
);

create table review_notes (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements (id) on delete cascade,
  assurance_firm_id uuid not null references organizations (id) on delete cascade,
  target_type text not null,
  target_id uuid,
  body text not null,
  raised_by uuid not null references profiles (id),
  assigned_to uuid references profiles (id),
  status text not null default 'open' check (status in ('open', 'responded', 'cleared')),
  -- 既定 false。false の間は企業側から一切見えない（指示書 11-10）。
  shared_with_client boolean not null default false,
  resolution_comment text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id)
);

create table signoffs (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements (id) on delete cascade,
  assurance_firm_id uuid not null references organizations (id) on delete cascade,
  signoff_stage text not null check (signoff_stage in ('prepared', 'reviewed', 'partner_approved')),
  -- 代理 Sign-off 禁止。RLS の WITH CHECK と 0013 のトリガで本人性を強制。
  user_id uuid not null references profiles (id),
  role_key text not null references roles (key),
  version integer not null default 1,
  snapshot_id uuid references assurance_snapshots (id),
  comment text,
  created_at timestamptz not null default now(),
  constraint signoffs_unique unique (engagement_id, signoff_stage, user_id, version)
);

create table workpaper_references (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements (id) on delete cascade,
  assurance_firm_id uuid not null references organizations (id) on delete cascade,
  reference text not null,
  target_type text not null,
  target_id uuid not null,
  created_at timestamptz not null default now(),
  created_by uuid not null references profiles (id),
  constraint workpaper_references_unique unique (engagement_id, reference)
);

-- 遅延していた FK
alter table tasks
  add constraint tasks_engagement_fk
  foreign key (engagement_id) references engagements (id) on delete set null;
alter table ai_jobs
  add constraint ai_jobs_engagement_fk
  foreign key (engagement_id) references engagements (id) on delete set null;
alter table ai_runs
  add constraint ai_runs_engagement_fk
  foreign key (engagement_id) references engagements (id) on delete set null;
alter table storage_access_events
  add constraint storage_access_events_engagement_fk
  foreign key (engagement_id) references engagements (id) on delete set null;

create trigger engagements_set_updated_at
  before update on engagements
  for each row execute function t4d.set_updated_at();
create trigger client_access_grants_set_updated_at
  before update on client_access_grants
  for each row execute function t4d.set_updated_at();
create trigger engagement_scopes_set_updated_at
  before update on engagement_scopes
  for each row execute function t4d.set_updated_at();
create trigger assurance_procedures_set_updated_at
  before update on assurance_procedures
  for each row execute function t4d.set_updated_at();
create trigger assurance_tests_set_updated_at
  before update on assurance_tests
  for each row execute function t4d.set_updated_at();
create trigger pbc_requests_set_updated_at
  before update on pbc_requests
  for each row execute function t4d.set_updated_at();
create trigger assurance_issues_set_updated_at
  before update on assurance_issues
  for each row execute function t4d.set_updated_at();
create trigger review_notes_set_updated_at
  before update on review_notes
  for each row execute function t4d.set_updated_at();
