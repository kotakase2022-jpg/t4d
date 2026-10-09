-- ----------------------------------------------------------------------
-- インパクト・リスク・機会の台帳のための列（トライアル対応 2026-10: NF-10）
--
-- 1. csrd_dma_iros に根拠（引用位置）と方針・取組のメモを足す。
-- 2. narrative_versions に、その版が説明する IRO（csrd_dma_iros.id）の参照を足す。
--    SSBJ の「企業への影響（財務的影響を含む）」の定性情報と、CSRD・ESRS-40a の「人・環境へのインパクト」を
--    同じ台帳で並べるため。narrative_versions は追記専用のため、列を足すだけ（既存の行は空配列）。
-- 参照先はどちらも配列で外部キーにできないため、同じ組織の行であることをトリガで確かめる。
-- ロールバック方針は docs/known-limitations.md §6。
-- ----------------------------------------------------------------------

alter table csrd_dma_iros
  add column source_anchor_ids uuid[] not null default '{}',
  add column policy_action_note text not null default '';

alter table narrative_versions
  add column iro_refs uuid[] not null default '{}';

comment on column narrative_versions.iro_refs is
  'この版が説明するインパクト・リスク・機会（csrd_dma_iros.id）。同じ組織の行だけ。';

create or replace function t4d.iro_source_anchor_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if cardinality(new.source_anchor_ids) = 0 then
    return new;
  end if;
  if exists (
    select 1 from unnest(new.source_anchor_ids) as r(anchor_id)
     where not exists (
       select 1 from source_anchors a
        where a.id = r.anchor_id and a.organization_id = new.organization_id
     )
  ) then
    raise exception 'T4D_TENANT_SCOPE: 別の組織の引用位置は根拠にできません'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger csrd_dma_iros_source_anchor_guard
  before insert or update of source_anchor_ids on csrd_dma_iros
  for each row execute function t4d.iro_source_anchor_guard();

create or replace function t4d.narrative_iro_refs_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if cardinality(new.iro_refs) = 0 then
    return new;
  end if;
  if exists (
    select 1 from unnest(new.iro_refs) as r(iro_id)
     where not exists (
       select 1 from csrd_dma_iros i
        where i.id = r.iro_id and i.organization_id = new.organization_id
     )
  ) then
    raise exception 'T4D_TENANT_SCOPE: 別の組織のインパクト・リスク・機会は参照できません'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger narrative_versions_iro_refs_guard
  before insert on narrative_versions
  for each row execute function t4d.narrative_iro_refs_guard();
