-- ======================================================================
-- 0006 Workflow / Task / Alert（指示書 10.5）
-- ======================================================================

create table workflow_definitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  key text not null,
  name text not null,
  target_type text not null check (target_type in ('data_point', 'disclosure_response')),
  steps text[] not null default array['input', 'review', 'approval'],
  constraint workflow_definitions_key_unique unique (organization_id, key)
);

create table workflow_instances (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  definition_id uuid not null references workflow_definitions (id) on delete restrict,
  target_type text not null check (target_type in ('data_point', 'disclosure_response')),
  target_id uuid not null,
  current_step text not null check (current_step in ('input', 'review', 'approval')),
  status text not null default 'open' check (status in ('open', 'completed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  constraint workflow_instances_target_unique unique (target_type, target_id)
);

create table workflow_steps (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references workflow_instances (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  step_key text not null check (step_key in ('input', 'review', 'approval')),
  assignee_user_id uuid references profiles (id),
  status text not null default 'pending' check (status in ('pending', 'active', 'done', 'skipped')),
  entered_at timestamptz,
  completed_at timestamptz,
  constraint workflow_steps_unique unique (instance_id, step_key)
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  title text not null,
  description text,
  target_type text not null,
  target_id uuid,
  assignee_user_id uuid references profiles (id),
  due_date date,
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'blocked', 'done', 'cancelled')),
  priority text not null default 'medium'
    check (priority in ('critical', 'high', 'medium', 'low')),
  engagement_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id)
);

create index tasks_assignee_idx on tasks (organization_id, assignee_user_id, status);

create table approvals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  target_type text not null check (target_type in ('data_point', 'disclosure_response')),
  target_id uuid not null,
  target_version_id uuid,
  stage text not null check (stage in ('review', 'final')),
  decision text not null check (decision in ('approved', 'returned')),
  actor_user_id uuid not null references profiles (id),
  comment text,
  decided_at timestamptz not null default now()
);

create index approvals_target_idx on approvals (target_type, target_id, decided_at desc);

create table comments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  target_type text not null,
  target_id uuid not null,
  body text not null,
  author_user_id uuid not null references profiles (id),
  -- internal = 自テナント内のみ / shared = 相手テナントにも見える
  visibility text not null default 'internal' check (visibility in ('internal', 'shared')),
  mentions uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id)
);

create index comments_target_idx on comments (target_type, target_id, created_at);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  title text not null,
  body text not null,
  category text not null check (category in ('task', 'alert', 'pbc', 'review', 'system')),
  href text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_user_idx on notifications (user_id, read_at);

create table alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  kind text not null check (kind in (
    'overdue', 'not_submitted', 'validation_error', 'missing_evidence',
    'changed_after_approval', 'question_updated', 'assurance_request', 'snapshot_change'
  )),
  severity text not null check (severity in ('critical', 'high', 'medium', 'low')),
  title text not null,
  detail text not null,
  target_type text not null,
  target_id uuid,
  href text not null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create trigger workflow_instances_set_updated_at
  before update on workflow_instances
  for each row execute function t4d.set_updated_at();
create trigger tasks_set_updated_at
  before update on tasks
  for each row execute function t4d.set_updated_at();
create trigger comments_set_updated_at
  before update on comments
  for each row execute function t4d.set_updated_at();
