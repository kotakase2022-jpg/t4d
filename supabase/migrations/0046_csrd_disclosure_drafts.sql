-- ----------------------------------------------------------------------
-- CSRD 開示ドラフトの節（docs/disclosure-first.md §9.3 0046）
--
-- 節（ESRS 2 とテーマ別基準 10 個）ごとに 1 行。AI の草案（ai_body）と人の本文（body）を分ける。
-- SSBJ の ssbj_disclosure_drafts（0030）は生成で body まで置き換えていたが、CSRD は
-- AI が ai_body 等の候補列だけを書き、「本文に採用」「保存」「確定」はすべて人が行う
-- （AI は確定しない。CLAUDE.md §0.4）。本文を直すと確定は外れる。
--
-- ssbj_disclosure_drafts は再利用しない（節の値 area と行 ID が衝突し、SSBJ の画面へ混入する）。
-- テナント整合: 0035 と同じ複合外部キー方式。
-- RLS: 参照は組織メンバー、書込は enterprise.disclosure.write（0030 と同じ）。
-- ----------------------------------------------------------------------

create table csrd_disclosure_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  reporting_period_id uuid not null,
  /** 節。src/types/domain.ts の CSRD_SECTIONS と対応 */
  section text not null
    check (section in ('ESRS2', 'E1', 'E2', 'E3', 'E4', 'E5', 'S1', 'S2', 'S3', 'S4', 'G1')),

  /** 開示に載せる本文（人が採用・編集したもの） */
  body text not null default '',
  /** AI の草案（候補）。人が「本文に採用」するまで本文にならない */
  ai_body text not null default '',
  /** 草案が根拠にした要求事項のコード */
  covered_item_codes text[] not null default '{}',
  /** 書けなかった箇所（要求事項コードと理由） */
  gaps jsonb not null default '[]'::jsonb check (jsonb_typeof(gaps) = 'array'),

  ai_run_id uuid,
  ai_confidence numeric(4, 3) check (ai_confidence between 0 and 1),
  ai_warnings text[] not null default '{}',
  ai_generated_at timestamptz,

  /** 人が確定した日時。null は未確定。AI では入らない */
  confirmed_at timestamptz,
  confirmed_by uuid references profiles (id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),

  constraint csrd_disclosure_drafts_period_matches
    foreign key (reporting_period_id, organization_id)
    references reporting_periods (id, organization_id) on delete cascade,
  constraint csrd_disclosure_drafts_ai_run_matches
    foreign key (ai_run_id, organization_id)
    references ai_runs (id, organization_id),
  constraint csrd_disclosure_drafts_unique unique (organization_id, reporting_period_id, section),
  -- 本文の無い節は確定できない
  constraint csrd_disclosure_drafts_confirmed_requires_body
    check (confirmed_at is null or btrim(body) <> ''),
  constraint csrd_disclosure_drafts_confirmed_pair
    check ((confirmed_at is null) = (confirmed_by is null))
);

comment on table csrd_disclosure_drafts is
  'CSRD 開示ドラフトの節ごとの本文。AI の草案（ai_body）と人の本文（body）を分け、確定は人だけが行う。';

create index csrd_disclosure_drafts_org_period_idx
  on csrd_disclosure_drafts (organization_id, reporting_period_id);

alter table csrd_disclosure_drafts enable row level security;

create policy csrd_disclosure_drafts_select on csrd_disclosure_drafts for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy csrd_disclosure_drafts_write on csrd_disclosure_drafts for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.disclosure.write'))
  with check (t4d.has_permission(organization_id, 'enterprise.disclosure.write'));
