-- ----------------------------------------------------------------------
-- 開示本文のレビュー・承認・スナップショットの整合（自己監査 2026-09-29 の指摘への対応）
--
-- 0037 / 0038 の職務分離は「review_events を記録するとき」だけを見ていたため、
-- 次の抜け道が残っていた。
--   1. 自動保存の作業本文（working_body）を書いた人が記録されず、別の人が依頼すると
--      その人の版として承認に回り、本文を書いた承認者が自分の文章を承認できた
--   2. レビュー依頼の状態（reviewed / approved）を記録なしに直接書き換えられ、
--      第 1 段レビューを飛ばして最終承認できた。レビュー担当・最終承認者も差し替えられた
--   3. 承認権限を持つ人が、最終承認の記録なしに節を「承認済み」にできた
--   4. report_snapshots は内容を検証せずに INSERT でき、作り話の「社内承認済み版」を出力できた
--   5. 報告範囲・期間を承認後に変えても、承認済みの節に再確認の印が付かなかった
--   6. KPI 目標と実績の算定方法を比べる手掛かりが無かった
-- 追加する列はすべて既定値を持ち、既存行はそのまま有効（破壊的変更なし。ロールバック方針は
-- docs/known-limitations.md に記載）。
-- ----------------------------------------------------------------------

-- ----------------------------------------------------------------------
-- 1. 作業本文を書いた人（職務分離の判定に含める）
-- ----------------------------------------------------------------------

alter table disclosure_blocks
  add column working_updated_by uuid references profiles (id),
  add column working_contributor_ids uuid[] not null default '{}';

comment on column disclosure_blocks.working_contributor_ids is
  '現在の作業本文（working_body）を自動保存した人。版を作るとその版の contributor_user_ids へ写す。';

alter table disclosure_block_versions
  add column contributor_user_ids uuid[] not null default '{}';

comment on column disclosure_block_versions.contributor_user_ids is
  '版の作成者以外で、この版の本文（自動保存）を書いた人。レビュー完了・最終承認の職務分離で作成者と同じ扱いにする。';

-- 版を追記するときは、節の作業本文を書いた人を必ず写す（アプリが渡し忘れても DB で補う）
create or replace function t4d.merge_block_version_contributors()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
begin
  select b.working_contributor_ids into v_ids from disclosure_blocks b where b.id = new.block_id;
  new.contributor_user_ids := array(
    select distinct x
      from unnest(coalesce(new.contributor_user_ids, '{}') || coalesce(v_ids, '{}')) as x
     where x is distinct from new.created_by
  );
  return new;
end;
$$;

create trigger disclosure_block_versions_contributors
  before insert on disclosure_block_versions
  for each row execute function t4d.merge_block_version_contributors();

-- ----------------------------------------------------------------------
-- 2. 報告範囲の改訂番号（承認後の範囲変更を再確認の対象にする）
-- ----------------------------------------------------------------------

alter table disclosure_projects
  add column scope_revision integer not null default 0 check (scope_revision >= 0);

comment on column disclosure_projects.scope_revision is
  '報告範囲（報告主体・期間・組織・連結・GHG 境界・バリューチェーン・対象拠点）を確定して変えるたびに 1 増やす。';

alter table review_requests
  add column project_scope_revision integer not null default 0 check (project_scope_revision >= 0);

comment on column review_requests.project_scope_revision is
  '依頼時点のプロジェクトの報告範囲の改訂番号。これより後に範囲を変えた承認は再確認が必要。';

-- ----------------------------------------------------------------------
-- 3. KPI 目標が前提にした実績の算定方法（data_points.methodology と同じ表記）
-- ----------------------------------------------------------------------

alter table kpi_targets
  add column actual_methodology text;

comment on column kpi_targets.actual_methodology is
  '目標が前提にした実績の算定方法。実績（data_points.methodology）と一致しなければ達成率を出さない。null は未設定。';

-- ----------------------------------------------------------------------
-- 4. 節の新規作成は下書き・版なしに限る（承認済みの節をいきなり作らせない）
-- ----------------------------------------------------------------------

create or replace function t4d.enforce_disclosure_block_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Service Role（seed・ワーカー）は対象外。利用者の JWT による作成だけを絞る
  if auth.uid() is null then
    return new;
  end if;
  if new.status <> 'draft'
     or new.current_version_id is not null
     or new.submitted_version_id is not null
     or new.approved_version_id is not null
     or new.working_body is not null
     or cardinality(new.working_contributor_ids) > 0 then
    raise exception 'T4D_TRANSITION_FORBIDDEN: 節は下書き・版なしの状態でだけ作成できます'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger disclosure_blocks_enforce_insert
  before insert on disclosure_blocks
  for each row execute function t4d.enforce_disclosure_block_insert();

-- ----------------------------------------------------------------------
-- 5. 節の更新: 承認は最終承認の記録がある版だけ・作業本文を書いた人を必ず残す
-- ----------------------------------------------------------------------

create or replace function t4d.enforce_disclosure_block_update()
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

  if new.status is distinct from old.status
     and new.status = 'approved'
     and not t4d.has_permission(new.organization_id, 'enterprise.disclosure.approve') then
    raise exception 'T4D_TRANSITION_FORBIDDEN: 最終承認には承認権限が必要です'
      using errcode = '42501';
  end if;

  if new.approved_version_id is distinct from old.approved_version_id
     and not t4d.has_permission(new.organization_id, 'enterprise.disclosure.approve') then
    raise exception 'T4D_TRANSITION_FORBIDDEN: 承認済みの版を変更するには承認権限が必要です'
      using errcode = '42501';
  end if;

  -- 承認済みにできるのは、この節の依頼で最終承認が記録された版だけ
  -- （承認権限だけで、記録なしに自分の文章を承認済みにする経路を塞ぐ）
  if (new.approved_version_id is distinct from old.approved_version_id
        and new.approved_version_id is not null)
     or (new.status is distinct from old.status and new.status = 'approved') then
    if new.approved_version_id is null or not exists (
      select 1
        from review_events e
        join review_requests r on r.id = e.review_request_id
       where r.target_id = new.id
         and e.event_type = 'approved'
         and e.target_version_id = new.approved_version_id
    ) then
      raise exception 'T4D_TRANSITION_FORBIDDEN: 最終承認の記録が無い版は承認済みにできません'
        using errcode = '42501';
    end if;
  end if;

  -- 「承認待ち」はレビュー（第 1 段）の完了記録がある依頼の版だけ
  if new.status is distinct from old.status and new.status = 'approval_pending' then
    if not exists (
      select 1
        from review_events e
        join review_requests r on r.id = e.review_request_id
       where r.target_id = new.id
         and r.status = 'reviewed'
         and e.event_type = 'review_completed'
         and e.target_version_id = new.submitted_version_id
    ) then
      raise exception 'T4D_TRANSITION_FORBIDDEN: レビューの完了記録が無い節は承認待ちにできません'
        using errcode = '42501';
    end if;
  end if;

  -- 作業本文を書いた人は必ず残す（自動保存した本人を記録し、既に書いた人を外させない）
  if new.working_body is not null and new.working_body is distinct from old.working_body then
    new.working_updated_by := auth.uid();
    if not (auth.uid() = any(new.working_contributor_ids)) then
      new.working_contributor_ids := array_append(new.working_contributor_ids, auth.uid());
    end if;
  end if;
  if old.working_body is not null
     and new.working_body is not null
     and not (old.working_contributor_ids <@ new.working_contributor_ids) then
    new.working_contributor_ids := new.working_contributor_ids || array(
      select x from unnest(old.working_contributor_ids) as x
       where not (x = any(new.working_contributor_ids))
    );
  end if;

  if not t4d.has_permission(new.organization_id, 'enterprise.disclosure.write')
     and (to_jsonb(new) - array[
           'status', 'submitted_version_id', 'approved_version_id', 'updated_at', 'updated_by'
         ])
         is distinct from
         (to_jsonb(old) - array[
           'status', 'submitted_version_id', 'approved_version_id', 'updated_at', 'updated_by'
         ]) then
    raise exception 'T4D_TRANSITION_FORBIDDEN: 承認権限だけでは本文や担当は変更できません'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- ----------------------------------------------------------------------
-- 6. レビュー依頼: 指名と範囲の改訂番号を固定し、状態は記録に合わせてしか進めない
-- ----------------------------------------------------------------------

create or replace function t4d.review_request_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.organization_id is distinct from old.organization_id
     or new.project_id is distinct from old.project_id
     or new.target_type is distinct from old.target_type
     or new.target_id is distinct from old.target_id
     or new.target_version_id is distinct from old.target_version_id
     or new.requested_by is distinct from old.requested_by
     -- 指名を差し替えると、指定した最終承認者を外して別の人に承認させられる
     or new.reviewer_user_id is distinct from old.reviewer_user_id
     or new.approver_user_id is distinct from old.approver_user_id
     or new.policy_version is distinct from old.policy_version
     or new.policy is distinct from old.policy
     or new.decision_ids is distinct from old.decision_ids
     or new.referenced_versions is distinct from old.referenced_versions
     or new.project_scope_revision is distinct from old.project_scope_revision
     or new.created_at is distinct from old.created_at
     or new.created_by is distinct from old.created_by then
    raise exception 'T4D_IMMUTABLE: レビュー依頼の依頼時点の内容（対象の版・依頼者・指名・規則）は変更できません'
      using errcode = '42501';
  end if;

  -- 差戻し・承認・取下げで終わった依頼は再開しない（再提出は新しい依頼として作る）
  if old.status in ('returned', 'approved', 'withdrawn') and new.status is distinct from old.status then
    raise exception 'T4D_TRANSITION_FORBIDDEN: 完了したレビュー依頼の状態は変更できません'
      using errcode = '42501';
  end if;

  if auth.uid() is not null
     and new.status is distinct from old.status
     and new.status = 'approved'
     and not t4d.has_permission(new.organization_id, 'enterprise.disclosure.approve') then
    raise exception 'T4D_TRANSITION_FORBIDDEN: 最終承認には承認権限が必要です'
      using errcode = '42501';
  end if;

  -- 状態は、その判断の記録（review_events）が先にあるときだけ進める。
  -- 記録には職務分離のトリガ（t4d.enforce_review_event）が掛かるため、記録なしの状態変更で
  -- 第 1 段レビューや職務分離を飛ばせないようにする（Service Role も同じ）
  if new.status is distinct from old.status then
    if new.status = 'open' then
      raise exception 'T4D_TRANSITION_FORBIDDEN: レビュー依頼を「レビュー待ち」へ戻すことはできません'
        using errcode = '42501';
    elsif new.status = 'reviewed' and (
      old.status <> 'open' or not exists (
        select 1 from review_events e
         where e.review_request_id = new.id
           and e.event_type = 'review_completed'
           and e.target_version_id = new.target_version_id
      )
    ) then
      raise exception 'T4D_TRANSITION_FORBIDDEN: レビュー（第 1 段）の完了記録が無い依頼は「レビュー完了」にできません'
        using errcode = '42501';
    elsif new.status = 'approved' and (
      old.status <> 'reviewed' or not exists (
        select 1 from review_events e
         where e.review_request_id = new.id
           and e.event_type = 'approved'
           and e.target_version_id = new.target_version_id
      )
    ) then
      raise exception 'T4D_TRANSITION_FORBIDDEN: 最終承認の記録が無い依頼は「承認済み」にできません'
        using errcode = '42501';
    elsif new.status = 'returned' and not exists (
      select 1 from review_events e
       where e.review_request_id = new.id and e.event_type = 'returned'
    ) then
      raise exception 'T4D_TRANSITION_FORBIDDEN: 差戻しの記録が無い依頼は「差戻し」にできません'
        using errcode = '42501';
    elsif new.status = 'withdrawn' and not exists (
      select 1 from review_events e
       where e.review_request_id = new.id and e.event_type = 'withdrawn'
    ) then
      raise exception 'T4D_TRANSITION_FORBIDDEN: 取下げの記録が無い依頼は「取下げ」にできません'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

-- ----------------------------------------------------------------------
-- 7. 職務分離: 本文を書いた人（contributor）も作成者と同じ扱い・最終承認は第 1 段の後だけ
-- ----------------------------------------------------------------------

create or replace function t4d.enforce_review_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_requested_by uuid;
  v_request_version uuid;
  v_version_author uuid;
  v_contributors uuid[];
begin
  select r.requested_by, r.target_version_id
    into v_requested_by, v_request_version
    from review_requests r
   where r.id = new.review_request_id;
  if not found then
    raise exception 'T4D_REVIEW_REQUEST_NOT_FOUND: レビュー依頼が見つかりません'
      using errcode = '23503';
  end if;

  -- 判断は依頼で固定した版に対してだけ記録できる（別の版を名乗って作成者の判定をすり抜けさせない）
  if new.target_version_id is distinct from v_request_version then
    raise exception 'T4D_REVIEW_TARGET_MISMATCH: 依頼で固定した版以外への判断は記録できません'
      using errcode = '23514';
  end if;

  if new.event_type = 'returned'
     and (coalesce(btrim(new.reason), '') = '' or coalesce(btrim(new.paragraph_id), '') = '') then
    raise exception 'T4D_RETURN_REASON_REQUIRED: 差戻しには理由と対象段落が必要です'
      using errcode = '23514';
  end if;

  if new.event_type in ('review_completed', 'approved') then
    select v.created_by, v.contributor_user_ids
      into v_version_author, v_contributors
      from disclosure_block_versions v
     where v.id = v_request_version;

    if new.actor_user_id = v_requested_by then
      raise exception 'T4D_SOD: 依頼者本人はレビュー完了・最終承認できません'
        using errcode = '42501';
    end if;
    if new.actor_user_id = v_version_author then
      raise exception 'T4D_SOD: 対象版の作成者はレビュー完了・最終承認できません'
        using errcode = '42501';
    end if;
    if new.actor_user_id = any(coalesce(v_contributors, '{}')) then
      raise exception 'T4D_SOD: 対象版の本文を書いた人（自動保存を含む）はレビュー完了・最終承認できません'
        using errcode = '42501';
    end if;
  end if;

  if new.event_type = 'approved'
     and exists (
       select 1
         from review_events e
        where e.review_request_id = new.review_request_id
          and e.event_type = 'review_completed'
          and e.actor_user_id = new.actor_user_id
     ) then
    raise exception 'T4D_SOD: 同じ依頼のレビューを完了した人は最終承認できません'
      using errcode = '42501';
  end if;

  -- 最終承認は、同じ版について別の人のレビュー（第 1 段）の完了記録があるときだけ
  if new.event_type = 'approved'
     and not exists (
       select 1
         from review_events e
        where e.review_request_id = new.review_request_id
          and e.event_type = 'review_completed'
          and e.target_version_id = new.target_version_id
          and e.actor_user_id <> new.actor_user_id
     ) then
    raise exception 'T4D_REVIEW_STAGE_SKIPPED: レビュー（第 1 段）の完了記録が無い依頼は最終承認できません'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- ----------------------------------------------------------------------
-- 8. レポートのスナップショット: 保存する内容を DB の行と突き合わせる
--
-- 内容ハッシュには秘密が無く、クライアントでも計算できる。INSERT の権限だけで
-- 作り話の本文・数値・機密区分を「社内承認済み版」として保存し出力できないよう、
-- 節の本文は引用した版の行と、数値は Data Point の版と、引用位置は資料の行と一致させる。
-- 確定版（approved）は、全節が最終承認の記録のある版で、指定の最終承認者が作り、
-- 作成者がすべての節の本文を書いた本人ではないことまで確かめる（report-snapshot.ts と同じ規則）。
-- Service Role の書込みにも効かせる（内容の検証であって権限の判定ではないため）。
-- ----------------------------------------------------------------------

create or replace function t4d.verify_report_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project disclosure_projects%rowtype;
  v_block disclosure_blocks%rowtype;
  v_version disclosure_block_versions%rowtype;
  v_dpv data_point_versions%rowtype;
  v_dp data_points%rowtype;
  v_anchor source_anchors%rowtype;
  v_file files%rowtype;
  v_entry jsonb;
  v_block_ids uuid[] := '{}';
  v_version_count integer := 0;
  v_all_self boolean := true;
  v_value numeric;
begin
  select * into v_project from disclosure_projects where id = new.project_id;
  if not found or v_project.organization_id <> new.organization_id then
    raise exception 'T4D_SNAPSHOT_MISMATCH: プロジェクトが見つかりません'
      using errcode = '23514';
  end if;
  if jsonb_typeof(new.blocks) <> 'array'
     or jsonb_typeof(new.metric_values) <> 'array'
     or jsonb_typeof(new.anchors) <> 'array' then
    raise exception 'T4D_SNAPSHOT_MISMATCH: スナップショットの形式が正しくありません'
      using errcode = '23514';
  end if;

  -- 節: 引用した版の行と本文・内容ハッシュ・作成者が一致すること
  for v_entry in select value from jsonb_array_elements(new.blocks) loop
    select * into v_block from disclosure_blocks where id = (v_entry ->> 'blockId')::uuid;
    if not found
       or v_block.project_id <> new.project_id
       or v_block.organization_id <> new.organization_id then
      raise exception 'T4D_SNAPSHOT_MISMATCH: プロジェクトの節ではない節が含まれています'
        using errcode = '23514';
    end if;
    v_block_ids := v_block_ids || v_block.id;

    if v_entry ->> 'versionId' is null then
      if new.snapshot_kind = 'approved' then
        raise exception 'T4D_SNAPSHOT_MISMATCH: 確定版に版の無い節は含められません'
          using errcode = '23514';
      end if;
      if jsonb_array_length(coalesce(v_entry -> 'body' -> 'paragraphs', '[]'::jsonb)) > 0 then
        raise exception 'T4D_SNAPSHOT_MISMATCH: 版の無い節に本文があります'
          using errcode = '23514';
      end if;
      continue;
    end if;

    select * into v_version
      from disclosure_block_versions
     where id = (v_entry ->> 'versionId')::uuid;
    if not found or v_version.block_id <> v_block.id then
      raise exception 'T4D_SNAPSHOT_MISMATCH: 節の版が見つかりません'
        using errcode = '23514';
    end if;
    if v_version.body is distinct from (v_entry -> 'body')
       or v_version.content_hash is distinct from (v_entry ->> 'contentHash')
       or v_version.created_by::text is distinct from (v_entry ->> 'versionCreatedBy') then
      raise exception 'T4D_SNAPSHOT_MISMATCH: 節の本文が引用した版と一致しません'
        using errcode = '23514';
    end if;
    v_version_count := v_version_count + 1;
    if v_version.created_by <> new.created_by
       and not (new.created_by = any(v_version.contributor_user_ids)) then
      v_all_self := false;
    end if;

    if new.snapshot_kind = 'approved' then
      if v_block.approved_version_id is distinct from v_version.id
         or v_block.status <> 'approved'
         or (v_entry ->> 'isApprovedVersion') is distinct from 'true'
         or not exists (
           select 1
             from review_events e
             join review_requests r on r.id = e.review_request_id
            where r.target_id = v_block.id
              and e.event_type = 'approved'
              and e.target_version_id = v_version.id
         ) then
        raise exception 'T4D_SNAPSHOT_MISMATCH: 最終承認の記録が無い版は確定版に含められません'
          using errcode = '23514';
      end if;
    elsif v_block.current_version_id is distinct from v_version.id then
      raise exception 'T4D_SNAPSHOT_MISMATCH: 草稿は節の現在の版だけを固定できます'
        using errcode = '23514';
    end if;
  end loop;

  -- 数値: 引用した Data Point の版の値・単位と一致し、承認の主張が事実であること
  for v_entry in select value from jsonb_array_elements(new.metric_values) loop
    select * into v_dpv
      from data_point_versions
     where id = (v_entry ->> 'dataPointVersionId')::uuid;
    if not found
       or v_dpv.organization_id <> new.organization_id
       or v_dpv.data_point_id::text is distinct from (v_entry ->> 'dataPointId') then
      raise exception 'T4D_SNAPSHOT_MISMATCH: 数値の版が見つかりません'
        using errcode = '23514';
    end if;
    v_value := (v_entry ->> 'value')::numeric;
    if (v_value is null) <> (v_dpv.value is null)
       or (v_value is not null
           and abs(v_value - v_dpv.value) > 1e-9 * greatest(1, abs(v_dpv.value)))
       or v_dpv.text_value is distinct from (v_entry ->> 'textValue')
       or v_dpv.unit_of_measure is distinct from (v_entry ->> 'unitOfMeasure') then
      raise exception 'T4D_SNAPSHOT_MISMATCH: 数値が引用した版の値と一致しません'
        using errcode = '23514';
    end if;
    select * into v_dp from data_points where id = v_dpv.data_point_id;
    if (v_entry ->> 'versionApproved') = 'true' then
      if not (
        v_dpv.status = 'approved'
        or (v_dp.status = 'approved' and v_dp.current_version_id = v_dpv.id)
        or exists (
          select 1 from approvals a
           where a.target_type = 'data_point'
             and a.target_id = v_dpv.data_point_id
             and a.target_version_id = v_dpv.id
             and a.decision = 'approved'
        )
      ) then
        raise exception 'T4D_SNAPSHOT_MISMATCH: 承認されていない数値の版を承認済みとして固定できません'
          using errcode = '23514';
      end if;
    elsif new.snapshot_kind = 'approved' then
      raise exception 'T4D_SNAPSHOT_MISMATCH: 確定版に未承認の数値は含められません'
        using errcode = '23514';
    end if;
  end loop;

  -- 引用位置: 資料の行と引用文・機密区分・ファイル名が一致すること（対外出力の伏せ字の根拠）
  for v_entry in select value from jsonb_array_elements(new.anchors) loop
    select * into v_anchor from source_anchors where id = (v_entry ->> 'sourceAnchorId')::uuid;
    if not found
       or v_anchor.organization_id <> new.organization_id
       or v_anchor.quote_text is distinct from (v_entry ->> 'quoteText')
       or v_anchor.file_version_id::text is distinct from (v_entry ->> 'fileVersionId') then
      raise exception 'T4D_SNAPSHOT_MISMATCH: 引用位置が資料の行と一致しません'
        using errcode = '23514';
    end if;
    select f.* into v_file
      from file_versions fv
      join files f on f.id = fv.file_id
     where fv.id = v_anchor.file_version_id;
    if found then
      if v_file.confidentiality::text is distinct from (v_entry ->> 'confidentiality')
         or v_file.original_name is distinct from (v_entry ->> 'fileName') then
        raise exception 'T4D_SNAPSHOT_MISMATCH: 資料の機密区分・ファイル名が一致しません'
          using errcode = '23514';
      end if;
    elsif coalesce(v_entry ->> 'confidentiality', 'confidential') <> 'confidential' then
      raise exception 'T4D_SNAPSHOT_MISMATCH: 資料が見つからない引用位置を公開扱いにはできません'
        using errcode = '23514';
    end if;
  end loop;

  if exists (
    select 1 from unnest(new.narrative_version_ids) as nv(id)
     where not exists (
       select 1 from narrative_versions v
        where v.id = nv.id and v.organization_id = new.organization_id
     )
  ) then
    raise exception 'T4D_SNAPSHOT_MISMATCH: 定性情報の版が見つかりません'
      using errcode = '23514';
  end if;

  if new.snapshot_kind = 'approved' then
    -- 対象外と判断した基準以外の節はすべて含める（都合の良い節だけを確定させない）
    if exists (
      select 1
        from disclosure_blocks b
        join project_frameworks pf
          on pf.project_id = b.project_id and pf.framework_version_id = b.framework_version_id
       where b.project_id = new.project_id
         and b.deleted_at is null
         and pf.applicability_status <> 'not_applicable'
         and not (b.id = any(v_block_ids))
    ) then
      raise exception 'T4D_SNAPSHOT_INCOMPLETE: 確定版に含まれていない節があります'
        using errcode = '23514';
    end if;
    if v_project.final_approver_user_id is not null
       and v_project.final_approver_user_id <> new.created_by then
      raise exception 'T4D_SOD: このプロジェクトの最終承認者として指定された人だけが確定できます'
        using errcode = '42501';
    end if;
    if v_version_count > 0 and v_all_self then
      raise exception 'T4D_SOD: すべての節の本文を書いた本人はレポートを確定できません'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

create trigger report_snapshots_verify
  before insert on report_snapshots
  for each row execute function t4d.verify_report_snapshot();
