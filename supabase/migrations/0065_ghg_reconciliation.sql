-- ----------------------------------------------------------------------
-- 既存の算定結果・照合・原因の確認の記録（2026-10-16 の要望 ③。CR-11・12・13）
--
-- 1. ghg_baseline_results: 既存の算定結果（追記専用）。ファイルの sha256・粒度（拠点×区分／拠点×活動／行）・
--    行（JSONB。5,000 行まで）・拠点コードから拠点への対応付け（利用者が選ぶ）。差し替えは supersedes_id。
-- 2. ghg_reconciliations: 照合の記録（追記専用）。算定の記録と既存結果は同じ組織・同じ期間（トリガ）。
--    許容差（区分ごとの絶対値 t・相対 %。既定値は置かない）・原因の順序・結果・照合の規則の版を残す。
-- 3. ghg_reconciliation_notes: 原因の確認の記録（追記専用）。enterprise.data.review かつ本人名義
--    （decided_by = auth.uid()）。原因が other のときはコメント必須。AI は関与しない。
-- 判定の語に「一致」を使わない（許容差内・要確認・原因を確認済み・原因不明〔残差〕・片側のみ。plan K8）。
--
-- ロールバック: 表は残して使わなくする（DROP しない）。docs/known-limitations.md §6。
-- ----------------------------------------------------------------------

create table ghg_baseline_results (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  reporting_period_id uuid not null,
  label text not null check (btrim(label) <> '' and length(label) <= 200),
  file_name text not null default '' check (length(file_name) <= 255),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  granularity text not null check (granularity in ('site_scope', 'site_activity', 'line')),
  rows jsonb not null
    check (jsonb_typeof(rows) = 'array' and jsonb_array_length(rows) <= 5000),
  unit_mapping jsonb not null default '{}'::jsonb check (jsonb_typeof(unit_mapping) = 'object'),
  row_count integer not null check (row_count between 0 and 5000),
  supersedes_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid not null references profiles (id),

  constraint ghg_baseline_results_period_matches
    foreign key (reporting_period_id, organization_id)
    references reporting_periods (id, organization_id) on delete restrict,
  constraint ghg_baseline_results_id_org_unique unique (id, organization_id),
  constraint ghg_baseline_results_supersedes_matches
    foreign key (supersedes_id, organization_id)
    references ghg_baseline_results (id, organization_id) on delete restrict
);

comment on table ghg_baseline_results is
  '既存の算定結果（追記専用）。ファイルは保存せず sha256 と行を持つ。拠点の対応付けは利用者が選ぶ。';

create trigger ghg_baseline_results_stamp
  before insert on ghg_baseline_results
  for each row execute function t4d.ghg_stamp_created_by();

create trigger ghg_baseline_results_immutable
  before update or delete on ghg_baseline_results
  for each row execute function t4d.forbid_mutation();

alter table ghg_baseline_results enable row level security;

create policy ghg_baseline_results_select on ghg_baseline_results for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy ghg_baseline_results_insert on ghg_baseline_results for insert to authenticated
  with check (t4d.has_permission(organization_id, 'enterprise.data.write'));

-- ----------------------------------------------------------------------
-- 照合の記録
-- ----------------------------------------------------------------------

create table ghg_reconciliations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  run_id uuid not null,
  baseline_id uuid not null,
  tolerance jsonb not null check (jsonb_typeof(tolerance) = 'object'),
  attribution_order text[] not null,
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  checker_version text not null check (btrim(checker_version) <> '' and length(checker_version) <= 60),
  created_at timestamptz not null default now(),
  created_by uuid not null references profiles (id),

  constraint ghg_reconciliations_run_matches
    foreign key (run_id, organization_id)
    references ghg_calculation_runs (id, organization_id) on delete restrict,
  constraint ghg_reconciliations_baseline_matches
    foreign key (baseline_id, organization_id)
    references ghg_baseline_results (id, organization_id) on delete restrict,
  constraint ghg_reconciliations_id_org_unique unique (id, organization_id),
  constraint ghg_reconciliations_order_known check (
    attribution_order <@ array['classification', 'coverage', 'activity', 'conversion', 'factor', 'method', 'rounding']::text[]
  )
);

comment on table ghg_reconciliations is
  '照合の記録（追記専用）。整合性の確認と差異の原因を示す。一致を保証するものではない。許容差は利用者が入れる。';

create or replace function t4d.ghg_reconciliation_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_period uuid;
  v_baseline_period uuid;
begin
  select reporting_period_id into v_run_period from ghg_calculation_runs where id = new.run_id;
  select reporting_period_id into v_baseline_period from ghg_baseline_results where id = new.baseline_id;
  if v_run_period is distinct from v_baseline_period then
    raise exception 'T4D_RECONCILIATION_PERIOD: 算定の記録と既存の算定結果は同じ期間のものだけを照合できます'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger ghg_reconciliations_guard
  before insert on ghg_reconciliations
  for each row execute function t4d.ghg_reconciliation_guard();

create trigger ghg_reconciliations_stamp
  before insert on ghg_reconciliations
  for each row execute function t4d.ghg_stamp_created_by();

create trigger ghg_reconciliations_immutable
  before update or delete on ghg_reconciliations
  for each row execute function t4d.forbid_mutation();

alter table ghg_reconciliations enable row level security;

create policy ghg_reconciliations_select on ghg_reconciliations for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy ghg_reconciliations_insert on ghg_reconciliations for insert to authenticated
  with check (t4d.has_permission(organization_id, 'enterprise.data.write'));

-- ----------------------------------------------------------------------
-- 原因の確認の記録
-- ----------------------------------------------------------------------

create table ghg_reconciliation_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  reconciliation_id uuid not null,
  item_key text not null check (btrim(item_key) <> '' and length(item_key) <= 300),
  confirmed_cause text not null check (confirmed_cause in (
    'classification', 'coverage', 'activity', 'conversion', 'factor', 'method', 'rounding', 'other'
  )),
  comment text not null default '' check (length(comment) <= 1000),
  decided_by uuid not null references profiles (id),
  decided_at timestamptz not null default now(),
  supersedes_id uuid,

  constraint ghg_reconciliation_notes_reconciliation_matches
    foreign key (reconciliation_id, organization_id)
    references ghg_reconciliations (id, organization_id) on delete restrict,
  constraint ghg_reconciliation_notes_id_org_unique unique (id, organization_id),
  constraint ghg_reconciliation_notes_supersedes_matches
    foreign key (supersedes_id, organization_id)
    references ghg_reconciliation_notes (id, organization_id) on delete restrict,
  -- 「その他」の原因は何かをコメントに書く
  constraint ghg_reconciliation_notes_other_comment
    check (confirmed_cause <> 'other' or btrim(comment) <> '')
);

comment on table ghg_reconciliation_notes is
  '原因の確認の記録（追記専用・本人名義）。原因の確定は人が行う（AI は関与しない）。';

create trigger ghg_reconciliation_notes_immutable
  before update or delete on ghg_reconciliation_notes
  for each row execute function t4d.forbid_mutation();

alter table ghg_reconciliation_notes enable row level security;

create policy ghg_reconciliation_notes_select on ghg_reconciliation_notes
  for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy ghg_reconciliation_notes_insert on ghg_reconciliation_notes
  for insert to authenticated
  with check (
    t4d.has_permission(organization_id, 'enterprise.data.review')
    and decided_by = auth.uid()
  );
