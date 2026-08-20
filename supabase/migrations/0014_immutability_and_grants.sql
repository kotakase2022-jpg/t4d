-- ======================================================================
-- 0014 Immutability トリガ / GRANT / Storage
-- ----------------------------------------------------------------------
-- RLS は「通常ユーザー」に対する防御。Service Role は RLS をバイパスするため、
-- 追記専用テーブルはトリガでも UPDATE / DELETE を禁止する。
-- ======================================================================

-- ----------------------------------------------------------------------
-- 追記専用（Immutable）
-- ----------------------------------------------------------------------

create trigger assurance_snapshots_immutable
  before update or delete on assurance_snapshots
  for each row execute function t4d.forbid_mutation();

create trigger assurance_snapshot_items_immutable
  before update or delete on assurance_snapshot_items
  for each row execute function t4d.forbid_mutation();

create trigger audit_events_immutable
  before update or delete on audit_events
  for each row execute function t4d.forbid_mutation();

create trigger signoffs_immutable
  before update or delete on signoffs
  for each row execute function t4d.forbid_mutation();

create trigger data_point_versions_immutable
  before update or delete on data_point_versions
  for each row execute function t4d.forbid_mutation();

create trigger disclosure_response_versions_immutable
  before update or delete on disclosure_response_versions
  for each row execute function t4d.forbid_mutation();

create trigger file_versions_immutable
  before update or delete on file_versions
  for each row execute function t4d.forbid_mutation();

create trigger approvals_immutable
  before update or delete on approvals
  for each row execute function t4d.forbid_mutation();

-- 代理 Sign-off の禁止（RLS に加えてトリガでも強制）
create trigger signoffs_self_only
  before insert on signoffs
  for each row execute function t4d.enforce_self_signoff();

-- ----------------------------------------------------------------------
-- Data Point の状態遷移権限（指示書 11-4 / 11-5）
--
-- RLS の WITH CHECK は NEW 行しか見られないため、「遷移」の判定はトリガで行う。
--   draft/submitted へ  : enterprise.data.write
--   in_review/returned へ: enterprise.data.review
--   approved へ         : enterprise.data.approve（RLS でも二重に検査）
-- また、承認済みの行を編集するにはレビュー権限以上を要する。
-- ----------------------------------------------------------------------

create or replace function t4d.enforce_data_point_transition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Service Role（auth.uid() が null）はワーカー処理のため対象外
  if auth.uid() is null then
    return new;
  end if;

  if new.status is distinct from old.status then
    if new.status = 'approved'
       and not t4d.has_permission(new.organization_id, 'enterprise.data.approve') then
      raise exception 'T4D_TRANSITION_FORBIDDEN: 最終承認には承認者権限が必要です'
        using errcode = '42501';
    end if;
    if new.status in ('in_review', 'returned')
       and not t4d.has_permission(new.organization_id, 'enterprise.data.review') then
      raise exception 'T4D_TRANSITION_FORBIDDEN: レビュー・差戻しにはレビュー権限が必要です'
        using errcode = '42501';
    end if;
    if new.status in ('draft', 'submitted')
       and not t4d.has_permission(new.organization_id, 'enterprise.data.write') then
      raise exception 'T4D_TRANSITION_FORBIDDEN: 入力・提出には入力権限が必要です'
        using errcode = '42501';
    end if;
  end if;

  -- 承認済みの値をレビュー権限なしに書き換えることは許可しない。
  -- （承認後変更が必要な場合は、レビュー担当が差戻してから修正する）
  if old.status = 'approved'
     and (new.value is distinct from old.value
          or new.unit_of_measure is distinct from old.unit_of_measure)
     and not (
       t4d.has_permission(new.organization_id, 'enterprise.data.review')
       or t4d.has_permission(new.organization_id, 'enterprise.data.approve')
     ) then
    raise exception 'T4D_APPROVED_EDIT_FORBIDDEN: 承認済みデータの変更にはレビュー権限が必要です'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger data_points_enforce_transition
  before update on data_points
  for each row execute function t4d.enforce_data_point_transition();

-- ----------------------------------------------------------------------
-- AI が保証結論・開示回答を自動確定しないことの DB 側担保（指示書 14 章 / DoD 19）
-- ----------------------------------------------------------------------

create or replace function t4d.forbid_ai_auto_approval()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'approved' and new.originated_from_ai_run_id is not null then
    -- AI 由来のバージョンをそのまま approved にはできない。
    -- 人が編集して新しいバージョンを作るか、AI 由来フラグを外す必要がある。
    raise exception 'T4D_AI_AUTO_APPROVAL_FORBIDDEN: AI 生成のまま承認することはできません'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger disclosure_response_versions_no_ai_approval
  before insert on disclosure_response_versions
  for each row execute function t4d.forbid_ai_auto_approval();

-- ----------------------------------------------------------------------
-- Snapshot 後の企業側変更を検知して snapshot_changes へ記録する
-- （指示書 7.2-8 / 16.4「Change Since Snapshot」）
-- ----------------------------------------------------------------------

create or replace function t4d.detect_snapshot_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  item record;
begin
  for item in
    select si.id, si.snapshot_id, si.engagement_id, si.assurance_firm_id, si.value_snapshot
    from assurance_snapshot_items si
    where si.source_type = 'data_point'
      and si.source_id = new.data_point_id
  loop
    insert into snapshot_changes (
      snapshot_id, engagement_id, assurance_firm_id, snapshot_item_id,
      change_kind, before_summary, after_summary
    ) values (
      item.snapshot_id, item.engagement_id, item.assurance_firm_id, item.id,
      'version_added',
      format('固定時点: %s %s (v%s)',
        item.value_snapshot ->> 'value',
        item.value_snapshot ->> 'unitOfMeasure',
        item.value_snapshot ->> 'versionNo'),
      format('現在: %s %s (v%s)', new.value, new.unit_of_measure, new.version_no)
    );
  end loop;
  return new;
end;
$$;

create trigger data_point_versions_detect_snapshot_change
  after insert on data_point_versions
  for each row execute function t4d.detect_snapshot_change();

-- ----------------------------------------------------------------------
-- GRANT
-- ----------------------------------------------------------------------

grant usage on schema t4d to authenticated, anon, service_role;
grant execute on all functions in schema t4d to authenticated, service_role;

grant usage on schema public to authenticated, anon, service_role;
grant select, insert, update on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;

-- DELETE は原則与えない（Soft Delete と監査証跡を優先する）。
revoke delete on all tables in schema public from authenticated;

alter default privileges in schema public
  grant select, insert, update on tables to authenticated;
