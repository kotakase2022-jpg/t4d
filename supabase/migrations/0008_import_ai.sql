-- ======================================================================
-- 0008 Import / AI（指示書 10.7 / 13 / 14）
-- ======================================================================

create table ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  reporting_period_id uuid not null references reporting_periods (id) on delete cascade,
  unit_id uuid references organization_units (id) on delete set null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'needs_review', 'completed', 'failed', 'cancelled')),
  progress_percent integer not null default 0
    check (progress_percent >= 0 and progress_percent <= 100),
  error_code text,
  error_message text,
  retry_count integer not null default 0,
  -- 重複実行防止（指示書 13 章）
  idempotency_key text not null,
  started_at timestamptz,
  finished_at timestamptz,
  total_rows integer not null default 0,
  mapped_rows integer not null default 0,
  warning_rows integer not null default 0,
  error_rows integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  constraint ingestion_jobs_idempotency_unique unique (organization_id, idempotency_key)
);

create index ingestion_jobs_status_idx on ingestion_jobs (organization_id, status, created_at desc);

create table ingestion_job_files (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references ingestion_jobs (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  file_version_id uuid not null references file_versions (id) on delete restrict,
  original_name text not null,
  mime_type text not null,
  parse_status text not null default 'pending'
    check (parse_status in ('pending', 'parsed', 'needs_ocr', 'failed')),
  parse_message text,
  sheet_name text,
  detected_encoding text,
  created_at timestamptz not null default now()
);

create table ingestion_rows (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references ingestion_jobs (id) on delete cascade,
  job_file_id uuid not null references ingestion_job_files (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  row_index integer not null,
  raw jsonb not null default '{}'::jsonb,
  metric_id uuid references metric_definitions (id) on delete set null,
  unit_id uuid references organization_units (id) on delete set null,
  reporting_period_id uuid references reporting_periods (id) on delete set null,
  value numeric,
  unit_of_measure text,
  confidence numeric(4, 3) not null default 0 check (confidence >= 0 and confidence <= 1),
  warnings text[] not null default '{}',
  status text not null default 'pending'
    check (status in ('pending', 'mapped', 'needs_review', 'duplicate', 'rejected', 'confirmed')),
  source_locator text,
  duplicate_of_data_point_id uuid references data_points (id) on delete set null,
  ai_run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ingestion_rows_unique unique (job_file_id, row_index)
);

create index ingestion_rows_job_idx on ingestion_rows (job_id, status);

create table ai_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  feature_type text not null check (feature_type in (
    'importMapping', 'anomalyExplanation', 'cdpQuestionMapping', 'cdpDraftGeneration',
    'evidenceMapping', 'inconsistencyCheck', 'assuranceEvidenceSummary', 'assuranceChangeSummary'
  )),
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'needs_review', 'completed', 'failed', 'cancelled')),
  target_type text not null,
  target_id uuid,
  engagement_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id)
);

create table ai_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  job_id uuid references ai_jobs (id) on delete set null,
  feature_type text not null,
  provider text not null check (provider in ('openai', 'mock')),
  model text not null,
  prompt_version text not null,
  input_reference_ids text[] not null default '{}',
  output_json jsonb not null default '{}'::jsonb,
  source_references jsonb not null default '[]'::jsonb,
  confidence numeric(4, 3) not null default 0,
  warnings text[] not null default '{}',
  latency_ms integer not null default 0,
  token_usage jsonb not null default '{"input":0,"output":0,"total":0}'::jsonb,
  estimated_cost_usd numeric(12, 6) not null default 0,
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'failed', 'accepted', 'rejected')),
  error_message text,
  engagement_id uuid,
  reviewed_by uuid references profiles (id),
  accepted_at timestamptz,
  rejected_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references profiles (id)
);

create index ai_runs_org_idx on ai_runs (organization_id, feature_type, created_at desc);

create table ai_sources (
  id uuid primary key default gen_random_uuid(),
  ai_run_id uuid not null references ai_runs (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  kind text not null,
  source_id uuid,
  label text not null,
  locator text,
  period_label text
);

create table ai_feedback (
  id uuid primary key default gen_random_uuid(),
  ai_run_id uuid not null references ai_runs (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  user_id uuid not null references profiles (id),
  decision text not null check (decision in ('accepted', 'edited_accepted', 'rejected')),
  comment text,
  created_at timestamptz not null default now()
);

alter table ingestion_rows
  add constraint ingestion_rows_ai_run_fk
  foreign key (ai_run_id) references ai_runs (id) on delete set null;

alter table disclosure_response_versions
  add constraint disclosure_response_versions_ai_run_fk
  foreign key (originated_from_ai_run_id) references ai_runs (id) on delete set null;

alter table disclosure_mappings
  add constraint disclosure_mappings_ai_run_fk
  foreign key (ai_run_id) references ai_runs (id) on delete set null;

create trigger ingestion_jobs_set_updated_at
  before update on ingestion_jobs
  for each row execute function t4d.set_updated_at();
create trigger ingestion_rows_set_updated_at
  before update on ingestion_rows
  for each row execute function t4d.set_updated_at();
create trigger ai_jobs_set_updated_at
  before update on ai_jobs
  for each row execute function t4d.set_updated_at();
