-- ======================================================================
-- 0010 Audit（指示書 10.9 / 17）
-- ----------------------------------------------------------------------
-- audit_events は追記専用。通常ユーザーは UPDATE / DELETE できない。
-- PII や Evidence 本文を丸ごと保存しない（要約のみ）。
-- ======================================================================

create table audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references profiles (id) on delete set null,
  actor_organization_id uuid references organizations (id) on delete set null,
  event_type text not null check (event_type in (
    'login_success', 'login_failure', 'logout', 'workspace_selected', 'record_viewed',
    'file_uploaded', 'file_downloaded', 'signed_url_created',
    'data_created', 'data_updated', 'data_submitted', 'data_returned', 'data_approved',
    'permission_changed', 'access_grant_created', 'access_grant_revoked',
    'snapshot_created', 'snapshot_change_detected', 'sample_created', 'procedure_completed',
    'pbc_created', 'pbc_submitted', 'issue_created', 'issue_resolved', 'review_note_created',
    'signoff_created', 'ai_run_started', 'ai_run_completed', 'ai_output_accepted',
    'export_created'
  )),
  resource_type text,
  resource_id uuid,
  engagement_id uuid references engagements (id) on delete set null,
  -- 生 IP は保存しない。ハッシュの先頭 16 文字のみ。
  client_ip_hash text check (client_ip_hash is null or length(client_ip_hash) <= 32),
  user_agent text,
  before_summary text check (before_summary is null or length(before_summary) <= 500),
  after_summary text check (after_summary is null or length(after_summary) <= 500),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_events_org_idx on audit_events (actor_organization_id, created_at desc);
create index audit_events_engagement_idx on audit_events (engagement_id, created_at desc);
create index audit_events_resource_idx on audit_events (resource_type, resource_id, created_at desc);

comment on table audit_events is
  '追記専用の監査ログ。UPDATE / DELETE はトリガと RLS で禁止する。PII / Evidence 本文は保存しない。';
