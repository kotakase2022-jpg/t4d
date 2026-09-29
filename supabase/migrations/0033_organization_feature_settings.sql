-- ----------------------------------------------------------------------
-- 組織単位の機能設定（開示優先モード）
--
-- 開示業務を中心に据えた画面構成（docs/disclosure-first.md §2-1）は、
-- 使う組織と使わない組織が混在する。既存の組織の画面を黙って変えないよう、
-- 組織ごとに 1 行の設定を持ち、既定は false（従来ナビ・従来ホーム）とする。
--
-- organizations へ列を足さないのは、organizations が Demo Mode の Cookie 持ち回し
-- 対象外（偽造 Cookie で書き換えさせない表）であり、設定だけを持ち回せるように
-- 別表へ分けたいため。
--
-- RLS: 参照は組織メンバー、変更は enterprise.org.manage 保持者のみ。
-- ----------------------------------------------------------------------

create table organization_feature_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  /** 開示優先モード。false の組織は従来ナビ・従来ホームのまま */
  disclosure_first boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),

  constraint organization_feature_settings_org_unique unique (organization_id)
);

comment on table organization_feature_settings is
  '組織単位の機能設定。行が無い組織は既定値（disclosure_first = false）として扱う。';

alter table organization_feature_settings enable row level security;

create policy organization_feature_settings_select on organization_feature_settings
  for select to authenticated
  using (t4d.is_org_member(organization_id));

create policy organization_feature_settings_write on organization_feature_settings
  for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.org.manage'))
  with check (t4d.has_permission(organization_id, 'enterprise.org.manage'));
