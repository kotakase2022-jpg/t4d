-- ----------------------------------------------------------------------
-- 開示本文のレビュー: 指名・依頼の状態・書いた人の引き継ぎ・範囲の改訂番号・再確認の前提
-- （2026-09-29 自己監査 第 2 回の指摘への対応）
--
-- 0041 で職務分離と記録の整合を DB に入れたが、次の穴が残っていた。
--   1. review_events を記録する人が、依頼で指名したレビュー担当・最終承認者かを見ていなかった。
--      指名を変えられなくしても（0041）、指名されていない承認権限者が記録を入れて承認できた。
--      依頼の状態（差戻し済み・承認済みなど）も見ず、終わった依頼に承認の記録を足せた
--   2. 節の承認・確定版の検証は「承認の記録がある」ことだけを見て、依頼が承認で終わったかを見なかった
--   3. 版を追記するとき、土台にした版の作成者・本文を書いた人を引き継がなかった。
--      承認者が書いた段落を、別の人が 1 文字直した版なら、その承認者が自分の段落を承認できた
--   4. 報告範囲の改訂番号（scope_revision）と、依頼に固定した番号を利用者が直接書き換えられ、
--      承認後の範囲変更の再確認を外せた。依頼も「承認済み」の状態でいきなり INSERT できた
--   5. 「引用中の版を維持」の判断が、新しい版が未承認のときの判断かどうかを残していなかった
--      （承認された後も維持が有効なままで、再確認を促さなかった）
-- すべて列追加（既定値付き）とトリガ関数の追加・差し替えで、既存データを壊さない。
-- ロールバック方針は docs/known-limitations.md §6 に記載。
-- ----------------------------------------------------------------------

-- ----------------------------------------------------------------------
-- 1. 再確認の判断: 判断した時点で新しい版が承認済みだったか
-- ----------------------------------------------------------------------

alter table recheck_decisions
  add column new_ref_approved boolean not null default false;

comment on column recheck_decisions.new_ref_approved is
  '判断した時点で新しい版（new_ref_id）が承認済み（定性情報は確定済み）だったか。false の「維持」は、新しい版が承認された時点で無効になる。DB が INSERT 時に計算する。';

-- 利用者の申告を信用せず、INSERT の時点の事実を DB が書く
create or replace function t4d.set_recheck_new_ref_approved()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.ref_kind = 'metric' then
    new.new_ref_approved := exists (
      select 1
        from data_point_versions v
        join data_points d on d.id = v.data_point_id
       where v.id = new.new_ref_id
         and (
           v.status = 'approved'
           or (d.status = 'approved' and d.current_version_id = v.id)
           or exists (
             select 1 from approvals a
              where a.target_type = 'data_point'
                and a.target_id = v.data_point_id
                and a.target_version_id = v.id
                and a.decision = 'approved'
           )
         )
    );
  else
    new.new_ref_approved := exists (
      select 1
        from narrative_versions v
        join narrative_records r on r.id = v.narrative_record_id
       where v.id = new.new_ref_id
         and r.confirmed_version_id = v.id
    );
  end if;
  return new;
end;
$$;

create trigger recheck_decisions_new_ref_approved
  before insert on recheck_decisions
  for each row execute function t4d.set_recheck_new_ref_approved();

-- ----------------------------------------------------------------------
-- 2. 版の追記: 土台にした版（と節の現在の版）を書いた人を引き継ぐ
--
-- 0041 は節の作業本文を自動保存した人だけを写していた。版の作成者と本文を書いた人は
-- 次の版に引き継がないと、別の人が少し直した版（再確認の「新しい版を採用」を含む）で
-- 前の版を書いた人の記録が消え、その人が自分の文章を承認できてしまう。
-- 土台はクライアントが渡す base_version_id を信用せず、節の現在の版も必ず含める。
-- ----------------------------------------------------------------------

create or replace function t4d.merge_block_version_contributors()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_current uuid;
begin
  select b.working_contributor_ids, b.current_version_id
    into v_ids, v_current
    from disclosure_blocks b
   where b.id = new.block_id;
  new.contributor_user_ids := array(
    select distinct x
      from unnest(
        coalesce(new.contributor_user_ids, '{}')
        || coalesce(v_ids, '{}')
        || coalesce((
             select array_agg(w.uid)
               from disclosure_block_versions pv,
                    unnest(pv.contributor_user_ids || pv.created_by) as w(uid)
              where pv.block_id = new.block_id
                and pv.id <> new.id
                and (pv.id = v_current or pv.id = new.base_version_id)
           ), '{}')
      ) as x
     where x is distinct from new.created_by
  );
  return new;
end;
$$;

-- ----------------------------------------------------------------------
-- 3. 報告範囲の改訂番号は DB が決める
--
-- 範囲の項目（報告主体・期間・組織・連結・GHG 境界・バリューチェーン・対象拠点）を変えたら
-- 1 だけ増やし、変えていなければ変えさせない（下げて再確認を外す経路を塞ぐ）。
-- アプリ（disclosure-project.ts の SCOPE_FIELDS）と同じ項目。
-- ----------------------------------------------------------------------

create or replace function t4d.guard_project_scope_revision()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.reporting_entity is distinct from old.reporting_entity
     or new.period_start is distinct from old.period_start
     or new.period_end is distinct from old.period_end
     or new.scope_org_note is distinct from old.scope_org_note
     or new.scope_consolidation_note is distinct from old.scope_consolidation_note
     or new.scope_ghg_boundary_note is distinct from old.scope_ghg_boundary_note
     or new.scope_value_chain_note is distinct from old.scope_value_chain_note
     or new.included_unit_ids is distinct from old.included_unit_ids then
    new.scope_revision := old.scope_revision + 1;
  else
    new.scope_revision := old.scope_revision;
  end if;
  return new;
end;
$$;

create trigger disclosure_projects_scope_revision
  before update on disclosure_projects
  for each row execute function t4d.guard_project_scope_revision();

-- ----------------------------------------------------------------------
-- 4. レビュー依頼の作成: 利用者の依頼は「レビュー待ち」でだけ作り、範囲の改訂番号は DB が写す
-- ----------------------------------------------------------------------

create or replace function t4d.enforce_review_request_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_revision integer;
begin
  -- Service Role（seed・ワーカー）は対象外。利用者の JWT による作成だけを絞る
  if auth.uid() is null then
    return new;
  end if;
  if new.status <> 'open' then
    raise exception 'T4D_TRANSITION_FORBIDDEN: レビュー依頼は「レビュー待ち」の状態でだけ作成できます'
      using errcode = '42501';
  end if;
  select p.scope_revision into v_revision
    from disclosure_projects p
   where p.id = new.project_id and p.organization_id = new.organization_id;
  if not found then
    raise exception 'T4D_REVIEW_REQUEST_NOT_FOUND: プロジェクトが見つかりません'
      using errcode = '23503';
  end if;
  new.project_scope_revision := v_revision;
  return new;
end;
$$;

create trigger review_requests_enforce_insert
  before insert on review_requests
  for each row execute function t4d.enforce_review_request_insert();

-- ----------------------------------------------------------------------
-- 5. 職務分離と指名: 記録する人は依頼で指名した人・依頼はその段階の状態
-- ----------------------------------------------------------------------

create or replace function t4d.enforce_review_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request review_requests%rowtype;
  v_version_author uuid;
  v_contributors uuid[];
  v_block_owner uuid;
  v_project_revision integer;
begin
  select * into v_request
    from review_requests r
   where r.id = new.review_request_id;
  if not found then
    raise exception 'T4D_REVIEW_REQUEST_NOT_FOUND: レビュー依頼が見つかりません'
      using errcode = '23503';
  end if;

  -- 判断は依頼で固定した版に対してだけ記録できる（別の版を名乗って作成者の判定をすり抜けさせない）
  if new.target_version_id is distinct from v_request.target_version_id then
    raise exception 'T4D_REVIEW_TARGET_MISMATCH: 依頼で固定した版以外への判断は記録できません'
      using errcode = '23514';
  end if;

  if new.event_type = 'returned'
     and (coalesce(btrim(new.reason), '') = '' or coalesce(btrim(new.paragraph_id), '') = '') then
    raise exception 'T4D_RETURN_REASON_REQUIRED: 差戻しには理由と対象段落が必要です'
      using errcode = '23514';
  end if;

  -- 記録の種類と段階の組み合わせは 0037 の検査制約（review_events_stage_matches_type）が固定する

  if new.event_type in ('review_completed', 'approved') then
    select v.created_by, v.contributor_user_ids
      into v_version_author, v_contributors
      from disclosure_block_versions v
     where v.id = v_request.target_version_id;

    if new.actor_user_id = v_request.requested_by then
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

  -- ここから下は 0042 で追加した検査。職務分離（上）を先に判定し、理由として優先して示す

  -- 依頼の状態: 判断はその段階の依頼にだけ記録できる（終わった依頼に承認を足させない）。
  -- 記録を先に入れてから依頼の状態を進める順序（review_request_guard）なので、ここでは進める前の状態を見る。
  -- seed（Service Role）は承認まで済んだ依頼に記録を後から入れるため対象外
  if auth.uid() is not null then
    if (new.event_type = 'requested' and v_request.status <> 'open')
       or (new.event_type = 'review_completed' and v_request.status <> 'open')
       or (new.event_type = 'approved' and v_request.status <> 'reviewed')
       or (new.event_type = 'returned' and new.stage = 'review' and v_request.status <> 'open')
       or (new.event_type = 'returned' and new.stage = 'final' and v_request.status <> 'reviewed')
       or (new.event_type = 'withdrawn' and v_request.status not in ('open', 'reviewed')) then
      raise exception 'T4D_TRANSITION_FORBIDDEN: この状態のレビュー依頼にはその判断を記録できません（依頼: %）',
        v_request.status
        using errcode = '42501';
    end if;
  end if;

  -- 指名: レビュー担当・最終承認者を指名した依頼は、その人だけが判断を記録できる
  if (new.event_type = 'review_completed'
        or (new.event_type = 'returned' and new.stage = 'review'))
     and v_request.reviewer_user_id is not null
     and new.actor_user_id <> v_request.reviewer_user_id then
    raise exception 'T4D_NOT_DESIGNATED: この依頼のレビュー担当だけがレビューの判断を記録できます'
      using errcode = '42501';
  end if;
  if (new.event_type = 'approved'
        or (new.event_type = 'returned' and new.stage = 'final'))
     and v_request.approver_user_id is not null
     and new.actor_user_id <> v_request.approver_user_id then
    raise exception 'T4D_NOT_DESIGNATED: この依頼の最終承認者だけが最終承認の判断を記録できます'
      using errcode = '42501';
  end if;

  -- 段階ごとの権限（RLS は書込・承認のどちらかで差戻しを許すため、段階に合わせて絞る）
  if auth.uid() is not null and new.event_type = 'returned' then
    if new.stage = 'review'
       and not t4d.has_permission(new.organization_id, 'enterprise.disclosure.write') then
      raise exception 'T4D_TRANSITION_FORBIDDEN: レビュー段階の差戻しにはレビュー（編集）の権限が必要です'
        using errcode = '42501';
    end if;
    if new.stage = 'final'
       and not t4d.has_permission(new.organization_id, 'enterprise.disclosure.approve') then
      raise exception 'T4D_TRANSITION_FORBIDDEN: 最終承認段階の差戻しには承認権限が必要です'
        using errcode = '42501';
    end if;
  end if;

  -- 依頼した本人は差し戻さない（取下げを使う）
  if new.event_type = 'returned' and new.actor_user_id = v_request.requested_by then
    raise exception 'T4D_SOD: 依頼した本人は差し戻せません。取下げを使ってください'
      using errcode = '42501';
  end if;

  -- 取下げは依頼した本人か節の担当者だけ
  if new.event_type = 'withdrawn' then
    select b.owner_user_id into v_block_owner
      from disclosure_blocks b
     where b.id = v_request.target_id;
    if new.actor_user_id <> v_request.requested_by
       and new.actor_user_id is distinct from v_block_owner then
      raise exception 'T4D_SOD: 依頼した本人か節の担当者だけが取り下げられます'
        using errcode = '42501';
    end if;
  end if;

  -- 依頼の後に報告範囲を変えたなら、その依頼では最終承認しない（アプリの finalApprove と同じ）
  if new.event_type = 'approved' then
    select p.scope_revision into v_project_revision
      from disclosure_projects p
     where p.id = v_request.project_id;
    if v_request.project_scope_revision < coalesce(v_project_revision, 0) then
      raise exception 'T4D_SCOPE_CHANGED: 依頼の後に報告範囲が変更されました。差し戻して変更後の範囲で確認してください'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

-- ----------------------------------------------------------------------
-- 6. 節の更新: 承認済みにできるのは、承認で終わった依頼の版だけ
--    （0041 の本体に「r.status = 'approved'」を足したもの。他は同じ）
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

  -- 承認済みにできるのは、この節の依頼が最終承認で終わり、その記録がある版だけ
  -- （差し戻された依頼に後から承認の記録を足しても、承認済みにはできない）
  if (new.approved_version_id is distinct from old.approved_version_id
        and new.approved_version_id is not null)
     or (new.status is distinct from old.status and new.status = 'approved') then
    if new.approved_version_id is null or not exists (
      select 1
        from review_events e
        join review_requests r on r.id = e.review_request_id
       where r.target_id = new.id
         and r.status = 'approved'
         and r.target_version_id = new.approved_version_id
         and e.event_type = 'approved'
         and e.target_version_id = new.approved_version_id
    ) then
      raise exception 'T4D_TRANSITION_FORBIDDEN: 最終承認で終わった依頼の版だけを承認済みにできます'
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
-- 7. レポートのスナップショット: 確定版の節は「承認で終わった依頼」の版で、
--    その依頼が現在の報告範囲で承認されていること（0041 の本体に 2 条件を足したもの）
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
              and r.status = 'approved'
              and r.target_version_id = v_version.id
              and e.event_type = 'approved'
              and e.target_version_id = v_version.id
         ) then
        raise exception 'T4D_SNAPSHOT_MISMATCH: 最終承認で終わった依頼の版だけを確定版に含められます'
          using errcode = '23514';
      end if;
      -- 報告範囲の変更より前の依頼でしか承認されていない版は、再確認が済むまで確定させない
      if not exists (
        select 1
          from review_requests r
         where r.target_id = v_block.id
           and r.status = 'approved'
           and r.target_version_id = v_version.id
           and r.project_scope_revision >= v_project.scope_revision
      ) then
        raise exception 'T4D_SNAPSHOT_MISMATCH: 報告範囲の変更より前に承認された節は確定版に含められません'
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
