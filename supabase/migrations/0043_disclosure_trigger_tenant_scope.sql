-- ----------------------------------------------------------------------
-- 開示本文のレビューと再確認のトリガ: 別の組織の行を読まない（2026-09-30 自己監査 第 3 回 SEC-5）
--
-- 0042 の SECURITY DEFINER のトリガは、利用者が渡した ID で別の組織の行を読んでいた。
--   1. t4d.set_recheck_new_ref_approved は new_ref_id の版を組織を問わずに引き、RETURNING の
--      new_ref_approved から、他社の数値の版・定性情報の版が「ある・承認済み」かを 1 ビットずつ読めた
--   2. t4d.enforce_review_request_insert は組織の権限を確かめる前に project を引き、例外の違いから
--      他社のプロジェクトの有無を読めた（BEFORE トリガは RLS の WITH CHECK より先に動く）
--   3. t4d.enforce_review_event は依頼を組織を問わずに引き、例外に依頼の状態を載せていた
-- 関数の差し替えだけで、表・列・既存データは変えない。ロールバック方針は docs/known-limitations.md §6。
-- ----------------------------------------------------------------------

-- ----------------------------------------------------------------------
-- 1. 再確認の判断の前提: 判断と同じ組織の版だけを見る（別の組織・存在しない版は同じく false）
-- ----------------------------------------------------------------------

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
         and v.organization_id = new.organization_id
         and d.organization_id = new.organization_id
         and (
           v.status = 'approved'
           or (d.status = 'approved' and d.current_version_id = v.id)
           or exists (
             select 1 from approvals a
              where a.organization_id = new.organization_id
                and a.target_type = 'data_point'
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
         and v.organization_id = new.organization_id
         and r.organization_id = new.organization_id
         and r.confirmed_version_id = v.id
    );
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------------
-- 2. レビュー依頼の作成: 組織の開示の編集権限を先に確かめてから、プロジェクトを引く
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
  -- 権限の無い組織の依頼は、プロジェクトの有無を見る前に断る。後で RLS の WITH CHECK が出すのと
  -- 同じ例外にし、プロジェクトがあってもなくても同じ結果にする
  if not t4d.has_permission(new.organization_id, 'enterprise.disclosure.write') then
    raise exception 'new row violates row-level security policy for table "review_requests"'
      using errcode = '42501';
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

-- ----------------------------------------------------------------------
-- 3. 判断の記録: 記録と同じ組織の依頼だけを見て、例外に依頼の状態を載せない
--    （0042 の本体から、依頼の検索に組織の条件を足し、状態の例外の文言から状態を外したもの。他は同じ）
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
  -- 依頼は記録と同じ組織の行だけを見る。別の組織の依頼は「無い」と同じ結果にし、
  -- 状態・指名・版の作成者など、その依頼についての事実を例外の違いから読ませない（A29）
  select * into v_request
    from review_requests r
   where r.id = new.review_request_id
     and r.organization_id = new.organization_id;
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
      raise exception 'T4D_TRANSITION_FORBIDDEN: この状態のレビュー依頼にはその判断を記録できません'
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

