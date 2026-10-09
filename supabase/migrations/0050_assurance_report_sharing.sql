-- ----------------------------------------------------------------------
-- 承認済みレポートの保証側への共有・保証側のコメントと企業の回答・Sign-off との結び付け
-- （トライアル対応 2026-10: NF-20・21・23）
--
-- 1. shared_report_copies: 企業が承認済みスナップショットを案件へ共有するときに作る「保証側用の写し」。
--    企業と監査法人の接続は engagements と client_access_grants だけ（CLAUDE.md §0.2）なので、
--    report_snapshots に監査法人の SELECT を足さず、共有の行為（企業側）で別表に写しを作る。
--    写しは社内コメント・社内向けの確認事項を除いたもの（アプリの report-copy.ts が作る）。
--    取り下げ（withdrawn_at）だけ 1 回更新でき、他の列はトリガで不変。削除はできない。
-- 2. data_room_items・assurance_snapshot_items の source_type に report_copy を足す（CHECK の付け替え）。
-- 3. review_notes に段落・数値を指す対象列を足す（target_type は report_paragraph・report_metric）。
--    review_notes は監査法人の行なので企業は更新しない。企業の回答は追記専用の review_note_responses に書き、
--    「未回答／回答済み／クリア」は回答の有無と既存の status から導出する。
-- 4. signoffs に共有した写しへの参照（任意）。
-- 5. t4d.assurance_can_read_shared_file_version: 共有中の写しが引用する資料の版を、許諾が Evidence を含む
--    案件のメンバーだけが読める（既存の関数・ポリシーは変えず、追加の SELECT ポリシーだけ）。
--
-- 監査法人に企業原本の UPDATE を与えない（CLAUDE.md §0.3）。ロールバック方針は docs/known-limitations.md §6。
-- ----------------------------------------------------------------------

create table shared_report_copies (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements (id) on delete cascade,
  assurance_firm_id uuid not null references organizations (id) on delete cascade,
  client_organization_id uuid not null references organizations (id) on delete cascade,
  snapshot_id uuid not null,
  /** 共有した時点のスナップショットの内容ハッシュ（写しの元が承認版から変わっていないことの記録） */
  snapshot_content_hash text not null,
  /** 保証側用の写し（社内コメント・社内向け確認事項を除く） */
  copy jsonb not null check (jsonb_typeof(copy) = 'object'),
  copy_hash text not null,
  shared_by uuid not null references profiles (id),
  shared_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  withdrawn_by uuid references profiles (id),

  constraint shared_report_copies_snapshot_matches
    foreign key (snapshot_id, client_organization_id)
    references report_snapshots (id, organization_id) on delete cascade,
  constraint shared_report_copies_withdrawn_pair check ((withdrawn_at is null) = (withdrawn_by is null)),
  constraint shared_report_copies_distinct_orgs check (assurance_firm_id <> client_organization_id)
);

-- 同じ案件へ同じスナップショットを二重に共有しない（取り下げた後の共有し直しはできる）
create unique index shared_report_copies_active_unique
  on shared_report_copies (engagement_id, snapshot_id) where withdrawn_at is null;
create index shared_report_copies_engagement_idx on shared_report_copies (engagement_id, shared_at desc);

comment on table shared_report_copies is
  '保証側へ共有した承認済みレポートの写し。共有は企業側の行為。取り下げ以外は変更・削除できない。';

create or replace function t4d.shared_report_copy_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_engagement engagements%rowtype;
  v_snapshot report_snapshots%rowtype;
begin
  if tg_op = 'UPDATE' then
    -- 取り下げ（withdrawn_at・withdrawn_by を 1 回入れる）だけを許す
    if old.withdrawn_at is not null
       or new.withdrawn_at is null
       or (to_jsonb(new) - array['withdrawn_at', 'withdrawn_by'])
          is distinct from (to_jsonb(old) - array['withdrawn_at', 'withdrawn_by']) then
      raise exception 'T4D_IMMUTABLE: 共有した写しは取り下げ以外に変更できません'
        using errcode = '42501';
    end if;
    if auth.uid() is not null and new.withdrawn_by is distinct from auth.uid() then
      raise exception 'T4D_ACTOR_MUST_BE_SELF: 取り下げは本人の名義でのみ記録できます'
        using errcode = '42501';
    end if;
    return new;
  end if;

  select * into v_engagement from engagements where id = new.engagement_id;
  if not found
     or v_engagement.client_organization_id <> new.client_organization_id
     or v_engagement.assurance_firm_id <> new.assurance_firm_id then
    raise exception 'T4D_SHARE_SCOPE: 自社がクライアントの案件にだけ共有できます'
      using errcode = '23514';
  end if;
  select * into v_snapshot from report_snapshots where id = new.snapshot_id;
  if not found
     or v_snapshot.organization_id <> new.client_organization_id
     or v_snapshot.snapshot_kind <> 'approved'
     or v_snapshot.content_hash <> new.snapshot_content_hash then
    raise exception 'T4D_SHARE_SCOPE: 社内承認済みのスナップショットだけを共有できます'
      using errcode = '23514';
  end if;
  -- 有効な許諾がある案件だけ（許諾の無い案件へ開示本文を流さない）
  if not exists (
    select 1 from client_access_grants g
     where g.engagement_id = new.engagement_id and g.revoked_at is null
  ) then
    raise exception 'T4D_SHARE_SCOPE: 有効なアクセス許諾の無い案件には共有できません'
      using errcode = '23514';
  end if;
  if new.withdrawn_at is not null then
    raise exception 'T4D_SHARE_SCOPE: 取り下げた状態では共有できません'
      using errcode = '23514';
  end if;
  if auth.uid() is not null and new.shared_by <> auth.uid() then
    raise exception 'T4D_ACTOR_MUST_BE_SELF: 共有は本人の名義でのみ記録できます'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger shared_report_copies_guard
  before insert or update on shared_report_copies
  for each row execute function t4d.shared_report_copy_guard();

create trigger shared_report_copies_no_delete
  before delete on shared_report_copies
  for each row execute function t4d.forbid_mutation();

-- ----------------------------------------------------------------------
-- 2. Data Room・保証側スナップショットの取得元に「開示レポート」
-- ----------------------------------------------------------------------

alter table data_room_items
  drop constraint data_room_items_source_type_check;
alter table data_room_items
  add constraint data_room_items_source_type_check
    check (source_type in ('data_point', 'evidence', 'disclosure_response', 'report_copy'));

alter table assurance_snapshot_items
  drop constraint assurance_snapshot_items_source_type_check;
alter table assurance_snapshot_items
  add constraint assurance_snapshot_items_source_type_check
    check (source_type in ('data_point', 'evidence', 'disclosure_response', 'report_copy'));

-- ----------------------------------------------------------------------
-- 3. 保証側のコメントの対象（段落・数値）と企業の回答
-- ----------------------------------------------------------------------

alter table review_notes
  add column target_copy_id uuid references shared_report_copies (id) on delete restrict,
  add column target_block_id uuid,
  add column target_paragraph_id text,
  add column target_data_point_version_id uuid references data_point_versions (id) on delete restrict;

alter table review_notes
  add constraint review_notes_report_target_shape
    check (
      (target_type not in ('report_paragraph', 'report_metric'))
      or (
        target_copy_id is not null
        and (
          (target_type = 'report_paragraph'
            and target_block_id is not null and target_paragraph_id is not null)
          or (target_type = 'report_metric' and target_data_point_version_id is not null)
        )
      )
    );

comment on column review_notes.target_copy_id is
  '保証側のコメントが指す共有レポートの写し（target_type が report_paragraph・report_metric のとき）。';

-- 対象の写しは同じ案件の共有中のもの（取り下げた写しにコメントを起票しない）
create or replace function t4d.review_note_report_target_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.target_copy_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.target_copy_id is not distinct from old.target_copy_id then
    return new;
  end if;
  if not exists (
    select 1 from shared_report_copies c
     where c.id = new.target_copy_id
       and c.engagement_id = new.engagement_id
       and c.withdrawn_at is null
  ) then
    raise exception 'T4D_SHARE_SCOPE: 共有中の開示レポートだけにコメントできます'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger review_notes_report_target_guard
  before insert or update of target_copy_id on review_notes
  for each row execute function t4d.review_note_report_target_guard();

create table review_note_responses (
  id uuid primary key default gen_random_uuid(),
  review_note_id uuid not null references review_notes (id) on delete cascade,
  engagement_id uuid not null references engagements (id) on delete cascade,
  client_organization_id uuid not null references organizations (id) on delete cascade,
  body text not null check (btrim(body) <> '' and length(body) <= 2000),
  responded_by uuid not null references profiles (id),
  responded_at timestamptz not null default now()
);

create index review_note_responses_note_idx on review_note_responses (review_note_id, responded_at);

comment on table review_note_responses is
  '保証側のコメント（クライアントへ共有したもの）への企業の回答（追記専用）。監査法人の行は企業が更新しない。';

create or replace function t4d.review_note_response_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
      from review_notes n
      join engagements e on e.id = n.engagement_id
     where n.id = new.review_note_id
       and n.engagement_id = new.engagement_id
       and n.shared_with_client = true
       and e.client_organization_id = new.client_organization_id
  ) then
    raise exception 'T4D_SHARE_SCOPE: クライアントへ共有されたコメントにだけ回答できます'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger review_note_responses_guard
  before insert on review_note_responses
  for each row execute function t4d.review_note_response_guard();

create trigger review_note_responses_immutable
  before update or delete on review_note_responses
  for each row execute function t4d.forbid_mutation();

-- ----------------------------------------------------------------------
-- 4. Sign-off と共有レポート（任意）
-- ----------------------------------------------------------------------

alter table signoffs
  add column shared_report_copy_id uuid references shared_report_copies (id) on delete restrict,
  add column shared_report_content_hash text;

alter table signoffs
  add constraint signoffs_shared_report_pair
    check ((shared_report_copy_id is null) = (shared_report_content_hash is null));

create or replace function t4d.signoff_shared_report_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.shared_report_copy_id is null then
    return new;
  end if;
  if not exists (
    select 1 from shared_report_copies c
     where c.id = new.shared_report_copy_id
       and c.engagement_id = new.engagement_id
       and c.copy_hash = new.shared_report_content_hash
       and c.withdrawn_at is null
  ) then
    raise exception 'T4D_SHARE_SCOPE: この案件で共有中の開示レポートだけを Sign-off に結び付けられます'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger signoffs_shared_report_guard
  before insert on signoffs
  for each row execute function t4d.signoff_shared_report_guard();

-- ----------------------------------------------------------------------
-- 5. 共有中の写しが引用する資料の版（許諾が Evidence を含む案件のメンバーだけ）
-- ----------------------------------------------------------------------

create or replace function t4d.assurance_can_read_shared_file_version(p_file_version_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from shared_report_copies c
      join engagement_members em
        on em.engagement_id = c.engagement_id
       and em.user_id = auth.uid()
       and em.removed_at is null
     where c.withdrawn_at is null
       and exists (
         select 1 from jsonb_array_elements(coalesce(c.copy -> 'anchors', '[]'::jsonb)) a
          where a ->> 'fileVersionId' = p_file_version_id::text
       )
       and exists (
         select 1 from client_access_grants g
          where g.engagement_id = c.engagement_id
            and g.revoked_at is null
            and g.includes_evidence = true
       )
  );
$$;

comment on function t4d.assurance_can_read_shared_file_version(uuid) is
  '共有中の開示レポートの写しが引用する資料の版を、Evidence を含む許諾がある案件のメンバーが読めるか。';

create policy file_versions_select_shared_report on file_versions for select to authenticated
  using (t4d.assurance_can_read_shared_file_version(id));

create policy files_select_shared_report on files for select to authenticated
  using (exists (
    select 1 from file_versions fv
     where fv.file_id = files.id and t4d.assurance_can_read_shared_file_version(fv.id)
  ));

-- ----------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------

alter table shared_report_copies enable row level security;
alter table review_note_responses enable row level security;

create policy shared_report_copies_select on shared_report_copies for select to authenticated
  using (t4d.is_engagement_member(engagement_id) or t4d.is_org_member(client_organization_id));
-- 共有・取り下げは企業側の行為（許諾の管理権限）
create policy shared_report_copies_insert on shared_report_copies for insert to authenticated
  with check (
    t4d.has_permission(client_organization_id, 'enterprise.grant.manage')
    and shared_by = auth.uid()
  );
create policy shared_report_copies_update on shared_report_copies for update to authenticated
  using (t4d.has_permission(client_organization_id, 'enterprise.grant.manage'))
  with check (t4d.has_permission(client_organization_id, 'enterprise.grant.manage'));

create policy review_note_responses_select on review_note_responses for select to authenticated
  using (t4d.is_engagement_member(engagement_id) or t4d.is_org_member(client_organization_id));
create policy review_note_responses_insert on review_note_responses for insert to authenticated
  with check (
    responded_by = auth.uid()
    and t4d.has_permission(client_organization_id, 'enterprise.disclosure.write')
  );
