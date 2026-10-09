-- ----------------------------------------------------------------------
-- 要求事項ごとの判断・対象外の承認・対応付け・横断対応表（トライアル対応 2026-10: NF-01・02・05・06・09・12）
--
-- 1. project_requirement_assessments（＋追記専用の履歴 project_requirement_assessment_events）
--    これまで要求事項単位の判断は SSBJ の ssbj_assessments にしか無く、開示プロジェクトの要求事項タブは
--    どの基準でも ssbj_assessments を読んでいた（CSRD・ESRS-40a の行が全件「未判定」になる）。
--    SSBJ（ssbj_assessments）・CSRD（DMA から導出）以外の基準（ESRS-40a など）の判断はプロジェクトの基準ごとに
--    ここへ持つ。表示では行を作らない（保存の操作でだけ作る。ssbj_assessments の一括作成の問題を持ち込まない）。
-- 2. requirement_exclusion_events（追記専用）
--    対象外・非重要を理由付きで「申請」し、別の人（開示の承認権限）が「承認」「差戻し」する二者の記録。
--    承認は reason_digest＝sha256(区分 || 改行 || 理由) に結び付き、理由・区分を変えると承認は無効になる。
--    職務分離（申請者は承認できない）と、申請した時点の理由との一致はトリガで確かめる（Service Role にも効く）。
-- 3. narrative_requirement_links: 定性情報と要求事項の直接の対応付け（原稿が無くても不足を出すため）。
--    物理削除はしない（DbClient の契約）。外すときは deleted_at を入れる。
-- 4. t4d.block_requirement_items_guard(): disclosure_blocks.requirement_item_ids は配列で外部キーにできないため、
--    全項目が節の基準の版に属することをトリガで確かめる。
-- 5. requirement_crosswalks: テナント横断のマスター（SSBJ ↔ ESRS／ESRS-40a の対応）。参照だけ・書込ポリシーなし
--    （seed とマスター登録スクリプトで投入する。顧客が書き換えられない）。
-- 6. ssbj_analysis_settings.framework_version_id: SSBJ の設定を確定した時点の基準の版（null は公開中の版）。
--
-- テナント整合: 子の organization_id は親と一致させる（0035 と同じ複合外部キー方式）。
-- RLS: 参照は組織メンバー、書込は enterprise.disclosure.write（承認の記録は enterprise.disclosure.approve）。
-- 判断者・確認者・申請者・承認者は本人名義だけ（0047 の t4d.csrd_actor_must_be_self を使う）。
-- ロールバック方針は docs/known-limitations.md §6（使わなくするだけ。DROP しない）。
-- ----------------------------------------------------------------------

-- 利用者が組織でその権限を持つか（auth.uid() ではなく指定した利用者で見る。記録の名義人の検査に使う）
create or replace function t4d.user_has_permission(
  p_organization_id uuid,
  p_user_id uuid,
  p_permission text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from organization_memberships m
    join membership_roles mr on mr.membership_id = m.id
    join role_permissions rp on rp.role_key = mr.role_key
    where m.organization_id = p_organization_id
      and m.user_id = p_user_id
      and m.status = 'active'
      and rp.permission_key = p_permission
  );
$$;

comment on function t4d.user_has_permission(uuid, uuid, text) is
  '指定した利用者が組織でその権限を持つか。記録の名義人（申請者・承認者）の検査に使う。';

-- 対象外・非重要の理由のダイジェスト（アプリの requirement-coverage.ts の exclusionReasonDigest と同じ規則）
create or replace function t4d.exclusion_reason_digest(p_decision text, p_reason text)
returns text
language sql
immutable
as $$
  select encode(sha256(convert_to(coalesce(p_decision, '') || chr(10) || coalesce(p_reason, ''), 'UTF8')), 'hex');
$$;

-- ----------------------------------------------------------------------
-- 1. 要求事項の判断（SSBJ・CSRD 以外の基準）
-- ----------------------------------------------------------------------

create table project_requirement_assessments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  project_framework_id uuid not null,
  item_id uuid not null references disclosure_items (id) on delete restrict,
  applicability text not null default 'not_assessed'
    check (applicability in ('applicable', 'not_applicable', 'not_material', 'not_assessed')),
  applicability_reason text not null default '',
  /** 参照した規則とその版（例: 基準の項番・社内の判断基準） */
  rule_ref text not null default '',
  -- 3 観点の人の評価（SSBJ と同じ 5 値。null は未評価）
  disclosure_coverage text
    check (disclosure_coverage in ('covered', 'mostly_covered', 'partial', 'not_covered', 'unconfirmed')),
  data_coverage text
    check (data_coverage in ('covered', 'mostly_covered', 'partial', 'not_covered', 'unconfirmed')),
  process_coverage text
    check (process_coverage in ('covered', 'mostly_covered', 'partial', 'not_covered', 'unconfirmed')),
  missing_information text not null default '',
  owner_user_id uuid references profiles (id),
  due_on date,
  action_note text not null default '',
  decided_by uuid references profiles (id),
  decided_at timestamptz,
  reviewed_by uuid references profiles (id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),

  constraint project_requirement_assessments_pf_matches
    foreign key (project_framework_id, organization_id)
    references project_frameworks (id, organization_id) on delete cascade,
  constraint project_requirement_assessments_unique unique (project_framework_id, item_id),
  constraint project_requirement_assessments_id_org_unique unique (id, organization_id),
  -- 対象外・非重要は理由が必須（理由の無い除外で分母を減らさない）
  constraint project_requirement_assessments_exclusion_reason
    check (applicability not in ('not_applicable', 'not_material') or btrim(applicability_reason) <> ''),
  constraint project_requirement_assessments_decided_pair check ((decided_at is null) = (decided_by is null)),
  constraint project_requirement_assessments_reviewed_pair check ((reviewed_at is null) = (reviewed_by is null))
);

create index project_requirement_assessments_pf_idx
  on project_requirement_assessments (project_framework_id);

comment on table project_requirement_assessments is
  '開示プロジェクトの基準（SSBJ・CSRD 以外）の要求事項ごとの判断と 3 観点の評価。表示では作らず、保存の操作でだけ作る。';

-- 要求事項はプロジェクトの基準の版のものに限る（SSBJ・CSRD は別の表で判断する。0045 と同じ方針）
create or replace function t4d.project_requirement_assessment_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_version_id uuid;
begin
  select pf.framework_version_id into v_version_id
    from project_frameworks pf
   where pf.id = new.project_framework_id
     and pf.organization_id = new.organization_id;
  if not found then
    raise exception 'T4D_REQUIREMENT_SCOPE: プロジェクトの基準が見つかりません'
      using errcode = '23514';
  end if;
  if not exists (
    select 1 from disclosure_items i
     where i.id = new.item_id and i.framework_version_id = v_version_id
  ) then
    raise exception 'T4D_REQUIREMENT_SCOPE: 基準の版に属さない要求事項は判断できません'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger project_requirement_assessments_guard
  before insert or update of project_framework_id, item_id, organization_id
  on project_requirement_assessments
  for each row execute function t4d.project_requirement_assessment_guard();

create trigger project_requirement_assessments_decided_self
  before insert or update on project_requirement_assessments
  for each row execute function t4d.csrd_actor_must_be_self('decided_by', 'decided_at');
create trigger project_requirement_assessments_reviewed_self
  before insert or update on project_requirement_assessments
  for each row execute function t4d.csrd_actor_must_be_self('reviewed_by', 'reviewed_at');
create trigger project_requirement_assessments_set_updated_at
  before update on project_requirement_assessments
  for each row execute function t4d.set_updated_at();

-- 判断の履歴（追記専用）。前後の値（要約）・実行者・理由
create table project_requirement_assessment_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  assessment_id uuid not null,
  project_framework_id uuid not null,
  item_id uuid not null references disclosure_items (id) on delete restrict,
  before jsonb check (before is null or jsonb_typeof(before) = 'object'),
  after jsonb not null check (jsonb_typeof(after) = 'object'),
  reason text not null default '',
  actor_user_id uuid not null references profiles (id),
  created_at timestamptz not null default now(),

  constraint project_requirement_assessment_events_assessment_matches
    foreign key (assessment_id, organization_id)
    references project_requirement_assessments (id, organization_id) on delete cascade,
  constraint project_requirement_assessment_events_pf_matches
    foreign key (project_framework_id, organization_id)
    references project_frameworks (id, organization_id) on delete cascade
);

create index project_requirement_assessment_events_assessment_idx
  on project_requirement_assessment_events (assessment_id, created_at);

comment on table project_requirement_assessment_events is
  '要求事項の判断の履歴（追記専用）。承認版のスナップショットはこの行の ID で判断を固定する。';

create trigger project_requirement_assessment_events_immutable
  before update or delete on project_requirement_assessment_events
  for each row execute function t4d.forbid_mutation();

-- ----------------------------------------------------------------------
-- 2. 対象外・非重要の申請と承認（追記専用・二者）
-- ----------------------------------------------------------------------

create table requirement_exclusion_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  framework_version_id uuid not null references disclosure_framework_versions (id) on delete restrict,
  item_id uuid not null references disclosure_items (id) on delete restrict,
  reporting_period_id uuid not null,
  /** プロジェクトの判断（project_requirement_assessments）の申請のときだけ入る */
  project_framework_id uuid,
  source text not null check (source in ('ssbj_assessment', 'project_assessment')),
  event text not null check (event in ('requested', 'approved', 'returned', 'withdrawn')),
  decision text not null check (decision in ('not_applicable', 'not_material')),
  /** sha256(区分 || 改行 || 理由) の 16 進。理由・区分が変わると別の値になり、承認は無効になる */
  reason_digest text not null check (reason_digest ~ '^[0-9a-f]{64}$'),
  /** 確認ダイアログ・一覧に出す理由の先頭（全文は判断の行にある） */
  reason_excerpt text not null default '' check (length(reason_excerpt) <= 200),
  /** 差戻しの理由（差戻しのときは必須） */
  note text not null default '' check (length(note) <= 2000),
  actor_user_id uuid not null references profiles (id),
  created_at timestamptz not null default now(),

  constraint requirement_exclusion_events_period_matches
    foreign key (reporting_period_id, organization_id)
    references reporting_periods (id, organization_id) on delete cascade,
  constraint requirement_exclusion_events_pf_matches
    foreign key (project_framework_id, organization_id)
    references project_frameworks (id, organization_id) on delete cascade,
  constraint requirement_exclusion_events_source_shape
    check ((source = 'project_assessment') = (project_framework_id is not null)),
  constraint requirement_exclusion_events_return_note
    check (event <> 'returned' or btrim(note) <> '')
);

create index requirement_exclusion_events_item_idx
  on requirement_exclusion_events (organization_id, item_id, reporting_period_id, created_at);

comment on table requirement_exclusion_events is
  '対象外・非重要の申請・承認・差戻し・取り下げ（追記専用）。承認は申請者と別の承認権限者だけ。理由のダイジェストに結び付く。';

create or replace function t4d.requirement_exclusion_event_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text;
  v_current_decision text;
  v_requester uuid;
  v_recorder uuid;
begin
  -- 要求事項は名乗った基準の版のもの
  if not exists (
    select 1 from disclosure_items i
     where i.id = new.item_id and i.framework_version_id = new.framework_version_id
  ) then
    raise exception 'T4D_EXCLUSION_SCOPE: 基準の版に属さない要求事項です'
      using errcode = '23514';
  end if;

  -- 判断の行（理由）は同じ組織のもの。今の区分・理由とダイジェストが一致すること
  if new.source = 'ssbj_assessment' then
    select case when new.decision = 'not_applicable' then a.applicability_reason
                else a.materiality_reason end,
           case when a.applicability = 'not_applicable' then 'not_applicable'
                when a.materiality = 'not_material' then 'not_material'
                else null end
      into v_reason, v_current_decision
      from ssbj_assessments a
     where a.organization_id = new.organization_id
       and a.reporting_period_id = new.reporting_period_id
       and a.item_id = new.item_id;
  else
    if not exists (
      select 1 from project_frameworks pf
       where pf.id = new.project_framework_id
         and pf.organization_id = new.organization_id
         and pf.framework_version_id = new.framework_version_id
    ) then
      raise exception 'T4D_EXCLUSION_SCOPE: プロジェクトの基準が見つかりません'
        using errcode = '23514';
    end if;
    select a.applicability_reason,
           case when a.applicability in ('not_applicable', 'not_material') then a.applicability end,
           a.decided_by
      into v_reason, v_current_decision, v_recorder
      from project_requirement_assessments a
     where a.organization_id = new.organization_id
       and a.project_framework_id = new.project_framework_id
       and a.item_id = new.item_id;
  end if;

  if new.event in ('requested', 'approved') then
    if v_current_decision is distinct from new.decision
       or t4d.exclusion_reason_digest(new.decision, v_reason) <> new.reason_digest then
      raise exception 'T4D_EXCLUSION_STALE: 判断の区分・理由が申請の内容と一致しません（理由を変えた場合は申請し直してください）'
        using errcode = '23514';
    end if;
  end if;

  if new.event = 'requested' then
    if not t4d.user_has_permission(new.organization_id, new.actor_user_id, 'enterprise.disclosure.write') then
      raise exception 'T4D_EXCLUSION_FORBIDDEN: 申請には開示の編集権限が必要です'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- 承認・差戻し・取り下げ: 同じ内容（ダイジェスト）の申請が先にあること
  select e.actor_user_id into v_requester
    from requirement_exclusion_events e
   where e.organization_id = new.organization_id
     and e.item_id = new.item_id
     and e.reporting_period_id = new.reporting_period_id
     and e.project_framework_id is not distinct from new.project_framework_id
     and e.reason_digest = new.reason_digest
     and e.event = 'requested'
   order by e.created_at desc
   limit 1;
  if v_requester is null then
    raise exception 'T4D_EXCLUSION_NO_REQUEST: 同じ内容の申請がありません'
      using errcode = '23514';
  end if;

  if new.event = 'withdrawn' then
    if new.actor_user_id <> v_requester
       and not t4d.user_has_permission(new.organization_id, new.actor_user_id, 'enterprise.disclosure.write') then
      raise exception 'T4D_EXCLUSION_FORBIDDEN: 申請を取り下げられるのは申請者か編集権限者です'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- 承認・差戻し: 申請者・判断を記録した人と別の、開示の承認権限を持つ人。
  -- SSBJ の評価の行は理由以外の列（担当部署など）も同じ更新者に残るため、記録者の検査はプロジェクトの判断だけで行う
  if new.actor_user_id = v_requester then
    raise exception 'T4D_EXCLUSION_SOD: 申請者は承認・差戻しできません'
      using errcode = '42501';
  end if;
  if new.event = 'approved' and v_recorder is not null and new.actor_user_id = v_recorder then
    raise exception 'T4D_EXCLUSION_SOD: 理由を記録した人は承認できません'
      using errcode = '42501';
  end if;
  if not t4d.user_has_permission(new.organization_id, new.actor_user_id, 'enterprise.disclosure.approve') then
    raise exception 'T4D_EXCLUSION_FORBIDDEN: 承認・差戻しには開示の承認権限が必要です'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger requirement_exclusion_events_guard
  before insert on requirement_exclusion_events
  for each row execute function t4d.requirement_exclusion_event_guard();

create trigger requirement_exclusion_events_immutable
  before update or delete on requirement_exclusion_events
  for each row execute function t4d.forbid_mutation();

-- ----------------------------------------------------------------------
-- 3. 定性情報と要求事項の直接の対応付け
-- ----------------------------------------------------------------------

create table narrative_requirement_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  narrative_record_id uuid not null,
  framework_version_id uuid not null references disclosure_framework_versions (id) on delete restrict,
  item_id uuid not null references disclosure_items (id) on delete restrict,
  created_at timestamptz not null default now(),
  created_by uuid not null references profiles (id),
  /** 外した日時（物理削除はしない） */
  deleted_at timestamptz,
  deleted_by uuid references profiles (id),

  constraint narrative_requirement_links_record_matches
    foreign key (narrative_record_id, organization_id)
    references narrative_records (id, organization_id) on delete cascade,
  constraint narrative_requirement_links_deleted_pair check ((deleted_at is null) = (deleted_by is null))
);

create unique index narrative_requirement_links_unique
  on narrative_requirement_links (narrative_record_id, item_id) where deleted_at is null;

comment on table narrative_requirement_links is
  '定性情報と要求事項の直接の対応付け。原稿が無くても基準別の不足を出すために使う。外すときは deleted_at を入れる。';

create or replace function t4d.narrative_requirement_link_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from disclosure_items i
     where i.id = new.item_id and i.framework_version_id = new.framework_version_id
  ) then
    raise exception 'T4D_REQUIREMENT_SCOPE: 基準の版に属さない要求事項は対応付けられません'
      using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and (
    new.narrative_record_id is distinct from old.narrative_record_id
    or new.item_id is distinct from old.item_id
    or new.framework_version_id is distinct from old.framework_version_id
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
    or (old.deleted_at is not null)
  ) then
    raise exception 'T4D_IMMUTABLE: 対応付けは外す（deleted_at）以外に変更できません'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger narrative_requirement_links_guard
  before insert or update on narrative_requirement_links
  for each row execute function t4d.narrative_requirement_link_guard();

create trigger narrative_requirement_links_created_self
  before insert on narrative_requirement_links
  for each row execute function t4d.csrd_actor_must_be_self('created_by', 'created_at');
create trigger narrative_requirement_links_deleted_self
  before update on narrative_requirement_links
  for each row execute function t4d.csrd_actor_must_be_self('deleted_by', 'deleted_at');

-- ----------------------------------------------------------------------
-- 4. 節の要求事項は節の基準の版のものに限る（配列は外部キーにできないため）
-- ----------------------------------------------------------------------

create or replace function t4d.block_requirement_items_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if cardinality(new.requirement_item_ids) = 0 then
    return new;
  end if;
  if exists (
    select 1 from unnest(new.requirement_item_ids) as r(item_id)
     where not exists (
       select 1 from disclosure_items i
        where i.id = r.item_id and i.framework_version_id = new.framework_version_id
     )
  ) then
    raise exception 'T4D_REQUIREMENT_SCOPE: 節の基準の版に属さない要求事項は対応付けられません'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger disclosure_blocks_requirement_items_guard
  before insert or update of requirement_item_ids, framework_version_id on disclosure_blocks
  for each row execute function t4d.block_requirement_items_guard();

-- ----------------------------------------------------------------------
-- 5. 横断対応表（テナント横断のマスター）
-- ----------------------------------------------------------------------

create table requirement_crosswalks (
  id uuid primary key default gen_random_uuid(),
  from_item_id uuid not null references disclosure_items (id) on delete cascade,
  /** 対応先の基準の版（対応先が無い場合も、どの基準に対応先が無いのかを示す） */
  to_framework_version_id uuid not null references disclosure_framework_versions (id) on delete cascade,
  /** 対応先の要求事項。relation が no_counterpart のときだけ null */
  to_item_id uuid references disclosure_items (id) on delete cascade,
  relation text not null check (relation in ('equivalent', 'partial', 'related', 'no_counterpart')),
  rationale text not null default '',
  source text not null check (source in ('sample_fixture', 'suslab_curated')),
  source_ref text,
  verified_at date,
  verified_by text,
  created_at timestamptz not null default now(),

  constraint requirement_crosswalks_target_shape
    check ((relation = 'no_counterpart') = (to_item_id is null)),
  constraint requirement_crosswalks_not_self check (to_item_id is null or to_item_id <> from_item_id)
);

create unique index requirement_crosswalks_unique
  on requirement_crosswalks (from_item_id, to_framework_version_id, coalesce(to_item_id, '00000000-0000-0000-0000-000000000000'::uuid));

comment on table requirement_crosswalks is
  'SSBJ ↔ ESRS／ESRS-40a の横断対応のマスター（テナント横断）。参照だけ。サンプル（sample_fixture）は架空。';

create or replace function t4d.requirement_crosswalk_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.to_item_id is not null and not exists (
    select 1 from disclosure_items i
     where i.id = new.to_item_id and i.framework_version_id = new.to_framework_version_id
  ) then
    raise exception 'T4D_REQUIREMENT_SCOPE: 対応先の要求事項が対応先の版に属しません'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger requirement_crosswalks_guard
  before insert or update on requirement_crosswalks
  for each row execute function t4d.requirement_crosswalk_guard();

-- ----------------------------------------------------------------------
-- 6. SSBJ の設定を確定した時点の基準の版（null は公開中の版）
-- ----------------------------------------------------------------------

alter table ssbj_analysis_settings
  add column framework_version_id uuid references disclosure_framework_versions (id) on delete restrict;

comment on column ssbj_analysis_settings.framework_version_id is
  '設定を確定した時点の SSBJ の基準の版。新しい版を足しても過年度の画面が変わらないように固定する。null は公開中の版。';

-- ----------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------

alter table project_requirement_assessments enable row level security;
alter table project_requirement_assessment_events enable row level security;
alter table requirement_exclusion_events enable row level security;
alter table narrative_requirement_links enable row level security;
alter table requirement_crosswalks enable row level security;

create policy project_requirement_assessments_select on project_requirement_assessments
  for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy project_requirement_assessments_insert on project_requirement_assessments
  for insert to authenticated
  with check (t4d.has_permission(organization_id, 'enterprise.disclosure.write'));
create policy project_requirement_assessments_update on project_requirement_assessments
  for update to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.disclosure.write'))
  with check (t4d.has_permission(organization_id, 'enterprise.disclosure.write'));

create policy project_requirement_assessment_events_select on project_requirement_assessment_events
  for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy project_requirement_assessment_events_insert on project_requirement_assessment_events
  for insert to authenticated
  with check (
    actor_user_id = auth.uid()
    and t4d.has_permission(organization_id, 'enterprise.disclosure.write')
  );

create policy requirement_exclusion_events_select on requirement_exclusion_events
  for select to authenticated
  using (t4d.is_org_member(organization_id));
-- 申請・取り下げは編集権限、承認・差戻しは承認権限（トリガが名義人の権限と職務分離を確かめる）
create policy requirement_exclusion_events_insert on requirement_exclusion_events
  for insert to authenticated
  with check (
    actor_user_id = auth.uid()
    and (
      (event in ('requested', 'withdrawn')
        and t4d.has_permission(organization_id, 'enterprise.disclosure.write'))
      or (event in ('approved', 'returned')
        and t4d.has_permission(organization_id, 'enterprise.disclosure.approve'))
    )
  );

create policy narrative_requirement_links_select on narrative_requirement_links
  for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy narrative_requirement_links_insert on narrative_requirement_links
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and t4d.has_permission(organization_id, 'enterprise.disclosure.write')
  );
create policy narrative_requirement_links_update on narrative_requirement_links
  for update to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.disclosure.write'))
  with check (t4d.has_permission(organization_id, 'enterprise.disclosure.write'));

-- マスター: 認証済みの参照だけ。書込ポリシーは作らない
create policy requirement_crosswalks_select on requirement_crosswalks
  for select to authenticated
  using (true);
