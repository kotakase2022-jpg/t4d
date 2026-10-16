-- ----------------------------------------------------------------------
-- トライアルの範囲・別途協議・削除の後に残るもの（2026-10-16 の要望 ①④⑥⑦。CR-22・24・26・27）
--
-- 1. t4d.is_offboarding_delete(p_row jsonb): 終了処理（t4d.offboard_organization）の中の DELETE かを判定する。
--    関数の所有者の検査を 4 引数・5 引数の両方の署名で行う（0058 の forbid_mutation は 4 引数だけを見ていた）。
--    追記専用のトリガ（forbid_mutation）と、0061〜0065 の独自の不変トリガがこれを使い、終了処理の DELETE だけを通す。
-- 2. organization_data_terms.backup_residual_days: 削除の後もバックアップに残る日数の合意値（0〜400。null は未合意）。
--    追記専用の表への列の追加（既存の行は null）。
-- 3. trial_feedback_items.scope_kind: 別途協議の区分（大幅な拠点追加・大量の PDF 等の一次データ処理・
--    外部システムとの個別連携・新規機能の個別開発）。費用区分が別途協議のときだけ入れられる。
-- 4. trial_scenarios.theme の CHECK を作り直して calculation_reconciliation（算定の再現と整合性の確認）を足す。
-- 5. tenant_lifecycle_records に backup_residual_days・backup_purge_due_on。
--    t4d.offboard_organization(uuid, text, text, text, integer) を足し、旧 4 引数版は新版を null で呼ぶ。
--    EXECUTE の剥奪は新しい署名にも。
-- 6. 終了処理で組織の行を匿名化する（name＝「終了した組織」・legal_name＝null・code＝'offboarded-'＋コードの
--    sha256 の先頭 12 桁）。削除の記録（組織コードのハッシュ）と同じ考え方で、顧客の名称を DB とバックアップに残さない。
--    監査ログ（audit_events）は既定どおり残す（判断事項 D8）。
--
-- ロールバック: 列・関数・制約は残して使わなくする（DROP しない）。CHECK を戻す SQL・forbid_mutation の 0058 の本文は
-- docs/known-limitations.md §6。
-- ----------------------------------------------------------------------

-- ----------------------------------------------------------------------
-- 1. 終了処理の中の DELETE か
-- ----------------------------------------------------------------------

-- security definer にしない（current_user は呼び出した側のロール。終了処理の中では関数の所有者になる）
create or replace function t4d.is_offboarding_delete(p_row jsonb)
returns boolean
language plpgsql
stable
as $$
declare
  v_target text;
  v_owner4 name;
  v_owner5 name;
begin
  v_target := coalesce(current_setting('t4d.offboarding_organization_id', true), '');
  if v_target = '' then
    return false;
  end if;
  select r.rolname into v_owner4
    from pg_proc p
    join pg_roles r on r.oid = p.proowner
   where p.oid = to_regprocedure('t4d.offboard_organization(uuid,text,text,text)');
  select r.rolname into v_owner5
    from pg_proc p
    join pg_roles r on r.oid = p.proowner
   where p.oid = to_regprocedure('t4d.offboard_organization(uuid,text,text,text,integer)');
  if (v_owner4 is null or current_user <> v_owner4)
     and (v_owner5 is null or current_user <> v_owner5) then
    return false;
  end if;
  return (p_row ->> 'organization_id') = v_target;
end;
$$;

comment on function t4d.is_offboarding_delete(jsonb) is
  '終了処理（t4d.offboard_organization の 4 引数・5 引数のどちらか）の中で、その組織の行を消す DELETE か。';

create or replace function t4d.forbid_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and t4d.is_offboarding_delete(to_jsonb(old)) then
    return old;
  end if;
  raise exception 'T4D_IMMUTABLE: % は追記専用です（% は許可されていません）',
    tg_table_name, tg_op
    using errcode = '42501';
end;
$$;

-- ----------------------------------------------------------------------
-- 2. バックアップの残存期間（合意値）
-- ----------------------------------------------------------------------

alter table organization_data_terms
  add column backup_residual_days integer
    check (backup_residual_days is null or backup_residual_days between 0 and 400);

comment on column organization_data_terms.backup_residual_days is
  '削除の後もバックアップに残る日数の合意値（0〜400）。null は未合意（消去の見込み日を推測で出さない）。';

-- ----------------------------------------------------------------------
-- 3. 別途協議の区分
-- ----------------------------------------------------------------------

alter table trial_feedback_items
  add column scope_kind text
    check (scope_kind in ('site_expansion', 'bulk_primary_data', 'system_integration', 'custom_development'));

alter table trial_feedback_items
  add constraint trial_feedback_items_scope_kind_separate
    check (scope_kind is null or cost_class = 'separate_estimate');

comment on column trial_feedback_items.scope_kind is
  '別途協議の区分。費用区分が別途協議（separate_estimate）のときだけ入れる。';

-- ----------------------------------------------------------------------
-- 4. 検証シナリオの主題
-- ----------------------------------------------------------------------

alter table trial_scenarios drop constraint trial_scenarios_theme_check;
alter table trial_scenarios
  add constraint trial_scenarios_theme_check check (theme in (
    'traceability', 'gap_distinction', 'approval_change', 'output_reuse',
    'usability', 'work_time', 'operations', 'calculation_reconciliation'
  ));

-- ----------------------------------------------------------------------
-- 5・6. 削除の記録の列と終了処理の関数（5 引数）
-- ----------------------------------------------------------------------

alter table tenant_lifecycle_records
  add column backup_residual_days integer
    check (backup_residual_days is null or backup_residual_days between 0 and 400),
  add column backup_purge_due_on date;

comment on column tenant_lifecycle_records.backup_purge_due_on is
  'バックアップから消える見込みの日（削除日＋残存期間。残存期間が未合意なら null）。';

create or replace function t4d.offboard_organization(
  p_organization_id uuid,
  p_confirm_code text,
  p_return_manifest_sha256 text,
  p_executed_by_label text,
  p_backup_residual_days integer
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
  v_code_hash text;
  v_deleted_on date;
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
  if p_backup_residual_days is not null
     and (p_backup_residual_days < 0 or p_backup_residual_days > 400) then
    raise exception 'T4D_OFFBOARD_RESIDUAL_DAYS: バックアップの残存期間は 0〜400 日で指定してください'
      using errcode = '23514';
  end if;
  -- 保証側の記録（案件・調書・保証側スナップショット）は合意まで消さない
  if exists (select 1 from engagements e where e.client_organization_id = p_organization_id) then
    raise exception 'T4D_OFFBOARD_BLOCKED: 保証側の案件が残っています。保証人と合意した扱いに従ってから実行してください'
      using errcode = '23514';
  end if;

  -- organization_id を持つ表。storage_access_events は対象から外しているが、file_versions の削除に
  -- 連鎖して消える（0005 の on delete cascade。comment on function を参照）
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

  -- この関数の中でだけ、追記専用の表の DELETE を通す（t4d.is_offboarding_delete が見る）
  perform set_config('t4d.offboarding_organization_id', p_organization_id::text, true);

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

  v_code_hash := encode(sha256(convert_to(v_org.code, 'UTF8')), 'hex');
  -- 組織の行は外部キーの参照先として残し、顧客の名称・正式名・コードを残さない
  update organizations
     set name = '終了した組織',
         legal_name = null,
         code = 'offboarded-' || left(v_code_hash, 12),
         deleted_at = now(),
         updated_at = now()
   where id = p_organization_id;

  v_deleted_on := (now() at time zone 'Asia/Tokyo')::date;
  insert into tenant_lifecycle_records (
    id, event, organization_code_hash, table_counts, return_manifest_sha256, executed_by_label,
    backup_residual_days, backup_purge_due_on
  ) values (
    v_record_id,
    'offboarded',
    v_code_hash,
    v_counts,
    p_return_manifest_sha256,
    coalesce(nullif(btrim(p_executed_by_label), ''), 'operator'),
    p_backup_residual_days,
    case when p_backup_residual_days is null then null else v_deleted_on + p_backup_residual_days end
  );
  return v_record_id;
end;
$$;

comment on function t4d.offboard_organization(uuid, text, text, text, integer) is
  'テナントの終了（削除）。所有者だけが実行できる。組織の行は匿名化して残す。資料へのアクセスの記録（storage_access_events）は削除の対象の表から外しているが、file_versions の削除に連鎖して消える（残らない）。手順は docs/operations/tenant-offboarding.md。';

-- 旧 4 引数版は新しい版を残存期間 null（未合意）で呼ぶ
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
begin
  return t4d.offboard_organization(
    p_organization_id,
    p_confirm_code,
    p_return_manifest_sha256,
    p_executed_by_label,
    null::integer
  );
end;
$$;

comment on function t4d.offboard_organization(uuid, text, text, text) is
  'テナントの終了（削除）。バックアップの残存期間を指定しない旧い呼び方（5 引数版を null で呼ぶ）。所有者だけが実行できる。';

revoke all on function t4d.offboard_organization(uuid, text, text, text, integer) from public;
revoke all on function t4d.offboard_organization(uuid, text, text, text, integer) from anon;
revoke all on function t4d.offboard_organization(uuid, text, text, text, integer) from authenticated;
revoke all on function t4d.offboard_organization(uuid, text, text, text, integer) from service_role;
revoke all on function t4d.offboard_organization(uuid, text, text, text) from public;
revoke all on function t4d.offboard_organization(uuid, text, text, text) from anon;
revoke all on function t4d.offboard_organization(uuid, text, text, text) from authenticated;
revoke all on function t4d.offboard_organization(uuid, text, text, text) from service_role;
