-- ----------------------------------------------------------------------
-- 組織の XBRL のタグ付け（トライアル対応 2026-10: NF-42 Stage 1）
--
-- 1. organization_filing_identifiers: 提出者の識別子（EDINET コード・LEI・法人番号。デモは scheme='sample'）。
--    編集は enterprise.org.manage。
-- 2. xbrl_tag_mappings: T4D の対象（指標×組織単位×境界、または原稿の節）と概念の対応付け。
--    状態は candidate（候補）→ confirmed（確定）／excluded（対象外・理由必須）。
--    確定は開示の承認権限を持ち、対応付けを作った人と別の人だけ（AI の候補は自動で確定しない）。
--    境界の文字列から軸・decimals・単位を推測しない（対応付けに明示して持つ）。
-- 3. xbrl_tag_mapping_events（追記専用）: 対応付けの変更・確定・対象外の履歴。
-- 4. project_frameworks.taxonomy_package_id: 基準 → XBRL プロファイル（パッケージ）。
--
-- RLS: 参照は組織メンバー、書込は enterprise.disclosure.write（確定はトリガで approve と職務分離を見る）。
-- ロールバック方針は docs/known-limitations.md §6。
-- ----------------------------------------------------------------------

alter table organization_units
  add constraint organization_units_id_org_unique unique (id, organization_id);

create table organization_filing_identifiers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  scheme text not null check (scheme in ('edinet_code', 'lei', 'corporate_number', 'sample')),
  value text not null check (btrim(value) <> '' and length(value) <= 64),
  verified_at timestamptz,
  verified_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  constraint organization_filing_identifiers_unique unique (organization_id, scheme),
  constraint organization_filing_identifiers_verified_pair
    check ((verified_at is null) = (verified_by is null))
);

comment on table organization_filing_identifiers is
  '提出者の識別子（XBRL の entity）。デモは架空の sample だけ。';

create trigger organization_filing_identifiers_set_updated_at
  before update on organization_filing_identifiers
  for each row execute function t4d.set_updated_at();

create table xbrl_tag_mappings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  /** null は組織の既定（プロジェクトを問わない） */
  project_id uuid,
  package_id uuid not null references xbrl_taxonomy_packages (id) on delete restrict,
  concept_id uuid not null references xbrl_concepts (id) on delete restrict,
  target_kind text not null check (target_kind in ('metric', 'block', 'constant')),
  metric_id uuid,
  unit_id uuid,
  boundary text,
  framework_version_id uuid references disclosure_framework_versions (id) on delete restrict,
  section_key text,
  disclosure_item_id uuid references disclosure_items (id) on delete restrict,
  /** 軸 → メンバー（概念の local_name）。境界の文字列から推測しない */
  dimensions jsonb not null default '{}'::jsonb check (jsonb_typeof(dimensions) = 'object'),
  period_role text not null default 'current'
    check (period_role in ('current', 'prior1', 'base_year', 'target')),
  decimals integer check (decimals is null or decimals between -12 and 12),
  scale integer not null default 0 check (scale between -12 and 12),
  status text not null default 'candidate' check (status in ('candidate', 'confirmed', 'excluded')),
  excluded_reason text not null default '',
  origin text not null default 'human' check (origin in ('fixture', 'human', 'ai_adopted')),
  ai_run_id uuid,
  confirmed_by uuid references profiles (id),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  deleted_at timestamptz,

  constraint xbrl_tag_mappings_project_matches
    foreign key (project_id, organization_id)
    references disclosure_projects (id, organization_id) on delete cascade,
  constraint xbrl_tag_mappings_metric_matches
    foreign key (metric_id, organization_id)
    references metric_definitions (id, organization_id) on delete restrict,
  constraint xbrl_tag_mappings_unit_matches
    foreign key (unit_id, organization_id)
    references organization_units (id, organization_id) on delete restrict,
  constraint xbrl_tag_mappings_ai_run_matches
    foreign key (ai_run_id, organization_id)
    references ai_runs (id, organization_id),
  constraint xbrl_tag_mappings_id_org_unique unique (id, organization_id),
  constraint xbrl_tag_mappings_target_shape
    check (
      (target_kind = 'metric' and metric_id is not null)
      or (target_kind = 'block' and framework_version_id is not null and section_key is not null)
      or target_kind = 'constant'
    ),
  constraint xbrl_tag_mappings_excluded_reason
    check (status <> 'excluded' or btrim(excluded_reason) <> ''),
  constraint xbrl_tag_mappings_confirmed_pair
    check ((confirmed_at is null) = (confirmed_by is null)),
  constraint xbrl_tag_mappings_confirmed_requires_actor
    check (status <> 'confirmed' or confirmed_at is not null),
  -- 職務分離: 対応付けを作った人は確定しない（AI 由来の候補も、採用した人と別の人が確定する）
  constraint xbrl_tag_mappings_confirm_sod
    check (confirmed_by is null or created_by is null or confirmed_by <> created_by),
  constraint xbrl_tag_mappings_ai_origin
    check ((origin = 'ai_adopted') = (ai_run_id is not null))
);

create index xbrl_tag_mappings_org_idx on xbrl_tag_mappings (organization_id, package_id);

comment on table xbrl_tag_mappings is
  'T4D の対象と XBRL の概念の対応付け。候補 → 確定（承認権限・作成者と別人）／対象外（理由必須）。AI は確定しない。';

create or replace function t4d.xbrl_tag_mapping_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text;
begin
  select c.kind into v_kind
    from xbrl_concepts c
   where c.id = new.concept_id and c.package_id = new.package_id;
  if not found then
    raise exception 'T4D_XBRL_SCOPE: 概念がパッケージに属しません'
      using errcode = '23514';
  end if;
  -- 値を持つ概念だけに対応付ける（抽象・軸・メンバーに値を付けない）
  if v_kind not in ('item', 'text_block') then
    raise exception 'T4D_XBRL_SCOPE: 抽象・軸・メンバーの概念には対応付けられません'
      using errcode = '23514';
  end if;
  if new.disclosure_item_id is not null and new.framework_version_id is not null and not exists (
    select 1 from disclosure_items i
     where i.id = new.disclosure_item_id and i.framework_version_id = new.framework_version_id
  ) then
    raise exception 'T4D_XBRL_SCOPE: 要求事項が基準の版に属しません'
      using errcode = '23514';
  end if;

  -- 確定: 利用者の JWT による書込は、開示の承認権限を持つ本人の名義だけ（Service Role・seed は対象外）
  if auth.uid() is not null
     and new.status = 'confirmed'
     and (tg_op = 'INSERT' or old.status is distinct from 'confirmed'
          or old.confirmed_by is distinct from new.confirmed_by) then
    if not t4d.has_permission(new.organization_id, 'enterprise.disclosure.approve') then
      raise exception 'T4D_XBRL_FORBIDDEN: 対応付けの確定には開示の承認権限が必要です'
        using errcode = '42501';
    end if;
    if new.confirmed_by is distinct from auth.uid() then
      raise exception 'T4D_ACTOR_MUST_BE_SELF: 確定は本人の名義でのみ記録できます'
        using errcode = '42501';
    end if;
  end if;
  -- 確定・作成の名義を後から差し替えない
  if tg_op = 'UPDATE' and auth.uid() is not null
     and new.created_by is distinct from old.created_by then
    raise exception 'T4D_IMMUTABLE: 対応付けの作成者は変更できません'
      using errcode = '42501';
  end if;
  -- 承認権限だけを持つ人（編集権限なし）は確定の列しか変えられない（0042 の節の更新と同じ考え方）
  if tg_op = 'UPDATE' and auth.uid() is not null
     and not t4d.has_permission(new.organization_id, 'enterprise.disclosure.write')
     and (to_jsonb(new) - array['status', 'confirmed_by', 'confirmed_at', 'updated_at', 'updated_by'])
         is distinct from
         (to_jsonb(old) - array['status', 'confirmed_by', 'confirmed_at', 'updated_at', 'updated_by']) then
    raise exception 'T4D_XBRL_FORBIDDEN: 承認権限だけでは対応付けの内容は変更できません'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger xbrl_tag_mappings_guard
  before insert or update on xbrl_tag_mappings
  for each row execute function t4d.xbrl_tag_mapping_guard();

create trigger xbrl_tag_mappings_set_updated_at
  before update on xbrl_tag_mappings
  for each row execute function t4d.set_updated_at();

create table xbrl_tag_mapping_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  mapping_id uuid not null,
  event text not null
    check (event in ('created', 'updated', 'confirmed', 'excluded', 'restored', 'deleted')),
  before jsonb check (before is null or jsonb_typeof(before) = 'object'),
  after jsonb check (after is null or jsonb_typeof(after) = 'object'),
  reason text not null default '',
  actor_user_id uuid not null references profiles (id),
  created_at timestamptz not null default now(),

  constraint xbrl_tag_mapping_events_mapping_matches
    foreign key (mapping_id, organization_id)
    references xbrl_tag_mappings (id, organization_id) on delete cascade
);

create index xbrl_tag_mapping_events_mapping_idx on xbrl_tag_mapping_events (mapping_id, created_at);

comment on table xbrl_tag_mapping_events is 'XBRL の対応付けの履歴（追記専用）。';

create trigger xbrl_tag_mapping_events_immutable
  before update or delete on xbrl_tag_mapping_events
  for each row execute function t4d.forbid_mutation();

alter table project_frameworks
  add column taxonomy_package_id uuid references xbrl_taxonomy_packages (id) on delete restrict;

comment on column project_frameworks.taxonomy_package_id is
  'この基準の XBRL プロファイル（タクソノミのパッケージ）。null は未設定。';

-- ----------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------

alter table organization_filing_identifiers enable row level security;
alter table xbrl_tag_mappings enable row level security;
alter table xbrl_tag_mapping_events enable row level security;

create policy organization_filing_identifiers_select on organization_filing_identifiers
  for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy organization_filing_identifiers_insert on organization_filing_identifiers
  for insert to authenticated
  with check (t4d.has_permission(organization_id, 'enterprise.org.manage'));
create policy organization_filing_identifiers_update on organization_filing_identifiers
  for update to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.org.manage'))
  with check (t4d.has_permission(organization_id, 'enterprise.org.manage'));

create policy xbrl_tag_mappings_select on xbrl_tag_mappings
  for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy xbrl_tag_mappings_insert on xbrl_tag_mappings
  for insert to authenticated
  with check (t4d.has_permission(organization_id, 'enterprise.disclosure.write'));
create policy xbrl_tag_mappings_update on xbrl_tag_mappings
  for update to authenticated
  using (
    t4d.has_permission(organization_id, 'enterprise.disclosure.write')
    or t4d.has_permission(organization_id, 'enterprise.disclosure.approve')
  )
  with check (
    t4d.has_permission(organization_id, 'enterprise.disclosure.write')
    or t4d.has_permission(organization_id, 'enterprise.disclosure.approve')
  );

create policy xbrl_tag_mapping_events_select on xbrl_tag_mapping_events
  for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy xbrl_tag_mapping_events_insert on xbrl_tag_mapping_events
  for insert to authenticated
  with check (
    actor_user_id = auth.uid()
    and (
      t4d.has_permission(organization_id, 'enterprise.disclosure.write')
      or t4d.has_permission(organization_id, 'enterprise.disclosure.approve')
    )
  );
