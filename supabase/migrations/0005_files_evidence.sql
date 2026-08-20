-- ======================================================================
-- 0005 File / Evidence（指示書 10.4 / 12）
-- ======================================================================

create table files (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  bucket text not null check (bucket in (
    'brand-public',
    'enterprise-originals-private',
    'evidence-private',
    'assurance-workpapers-private',
    'exports-private'
  )),
  -- 表示名。Storage Key とは分離する（Path Traversal 防止）
  original_name text not null,
  mime_type text not null,
  confidentiality text not null default 'confidential'
    check (confidentiality in ('public', 'internal', 'confidential', 'restricted')),
  current_version_id uuid,
  document_type text,
  reporting_period_id uuid references reporting_periods (id) on delete set null,
  scan_status text not null default 'pending'
    check (scan_status in ('pending', 'clean', 'infected', 'skipped')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  deleted_at timestamptz
);

create index files_org_idx on files (organization_id, deleted_at);

create table file_versions (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references files (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  version_no integer not null check (version_no > 0),
  -- Object Path。ファイル名は含めず UUID ベースにする。
  storage_key text not null unique,
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 text not null,
  created_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  constraint file_versions_unique unique (file_id, version_no)
);

alter table files
  add constraint files_current_version_fk
  foreign key (current_version_id) references file_versions (id) deferrable initially deferred;

create table extracted_fragments (
  id uuid primary key default gen_random_uuid(),
  file_version_id uuid not null references file_versions (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  page integer not null,
  kind text not null check (kind in ('text', 'table', 'cell')),
  text text not null,
  locator text,
  created_at timestamptz not null default now()
);

create index extracted_fragments_fv_idx on extracted_fragments (file_version_id, page);

create table evidence_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  file_version_id uuid not null references file_versions (id) on delete cascade,
  target_type text not null check (target_type in (
    'data_point', 'disclosure_response', 'assurance_test', 'pbc_request_response', 'assurance_issue'
  )),
  target_id uuid not null,
  page integer,
  cell_ref text,
  fragment_id uuid references extracted_fragments (id) on delete set null,
  source_url text,
  coverage_period_start date,
  coverage_period_end date,
  obtained_at date,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  -- 同一対象へ同一 Evidence（同一箇所）を重複 Link しない（指示書 10 章 Unique 例）
  constraint evidence_links_unique
    unique (target_type, target_id, file_version_id, page, cell_ref)
);

create index evidence_links_target_idx on evidence_links (target_type, target_id);

create table storage_access_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  actor_user_id uuid not null references profiles (id),
  file_version_id uuid not null references file_versions (id) on delete cascade,
  action text not null check (action in ('signed_url_created', 'downloaded', 'viewed')),
  engagement_id uuid,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create index storage_access_events_fv_idx on storage_access_events (file_version_id, created_at desc);

create trigger files_set_updated_at
  before update on files
  for each row execute function t4d.set_updated_at();
create trigger evidence_links_set_updated_at
  before update on evidence_links
  for each row execute function t4d.set_updated_at();
