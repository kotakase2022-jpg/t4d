-- ----------------------------------------------------------------------
-- 値の有無の理由・値の区分・標準 CSV の取込バッチ（docs/disclosure-first.md §3 0039）
--
-- これまで data_points.value が NULL の行は、
--   まだ入力していない／取得できなかった／対象外／算定していない
-- のどれなのかを区別できず、集計では 0 として扱われていた（W0 棚卸し O4）。
-- 「0 と未入力を混同しない」ため、値の有無の状態と理由を別列で持つ。
--
-- value_kind は現在値の区分（実績／推計／目標）。業務キー
-- （組織＋指標＋拠点＋期間＋境界）は変えない（同じ枠に実績と推計が並ばないように）。
--
-- 既存行の backfill: value と text_value がともに NULL の行は not_entered にする。
-- **not_applicable にはしない。** 対象外かどうかは人が理由を添えて判断するもので、
-- 値が無いことから推測してはならない。
-- ----------------------------------------------------------------------

alter table data_points
  add column value_kind text not null default 'actual'
    check (value_kind in ('actual', 'estimate', 'target')),
  add column availability_status text not null default 'value_present'
    check (availability_status in
      ('value_present', 'not_entered', 'not_obtained', 'not_applicable', 'not_calculated')),
  add column absence_reason text;

alter table data_point_versions
  add column value_kind text not null default 'actual'
    check (value_kind in ('actual', 'estimate', 'target')),
  add column availability_status text not null default 'value_present'
    check (availability_status in
      ('value_present', 'not_entered', 'not_obtained', 'not_applicable', 'not_calculated')),
  add column absence_reason text;

comment on column data_points.availability_status is
  '値の有無の状態。value_present 以外は value を集計に含めない。not_applicable は人が理由を添えて判断する。';
comment on column data_points.value_kind is
  '現在値の区分（実績／推計／目標）。業務キーには含めない。';

-- backfill
-- UPDATE 文では行わない。
--   - data_point_versions は追記専用で、UPDATE は t4d.forbid_mutation() が拒否する
--     （拒否されるのが正しく、トリガを外して書き換える経路は作らない）。
--   - data_points は UPDATE すると updated_at の自動更新トリガが動き、
--     列を足しただけで全件が「最近変更されたデータ」に並んでしまう。
-- そこで ALTER COLUMN ... TYPE ... USING で**今回追加した列だけ**を計算し直す。
-- これは表の書き直しで、行トリガは発火しない。既存の値・単位・状態・ハッシュには触れない。
alter table data_points
  alter column availability_status type text
  using (case when value is null and text_value is null then 'not_entered' else 'value_present' end);

alter table data_point_versions
  alter column availability_status type text
  using (case when value is null and text_value is null then 'not_entered' else 'value_present' end);

-- ----------------------------------------------------------------------
-- 標準 CSV（数値を登録）の取込バッチ
--
-- 既存の取込（ingestion_jobs）は行ごとに逐次書き込むため、途中で失敗すると一部だけ
-- 反映される。標準 CSV は「検証 → 差分確認 → 確定」を 1 バッチとし、
-- 確定は commit_idempotency_key で 1 回に限る（再送しても二重に版を作らない）。
-- ----------------------------------------------------------------------

-- 複合外部キーの参照先 reporting_periods (id, organization_id) は 0035 で作成済み

create table quantitative_import_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  reporting_period_id uuid not null,
  project_id uuid,
  file_name text not null,
  file_sha256 text not null,
  status text not null default 'validated'
    check (status in ('validated', 'committed', 'rejected')),
  /** 行ごとの解析結果と差分区分 */
  rows jsonb not null default '[]'::jsonb check (jsonb_typeof(rows) = 'array'),
  /** 検証結果のハッシュ。確定時に再計算して一致しなければ（プレビュー後に変わっていれば）拒否する */
  preview_hash text not null,
  commit_idempotency_key text unique,
  committed_at timestamptz,
  committed_by uuid references profiles (id),
  /** 確定時に除外した行数（「有効な行だけ確定」を選んだ場合の記録） */
  excluded_count integer not null default 0 check (excluded_count >= 0),
  created_at timestamptz not null default now(),
  created_by uuid references profiles (id),

  constraint quantitative_import_batches_committed_requires_actor
    check (
      status <> 'committed'
      or (committed_at is not null and committed_by is not null and commit_idempotency_key is not null)
    ),
  constraint quantitative_import_batches_period_matches
    foreign key (reporting_period_id, organization_id)
    references reporting_periods (id, organization_id) on delete cascade,
  constraint quantitative_import_batches_project_matches
    foreign key (project_id, organization_id)
    references disclosure_projects (id, organization_id) on delete cascade
);

create index quantitative_import_batches_org_idx
  on quantitative_import_batches (organization_id, reporting_period_id, created_at desc);

comment on table quantitative_import_batches is
  '標準 CSV の取込バッチ。検証済み → 確定／却下。確定・却下したバッチは変更しない。';

-- 確定・却下したバッチを書き換えると、どの内容を確定したのかが追えなくなる
create or replace function t4d.quantitative_import_batch_guard()
returns trigger
language plpgsql
as $$
begin
  if old.status in ('committed', 'rejected') then
    raise exception 'T4D_IMMUTABLE: 確定・却下した取込バッチは変更できません'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger quantitative_import_batches_guard
  before update on quantitative_import_batches
  for each row execute function t4d.quantitative_import_batch_guard();

alter table quantitative_import_batches enable row level security;

create policy quantitative_import_batches_select on quantitative_import_batches
  for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy quantitative_import_batches_write on quantitative_import_batches
  for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.import.run'))
  with check (t4d.has_permission(organization_id, 'enterprise.import.run'));
