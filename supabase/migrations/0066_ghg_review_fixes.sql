-- ----------------------------------------------------------------------
-- Scope1・2 の算定と照合（0061〜0065）のレビュー指摘の修正（2026-10-16 自己監査）
--
-- 1. 算定行の方法に「購入した熱（ロケーション基準・マーケット基準）」を足す。熱（蒸気・温水を含む）も電力と
--    同じく Scope2 の 2 基準で別々に算定する（片方の基準にだけ入れると、2 基準の Scope2 が違うエネルギーを数える）。
-- 2. 係数の割当のガード（t4d.emission_factor_assignment_guard）: 係数の活動・基準・国が割当と合うこと
--    （サービスの割当の保存・算定の解決・Demo の Cookie の戻しと同じ規則。軽油の割当に揮発油の係数を当てない、
--    マーケット基準の割当にロケーション基準の係数を当てない）。電力のマーケット基準は契約の係数か組織の代替値 grid。
-- 3. 活動量のバッチ・行の INSERT に enterprise.import.run（アプリ層の取込〔取込とデータ入力・担当拠点〕と揃える。
--    CLAUDE.md §5。確定・破棄〔バッチの UPDATE〕はデータ入力と担当拠点のまま）。
-- 4. 既存結果の INSERT に enterprise.import.run と、拠点の対応付け・行の拠点がすべて担当拠点であること。
-- 5. 照合の INSERT に、算定の記録の拠点がすべて担当拠点であること（照合は拠点ごとの状況を決める）。
-- 6. 算定行の INSERT に、行の拠点が記録の拠点かつ担当拠点であること。記録の行数（line_count）を超えて足せない
--    （トリガ。記録の後から行を足して、追記専用の記録を変えさせない）。
--
-- ロールバック: 関数・ポリシー・制約を 0061〜0065 の定義へ戻す（表・列は足していない・消していない）。
-- docs/known-limitations.md §13.7。
-- ----------------------------------------------------------------------

-- 1. 算定行の方法 --------------------------------------------------------

alter table ghg_calculation_lines drop constraint if exists ghg_calculation_lines_method_check;
alter table ghg_calculation_lines add constraint ghg_calculation_lines_method_check check (method in (
  'fuel_combustion', 'electricity_location', 'electricity_market', 'heat_location', 'heat_market',
  'tonkm_improved', 'fuel_method'
));

-- 2. 係数の割当のガード -------------------------------------------------------

create or replace function t4d.emission_factor_assignment_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_period_status text;
  v_factor emission_factors%rowtype;
  v_set_status text;
  v_target_country text;
begin
  if tg_op = 'DELETE' then
    if t4d.is_offboarding_delete(to_jsonb(old)) then
      return old;
    end if;
    select status into v_period_status from reporting_periods where id = old.reporting_period_id;
    if v_period_status = 'closed' then
      raise exception 'T4D_PERIOD_CLOSED: 締めた期間の係数の割当は変更できません'
        using errcode = '23514';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' and auth.uid() is not null then
    new.created_by := auth.uid();
  end if;
  if tg_op = 'UPDATE' and (new.organization_id is distinct from old.organization_id
     or new.reporting_period_id is distinct from old.reporting_period_id) then
    raise exception 'T4D_IMMUTABLE: 割当の組織・期間は変更できません'
      using errcode = '42501';
  end if;
  select status into v_period_status from reporting_periods where id = new.reporting_period_id;
  if v_period_status = 'closed' then
    raise exception 'T4D_PERIOD_CLOSED: 締めた期間の係数の割当は変更できません'
      using errcode = '23514';
  end if;
  select * into v_factor from emission_factors where id = new.factor_id;
  if not found or v_factor.organization_id <> new.organization_id or v_factor.factor_set_id is null then
    raise exception 'T4D_FACTOR_ASSIGNMENT: 割り当てられるのは係数のセットの係数だけです'
      using errcode = '23514';
  end if;
  select status into v_set_status from emission_factor_sets where id = v_factor.factor_set_id;
  if v_set_status is distinct from 'active' then
    raise exception 'T4D_FACTOR_ASSIGNMENT: 割り当てられるのは有効なセットの係数だけです'
      using errcode = '23514';
  end if;
  if v_factor.activity_kind is distinct from new.activity_kind then
    raise exception 'T4D_FACTOR_ASSIGNMENT: 係数の種類が割当の活動と違います'
      using errcode = '23514';
  end if;
  if coalesce(v_factor.basis, '') <> coalesce(new.basis, '') then
    raise exception 'T4D_FACTOR_ASSIGNMENT: 係数の基準が割当の基準と違います'
      using errcode = '23514';
  end if;
  if not (
    v_factor.activity_code = new.activity_code
    or (new.activity_kind = 'electricity' and new.basis = 'market' and v_factor.activity_code = 'grid')
  ) then
    raise exception 'T4D_FACTOR_ASSIGNMENT: 係数の活動が割当の活動と違います'
      using errcode = '23514';
  end if;
  if new.unit_id is not null then
    select country_code into v_target_country from organization_units where id = new.unit_id;
  else
    v_target_country := new.country_code;
  end if;
  if v_factor.country_code is not null and v_target_country is not null
     and v_factor.country_code <> v_target_country then
    raise exception 'T4D_FACTOR_ASSIGNMENT: 係数の国が割当の拠点・国と違います'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

-- 3. 活動量の取込の権限 -----------------------------------------------------

drop policy if exists ghg_activity_batches_insert on ghg_activity_batches;
create policy ghg_activity_batches_insert on ghg_activity_batches for insert to authenticated
  with check (
    t4d.has_permission(organization_id, 'enterprise.import.run')
    and t4d.has_permission(organization_id, 'enterprise.data.write')
    and t4d.unit_in_scope(organization_id, unit_id)
  );

drop policy if exists ghg_activity_lines_insert on ghg_activity_lines;
create policy ghg_activity_lines_insert on ghg_activity_lines for insert to authenticated
  with check (
    t4d.has_permission(organization_id, 'enterprise.import.run')
    and t4d.has_permission(organization_id, 'enterprise.data.write')
    and exists (
      select 1 from ghg_activity_batches b
       where b.id = batch_id
         and b.organization_id = ghg_activity_lines.organization_id
         and b.status = 'draft'
         and t4d.unit_in_scope(b.organization_id, b.unit_id)
    )
  );

-- 4. 既存結果の取込の権限と担当拠点 ---------------------------------------------

create or replace function t4d.ghg_baseline_unit_ids(p_unit_mapping jsonb, p_rows jsonb)
returns uuid[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct u), '{}'::uuid[])
    from (
      select m.value::uuid as u
        from jsonb_each_text(
          case when jsonb_typeof(p_unit_mapping) = 'object' then p_unit_mapping else '{}'::jsonb end
        ) as m
       where m.value is not null and m.value <> ''
      union
      select (r ->> 'unitId')::uuid
        from jsonb_array_elements(
          case when jsonb_typeof(p_rows) = 'array' then p_rows else '[]'::jsonb end
        ) as r
       where jsonb_typeof(r) = 'object' and r ->> 'unitId' is not null and r ->> 'unitId' <> ''
    ) as s;
$$;

comment on function t4d.ghg_baseline_unit_ids(jsonb, jsonb) is
  '既存結果の拠点の対応付けと行が指す拠点の ID（重複なし）。';

drop policy if exists ghg_baseline_results_insert on ghg_baseline_results;
create policy ghg_baseline_results_insert on ghg_baseline_results for insert to authenticated
  with check (
    t4d.has_permission(organization_id, 'enterprise.import.run')
    and t4d.has_permission(organization_id, 'enterprise.data.write')
    and t4d.all_units_in_scope(organization_id, t4d.ghg_baseline_unit_ids(unit_mapping, rows))
  );

-- 5. 照合は記録の拠点がすべて担当拠点の人だけ --------------------------------------

drop policy if exists ghg_reconciliations_insert on ghg_reconciliations;
create policy ghg_reconciliations_insert on ghg_reconciliations for insert to authenticated
  with check (
    t4d.has_permission(organization_id, 'enterprise.data.write')
    and exists (
      select 1 from ghg_calculation_runs r
       where r.id = run_id
         and r.organization_id = ghg_reconciliations.organization_id
         and t4d.all_units_in_scope(r.organization_id, r.unit_ids)
    )
  );

-- 6. 算定行は記録の拠点・担当拠点・記録の行数まで ------------------------------------

drop policy if exists ghg_calculation_lines_insert on ghg_calculation_lines;
create policy ghg_calculation_lines_insert on ghg_calculation_lines for insert to authenticated
  with check (
    t4d.has_permission(organization_id, 'enterprise.data.write')
    and t4d.unit_in_scope(organization_id, unit_id)
    and exists (
      select 1 from ghg_calculation_runs r
       where r.id = run_id
         and r.organization_id = ghg_calculation_lines.organization_id
         and r.created_by = auth.uid()
         and ghg_calculation_lines.unit_id = any (r.unit_ids)
    )
  );

create or replace function t4d.ghg_calculation_line_guard()
returns trigger
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_unit_ids uuid[];
  v_line_count integer;
  v_existing integer;
begin
  select unit_ids, line_count into v_unit_ids, v_line_count
    from ghg_calculation_runs
   where id = new.run_id and organization_id = new.organization_id;
  if not found then
    -- 記録の無い行は複合外部キーが止める
    return new;
  end if;
  if not (new.unit_id = any (v_unit_ids)) then
    raise exception 'T4D_CALCULATION_LINE: 算定行の拠点は記録の拠点だけです'
      using errcode = '23514';
  end if;
  -- 同じ文で先に入れた行も数える（行単位の BEFORE トリガの問い合わせは、同じ文の前の行の挿入を見る）
  select count(*) into v_existing from ghg_calculation_lines where run_id = new.run_id;
  if v_existing >= v_line_count then
    raise exception 'T4D_IMMUTABLE: 算定の記録の行はそろっています（後から足せません）'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger ghg_calculation_lines_guard
  before insert on ghg_calculation_lines
  for each row execute function t4d.ghg_calculation_line_guard();
