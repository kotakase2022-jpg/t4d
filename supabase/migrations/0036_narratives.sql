-- ----------------------------------------------------------------------
-- 定性情報と引用位置（docs/disclosure-first.md §3 0036）
--
-- 開示本文の多くは数値ではなく定性情報（リスク・機会、ガバナンス体制、方針…）で、
-- これまでは materiality_topics の自由記述や ssbj_assessments の抜粋文字列に散っていた。
-- 本文の根拠を「どの資料の・どの版の・どこ」まで辿れるようにするため、
--   narrative_records  … 定性情報の台帳（テーマ・担当・状態）
--   narrative_versions … 内容の版（追記専用）
--   source_anchors     … 根拠資料の引用位置（追記専用）
-- を分けて持つ。
--
-- 版と引用位置は追記専用。確認済みの内容を後から書き換えると、
-- その内容を引用した開示本文の根拠が黙って変わってしまうため。
--
-- テナント整合: 子の organization_id は親と一致させる（0035 と同じ複合外部キー方式）。
-- RLS: 参照は組織メンバー、書込は enterprise.disclosure.write。版・引用位置は本人名義のみ。
-- ----------------------------------------------------------------------

-- 複合外部キーの参照先（既存表への一意制約の追加のみ）
alter table file_versions
  add constraint file_versions_id_org_unique unique (id, organization_id);
alter table extracted_fragments
  add constraint extracted_fragments_id_file_version_unique unique (id, file_version_id);
alter table ai_runs
  add constraint ai_runs_id_org_unique unique (id, organization_id);

create table narrative_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  theme text not null
    check (theme in ('risk_opportunity', 'financial_impact', 'governance', 'strategy', 'policy_other')),
  title text not null check (btrim(title) <> ''),
  owner_user_id uuid references profiles (id),
  owner_department text not null default '',
  tags text[] not null default '{}',
  status text not null default 'draft'
    check (status in ('draft', 'confirmed', 'needs_recheck')),
  current_version_id uuid,
  /** 人が確認した版。確認後に新しい版を作っても、確認済みの版はこちらに残る */
  confirmed_version_id uuid,
  confirmed_by uuid references profiles (id),
  confirmed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  deleted_at timestamptz,

  -- 「確認済み」は誰がどの版を確認したかが揃っているときだけ（AI では確認しない）
  constraint narrative_records_confirmed_requires_actor
    check (
      status <> 'confirmed'
      or (confirmed_version_id is not null and confirmed_by is not null and confirmed_at is not null)
    ),
  constraint narrative_records_id_org_unique unique (id, organization_id)
);

create index narrative_records_org_idx on narrative_records (organization_id, theme);

comment on table narrative_records is
  '定性情報の台帳。内容は narrative_versions に版として追記し、ここは状態と版へのポインタだけを持つ。';

create table narrative_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  narrative_record_id uuid not null,
  version_no integer not null check (version_no > 0),
  reporting_period_id uuid not null,
  scope_note text not null default '',
  /** テンプレート項目。値が無い項目はキー自体を持たない（空文字で「入力済み」に見せない） */
  fields jsonb not null default '{}'::jsonb check (jsonb_typeof(fields) = 'object'),
  body text not null default '',
  source_anchor_ids uuid[] not null default '{}',
  /** 前年度から引き継いだ場合の元の版 */
  carried_from_version_id uuid,
  change_reason text,
  /** AI の候補を人が採用して作った版なら、その実行 ID（AI が版を作ることはない） */
  originated_from_ai_run_id uuid,
  content_hash text not null,
  created_at timestamptz not null default now(),
  created_by uuid references profiles (id),

  constraint narrative_versions_record_matches
    foreign key (narrative_record_id, organization_id)
    references narrative_records (id, organization_id) on delete cascade,
  constraint narrative_versions_period_matches
    foreign key (reporting_period_id, organization_id)
    references reporting_periods (id, organization_id) on delete cascade,
  constraint narrative_versions_carried_from_matches
    foreign key (carried_from_version_id, organization_id)
    references narrative_versions (id, organization_id),
  constraint narrative_versions_ai_run_matches
    foreign key (originated_from_ai_run_id, organization_id)
    references ai_runs (id, organization_id),
  constraint narrative_versions_unique unique (narrative_record_id, version_no),
  constraint narrative_versions_id_org_unique unique (id, organization_id),
  constraint narrative_versions_id_record_unique unique (id, narrative_record_id)
);

create index narrative_versions_record_idx
  on narrative_versions (narrative_record_id, version_no desc);

comment on table narrative_versions is
  '定性情報の版（追記専用）。確認済みの内容を書き換えず、変更は新しい版として残す。';

-- 台帳のポインタは「自分の」版しか指せない。版を追記してから指し直すため遅延可能にする
alter table narrative_records
  add constraint narrative_records_current_version_fk
    foreign key (current_version_id, id)
    references narrative_versions (id, narrative_record_id)
    deferrable initially deferred,
  add constraint narrative_records_confirmed_version_fk
    foreign key (confirmed_version_id, id)
    references narrative_versions (id, narrative_record_id)
    deferrable initially deferred;

create table source_anchors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  file_version_id uuid not null,
  fragment_id uuid,
  anchor_kind text not null
    check (anchor_kind in ('pdf_page', 'heading_paragraph', 'sheet_cell', 'text_range', 'manual_excerpt')),
  page integer check (page is null or page > 0),
  /** 見出し・段落番号・シート!セル など、ページ以外の位置 */
  locator text,
  /** 引用した文言そのもの。資料が差し替わっても、何を根拠にしたかを示せるように写しを持つ */
  quote_text text not null check (btrim(quote_text) <> ''),
  acquired_by text not null check (acquired_by in ('manual', 'extracted')),
  created_at timestamptz not null default now(),
  created_by uuid references profiles (id),

  constraint source_anchors_pdf_page_requires_page
    check (anchor_kind <> 'pdf_page' or page is not null),
  -- 「抽出から取った」と名乗るなら、抽出結果を指していなければならない
  constraint source_anchors_extracted_requires_fragment
    check (acquired_by <> 'extracted' or fragment_id is not null),
  constraint source_anchors_file_version_matches
    foreign key (file_version_id, organization_id)
    references file_versions (id, organization_id) on delete cascade,
  -- 抽出断片は引用元と同じ版のものに限る（別の版・別の資料の断片を混ぜない）
  constraint source_anchors_fragment_matches
    foreign key (fragment_id, file_version_id)
    references extracted_fragments (id, file_version_id),
  constraint source_anchors_id_org_unique unique (id, organization_id)
);

create index source_anchors_file_version_idx on source_anchors (file_version_id);

comment on table source_anchors is
  '根拠資料の引用位置（追記専用）。利用目的は files.usage_purpose で判定する。';

create trigger narrative_versions_immutable
  before update or delete on narrative_versions
  for each row execute function t4d.forbid_mutation();

create trigger source_anchors_immutable
  before update or delete on source_anchors
  for each row execute function t4d.forbid_mutation();

-- ----------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------

alter table narrative_records enable row level security;
alter table narrative_versions enable row level security;
alter table source_anchors enable row level security;

create policy narrative_records_select on narrative_records for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy narrative_records_write on narrative_records for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.disclosure.write'))
  with check (t4d.has_permission(organization_id, 'enterprise.disclosure.write'));

create policy narrative_versions_select on narrative_versions for select to authenticated
  using (t4d.is_org_member(organization_id));
-- 追記専用: UPDATE / DELETE ポリシーは作らない（トリガでも禁止）
create policy narrative_versions_insert on narrative_versions for insert to authenticated
  with check (
    created_by = auth.uid()
    and t4d.has_permission(organization_id, 'enterprise.disclosure.write')
  );

create policy source_anchors_select on source_anchors for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy source_anchors_insert on source_anchors for insert to authenticated
  with check (
    created_by = auth.uid()
    and t4d.has_permission(organization_id, 'enterprise.disclosure.write')
  );
