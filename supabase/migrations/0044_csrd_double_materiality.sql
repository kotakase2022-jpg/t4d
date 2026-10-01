-- ----------------------------------------------------------------------
-- CSRD のダブル・マテリアリティ評価（docs/disclosure-first.md §9.2・§9.3 0044）
--
-- SSBJ は財務的重要性（シングル）で、重要性は ssbj_assessments の 1 軸に持つ。
-- CSRD（ESRS）はインパクトと財務の 2 軸で、どちらかで重要なら要求事項が適用になる。
-- 事項（ESRS のテーマ別基準 10 個）ごとに IRO（影響・リスク・機会）を登録し、
-- 算定結果は「提案」として画面に出すだけで、各軸の重要／重要でないは人が根拠付きで決める
-- （AI は判断も確定もしない。CLAUDE.md §0.4）。
--
-- ESRS は数値の閾値を定めていないため、閾値と採点方法は会社が決めて開示するものとして
-- 分析条件（csrd_analysis_settings）に持つ（scoring_method = 'dma-demo-v1' はデモ既定）。
--
-- SSBJ の表（ssbj_analysis_settings 等）は再利用しない。SSBJ 専用の列を持ち、
-- 組織 × 期間で一意のため、CSRD の行を足すと SSBJ の画面へ混入する（§9.3）。
--
-- テナント整合: 子の organization_id は親と一致させる（0035 と同じ複合外部キー方式）。
-- 報告期間も (id, organization_id) で参照し、他社の期間を名乗る行を作らせない。
-- RLS: 参照は組織メンバー、書込は enterprise.disclosure.write（0028 / 0030 と同じ）。
-- 追記専用の表は無い（判断・閾値は書き換えられ、確定は同じ処理で外れる）。
-- ----------------------------------------------------------------------

-- ----------------------------------------------------------------------
-- 分析条件（報告範囲・評価方法・閾値・ステークホルダー関与・DMA の確定）
-- ----------------------------------------------------------------------

create table csrd_analysis_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  reporting_period_id uuid not null,

  -- 報告の範囲（値と意味は 0028 の ssbj_analysis_settings と同じ）
  consolidation_scope text not null default 'same_as_financial'
    check (consolidation_scope in ('same_as_financial', 'custom')),
  consolidation_note text not null default '',
  /** 報告対象に含める組織・拠点。空配列は全社（未指定） */
  included_unit_ids uuid[] not null default '{}',
  value_chain_scope text not null default 'not_decided'
    check (value_chain_scope in ('not_decided', 'upstream', 'downstream', 'both', 'none')),
  value_chain_note text not null default '',

  -- 評価方法（自社の方法。ESRS は閾値を定めない）
  scoring_method text not null default 'dma-demo-v1'
    check (scoring_method in ('dma-demo-v1')),
  impact_threshold numeric(2, 1) not null default 3.0
    check (impact_threshold between 1.0 and 5.0),
  financial_threshold numeric(2, 1) not null default 3.0
    check (financial_threshold between 1.0 and 5.0),
  method_note text not null default '',
  stakeholder_engagement_note text not null default '',

  -- DMA の確定（人の操作でのみ入る。DMA に関わる書込で外れる）
  dma_confirmed_at timestamptz,
  dma_confirmed_by uuid references profiles (id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),

  constraint csrd_analysis_settings_period_matches
    foreign key (reporting_period_id, organization_id)
    references reporting_periods (id, organization_id) on delete cascade,
  constraint csrd_analysis_settings_period_unique unique (organization_id, reporting_period_id),
  constraint csrd_analysis_settings_dma_confirmed_pair
    check ((dma_confirmed_at is null) = (dma_confirmed_by is null))
);

comment on table csrd_analysis_settings is
  'CSRD の分析条件（報告範囲・DMA の評価方法と閾値・ステークホルダー関与）と DMA の確定。組織 × 期間で 1 件。';
comment on column csrd_analysis_settings.dma_confirmed_at is
  'DMA を人が確定した日時。null は未確定（要求事項の適用は暫定）。AI では入らない。';

create index csrd_analysis_settings_org_period_idx
  on csrd_analysis_settings (organization_id, reporting_period_id);

-- ----------------------------------------------------------------------
-- サステナビリティ事項ごとの人の判断（2 軸）
-- ----------------------------------------------------------------------

create table csrd_dma_matters (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  reporting_period_id uuid not null,
  /** ESRS のテーマ別基準。src/types/domain.ts の ESRS_TOPICS と対応 */
  esrs_topic text not null
    check (esrs_topic in ('E1', 'E2', 'E3', 'E4', 'E5', 'S1', 'S2', 'S3', 'S4', 'G1')),

  impact_assessment text not null default 'not_assessed'
    check (impact_assessment in ('material', 'not_material', 'not_assessed')),
  financial_assessment text not null default 'not_assessed'
    check (financial_assessment in ('material', 'not_material', 'not_assessed')),
  impact_rationale text not null default '',
  financial_rationale text not null default '',
  stakeholder_note text not null default '',
  decided_at timestamptz,
  decided_by uuid references profiles (id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),

  constraint csrd_dma_matters_period_matches
    foreign key (reporting_period_id, organization_id)
    references reporting_periods (id, organization_id) on delete cascade,
  constraint csrd_dma_matters_topic_unique unique (organization_id, reporting_period_id, esrs_topic),
  constraint csrd_dma_matters_id_org_unique unique (id, organization_id),
  -- 「重要」「重要でない」と判断した軸は、その根拠を必ず残す（重要でない判断も開示の対象になる）
  constraint csrd_dma_matters_impact_rationale
    check (impact_assessment = 'not_assessed' or btrim(impact_rationale) <> ''),
  constraint csrd_dma_matters_financial_rationale
    check (financial_assessment = 'not_assessed' or btrim(financial_rationale) <> ''),
  constraint csrd_dma_matters_decided_pair check ((decided_at is null) = (decided_by is null))
);

comment on table csrd_dma_matters is
  'CSRD のサステナビリティ事項ごとの重要性の判断（インパクト・財務の 2 軸）。結果は 2 軸から導出し、列に持たない。';

create index csrd_dma_matters_org_period_idx
  on csrd_dma_matters (organization_id, reporting_period_id);

-- ----------------------------------------------------------------------
-- IRO（影響・リスク・機会）。すべて 1〜5 の整数入力
-- ----------------------------------------------------------------------

create table csrd_dma_iros (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  reporting_period_id uuid not null,
  matter_id uuid not null,
  iro_type text not null check (iro_type in ('impact', 'risk', 'opportunity')),
  sub_topic text not null default '',
  description text not null check (btrim(description) <> ''),
  value_chain_stage text not null
    check (value_chain_stage in ('own_operations', 'upstream', 'downstream')),
  time_horizon text check (time_horizon in ('short', 'medium', 'long')),

  -- インパクト（impact のときだけ）
  impact_occurrence text check (impact_occurrence in ('actual', 'potential')),
  impact_direction text check (impact_direction in ('negative', 'positive')),
  impact_scale smallint check (impact_scale between 1 and 5),
  impact_scope smallint check (impact_scope between 1 and 5),
  impact_irremediability smallint check (impact_irremediability between 1 and 5),
  impact_likelihood smallint check (impact_likelihood between 1 and 5),

  -- リスク・機会（risk / opportunity のときだけ）
  financial_likelihood smallint check (financial_likelihood between 1 and 5),
  financial_magnitude smallint check (financial_magnitude between 1 and 5),

  human_rights boolean not null default false,
  affected_stakeholders text not null default '',
  /** リスク・機会が関連するインパクト IRO（任意） */
  related_impact_iro_id uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),
  deleted_at timestamptz,

  constraint csrd_dma_iros_period_matches
    foreign key (reporting_period_id, organization_id)
    references reporting_periods (id, organization_id) on delete cascade,
  constraint csrd_dma_iros_matter_matches
    foreign key (matter_id, organization_id)
    references csrd_dma_matters (id, organization_id) on delete cascade,
  constraint csrd_dma_iros_id_org_unique unique (id, organization_id),
  -- 関連するインパクト IRO は同じ組織の行だけ（他社の IRO を指させない）
  constraint csrd_dma_iros_related_matches
    foreign key (related_impact_iro_id, organization_id)
    references csrd_dma_iros (id, organization_id),
  constraint csrd_dma_iros_related_from_financial
    check (
      related_impact_iro_id is null
      or (iro_type in ('risk', 'opportunity') and related_impact_iro_id <> id)
    ),
  -- インパクトの形: 発生・方向・規模・範囲あり、財務 2 列なし。負 ⇔ 回復困難性あり、潜在 ⇔ 可能性あり
  constraint csrd_dma_iros_impact_shape
    check (
      iro_type <> 'impact'
      or (
        impact_occurrence is not null
        and impact_direction is not null
        and impact_scale is not null
        and impact_scope is not null
        and financial_likelihood is null
        and financial_magnitude is null
        and (impact_direction = 'negative') = (impact_irremediability is not null)
        and (impact_occurrence = 'potential') = (impact_likelihood is not null)
      )
    ),
  -- リスク・機会の形: インパクト系 6 列なし・人権フラグなし、財務 2 列と期間あり
  constraint csrd_dma_iros_financial_shape
    check (
      iro_type = 'impact'
      or (
        impact_occurrence is null
        and impact_direction is null
        and impact_scale is null
        and impact_scope is null
        and impact_irremediability is null
        and impact_likelihood is null
        and human_rights = false
        and financial_likelihood is not null
        and financial_magnitude is not null
        and time_horizon is not null
      )
    )
);

comment on table csrd_dma_iros is
  'CSRD の IRO（影響・リスク・機会）。算定結果は提案で、事項の重要性は csrd_dma_matters で人が判断する。';

create index csrd_dma_iros_org_period_idx on csrd_dma_iros (organization_id, reporting_period_id);
create index csrd_dma_iros_matter_idx on csrd_dma_iros (matter_id);

-- ----------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------

alter table csrd_analysis_settings enable row level security;
alter table csrd_dma_matters enable row level security;
alter table csrd_dma_iros enable row level security;

create policy csrd_analysis_settings_select on csrd_analysis_settings for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy csrd_analysis_settings_write on csrd_analysis_settings for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.disclosure.write'))
  with check (t4d.has_permission(organization_id, 'enterprise.disclosure.write'));

create policy csrd_dma_matters_select on csrd_dma_matters for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy csrd_dma_matters_write on csrd_dma_matters for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.disclosure.write'))
  with check (t4d.has_permission(organization_id, 'enterprise.disclosure.write'));

create policy csrd_dma_iros_select on csrd_dma_iros for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy csrd_dma_iros_write on csrd_dma_iros for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.disclosure.write'))
  with check (t4d.has_permission(organization_id, 'enterprise.disclosure.write'));
