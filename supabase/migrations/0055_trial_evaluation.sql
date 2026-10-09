-- ----------------------------------------------------------------------
-- トライアルの評価の記録（トライアル対応 2026-10: NF-32〜NF-36）
--
-- 1. trial_programs: 計画・利用枠・選定ケース（要求事項の集合）・合意・終了時の扱い・導入判断（人が入力）。
-- 2. trial_scenarios: 検証シナリオの定義（テーマ・判定の目安）。
-- 3. trial_scenario_runs（追記専用）: シナリオの実施記録（本人名義。完遂区分・問い合わせ回数・所要時間）。
-- 4. trial_scenario_judgements（追記専用）: 評価者の判定（合格・不合格・保留。理由必須）。
-- 5. trial_feedback_items: フィードバックと改善管理表（不具合・要望・質問・良かった点。定例会の論点も同じ表）。
-- 6. trial_task_timings（追記専用）: 作業時間（現行 vs T4D。測り方つき）。
--
-- すべて企業テナントの organization_id を持ち、監査法人は読めない（組織メンバーだけ）。
-- 計画・シナリオ定義・判定・改善の更新は enterprise.org.manage、実施・フィードバック・作業時間の記録は
-- 組織メンバー全員（本人名義だけ）。利用者の操作は自動追跡しない（外部の計測サービスも使わない）。
-- ロールバック方針は docs/known-limitations.md §6。
-- ----------------------------------------------------------------------

create table trial_programs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  starts_on date,
  ends_on date,
  phase text not null default 'setup'
    check (phase in ('setup', 'started', 'tuning', 'reverification', 'decision', 'closed')),
  project_id uuid,
  included_unit_ids uuid[] not null default '{}',
  target_data_note text not null default '',
  /** 選定ケース（要求事項の集合）。追跡率と評価 #1 の既定の分母 */
  selected_requirement_item_ids uuid[] not null default '{}',
  selected_metric_ids uuid[] not null default '{}',
  planned_members integer check (planned_members is null or planned_members >= 0),
  planned_sites integer check (planned_sites is null or planned_sites >= 0),
  planned_quantitative_metrics integer
    check (planned_quantitative_metrics is null or planned_quantitative_metrics >= 0),
  planned_narrative_blocks integer
    check (planned_narrative_blocks is null or planned_narrative_blocks >= 0),
  planned_requirements integer check (planned_requirements is null or planned_requirements >= 0),
  planned_fiscal_years integer check (planned_fiscal_years is null or planned_fiscal_years >= 0),
  planned_files integer check (planned_files is null or planned_files >= 0),
  planned_approval_levels integer
    check (planned_approval_levels is null or planned_approval_levels >= 0),
  options jsonb not null default '{}'::jsonb check (jsonb_typeof(options) = 'object'),
  /** 開始前に合意する 3 点（範囲・判断者・スケジュール）の合意日とメモ */
  agreements jsonb not null default '{}'::jsonb check (jsonb_typeof(agreements) = 'object'),
  end_disposition text not null default 'undecided'
    check (end_disposition in ('continue', 'return', 'delete', 'undecided')),
  end_agreed_on date,
  decision text not null default 'undecided'
    check (decision in ('adopt', 'conditional', 'decline', 'undecided')),
  decision_conditions text not null default '',
  decided_by_label text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),

  constraint trial_programs_project_matches
    foreign key (project_id, organization_id)
    references disclosure_projects (id, organization_id) on delete set null (project_id),
  constraint trial_programs_period_order
    check (starts_on is null or ends_on is null or starts_on <= ends_on),
  constraint trial_programs_id_org_unique unique (id, organization_id)
);

comment on table trial_programs is
  'トライアルの計画・利用枠・選定ケース・終了時の扱い・導入判断（人が入力。AI は関与しない）。';

create trigger trial_programs_set_updated_at
  before update on trial_programs
  for each row execute function t4d.set_updated_at();

create table trial_scenarios (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  theme text not null check (theme in (
    'traceability', 'gap_distinction', 'approval_change', 'output_reuse',
    'usability', 'work_time', 'operations'
  )),
  code text not null check (btrim(code) <> ''),
  title text not null check (btrim(title) <> ''),
  steps text not null default '',
  target_role text not null default '',
  acceptance_criterion text not null default '',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  deleted_at timestamptz,

  constraint trial_scenarios_unique unique (organization_id, code),
  constraint trial_scenarios_id_org_unique unique (id, organization_id)
);

comment on table trial_scenarios is 'トライアルの検証シナリオ（テーマ・対象役割・判定の目安）。';

create trigger trial_scenarios_set_updated_at
  before update on trial_scenarios
  for each row execute function t4d.set_updated_at();

create table trial_scenario_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  scenario_id uuid not null,
  performed_by uuid not null references profiles (id),
  /** 実施した役割（業務の役割名。権限キーではない） */
  performed_role text not null default '',
  started_at timestamptz,
  ended_at timestamptz,
  minutes numeric(8, 1) check (minutes is null or minutes >= 0),
  completion text not null check (completion in ('self', 'with_help', 'not_completed')),
  help_count integer not null default 0 check (help_count >= 0),
  ease_rating smallint check (ease_rating is null or ease_rating between 1 and 5),
  comment text not null default '',
  /** 記録の相対 URL・監査ログ ID・出力記録 ID */
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  environment_version text not null default '',
  supersedes_run_id uuid,
  created_at timestamptz not null default now(),

  constraint trial_scenario_runs_scenario_matches
    foreign key (scenario_id, organization_id)
    references trial_scenarios (id, organization_id) on delete cascade,
  constraint trial_scenario_runs_period_order
    check (started_at is null or ended_at is null or started_at <= ended_at),
  constraint trial_scenario_runs_id_org_unique unique (id, organization_id)
);

alter table trial_scenario_runs
  add constraint trial_scenario_runs_supersedes_matches
    foreign key (supersedes_run_id, organization_id)
    references trial_scenario_runs (id, organization_id);

create index trial_scenario_runs_scenario_idx on trial_scenario_runs (scenario_id, created_at);

comment on table trial_scenario_runs is
  'シナリオの実施記録（追記専用・本人名義）。訂正は supersedes_run_id で新しい記録を足す。';

create trigger trial_scenario_runs_immutable
  before update or delete on trial_scenario_runs
  for each row execute function t4d.forbid_mutation();

create table trial_scenario_judgements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  scenario_id uuid not null,
  judgement text not null check (judgement in ('pass', 'fail', 'hold')),
  reason text not null check (btrim(reason) <> ''),
  measured_value text not null default '',
  judged_by uuid not null references profiles (id),
  judged_at timestamptz not null default now(),

  constraint trial_scenario_judgements_scenario_matches
    foreign key (scenario_id, organization_id)
    references trial_scenarios (id, organization_id) on delete cascade
);

create index trial_scenario_judgements_scenario_idx
  on trial_scenario_judgements (scenario_id, judged_at);

comment on table trial_scenario_judgements is
  '評価者の判定（追記専用。取り消せない）。測定値の候補はアプリが出すが、判定は人。';

create trigger trial_scenario_judgements_immutable
  before update or delete on trial_scenario_judgements
  for each row execute function t4d.forbid_mutation();

create table trial_feedback_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  kind text not null check (kind in ('defect', 'request', 'question', 'positive', 'other')),
  channel text not null default 'in_app'
    check (channel in ('in_app', 'meeting', 'email', 'phone', 'other')),
  title text not null check (btrim(title) <> '' and length(title) <= 200),
  body text not null default '' check (length(body) <= 2000),
  /** 画面のルートのパターン（クエリ・ID は記録しない） */
  route_pattern text not null default '' check (length(route_pattern) <= 300),
  scenario_id uuid,
  /** 重大度（不具合のみ） */
  severity text check (severity in ('critical', 'major', 'minor')),
  mandatory_requirement boolean not null default false,
  status text not null default 'open'
    check (status in ('open', 'triaged', 'in_progress', 'resolved', 'wont_fix', 'verified')),
  response_policy text not null default '',
  cost_class text not null default 'undecided'
    check (cost_class in ('maintenance', 'separate_estimate', 'undecided')),
  owner_label text not null default '',
  due_on date,
  resolved_in_version text not null default '',
  verification_result text not null default '',
  verified_by uuid references profiles (id),
  verified_at timestamptz,
  agreed boolean not null default false,
  /** 記録した時点の環境の版（ビルド） */
  environment_version text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references profiles (id),
  updated_by uuid references profiles (id),
  deleted_at timestamptz,

  constraint trial_feedback_items_scenario_matches
    foreign key (scenario_id, organization_id)
    references trial_scenarios (id, organization_id) on delete set null (scenario_id),
  constraint trial_feedback_items_severity_defect_only
    check (severity is null or kind = 'defect'),
  constraint trial_feedback_items_verified_pair check ((verified_at is null) = (verified_by is null))
);

create index trial_feedback_items_org_idx on trial_feedback_items (organization_id, created_at desc);

comment on table trial_feedback_items is
  'フィードバックと改善管理表。投稿は組織メンバー本人、トリアージ・更新は enterprise.org.manage。履歴は監査ログ。';

create trigger trial_feedback_items_set_updated_at
  before update on trial_feedback_items
  for each row execute function t4d.set_updated_at();

-- 投稿者・投稿内容（種類・経路・件名・本文・画面）は更新で書き換えない（改善管理の列だけを更新する）
create or replace function t4d.trial_feedback_update_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.organization_id is distinct from old.organization_id then
    raise exception 'T4D_IMMUTABLE: フィードバックの投稿者・投稿日時は変更できません'
      using errcode = '42501';
  end if;
  if auth.uid() is not null
     and new.verified_by is not null
     and new.verified_by is distinct from old.verified_by
     and new.verified_by <> auth.uid() then
    raise exception 'T4D_ACTOR_MUST_BE_SELF: 再検証の記録は本人の名義でのみ記録できます'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger trial_feedback_items_update_guard
  before update on trial_feedback_items
  for each row execute function t4d.trial_feedback_update_guard();

create table trial_task_timings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  task_key text not null check (task_key in (
    'transcription', 'check_reconcile', 'drafting', 'approval', 'assurance_response', 'handover'
  )),
  mode text not null check (mode in ('baseline', 't4d')),
  unit_label text not null default '',
  quantity numeric not null default 1 check (quantity > 0),
  minutes numeric not null check (minutes >= 0),
  method text not null check (method in ('self_report', 'observed', 'log_estimate')),
  department text not null default '',
  measured_on date not null,
  scenario_run_id uuid,
  supersedes_id uuid,
  note text not null default '' check (length(note) <= 2000),
  recorded_by uuid not null references profiles (id),
  created_at timestamptz not null default now(),

  constraint trial_task_timings_run_matches
    foreign key (scenario_run_id, organization_id)
    references trial_scenario_runs (id, organization_id),
  constraint trial_task_timings_id_org_unique unique (id, organization_id)
);

alter table trial_task_timings
  add constraint trial_task_timings_supersedes_matches
    foreign key (supersedes_id, organization_id)
    references trial_task_timings (id, organization_id);

create index trial_task_timings_org_idx on trial_task_timings (organization_id, task_key, mode);

comment on table trial_task_timings is
  '作業時間（追記専用・本人名義）。現行と T4D を測り方つきで記録し、件数が足りなければ短縮率を出さない。';

create trigger trial_task_timings_immutable
  before update or delete on trial_task_timings
  for each row execute function t4d.forbid_mutation();

-- ----------------------------------------------------------------------
-- RLS（監査法人は組織メンバーでないため読めない）
-- ----------------------------------------------------------------------

alter table trial_programs enable row level security;
alter table trial_scenarios enable row level security;
alter table trial_scenario_runs enable row level security;
alter table trial_scenario_judgements enable row level security;
alter table trial_feedback_items enable row level security;
alter table trial_task_timings enable row level security;

create policy trial_programs_select on trial_programs for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy trial_programs_insert on trial_programs for insert to authenticated
  with check (t4d.has_permission(organization_id, 'enterprise.org.manage'));
create policy trial_programs_update on trial_programs for update to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.org.manage'))
  with check (t4d.has_permission(organization_id, 'enterprise.org.manage'));

create policy trial_scenarios_select on trial_scenarios for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy trial_scenarios_insert on trial_scenarios for insert to authenticated
  with check (t4d.has_permission(organization_id, 'enterprise.org.manage'));
create policy trial_scenarios_update on trial_scenarios for update to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.org.manage'))
  with check (t4d.has_permission(organization_id, 'enterprise.org.manage'));

create policy trial_scenario_runs_select on trial_scenario_runs for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy trial_scenario_runs_insert on trial_scenario_runs for insert to authenticated
  with check (t4d.is_org_member(organization_id) and performed_by = auth.uid());

create policy trial_scenario_judgements_select on trial_scenario_judgements
  for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy trial_scenario_judgements_insert on trial_scenario_judgements
  for insert to authenticated
  with check (
    judged_by = auth.uid()
    and t4d.has_permission(organization_id, 'enterprise.org.manage')
  );

create policy trial_feedback_items_select on trial_feedback_items for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy trial_feedback_items_insert on trial_feedback_items for insert to authenticated
  with check (t4d.is_org_member(organization_id) and created_by = auth.uid());
create policy trial_feedback_items_update on trial_feedback_items for update to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.org.manage'))
  with check (t4d.has_permission(organization_id, 'enterprise.org.manage'));

create policy trial_task_timings_select on trial_task_timings for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy trial_task_timings_insert on trial_task_timings for insert to authenticated
  with check (t4d.is_org_member(organization_id) and recorded_by = auth.uid());
