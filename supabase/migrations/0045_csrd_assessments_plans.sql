-- ----------------------------------------------------------------------
-- CSRD 要求事項の評価と対応計画（docs/disclosure-first.md §9.3 0045）
--
-- SSBJ の ssbj_assessments は適用区分・重要性を行に持つが、CSRD の適用は DMA（0044）の
-- 人の判断から毎回導出するため、ここには持たない（保存すると DMA を直したときに古い適用が残る）。
--
-- AI の候補（ai_*）と人の確定（3 観点・final_status・reviewed_*）を別の列に分ける。
-- AI は ai_* だけを書き、人が「候補を採用」「修正して確定」して初めて final_status が入る
-- （AI は確定しない。CLAUDE.md §0.4）。
--
-- ssbj_assessments / ssbj_action_plans は再利用しない。SSBJ の読み取り経路の多くは
-- フレームワークで絞らずに行を読むため、CSRD の行が SSBJ の画面へ混入する（§9.3）。
-- 逆に、ここへ SSBJ の要求事項が入らないよう、要求事項の版の基準が csrd であることを
-- トリガで確かめる（Service Role にも効く）。
--
-- テナント整合: 0035 と同じ複合外部キー方式（期間・AI の実行・評価は同じ組織の行だけ）。
-- RLS: 参照は組織メンバー、書込は enterprise.disclosure.write（0025 と同じ）。
-- ----------------------------------------------------------------------

create table csrd_assessments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  reporting_period_id uuid not null,
  item_id uuid not null references disclosure_items (id) on delete cascade,

  -- 人が入力・確定した 3 観点
  disclosure_status text not null default 'unconfirmed'
    check (disclosure_status in
      ('covered', 'mostly_covered', 'partial', 'not_covered', 'unconfirmed')),
  data_status text not null default 'unconfirmed'
    check (data_status in
      ('covered', 'mostly_covered', 'partial', 'not_covered', 'unconfirmed')),
  process_status text not null default 'unconfirmed'
    check (process_status in
      ('covered', 'mostly_covered', 'partial', 'not_covered', 'unconfirmed')),

  -- AI の候補（人が採用するまで確定値にならない）
  ai_disclosure_status text
    check (ai_disclosure_status in
      ('covered', 'mostly_covered', 'partial', 'not_covered', 'unconfirmed')),
  ai_data_status text
    check (ai_data_status in
      ('covered', 'mostly_covered', 'partial', 'not_covered', 'unconfirmed')),
  ai_process_status text
    check (ai_process_status in
      ('covered', 'mostly_covered', 'partial', 'not_covered', 'unconfirmed')),
  ai_status text
    check (ai_status in
      ('covered', 'mostly_covered', 'partial', 'not_covered', 'unconfirmed')),
  ai_comment text not null default '',
  ai_missing_info text[] not null default '{}',
  ai_recommendation text not null default '',
  ai_run_id uuid,
  ai_evaluated_at timestamptz,

  -- 人の確認
  review_decision text check (review_decision in ('approved', 'modified')),
  reviewed_by uuid references profiles (id),
  reviewed_at timestamptz,
  review_comment text not null default '',
  final_status text
    check (final_status in
      ('covered', 'mostly_covered', 'partial', 'not_covered', 'unconfirmed')),

  owner_department text not null default '',
  owner_user_id uuid references profiles (id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),

  constraint csrd_assessments_period_matches
    foreign key (reporting_period_id, organization_id)
    references reporting_periods (id, organization_id) on delete cascade,
  -- AI の実行は同じ組織のものだけ（0036 で足した ai_runs の (id, organization_id) 一意制約を使う）
  constraint csrd_assessments_ai_run_matches
    foreign key (ai_run_id, organization_id)
    references ai_runs (id, organization_id),
  constraint csrd_assessments_unique unique (organization_id, reporting_period_id, item_id),
  constraint csrd_assessments_id_org_unique unique (id, organization_id),
  -- 最終判定は人が確認したときだけ入る
  constraint csrd_assessments_final_requires_review
    check ((final_status is null) = (reviewed_at is null)),
  constraint csrd_assessments_reviewed_pair check ((reviewed_at is null) = (reviewed_by is null)),
  constraint csrd_assessments_decision_requires_review
    check (review_decision is null or reviewed_at is not null),
  -- AI の候補は 3 観点・総合・実行日時がそろって入る（一部だけの候補を作らない）
  constraint csrd_assessments_ai_candidate_shape
    check (
      (ai_status is null and ai_disclosure_status is null and ai_data_status is null
        and ai_process_status is null and ai_evaluated_at is null)
      or (ai_status is not null and ai_disclosure_status is not null and ai_data_status is not null
        and ai_process_status is not null and ai_evaluated_at is not null)
    )
);

create index csrd_assessments_org_period_idx
  on csrd_assessments (organization_id, reporting_period_id);
create index csrd_assessments_item_idx on csrd_assessments (item_id);

comment on table csrd_assessments is
  'CSRD 要求事項ごとの評価（3 観点）。AI の候補（ai_*）と人の確定を分けて持つ。適用・重要性は DMA から導出し、列に持たない。';

-- 要求事項は CSRD の版のものに限る。SSBJ・CDP の要求事項を CSRD の評価として登録させない
-- （disclosure_items 等は全利用者が読めるマスターで、例外の違いから他社の情報は読めない）
create or replace function t4d.csrd_assessment_item_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
      from disclosure_items i
      join disclosure_framework_versions v on v.id = i.framework_version_id
      join disclosure_frameworks f on f.id = v.framework_id
     where i.id = new.item_id
       and f.key = 'csrd'
  ) then
    raise exception 'T4D_CSRD_ITEM_ONLY: CSRD の要求事項以外は CSRD の評価に登録できません'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger csrd_assessments_item_guard
  before insert or update of item_id on csrd_assessments
  for each row execute function t4d.csrd_assessment_item_guard();

-- ----------------------------------------------------------------------
-- 対応計画（列は 0025 の ssbj_action_plans と同じ）
-- ----------------------------------------------------------------------

create table csrd_action_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  reporting_period_id uuid not null,
  assessment_id uuid not null,
  gap_kind text not null check (gap_kind in ('disclosure', 'data', 'process')),
  title text not null check (btrim(title) <> ''),
  detail text not null default '',
  action_type text not null check (action_type in (
    'data_collection', 'disclosure_addition', 'governance', 'policy',
    'internal_control', 'system', 'calculation_method'
  )),
  department text not null default '',
  assignee_user_id uuid references profiles (id),
  due_date date,
  priority text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  status text not null default 'not_started'
    check (status in ('not_started', 'in_progress', 'in_review', 'done')),
  -- データ収集項目を作った場合の指標コード（metric_definitions.code）
  linked_metric_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),

  constraint csrd_action_plans_period_matches
    foreign key (reporting_period_id, organization_id)
    references reporting_periods (id, organization_id) on delete cascade,
  -- 評価は同じ組織の行だけ（他社の評価に計画を付けさせない）
  constraint csrd_action_plans_assessment_matches
    foreign key (assessment_id, organization_id)
    references csrd_assessments (id, organization_id) on delete cascade
);

create index csrd_action_plans_org_period_idx
  on csrd_action_plans (organization_id, reporting_period_id);
create index csrd_action_plans_assessment_idx on csrd_action_plans (assessment_id);

comment on table csrd_action_plans is
  'CSRD のギャップに対する対応計画。担当部署・担当者・期限・対応状況を持ち、データ収集項目へ接続する。';

-- ----------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------

alter table csrd_assessments enable row level security;
alter table csrd_action_plans enable row level security;

create policy csrd_assessments_select on csrd_assessments for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy csrd_assessments_write on csrd_assessments for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.disclosure.write'))
  with check (t4d.has_permission(organization_id, 'enterprise.disclosure.write'));

create policy csrd_action_plans_select on csrd_action_plans for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy csrd_action_plans_write on csrd_action_plans for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.disclosure.write'))
  with check (t4d.has_permission(organization_id, 'enterprise.disclosure.write'));
