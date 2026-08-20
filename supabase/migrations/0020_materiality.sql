-- ----------------------------------------------------------------------
-- マテリアリティ評価（SSBJ 開示対応の起点）
--
-- SSBJ は「自社にとって重要なサステナビリティ関連のリスク・機会」を特定した
-- うえで開示する。したがって開示項目の一覧から入るのではなく、
--   マテリアリティの登録 → 対象データの収集 → 充足度の確認 → 不足項目の対応
-- という順序になる。その起点をデータとして持つためのテーブル。
--
-- 組織 × 報告期間 × トピック で一意。期間ごとに見直す運用を想定している。
-- 対象指標は metric の code 配列で持つ（指標マスターは組織ごとに ID が異なるため、
-- 期間をまたいでも読み替えられる code を保持する）。
--
-- RLS: 参照は組織メンバー、更新は enterprise.disclosure.write 保持者のみ
--      （applicability_results と同じ扱い）。
-- ----------------------------------------------------------------------

create table materiality_topics (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  reporting_period_id uuid not null references reporting_periods (id) on delete cascade,
  topic_key text not null,
  title text not null,
  category text not null
    check (category in ('environment', 'social', 'governance')),
  materiality text not null default 'not_assessed'
    check (materiality in ('high', 'medium', 'low', 'not_material', 'not_assessed')),
  rationale text not null default '',
  -- 対象指標（metric_definitions.code の配列）
  metric_codes text[] not null default '{}',
  assessed_at timestamptz,
  assessed_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  constraint materiality_topics_unique unique (organization_id, reporting_period_id, topic_key)
);

create index materiality_topics_org_period_idx
  on materiality_topics (organization_id, reporting_period_id);

comment on table materiality_topics is
  'マテリアリティ評価。SSBJ 開示の起点となる重要課題の特定結果を期間ごとに保持する。';

alter table materiality_topics enable row level security;

create policy materiality_topics_select on materiality_topics for select to authenticated
  using (t4d.is_org_member(organization_id));

create policy materiality_topics_write on materiality_topics for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.disclosure.write'))
  with check (t4d.has_permission(organization_id, 'enterprise.disclosure.write'));
