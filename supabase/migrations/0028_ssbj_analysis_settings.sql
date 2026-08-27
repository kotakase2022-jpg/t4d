-- ----------------------------------------------------------------------
-- SSBJ 対応の「①マテリアリティ・分析条件の設定」
--
-- 8 ステップの入口である①は、これまで画面上で常に「完了」と表示されていた。
-- 対象年度と基準の版を機械的に表示していただけで、実際には何も決めていない。
-- だが SSBJ 対応でこの工程が担うのは、後続すべての前提になる次の 3 つの決定で、
-- 人が決めない限り先へ進めない。
--
--   ① どの基準を適用するか（一般開示基準／気候関連開示基準／実務対応基準）
--   ② どこまでを報告の範囲にするか（連結範囲・バリューチェーンの扱い）
--   ③ どのサステナビリティ課題に重要性があるか（マテリアリティ）
--
-- ③は materiality_topics に既にあるため、ここでは①②と「確定したか」を持つ。
-- 確定は人の操作でしか起きない（AI は確定しない。CLAUDE.md §0.4）。
--
-- 期間ごとに 1 行。年度が変わればまた決め直す（前年の判断は引き継げるが、
-- 引き継いだことを人が確認して初めて確定になる）。
--
-- RLS: 参照は組織メンバー、更新は enterprise.disclosure.write 保持者のみ
--      （ssbj_assessments と同じ扱い）。
-- ----------------------------------------------------------------------

create table ssbj_analysis_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  reporting_period_id uuid not null references reporting_periods (id) on delete cascade,

  -- ① 適用する基準。SSBJ は基準ごとに適用の要否が分かれる
  apply_general boolean not null default true,
  apply_climate boolean not null default true,
  apply_practical boolean not null default false,
  /** 初年度適用（経過措置を使うか）。使う場合は比較情報の免除などが効く */
  first_time_adoption boolean not null default false,

  -- ② 報告の範囲
  /** 連結範囲の考え方（財務諸表と同一か、範囲を変えるか） */
  consolidation_scope text not null default 'same_as_financial'
    check (consolidation_scope in ('same_as_financial', 'custom')),
  consolidation_note text not null default '',
  /** 報告対象に含める組織・拠点。空配列は「全社（未指定）」 */
  included_unit_ids uuid[] not null default '{}',
  /** バリューチェーンをどこまで含めるか */
  value_chain_scope text not null default 'not_decided'
    check (value_chain_scope in ('not_decided', 'upstream', 'downstream', 'both', 'none')),
  value_chain_note text not null default '',

  -- 確定（人の操作でのみ入る）
  confirmed_at timestamptz,
  confirmed_by uuid references profiles (id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references profiles (id),
  updated_by uuid references profiles (id),

  constraint ssbj_analysis_settings_period_unique unique (organization_id, reporting_period_id)
);

comment on table ssbj_analysis_settings is
  'SSBJ 対応の分析条件（適用する基準・報告範囲）。確定するまで後続の工程は前提が定まらない。';
comment on column ssbj_analysis_settings.confirmed_at is
  '確定した日時。null は未完了。AI では入らず、人の操作でのみ入る。';

create index ssbj_analysis_settings_org_period_idx
  on ssbj_analysis_settings (organization_id, reporting_period_id);

alter table ssbj_analysis_settings enable row level security;

create policy ssbj_analysis_settings_select on ssbj_analysis_settings for select to authenticated
  using (t4d.is_org_member(organization_id));

create policy ssbj_analysis_settings_write on ssbj_analysis_settings for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.disclosure.write'))
  with check (t4d.has_permission(organization_id, 'enterprise.disclosure.write'));
