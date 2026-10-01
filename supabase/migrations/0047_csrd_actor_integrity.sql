-- ----------------------------------------------------------------------
-- CSRD の判断者・確認者・確定者は本人名義だけ（docs/disclosure-first.md §9.3・自己監査 SEC-2）
--
-- 0044〜0046 の書込ポリシーは enterprise.disclosure.write だけを見ており、同じ組織の編集権限者が
-- PostgREST へ直接、別の人の名義（dma_confirmed_by・decided_by・reviewed_by・confirmed_by）を書けた。
-- 画面には「〇〇さんが確定」と出るため、誰が判断・確定したかの記録が偽れる。
-- 0035〜0037 の「判断・依頼・記録は本人名義（auth.uid()）」と同じ規則を、CSRD の 4 表にも掛ける。
--
-- あわせて DMA の確定（dma_confirmed_at が入る更新）は、確定の条件（報告範囲の決定・
-- ステークホルダー関与の記載・10 事項すべての両軸の判断）を DB でも確かめる
-- （アプリの dmaReadiness・Demo の Cookie の検査 acceptSettings と同じ規則）。
--
-- 対象は利用者の JWT による書込だけ（auth.uid() が null の Service Role・seed は対象外。
-- 0037 の enforce_disclosure_block_update と同じ）。日時と名義の対の CHECK（*_pair）は既存の制約が見るため、
-- 片方だけが入る更新はここでは素通しし、制約の違反として止める。
-- 既存の列・ポリシーは変えない（追加のトリガだけ。ロールバックはトリガと関数の DROP）。
-- ----------------------------------------------------------------------

create or replace function t4d.csrd_actor_must_be_self()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- tg_argv[0]: 名義の列、tg_argv[1]: 対になる日時の列
  actor_column text := tg_argv[0];
  at_column text := tg_argv[1];
  new_actor text := to_jsonb(new) ->> actor_column;
  new_at text := to_jsonb(new) ->> at_column;
  old_actor text := case when tg_op = 'UPDATE' then to_jsonb(old) ->> actor_column end;
  old_at text := case when tg_op = 'UPDATE' then to_jsonb(old) ->> at_column end;
begin
  if auth.uid() is null then
    return new;
  end if;
  -- 名義か日時が新しく入る（変わる）ときだけ確かめる。確定を外す（null に戻す）のは誰でもできる
  if new_actor is not null
     and new_at is not null
     and (new_actor is distinct from old_actor or new_at is distinct from old_at)
     and new_actor <> auth.uid()::text then
    raise exception 'T4D_ACTOR_MUST_BE_SELF: % は本人の名義でのみ記録できます', actor_column
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function t4d.csrd_actor_must_be_self() is
  'CSRD の判断者・確認者・確定者の列は、利用者本人（auth.uid()）の名義でのみ入れられる。';

create trigger csrd_analysis_settings_actor_self
  before insert or update on csrd_analysis_settings
  for each row execute function t4d.csrd_actor_must_be_self('dma_confirmed_by', 'dma_confirmed_at');

create trigger csrd_dma_matters_actor_self
  before insert or update on csrd_dma_matters
  for each row execute function t4d.csrd_actor_must_be_self('decided_by', 'decided_at');

create trigger csrd_assessments_actor_self
  before insert or update on csrd_assessments
  for each row execute function t4d.csrd_actor_must_be_self('reviewed_by', 'reviewed_at');

create trigger csrd_disclosure_drafts_actor_self
  before insert or update on csrd_disclosure_drafts
  for each row execute function t4d.csrd_actor_must_be_self('confirmed_by', 'confirmed_at');

-- ----------------------------------------------------------------------
-- DMA の確定の条件
-- ----------------------------------------------------------------------

create or replace function t4d.csrd_dma_confirmation_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  assessed_topics integer;
begin
  if auth.uid() is null then
    return new;
  end if;
  -- 確定が新しく入る（日時か確定者が変わる）ときだけ。片方だけの更新は対の CHECK が止める
  if new.dma_confirmed_at is null or new.dma_confirmed_by is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.dma_confirmed_at is not distinct from old.dma_confirmed_at
     and new.dma_confirmed_by is not distinct from old.dma_confirmed_by then
    return new;
  end if;

  if new.value_chain_scope = 'not_decided'
     or (new.consolidation_scope = 'custom' and btrim(new.consolidation_note) = '') then
    raise exception 'T4D_DMA_NOT_READY: 報告範囲が決まっていないため、DMA を確定できません'
      using errcode = '23514';
  end if;
  if btrim(new.stakeholder_engagement_note) = '' then
    raise exception 'T4D_DMA_NOT_READY: ステークホルダー関与の記載が無いため、DMA を確定できません'
      using errcode = '23514';
  end if;
  select count(distinct m.esrs_topic) into assessed_topics
    from csrd_dma_matters m
   where m.organization_id = new.organization_id
     and m.reporting_period_id = new.reporting_period_id
     and m.impact_assessment <> 'not_assessed'
     and m.financial_assessment <> 'not_assessed';
  if assessed_topics < 10 then
    raise exception 'T4D_DMA_NOT_READY: 未評価のサステナビリティ事項があるため、DMA を確定できません'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function t4d.csrd_dma_confirmation_guard() is
  'DMA の確定は、報告範囲の決定・ステークホルダー関与の記載・10 事項すべての両軸の判断がそろったときだけ。';

create trigger csrd_analysis_settings_dma_guard
  before insert or update on csrd_analysis_settings
  for each row execute function t4d.csrd_dma_confirmation_guard();
