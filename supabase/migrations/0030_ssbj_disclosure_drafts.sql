-- ----------------------------------------------------------------------
-- SSBJ 開示ドラフトの草案
--
-- これまで「開示ドラフト」は DOCX を書き出すだけで、中身の文章は
-- 人が一から書くしかなかった。要求事項の判定とデータは揃っているのに、
-- それを文章にする工程だけが手作業のまま残っていた。
--
-- AI に節（ガバナンス・戦略・リスク管理・指標及び目標）単位の草案を
-- 書かせ、その結果をここへ保存する。保存するのはあくまで**草案**で、
-- 人が読んで直し、確定して初めて開示に載る（CLAUDE.md §0.4）。
--
-- 節ごとに 1 行。作り直すと本文が置き換わるが、
-- 誰がいつ確定したかは残す（差し替えたら確定は外れる）。
--
-- RLS: 参照は組織メンバー、更新は enterprise.disclosure.write 保持者のみ。
-- ----------------------------------------------------------------------

create table ssbj_disclosure_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  reporting_period_id uuid not null references reporting_periods (id) on delete cascade,
  /** 開示書類の節。src/lib/domain/ssbj.ts の SsbjArea と対応する */
  area text not null check (area in ('governance', 'strategy', 'risk', 'metrics', 'other')),

  /** 開示に載せる文章。AI の草案を人が直したもの */
  body text not null default '',
  /** AI が草案を書いた時点の本文（人の修正と区別するために残す） */
  ai_body text not null default '',
  /** 草案が根拠にした要求事項のコード */
  covered_item_codes text[] not null default '{}',
  /** 書けなかった箇所（要求事項コードと理由） */
  gaps jsonb not null default '[]'::jsonb,

  ai_run_id uuid references ai_runs (id),
  ai_confidence numeric(4, 3),
  ai_warnings text[] not null default '{}',
  ai_generated_at timestamptz,

  /** 人が確定した日時。null は未確定。AI では入らない */
  confirmed_at timestamptz,
  confirmed_by uuid references profiles (id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),

  constraint ssbj_disclosure_drafts_unique unique (organization_id, reporting_period_id, area)
);

comment on table ssbj_disclosure_drafts is
  'SSBJ 開示ドラフトの節ごとの草案。AI が書いた ai_body と、人が直した body を分けて持つ。';
comment on column ssbj_disclosure_drafts.confirmed_at is
  '人が確定した日時。null は未確定。AI では入らない。';

create index ssbj_disclosure_drafts_org_period_idx
  on ssbj_disclosure_drafts (organization_id, reporting_period_id);

alter table ssbj_disclosure_drafts enable row level security;

create policy ssbj_disclosure_drafts_select on ssbj_disclosure_drafts for select to authenticated
  using (t4d.is_org_member(organization_id));

create policy ssbj_disclosure_drafts_write on ssbj_disclosure_drafts for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.disclosure.write'))
  with check (t4d.has_permission(organization_id, 'enterprise.disclosure.write'));
