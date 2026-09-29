-- ----------------------------------------------------------------------
-- 開示プロジェクトと適用判断（docs/disclosure-first.md §3 0035）
--
-- これまで開示の前提（どの基準を・どの目的で・誰が確認して・いつまでに）は
-- SSBJ だけ組織 × 期間の設定（ssbj_analysis_settings）で持っていた。
-- 同じ年度に SSBJ（法定）と CSRD 域外（40a）準備を並行する場合、基準ごとに
-- 目的も適用判断も異なるため、「開示プロジェクト」を起点に束ねる。
--
-- 適用判断は「保存して準備を始める」（project_frameworks の更新）と
-- 「適用判断を確定」（project_framework_decisions への追記）を分ける。
-- 確定した判断は後から書き換えず、見直しは新しい判断番号で追記する
-- （いつ・誰が・どの規則の版に基づいて判断したかを保証対応で示すため）。
--
-- テナント整合: 子の organization_id は親と一致しなければならない。
-- 0021 / 0022 と同じく、親に (id, organization_id) の一意制約を置いて複合外部キーで固定する。
--
-- RLS: 参照は組織メンバー、書込は enterprise.disclosure.write。
--      判断の追記は本人名義（decided_by = auth.uid()）のみ。
-- ----------------------------------------------------------------------

-- 複合外部キーの参照先（既存表への一意制約の追加のみ。id が主キーなので既存行は必ず満たす）
alter table reporting_periods
  add constraint reporting_periods_id_org_unique unique (id, organization_id);

create table disclosure_projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  reporting_period_id uuid not null,
  name text not null check (btrim(name) <> ''),
  /** 報告主体（例: 株式会社○○及び連結子会社） */
  reporting_entity text not null default '',
  period_start date not null,
  period_end date not null,
  currency text not null default 'JPY',
  /** 開示目的。src/types/domain.ts の DISCLOSURE_PURPOSES と対応 */
  purposes text[] not null default '{}'
    check (purposes <@ array[
      'ssbj_statutory', 'ssbj_voluntary', 'csrd_40a_prep', 'csrd_eu_entity', 'internal_esg'
    ]::text[]),
  languages text[] not null default '{ja}'
    check (cardinality(languages) > 0 and languages <@ array['ja', 'en']::text[]),
  owner_user_id uuid references profiles (id),
  reviewer_user_id uuid references profiles (id),
  final_approver_user_id uuid references profiles (id),
  due_date date,

  -- 報告範囲の考え方（文章）。範囲の数値的な確定は別途 included_unit_ids で持つ
  scope_org_note text not null default '',
  scope_consolidation_note text not null default '',
  scope_ghg_boundary_note text not null default '',
  scope_value_chain_note text not null default '',
  /** 報告対象に含める組織・拠点。空配列は全社（未指定） */
  included_unit_ids uuid[] not null default '{}',

  status text not null default 'preparing'
    check (status in ('preparing', 'active', 'closed')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  deleted_at timestamptz,

  constraint disclosure_projects_period_order check (period_start <= period_end),
  constraint disclosure_projects_period_matches
    foreign key (reporting_period_id, organization_id)
    references reporting_periods (id, organization_id) on delete cascade,
  constraint disclosure_projects_id_org_unique unique (id, organization_id)
);

create index disclosure_projects_org_period_idx
  on disclosure_projects (organization_id, reporting_period_id);

comment on table disclosure_projects is
  '開示プロジェクト。報告期間・目的・担当・報告範囲を束ね、基準ごとの適用判断の起点になる。';

-- ----------------------------------------------------------------------
-- プロジェクトで扱う基準の版
-- ----------------------------------------------------------------------

create table project_frameworks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  project_id uuid not null,
  /** 使う基準の版を固定する（「最新の版」を毎回引き直すと、改正で黙って判断根拠が変わる） */
  framework_version_id uuid not null references disclosure_framework_versions (id) on delete restrict,
  purpose text not null
    check (purpose in (
      'ssbj_statutory', 'ssbj_voluntary', 'csrd_40a_prep', 'csrd_eu_entity', 'internal_esg'
    )),
  /** 現在の適用区分。確定した判断があれば current_decision_id の内容と一致させる */
  applicability_status text not null default 'not_assessed'
    check (applicability_status in (
      'not_assessed', 'candidate', 'applicable', 'not_applicable', 'voluntary', 'awaiting_confirmation'
    )),
  current_decision_id uuid,
  /**
   * 適用条件の入力（EU 域内売上・従業員数など）。
   * 未入力の項目はキー自体を持たない（0 と「分からない」を混同しない）。
   */
  conditions jsonb not null default '{}'::jsonb check (jsonb_typeof(conditions) = 'object'),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),

  constraint project_frameworks_project_matches
    foreign key (project_id, organization_id)
    references disclosure_projects (id, organization_id) on delete cascade,
  constraint project_frameworks_unique unique (project_id, framework_version_id),
  constraint project_frameworks_id_org_unique unique (id, organization_id)
);

create index project_frameworks_project_idx on project_frameworks (project_id);

comment on table project_frameworks is
  'プロジェクトが扱う基準の版と適用区分。保存しただけでは判断は確定しない（確定は project_framework_decisions への追記）。';

-- ----------------------------------------------------------------------
-- 適用判断（追記専用）
-- ----------------------------------------------------------------------

create table project_framework_decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  project_framework_id uuid not null,
  /** 1 から。見直しは新しい番号で追記する */
  decision_no integer not null check (decision_no > 0),
  /** 「未判定」を確定することはできない（未判定は判断が無い状態そのもの） */
  applicability_status text not null
    check (applicability_status in (
      'candidate', 'applicable', 'not_applicable', 'voluntary', 'awaiting_confirmation'
    )),
  reason text not null check (btrim(reason) <> ''),
  /** 参照した規則とその版（例: SSBJ 適用基準 2026-03-13 改正 第 X 項） */
  rule_ref text not null check (btrim(rule_ref) <> ''),
  /** 規則を確認した日 */
  confirmed_on date not null,
  transitional_note text,
  /** 判断時点の適用条件の写し（後から条件を直しても、判断の根拠は変わらない） */
  conditions_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(conditions_snapshot) = 'object'),
  decided_by uuid not null references profiles (id),
  decided_at timestamptz not null default now(),

  constraint project_framework_decisions_pf_matches
    foreign key (project_framework_id, organization_id)
    references project_frameworks (id, organization_id) on delete cascade,
  constraint project_framework_decisions_unique unique (project_framework_id, decision_no),
  constraint project_framework_decisions_id_pf_unique unique (id, project_framework_id)
);

comment on table project_framework_decisions is
  '適用判断の確定記録（追記専用）。理由・参照規則・確認日・判断者を必ず持つ。';

-- 現在の判断は「自分の」判断しか指せない（他の基準・他テナントの判断を指させない）。
-- 判断を追記してから指し直すため、遅延可能にしておく。
alter table project_frameworks
  add constraint project_frameworks_current_decision_fk
    foreign key (current_decision_id, id)
    references project_framework_decisions (id, project_framework_id)
    deferrable initially deferred;

create trigger project_framework_decisions_immutable
  before update or delete on project_framework_decisions
  for each row execute function t4d.forbid_mutation();

-- ----------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------

alter table disclosure_projects enable row level security;
alter table project_frameworks enable row level security;
alter table project_framework_decisions enable row level security;

create policy disclosure_projects_select on disclosure_projects for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy disclosure_projects_write on disclosure_projects for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.disclosure.write'))
  with check (t4d.has_permission(organization_id, 'enterprise.disclosure.write'));

create policy project_frameworks_select on project_frameworks for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy project_frameworks_write on project_frameworks for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.disclosure.write'))
  with check (t4d.has_permission(organization_id, 'enterprise.disclosure.write'));

create policy project_framework_decisions_select on project_framework_decisions
  for select to authenticated
  using (t4d.is_org_member(organization_id));
-- 追記専用: UPDATE / DELETE ポリシーは作らない（トリガでも禁止）
create policy project_framework_decisions_insert on project_framework_decisions
  for insert to authenticated
  with check (
    decided_by = auth.uid()
    and t4d.has_permission(organization_id, 'enterprise.disclosure.write')
  );
