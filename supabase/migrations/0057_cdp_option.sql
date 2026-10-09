-- ----------------------------------------------------------------------
-- CDP 対応オプションの組織単位の有効化・CDP 回答と T4D の情報の対応付け・回答の承認の職務分離
-- （トライアル対応 2026-10: NF-38・NF-39）
--
-- 1. organization_options: 契約で開く有償の機能（option_key='cdp'）。組織メンバーは参照だけ。
--    書込ポリシーは作らない（Suslab が Service Role・払い出しスクリプトで設定する。顧客の管理者が自分で開けない）。
--    organization_feature_settings（顧客が切り替える表示の設定）には入れない。権限キーも足さない
--    （契約は役割の権限ではない）。
-- 2. response_content_links: CDP 回答と、確認済みの定性情報・承認済みの原稿の節・SSBJ 要求事項の対応付け。
--    外すときは deleted_at を入れる（物理削除しない）。
-- 3. disclosure_responses の承認の職務分離（CDP・CSRD の回答で共通）: 現在の版を作った人は承認できない。
--    利用者の JWT による書込だけを見る（Service Role・seed は対象外。0037 と同じ）。
-- ロールバック方針は docs/known-limitations.md §6。
-- ----------------------------------------------------------------------

create table organization_options (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  option_key text not null check (option_key in ('cdp')),
  enabled boolean not null default false,
  contract_ref text not null default '',
  valid_from date,
  valid_to date,
  note text not null default '',
  set_at timestamptz not null default now(),
  set_by_label text not null default '',
  constraint organization_options_unique unique (organization_id, option_key),
  constraint organization_options_valid_order
    check (valid_from is null or valid_to is null or valid_from <= valid_to)
);

comment on table organization_options is
  '契約で開く有償オプション（CDP 対応など）。組織メンバーは参照だけで、書込は運営（Service Role）だけ。';

create table response_content_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  item_id uuid not null references disclosure_items (id) on delete restrict,
  target_kind text not null
    check (target_kind in ('narrative_record', 'disclosure_block', 'requirement_item')),
  target_id uuid not null,
  link_source text not null default 'manual' check (link_source in ('manual', 'ai_adopted')),
  ai_run_id uuid,
  confirmed_by uuid not null references profiles (id),
  confirmed_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references profiles (id),

  constraint response_content_links_ai_run_matches
    foreign key (ai_run_id, organization_id)
    references ai_runs (id, organization_id),
  constraint response_content_links_ai_origin
    check ((link_source = 'ai_adopted') = (ai_run_id is not null)),
  constraint response_content_links_deleted_pair check ((deleted_at is null) = (deleted_by is null))
);

create unique index response_content_links_unique
  on response_content_links (organization_id, item_id, target_kind, target_id)
  where deleted_at is null;

comment on table response_content_links is
  'CDP 等の回答と T4D の情報（定性情報・原稿の節・SSBJ 要求事項）の対応付け。人が確定したものだけ。';

create or replace function t4d.response_content_link_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - array['deleted_at', 'deleted_by'])
       is distinct from (to_jsonb(old) - array['deleted_at', 'deleted_by'])
       or old.deleted_at is not null then
      raise exception 'T4D_IMMUTABLE: 対応付けは外す（deleted_at）以外に変更できません'
        using errcode = '42501';
    end if;
    return new;
  end if;
  if new.target_kind = 'narrative_record' and not exists (
    select 1 from narrative_records r
     where r.id = new.target_id and r.organization_id = new.organization_id
  ) then
    raise exception 'T4D_TENANT_SCOPE: 同じ組織の定性情報だけを対応付けられます'
      using errcode = '23514';
  elsif new.target_kind = 'disclosure_block' and not exists (
    select 1 from disclosure_blocks b
     where b.id = new.target_id and b.organization_id = new.organization_id
  ) then
    raise exception 'T4D_TENANT_SCOPE: 同じ組織の原稿の節だけを対応付けられます'
      using errcode = '23514';
  elsif new.target_kind = 'requirement_item' and not exists (
    select 1 from disclosure_items i where i.id = new.target_id
  ) then
    raise exception 'T4D_TENANT_SCOPE: 要求事項が見つかりません'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger response_content_links_guard
  before insert or update on response_content_links
  for each row execute function t4d.response_content_link_guard();

create trigger response_content_links_confirmed_self
  before insert on response_content_links
  for each row execute function t4d.csrd_actor_must_be_self('confirmed_by', 'confirmed_at');
create trigger response_content_links_deleted_self
  before update on response_content_links
  for each row execute function t4d.csrd_actor_must_be_self('deleted_by', 'deleted_at');

-- ----------------------------------------------------------------------
-- 回答の承認の職務分離（CDP・CSRD 共通）
-- ----------------------------------------------------------------------

create or replace function t4d.disclosure_response_approval_sod()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_author uuid;
begin
  if auth.uid() is null or new.status <> 'approved' then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and old.status = 'approved'
     and new.current_version_id is not distinct from old.current_version_id
     and new.approved_by is not distinct from old.approved_by then
    return new;
  end if;
  select v.created_by into v_author
    from disclosure_response_versions v
   where v.id = new.current_version_id and v.response_id = new.id;
  if v_author is not null and (v_author = auth.uid() or v_author = new.approved_by) then
    raise exception 'T4D_RESPONSE_SOD: 回答の現在の版を作成した人は承認できません'
      using errcode = '42501';
  end if;
  if new.approved_by is not null and new.approved_by <> auth.uid() then
    raise exception 'T4D_ACTOR_MUST_BE_SELF: 承認は本人の名義でのみ記録できます'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger disclosure_responses_approval_sod
  before insert or update on disclosure_responses
  for each row execute function t4d.disclosure_response_approval_sod();

-- ----------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------

alter table organization_options enable row level security;
alter table response_content_links enable row level security;

-- 参照だけ（書込ポリシーは作らない）
create policy organization_options_select on organization_options for select to authenticated
  using (t4d.is_org_member(organization_id));

create policy response_content_links_select on response_content_links for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy response_content_links_insert on response_content_links for insert to authenticated
  with check (
    confirmed_by = auth.uid()
    and t4d.has_permission(organization_id, 'enterprise.disclosure.write')
  );
create policy response_content_links_update on response_content_links for update to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.disclosure.write'))
  with check (t4d.has_permission(organization_id, 'enterprise.disclosure.write'));
