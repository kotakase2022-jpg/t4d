-- ----------------------------------------------------------------------
-- テナントの終了（削除）手順の保守関数（トライアル対応 2026-10: NF-30）
--
-- トライアル終了時に「継続移行またはデータ返却・削除」を合意する。削除は運営（Suslab）が手順書
-- （docs/operations/tenant-offboarding.md）に従って、DB の所有者のロールで 1 組織ずつ実行する。
--
-- 1. tenant_lifecycle_records: 削除の記録。顧客の内容を持たない（組織コードのハッシュ・表ごとの件数・
--    返却 manifest の sha256・実行者の表示名・日時だけ）。組織への外部キーを持たない（削除後も残す）。
--    RLS は有効にし、authenticated のポリシーは作らない（Service Role の参照だけ）。
-- 2. t4d.offboard_organization(org, confirm_code, manifest_sha256, executed_by_label):
--    security definer。authenticated・anon・service_role から EXECUTE を剥奪し、所有者だけが実行できる。
--    確認コード（組織コード）が一致し、保証側の記録（案件）が無いときだけ動く。
--    organization_id を持つ表の行を消し、organizations の行は deleted_at を入れて残す
--    （監査ログ・保証側の記録は合意まで削除しない: 判断事項 D17 の既定。Storage の実体・Auth ユーザーは手順書）。
-- 3. t4d.forbid_mutation() の差し替え: 追記専用の表の DELETE は、上の関数の中でだけ立てる
--    トランザクション内の設定（t4d.offboarding_organization_id）が立ち、実行ロールが関数の所有者で、
--    行の organization_id が設定と一致するときだけ通す。UPDATE は常に止める。
--    利用者が自分で設定を立てても、実行ロールが所有者でないため越えられない。
--
-- ロールバック: 旧 forbid_mutation の本文（0001）で create or replace し、offboard_organization の
-- EXECUTE を誰にも与えない（関数・表は残す。DROP しない）。docs/known-limitations.md §6。
-- ----------------------------------------------------------------------

create table tenant_lifecycle_records (
  id uuid primary key default gen_random_uuid(),
  event text not null check (event in ('offboarded')),
  /** 組織コードの sha256（顧客の名称・コードそのものは持たない） */
  organization_code_hash text not null check (organization_code_hash ~ '^[0-9a-f]{64}$'),
  /** 表ごとの削除件数 */
  table_counts jsonb not null check (jsonb_typeof(table_counts) = 'object'),
  return_manifest_sha256 text check (return_manifest_sha256 is null or return_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  executed_by_label text not null check (btrim(executed_by_label) <> ''),
  executed_at timestamptz not null default now()
);

comment on table tenant_lifecycle_records is
  'テナントの終了（削除）の記録。顧客の内容を持たない。authenticated からは読めない。';

create trigger tenant_lifecycle_records_immutable
  before update or delete on tenant_lifecycle_records
  for each row execute function t4d.forbid_mutation();

alter table tenant_lifecycle_records enable row level security;

-- authenticated のポリシーは作らない。運営の確認用に Service Role の参照だけを明示する
create policy tenant_lifecycle_records_service_select on tenant_lifecycle_records
  for select to service_role using (true);

-- ----------------------------------------------------------------------
-- 保守関数
-- ----------------------------------------------------------------------

create or replace function t4d.offboard_organization(
  p_organization_id uuid,
  p_confirm_code text,
  p_return_manifest_sha256 text default null,
  p_executed_by_label text default 'operator'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org organizations%rowtype;
  v_tables text[];
  v_table text;
  v_count bigint;
  v_counts jsonb := '{}'::jsonb;
  v_remaining text[];
  v_retry text[];
  v_progress boolean;
  v_pass integer := 0;
  v_record_id uuid := gen_random_uuid();
begin
  select * into v_org from organizations where id = p_organization_id;
  if not found or v_org.deleted_at is not null then
    raise exception 'T4D_OFFBOARD_NOT_FOUND: 組織が見つかりません'
      using errcode = '23514';
  end if;
  if v_org.type <> 'enterprise' then
    raise exception 'T4D_OFFBOARD_BLOCKED: 企業テナントだけを終了できます'
      using errcode = '23514';
  end if;
  if p_confirm_code is distinct from v_org.code then
    raise exception 'T4D_OFFBOARD_CONFIRM_MISMATCH: 確認コードが組織コードと一致しません'
      using errcode = '23514';
  end if;
  -- 保証側の記録（案件・調書・保証側スナップショット）は合意まで消さない
  if exists (select 1 from engagements e where e.client_organization_id = p_organization_id) then
    raise exception 'T4D_OFFBOARD_BLOCKED: 保証側の案件が残っています。保証人と合意した扱いに従ってから実行してください'
      using errcode = '23514';
  end if;

  -- organization_id を持つ表（アクセスの記録は監査ログとして残す）
  select array_agg(c.table_name::text order by c.table_name)
    into v_tables
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
   where c.table_schema = 'public'
     and c.column_name = 'organization_id'
     and t.table_type = 'BASE TABLE'
     and c.table_name not in ('storage_access_events', 'tenant_lifecycle_records');

  foreach v_table in array coalesce(v_tables, '{}') loop
    execute format('select count(*) from %I where organization_id = $1', v_table)
      into v_count using p_organization_id;
    if v_count > 0 then
      v_counts := v_counts || jsonb_build_object(v_table, v_count);
    end if;
  end loop;

  -- この関数の中でだけ、追記専用の表の DELETE を通す（t4d.forbid_mutation が見る）
  perform set_config('t4d.offboarding_organization_id', p_organization_id::text, true);

  -- 参照の順を固定せず、外部キーで止まった表を後回しにして進まなくなるまで繰り返す
  v_remaining := coalesce(v_tables, '{}');
  loop
    v_pass := v_pass + 1;
    v_progress := false;
    v_retry := '{}';
    foreach v_table in array v_remaining loop
      begin
        execute format('delete from %I where organization_id = $1', v_table) using p_organization_id;
        v_progress := true;
      exception when foreign_key_violation then
        v_retry := v_retry || v_table;
      end;
    end loop;
    v_remaining := v_retry;
    exit when cardinality(v_remaining) = 0;
    if not v_progress or v_pass > 30 then
      raise exception 'T4D_OFFBOARD_FK: 削除できない表があります: %', array_to_string(v_remaining, ', ')
        using errcode = '23503';
    end if;
  end loop;

  perform set_config('t4d.offboarding_organization_id', '', true);

  update organizations
     set deleted_at = now(), updated_at = now()
   where id = p_organization_id;

  insert into tenant_lifecycle_records (
    id, event, organization_code_hash, table_counts, return_manifest_sha256, executed_by_label
  ) values (
    v_record_id,
    'offboarded',
    encode(sha256(convert_to(v_org.code, 'UTF8')), 'hex'),
    v_counts,
    p_return_manifest_sha256,
    coalesce(nullif(btrim(p_executed_by_label), ''), 'operator')
  );
  return v_record_id;
end;
$$;

comment on function t4d.offboard_organization(uuid, text, text, text) is
  'テナントの終了（削除）。所有者だけが実行できる。手順は docs/operations/tenant-offboarding.md。';

-- 0014 の「t4d の全関数を authenticated へ」と既定の PUBLIC への EXECUTE を剥奪し、所有者だけにする
revoke all on function t4d.offboard_organization(uuid, text, text, text) from public;
revoke all on function t4d.offboard_organization(uuid, text, text, text) from anon;
revoke all on function t4d.offboard_organization(uuid, text, text, text) from authenticated;
revoke all on function t4d.offboard_organization(uuid, text, text, text) from service_role;

-- ----------------------------------------------------------------------
-- 追記専用のトリガ関数の差し替え（0001 の本文に、終了処理の中の DELETE だけを通す条件を足す）
-- ----------------------------------------------------------------------

create or replace function t4d.forbid_mutation()
returns trigger
language plpgsql
as $$
declare
  v_target text;
  v_owner name;
begin
  if tg_op = 'DELETE' then
    v_target := coalesce(current_setting('t4d.offboarding_organization_id', true), '');
    if v_target <> '' then
      select r.rolname into v_owner
        from pg_proc p
        join pg_roles r on r.oid = p.proowner
       where p.oid = to_regprocedure('t4d.offboard_organization(uuid,text,text,text)');
      if v_owner is not null
         and current_user = v_owner
         and (to_jsonb(old) ->> 'organization_id') = v_target then
        return old;
      end if;
    end if;
  end if;
  raise exception 'T4D_IMMUTABLE: % は追記専用です（% は許可されていません）',
    tg_table_name, tg_op
    using errcode = '42501';
end;
$$;
