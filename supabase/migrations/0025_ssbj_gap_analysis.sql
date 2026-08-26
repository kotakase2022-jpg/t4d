-- ----------------------------------------------------------------------
-- SSBJ ギャップ分析と対応計画
--
-- SSBJ 対応は「要求事項を ○△× で採点する」作業ではない。
--   ① その企業に適用される要求事項か（適用区分）
--   ② その情報に重要性があるか（重要性）
--   ③ 現在どこまで対応できているか（対応状況）
-- を別々に持ち、③はさらに 3 観点に分ける。
--   開示   … SSBJ が求める情報が現在の開示資料に記載されているか
--   データ … 開示に必要な数値を社内で取得できているか
--   業務プロセス・内部統制 … 継続的かつ正確に収集・確認・承認できる仕組みがあるか
--
-- AI の判定はそのまま最終判定にしない（CLAUDE.md §0.4）。
-- ai_* 列は候補で、担当者が確認して final_status を入れて初めて確定する。
--
-- 優先度は保存しない。重要性と 3 観点の対応状況から毎回計算する
-- （保存すると入力が変わったときに古い優先度が残り、根拠と食い違う）。
--
-- RLS: 参照は組織メンバー、更新は enterprise.disclosure.write 保持者のみ
--      （materiality_topics / applicability_results と同じ扱い）。
-- ----------------------------------------------------------------------

create table ssbj_assessments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  reporting_period_id uuid not null references reporting_periods (id) on delete cascade,
  item_id uuid not null references disclosure_items (id) on delete cascade,

  -- ① 適用区分
  applicability text not null default 'applicable'
    check (applicability in ('applicable', 'not_applicable')),
  applicability_reason text not null default '',

  -- ② 重要性
  materiality text not null default 'not_assessed'
    check (materiality in ('material', 'not_material', 'not_assessed')),
  materiality_reason text not null default '',

  -- ③ 対応状況（3 観点）
  disclosure_status text not null default 'unconfirmed'
    check (disclosure_status in
      ('covered', 'mostly_covered', 'partial', 'not_covered', 'unconfirmed')),
  data_status text not null default 'unconfirmed'
    check (data_status in
      ('covered', 'mostly_covered', 'partial', 'not_covered', 'unconfirmed')),
  process_status text not null default 'unconfirmed'
    check (process_status in
      ('covered', 'mostly_covered', 'partial', 'not_covered', 'unconfirmed')),

  -- AI による判定（候補）
  ai_status text
    check (ai_status is null or ai_status in
      ('covered', 'mostly_covered', 'partial', 'not_covered', 'unconfirmed')),
  ai_comment text not null default '',
  ai_missing_info text[] not null default '{}',
  ai_recommendation text not null default '',
  ai_run_id uuid references ai_runs (id),
  ai_evaluated_at timestamptz,

  -- AI が既存資料から見つけた該当箇所（判定の根拠）
  source_document text,
  source_page text,
  source_excerpt text,

  -- 担当者による確認
  review_decision text
    check (review_decision is null or review_decision in ('approved', 'modified')),
  reviewed_by uuid references profiles (id),
  reviewed_at timestamptz,
  review_comment text not null default '',

  -- 最終判定（担当者が確認して初めて入る）
  final_status text
    check (final_status is null or final_status in
      ('covered', 'mostly_covered', 'partial', 'not_covered', 'unconfirmed')),

  owner_department text not null default '',
  owner_user_id uuid references profiles (id),

  -- 前年度からの引き継ぎ
  carried_over_from uuid references ssbj_assessments (id),
  recheck_reason text not null default '',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  constraint ssbj_assessments_unique unique (organization_id, reporting_period_id, item_id)
);

create index ssbj_assessments_org_period_idx
  on ssbj_assessments (organization_id, reporting_period_id);
create index ssbj_assessments_item_idx on ssbj_assessments (item_id);

comment on table ssbj_assessments is
  'SSBJ 要求事項ごとの評価。適用区分・重要性・3 観点の対応状況を分けて持ち、AI 判定は担当者の確認を経て最終判定になる。';

alter table ssbj_assessments enable row level security;

create policy ssbj_assessments_select on ssbj_assessments for select to authenticated
  using (t4d.is_org_member(organization_id));

create policy ssbj_assessments_write on ssbj_assessments for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.disclosure.write'))
  with check (t4d.has_permission(organization_id, 'enterprise.disclosure.write'));

-- ----------------------------------------------------------------------
-- 対応計画
--
-- ギャップ（要求事項 × 観点）ごとに、誰がいつまでに何をするかを持つ。
-- データ収集が必要な場合は linked_metric_code で指標マスターへ接続し、
-- ギャップ分析 → 対応計画 → データ収集 が途切れないようにする。
-- ----------------------------------------------------------------------

create table ssbj_action_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  reporting_period_id uuid not null references reporting_periods (id) on delete cascade,
  assessment_id uuid not null references ssbj_assessments (id) on delete cascade,
  gap_kind text not null check (gap_kind in ('disclosure', 'data', 'process')),
  title text not null,
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
  updated_by uuid references profiles (id)
);

create index ssbj_action_plans_org_period_idx
  on ssbj_action_plans (organization_id, reporting_period_id);
create index ssbj_action_plans_assessment_idx on ssbj_action_plans (assessment_id);

comment on table ssbj_action_plans is
  'SSBJ ギャップに対する対応計画。担当部署・担当者・期限・対応状況を持ち、データ収集項目へ接続する。';

alter table ssbj_action_plans enable row level security;

create policy ssbj_action_plans_select on ssbj_action_plans for select to authenticated
  using (t4d.is_org_member(organization_id));

create policy ssbj_action_plans_write on ssbj_action_plans for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.disclosure.write'))
  with check (t4d.has_permission(organization_id, 'enterprise.disclosure.write'));
