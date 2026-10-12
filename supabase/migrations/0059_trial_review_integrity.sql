-- ----------------------------------------------------------------------
-- トライアル対応のレビュー指摘への対応（2026-10-12）。DB の第二の防御線の抜け道を塞ぐ
--
-- 1. 対象外・非重要の申請と承認（0049 の t4d.requirement_exclusion_event_guard を置き換える）
--    - 承認・差戻し・取り下げは、同じ内容（区分・理由のダイジェスト）の最後の記録が「申請」のときだけ
--      （差し戻した・取り下げた申請を、申請し直さずに承認させない。アプリの decideExclusion と同じ）
--    - 利用者の JWT の書込では記録の時刻をサーバーが決める（前の記録より必ず後。状態は時刻順に導くため、
--      時刻を指定して並びを入れ替えさせない）
--    - 理由を記録した人は承認できない。SSBJ の評価でも検査する（新しい列 reason_recorded_by。
--      無い行は最後に更新した人）。プロジェクトの判断は決定者（decided_by）
-- 2. ssbj_assessments.reason_recorded_by: 適用区分・重要性とその理由を最後に記録した人。利用者の JWT の
--    書込では、それらの列が変わったときに本人を入れ、変わらないときは前の値を保つ（直接書き換えさせない）
-- 3. project_requirement_assessments: 対象外・非重要の判断は決定者を必ず持ち、区分・理由を変えた人が
--    決定者になる（決定者を外して・別の人にして「理由を記録した人」の検査を逃れさせない）
-- 4. xbrl_tag_mappings: 作成者は本人だけ（INSERT のポリシーと trigger）。利用者の JWT では候補として作り、
--    作成と同時に確定しない。最後に内容を変えた人の確定・内容の変更と同時の確定を断る（アプリの
--    confirmBlockedReason と同じ）
-- 5. 開示回答（0057 の職務分離の抜け道）
--    - disclosure_response_versions.created_by は本人だけ（別の人の名義で版を作って承認させない）
--    - 承認と同じ更新で現在の版を差し替えない。承認する本文は現在の版の本文と同じであること
--    - 一度付いた現在の版を外さない（版の無い回答として承認させない）
-- 6. shared_report_copies（0050）
--    - 利用者の JWT では写しを作れない（INSERT のポリシーを外し、トリガでも断る）。写しはサーバーが
--      承認版から作り、Service Role で書く（src/lib/services/report-share.ts。内容・ハッシュを利用者に
--      書かせない。作り話の「社内承認済み版」を保証側に見せない）
--    - 案件のメンバー（保証側）が読めるのは共有中の写しだけ（取り下げた写しは見えない）
--    - 写しが引用する資料の版は、写しのクライアント企業の資料に限る（アプリの canReadEvidence と同じ）
--
-- 列の追加・関数の置き換え・トリガとポリシーの追加と付け替えだけ（破壊的変更なし）。
-- ロールバック方針は docs/known-limitations.md §6（関数を 0049・0050・0054・0057 の定義に戻す。列は残す）。
-- ----------------------------------------------------------------------

-- ----------------------------------------------------------------------
-- 2. SSBJ の評価の「理由を記録した人」
-- ----------------------------------------------------------------------

alter table ssbj_assessments
  add column reason_recorded_by uuid references profiles (id);

comment on column ssbj_assessments.reason_recorded_by is
  '適用区分・重要性とその理由を最後に記録した人。対象外・非重要の承認の職務分離に使う（null は以前の行。最後の更新者で代える）。';

create or replace function t4d.ssbj_assessment_reason_recorder()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if tg_op = 'INSERT'
     or new.applicability is distinct from old.applicability
     or new.applicability_reason is distinct from old.applicability_reason
     or new.materiality is distinct from old.materiality
     or new.materiality_reason is distinct from old.materiality_reason then
    new.reason_recorded_by := auth.uid();
  else
    new.reason_recorded_by := old.reason_recorded_by;
  end if;
  return new;
end;
$$;

create trigger ssbj_assessments_reason_recorder
  before insert or update on ssbj_assessments
  for each row execute function t4d.ssbj_assessment_reason_recorder();

-- ----------------------------------------------------------------------
-- 3. プロジェクトの判断の決定者
-- ----------------------------------------------------------------------

create or replace function t4d.project_requirement_exclusion_decider()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or new.applicability not in ('not_applicable', 'not_material') then
    return new;
  end if;
  if new.decided_by is null then
    raise exception 'T4D_DECIDER_REQUIRED: 対象外・非重要の判断には決定者（本人）の記録が必要です'
      using errcode = '23514';
  end if;
  if (tg_op = 'INSERT'
      or new.applicability is distinct from old.applicability
      or new.applicability_reason is distinct from old.applicability_reason)
     and new.decided_by is distinct from auth.uid() then
    raise exception 'T4D_ACTOR_MUST_BE_SELF: 区分・理由を変えた人を決定者として記録してください'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger project_requirement_assessments_exclusion_decider
  before insert or update on project_requirement_assessments
  for each row execute function t4d.project_requirement_exclusion_decider();

-- ----------------------------------------------------------------------
-- 1. 対象外・非重要の申請と承認
-- ----------------------------------------------------------------------

create or replace function t4d.requirement_exclusion_event_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text;
  v_current_decision text;
  v_recorder uuid;
  v_last_at timestamptz;
  v_latest requirement_exclusion_events%rowtype;
begin
  -- 要求事項は名乗った基準の版のもの
  if not exists (
    select 1 from disclosure_items i
     where i.id = new.item_id and i.framework_version_id = new.framework_version_id
  ) then
    raise exception 'T4D_EXCLUSION_SCOPE: 基準の版に属さない要求事項です'
      using errcode = '23514';
  end if;

  -- 利用者の JWT の書込では時刻をサーバーが決める（同じ要求事項の前の記録より必ず後）
  if auth.uid() is not null then
    select max(e.created_at) into v_last_at
      from requirement_exclusion_events e
     where e.organization_id = new.organization_id
       and e.item_id = new.item_id
       and e.reporting_period_id = new.reporting_period_id
       and e.project_framework_id is not distinct from new.project_framework_id;
    new.created_at := greatest(
      clock_timestamp(),
      coalesce(v_last_at + interval '1 millisecond', clock_timestamp())
    );
  end if;

  -- 判断の行（理由）は同じ組織のもの。今の区分・理由とダイジェストが一致すること
  if new.source = 'ssbj_assessment' then
    select case when new.decision = 'not_applicable' then a.applicability_reason
                else a.materiality_reason end,
           case when a.applicability = 'not_applicable' then 'not_applicable'
                when a.materiality = 'not_material' then 'not_material'
                else null end,
           coalesce(a.reason_recorded_by, a.updated_by, a.created_by)
      into v_reason, v_current_decision, v_recorder
      from ssbj_assessments a
     where a.organization_id = new.organization_id
       and a.reporting_period_id = new.reporting_period_id
       and a.item_id = new.item_id;
  else
    if not exists (
      select 1 from project_frameworks pf
       where pf.id = new.project_framework_id
         and pf.organization_id = new.organization_id
         and pf.framework_version_id = new.framework_version_id
    ) then
      raise exception 'T4D_EXCLUSION_SCOPE: プロジェクトの基準が見つかりません'
        using errcode = '23514';
    end if;
    select a.applicability_reason,
           case when a.applicability in ('not_applicable', 'not_material') then a.applicability end,
           a.decided_by
      into v_reason, v_current_decision, v_recorder
      from project_requirement_assessments a
     where a.organization_id = new.organization_id
       and a.project_framework_id = new.project_framework_id
       and a.item_id = new.item_id;
  end if;

  if new.event in ('requested', 'approved') then
    if v_current_decision is distinct from new.decision
       or t4d.exclusion_reason_digest(new.decision, v_reason) <> new.reason_digest then
      raise exception 'T4D_EXCLUSION_STALE: 判断の区分・理由が申請の内容と一致しません（理由を変えた場合は申請し直してください）'
        using errcode = '23514';
    end if;
  end if;

  if new.event = 'requested' then
    if not t4d.user_has_permission(new.organization_id, new.actor_user_id, 'enterprise.disclosure.write') then
      raise exception 'T4D_EXCLUSION_FORBIDDEN: 申請には開示の編集権限が必要です'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- 承認・差戻し・取り下げ: 同じ内容（区分・ダイジェスト）の最後の記録が申請であること
  select * into v_latest
    from requirement_exclusion_events e
   where e.organization_id = new.organization_id
     and e.item_id = new.item_id
     and e.reporting_period_id = new.reporting_period_id
     and e.project_framework_id is not distinct from new.project_framework_id
     and e.reason_digest = new.reason_digest
     and e.decision = new.decision
   order by e.created_at desc, e.id desc
   limit 1;
  if not found or v_latest.event <> 'requested' or new.created_at <= v_latest.created_at then
    raise exception 'T4D_EXCLUSION_NO_REQUEST: 承認待ちの同じ内容の申請がありません（差し戻した・取り下げた申請は申請し直してください）'
      using errcode = '23514';
  end if;

  if new.event = 'withdrawn' then
    if new.actor_user_id <> v_latest.actor_user_id
       and not t4d.user_has_permission(new.organization_id, new.actor_user_id, 'enterprise.disclosure.write') then
      raise exception 'T4D_EXCLUSION_FORBIDDEN: 申請を取り下げられるのは申請者か編集権限者です'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- 承認・差戻し: 申請者・理由を記録した人と別の、開示の承認権限を持つ人（差戻しは記録した人でもできる）
  if new.actor_user_id = v_latest.actor_user_id then
    raise exception 'T4D_EXCLUSION_SOD: 申請者は承認・差戻しできません'
      using errcode = '42501';
  end if;
  if new.event = 'approved' and v_recorder is not null and new.actor_user_id = v_recorder then
    raise exception 'T4D_EXCLUSION_SOD: 理由を記録した人は承認できません'
      using errcode = '42501';
  end if;
  if not t4d.user_has_permission(new.organization_id, new.actor_user_id, 'enterprise.disclosure.approve') then
    raise exception 'T4D_EXCLUSION_FORBIDDEN: 承認・差戻しには開示の承認権限が必要です'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------------
-- 4. XBRL の対応付け
-- ----------------------------------------------------------------------

drop policy xbrl_tag_mappings_insert on xbrl_tag_mappings;
create policy xbrl_tag_mappings_insert on xbrl_tag_mappings
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and t4d.has_permission(organization_id, 'enterprise.disclosure.write')
  );

create or replace function t4d.xbrl_tag_mapping_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text;
  v_confirming boolean;
begin
  select c.kind into v_kind
    from xbrl_concepts c
   where c.id = new.concept_id and c.package_id = new.package_id;
  if not found then
    raise exception 'T4D_XBRL_SCOPE: 概念がパッケージに属しません'
      using errcode = '23514';
  end if;
  -- 値を持つ概念だけに対応付ける（抽象・軸・メンバーに値を付けない）
  if v_kind not in ('item', 'text_block') then
    raise exception 'T4D_XBRL_SCOPE: 抽象・軸・メンバーの概念には対応付けられません'
      using errcode = '23514';
  end if;
  if new.disclosure_item_id is not null and new.framework_version_id is not null and not exists (
    select 1 from disclosure_items i
     where i.id = new.disclosure_item_id and i.framework_version_id = new.framework_version_id
  ) then
    raise exception 'T4D_XBRL_SCOPE: 要求事項が基準の版に属しません'
      using errcode = '23514';
  end if;

  -- 作成: 利用者の JWT では本人の名義で、候補として作る（作成と同時に確定・対象外にしない）
  if auth.uid() is not null and tg_op = 'INSERT' then
    if new.created_by is distinct from auth.uid() then
      raise exception 'T4D_ACTOR_MUST_BE_SELF: 対応付けの作成者は本人の名義でのみ記録できます'
        using errcode = '42501';
    end if;
    if new.status <> 'candidate' or new.confirmed_by is not null or new.confirmed_at is not null then
      raise exception 'T4D_XBRL_FORBIDDEN: 対応付けは候補として作り、別の承認者が確定します'
        using errcode = '42501';
    end if;
  end if;

  -- 確定: 利用者の JWT による書込は、開示の承認権限を持つ本人の名義だけ（Service Role・seed は対象外）
  v_confirming := new.status = 'confirmed'
    and (tg_op = 'INSERT' or old.status is distinct from 'confirmed'
         or old.confirmed_by is distinct from new.confirmed_by);
  if auth.uid() is not null and v_confirming then
    if not t4d.has_permission(new.organization_id, 'enterprise.disclosure.approve') then
      raise exception 'T4D_XBRL_FORBIDDEN: 対応付けの確定には開示の承認権限が必要です'
        using errcode = '42501';
    end if;
    if new.confirmed_by is distinct from auth.uid() then
      raise exception 'T4D_ACTOR_MUST_BE_SELF: 確定は本人の名義でのみ記録できます'
        using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' then
      -- 職務分離: 最後に内容を変えた人は確定しない（作った人は CHECK の xbrl_tag_mappings_confirm_sod）
      if old.updated_by is not null and old.updated_by = new.confirmed_by then
        raise exception 'T4D_XBRL_SOD: 最後に内容を変えた人は確定できません'
          using errcode = '42501';
      end if;
      -- 内容の変更と確定を同じ操作で行わない（自分で書き換えた内容を確定させない）
      if (to_jsonb(new) - array['status', 'confirmed_by', 'confirmed_at', 'updated_at', 'updated_by'])
         is distinct from
         (to_jsonb(old) - array['status', 'confirmed_by', 'confirmed_at', 'updated_at', 'updated_by']) then
        raise exception 'T4D_XBRL_SOD: 内容の変更と確定は別の操作で行ってください'
          using errcode = '42501';
      end if;
    end if;
  end if;
  -- 確定・作成の名義を後から差し替えない
  if tg_op = 'UPDATE' and auth.uid() is not null
     and new.created_by is distinct from old.created_by then
    raise exception 'T4D_IMMUTABLE: 対応付けの作成者は変更できません'
      using errcode = '42501';
  end if;
  -- 承認権限だけを持つ人（編集権限なし）は確定の列しか変えられない（0042 の節の更新と同じ考え方）
  if tg_op = 'UPDATE' and auth.uid() is not null
     and not t4d.has_permission(new.organization_id, 'enterprise.disclosure.write')
     and (to_jsonb(new) - array['status', 'confirmed_by', 'confirmed_at', 'updated_at', 'updated_by'])
         is distinct from
         (to_jsonb(old) - array['status', 'confirmed_by', 'confirmed_at', 'updated_at', 'updated_by']) then
    raise exception 'T4D_XBRL_FORBIDDEN: 承認権限だけでは対応付けの内容は変更できません'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------------
-- 5. 開示回答の版の作成者と承認の職務分離
-- ----------------------------------------------------------------------

create or replace function t4d.disclosure_response_version_author_self()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null and new.created_by is distinct from auth.uid() then
    raise exception 'T4D_ACTOR_MUST_BE_SELF: 回答の版は本人の名義でのみ作成できます'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger disclosure_response_versions_author_self
  before insert on disclosure_response_versions
  for each row execute function t4d.disclosure_response_version_author_self();

create or replace function t4d.disclosure_response_approval_sod()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_version disclosure_response_versions%rowtype;
begin
  if auth.uid() is null then
    return new;
  end if;
  -- 一度付いた現在の版を外さない（版の無い回答として承認させない。版は追記で増える）
  if tg_op = 'UPDATE' and old.current_version_id is not null and new.current_version_id is null then
    raise exception 'T4D_RESPONSE_SOD: 回答の現在の版は外せません'
      using errcode = '42501';
  end if;
  if new.status <> 'approved' then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and old.status = 'approved'
     and new.current_version_id is not distinct from old.current_version_id
     and new.approved_by is not distinct from old.approved_by then
    return new;
  end if;
  -- 承認と同じ更新で現在の版を差し替えない（別の人の版を指して自分の回答を承認させない）
  if tg_op = 'UPDATE' and new.current_version_id is distinct from old.current_version_id then
    raise exception 'T4D_RESPONSE_SOD: 承認と同じ操作で回答の版を差し替えることはできません'
      using errcode = '42501';
  end if;
  if new.current_version_id is not null then
    select * into v_version
      from disclosure_response_versions v
     where v.id = new.current_version_id and v.response_id = new.id;
    -- 承認する本文は現在の版の本文と同じであること（版の作成者と別の人が書いた本文を承認させない）
    if found and (
      new.answer_text is distinct from v_version.answer_text
      or new.answer_numeric is distinct from v_version.answer_numeric
      or new.answer_choice is distinct from v_version.answer_choice
    ) then
      raise exception 'T4D_RESPONSE_SOD: 回答の本文が現在の版と一致しません（版として保存してから承認してください）'
        using errcode = '42501';
    end if;
    if found and v_version.created_by is not null
       and (v_version.created_by = auth.uid() or v_version.created_by = new.approved_by) then
      raise exception 'T4D_RESPONSE_SOD: 回答の現在の版を作成した人は承認できません'
        using errcode = '42501';
    end if;
  end if;
  if new.approved_by is not null and new.approved_by <> auth.uid() then
    raise exception 'T4D_ACTOR_MUST_BE_SELF: 承認は本人の名義でのみ記録できます'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------------
-- 6. 共有レポートの写し
-- ----------------------------------------------------------------------

-- 利用者の JWT では写しを作らない（サーバーが承認版から作り、Service Role で書く）
drop policy shared_report_copies_insert on shared_report_copies;

-- 保証側（案件のメンバー）は共有中の写しだけを読む。企業（クライアント）は取り下げた写しも読む
drop policy shared_report_copies_select on shared_report_copies;
create policy shared_report_copies_select on shared_report_copies for select to authenticated
  using (
    (t4d.is_engagement_member(engagement_id) and withdrawn_at is null)
    or t4d.is_org_member(client_organization_id)
  );

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

  -- 写しの内容は利用者に書かせない（サーバーが承認版から作る。ポリシーを足しても効くようにここでも断る）
  if auth.uid() is not null then
    raise exception 'T4D_SHARE_SERVER_ONLY: 共有の写しはサーバーが承認版から作ります'
      using errcode = '42501';
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
  -- 共有した人はクライアント企業で許諾の管理の権限を持つ人（サーバーが本人の名義で書く）
  if not t4d.user_has_permission(new.client_organization_id, new.shared_by, 'enterprise.grant.manage') then
    raise exception 'T4D_SHARE_SCOPE: 共有した人に許諾の管理の権限がありません'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

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
      -- 写しのクライアント企業の資料の版だけ（他社の資料の版を写しに書いても読ませない）
      join file_versions fv
        on fv.id = p_file_version_id
       and fv.organization_id = c.client_organization_id
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
