-- ----------------------------------------------------------------------
-- レポートの固定・出力記録・KPI 目標（docs/disclosure-first.md §3 0038）
--
-- これまでの出力（DOCX / XLSX / CSV）は毎回ライブデータから組み立てていたため、
--   - 同じ「承認済みレポート」を 2 回出力すると中身が変わりうる
--   - 何を出力したか（どの版・どの数値）を後から示せない
-- という問題があった。出力は必ずスナップショット（追記専用）から作り、
-- 生成したファイルのハッシュと、スナップショットの正規化内容のハッシュを記録する。
--
-- KPI 目標も追記専用の版として持つ。目標値を上書きすると、
-- 過去の開示で示した目標と現在の目標の違いを説明できなくなるため。
--
-- テナント整合: 子の organization_id は親と一致させる（0035 と同じ複合外部キー方式）。
-- ----------------------------------------------------------------------

-- 複合外部キーの参照先（既存表への一意制約の追加のみ）
alter table metric_definitions
  add constraint metric_definitions_id_org_unique unique (id, organization_id);

create table report_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  project_id uuid not null,
  /**
   * review_draft … レビュー用の草稿（阻害条件があっても作れる）
   * approved     … 全必須節が承認済みで阻害条件が無いときだけ作る確定版
   */
  snapshot_kind text not null check (snapshot_kind in ('review_draft', 'approved')),
  snapshot_no integer not null check (snapshot_no > 0),
  label text not null default '',
  /** 固定時点の基準の版（版コード・法的位置付け・適用区分の写し） */
  framework_versions jsonb not null default '[]'::jsonb,
  decision_ids uuid[] not null default '{}',
  /** 節ごとの blockId・versionId・本文 AST・状態 */
  blocks jsonb not null default '[]'::jsonb,
  /** 引用した data_point_version の値・単位・期間・境界・承認状態 */
  metric_values jsonb not null default '[]'::jsonb,
  narrative_version_ids uuid[] not null default '{}',
  anchors jsonb not null default '[]'::jsonb,
  policy_version text,
  /** 正規化した内容のハッシュ。再出力で同じ値になることを検証に使う */
  content_hash text not null,
  created_at timestamptz not null default now(),
  created_by uuid not null references profiles (id),

  constraint report_snapshots_project_matches
    foreign key (project_id, organization_id)
    references disclosure_projects (id, organization_id) on delete cascade,
  constraint report_snapshots_unique unique (project_id, snapshot_kind, snapshot_no),
  constraint report_snapshots_id_org_unique unique (id, organization_id)
);

create index report_snapshots_project_idx on report_snapshots (project_id, created_at desc);

comment on table report_snapshots is
  'レポートのスナップショット（追記専用）。出力は必ずここから作り、ライブデータを直接出力しない。';

create table export_artifacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  snapshot_id uuid not null,
  format text not null check (format in ('docx', 'xlsx', 'csv')),
  /** internal … 社内確認用（コメント等を含みうる）／ external … 社外提出用 */
  audience text not null default 'internal' check (audience in ('internal', 'external')),
  template_version text not null,
  file_name text not null,
  byte_size integer not null check (byte_size >= 0),
  file_sha256 text not null,
  /** スナップショットの正規化内容のハッシュ。同じスナップショットから再出力すれば一致する */
  content_hash text not null,
  generated_at timestamptz not null default now(),
  generated_by uuid not null references profiles (id),

  constraint export_artifacts_snapshot_matches
    foreign key (snapshot_id, organization_id)
    references report_snapshots (id, organization_id) on delete cascade
);

create index export_artifacts_snapshot_idx on export_artifacts (snapshot_id, generated_at desc);

comment on table export_artifacts is
  '出力ファイルの記録（追記専用）。どのスナップショットから・どのテンプレートで・誰が出力したかを残す。';

create table kpi_targets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  /** 目標の識別子。版が変わっても同じ値を使う */
  target_key text not null check (btrim(target_key) <> ''),
  version_no integer not null check (version_no > 0),
  metric_id uuid not null,
  boundary text not null default '連結',
  scope_note text not null default '',
  base_year integer,
  base_value numeric,
  target_year integer not null,
  target_value numeric not null,
  target_type text not null check (target_type in ('absolute', 'intensity')),
  direction text not null check (direction in ('reduce', 'increase')),
  methodology_note text not null default '',
  owner_user_id uuid references profiles (id),
  /** 2 版目以降は改訂理由が必須（なぜ目標を変えたかを説明できるように） */
  revision_reason text,
  created_at timestamptz not null default now(),
  created_by uuid references profiles (id),

  constraint kpi_targets_year_order check (base_year is null or target_year > base_year),
  constraint kpi_targets_revision_reason
    check (version_no = 1 or coalesce(btrim(revision_reason), '') <> ''),
  constraint kpi_targets_metric_matches
    foreign key (metric_id, organization_id)
    references metric_definitions (id, organization_id) on delete cascade,
  constraint kpi_targets_unique unique (organization_id, target_key, version_no)
);

create index kpi_targets_metric_idx on kpi_targets (organization_id, metric_id);

comment on table kpi_targets is
  'ESG 経営の KPI 目標（追記専用の版）。目標を変えるときは新しい版を改訂理由付きで追記する。';

create trigger report_snapshots_immutable
  before update or delete on report_snapshots
  for each row execute function t4d.forbid_mutation();

create trigger export_artifacts_immutable
  before update or delete on export_artifacts
  for each row execute function t4d.forbid_mutation();

create trigger kpi_targets_immutable
  before update or delete on kpi_targets
  for each row execute function t4d.forbid_mutation();

-- ----------------------------------------------------------------------
-- RLS（3 表とも追記専用: UPDATE / DELETE ポリシーは作らない）
-- ----------------------------------------------------------------------

alter table report_snapshots enable row level security;
alter table export_artifacts enable row level security;
alter table kpi_targets enable row level security;

create policy report_snapshots_select on report_snapshots for select to authenticated
  using (t4d.is_org_member(organization_id));
-- 草稿は下書き編集者か出力担当が作れる。確定版は承認権限を持つ人だけが作る
create policy report_snapshots_insert on report_snapshots for insert to authenticated
  with check (
    created_by = auth.uid()
    and (
      (snapshot_kind = 'review_draft'
        and (t4d.has_permission(organization_id, 'enterprise.disclosure.write')
             or t4d.has_permission(organization_id, 'enterprise.export.run')))
      or (snapshot_kind = 'approved'
        and t4d.has_permission(organization_id, 'enterprise.disclosure.approve'))
    )
  );

create policy export_artifacts_select on export_artifacts for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy export_artifacts_insert on export_artifacts for insert to authenticated
  with check (
    generated_by = auth.uid()
    and t4d.has_permission(organization_id, 'enterprise.export.run')
  );

create policy kpi_targets_select on kpi_targets for select to authenticated
  using (t4d.is_org_member(organization_id));
-- 目標は指標マスターと同じく管理側の設定として扱う
create policy kpi_targets_insert on kpi_targets for insert to authenticated
  with check (
    created_by = auth.uid()
    and t4d.has_permission(organization_id, 'enterprise.metric.manage')
  );
