-- ----------------------------------------------------------------------
-- 出力の自動突合と外部編集ファイルの突合・XBRL の出力記録（トライアル対応 2026-10: NF-15・NF-42）
--
-- 1. export_artifacts の format に xbrl_json・ixbrl_html を足す（CHECK の付け替え。0040 と同じ方式）。
-- 2. export_artifacts に突合の結果の列と XBRL の列を足す。挿入時に入れ、以後は変えない（追記専用のまま）。
--    過去の出力は null（＝未突合）のまま。
-- 3. export_reconciliations（追記専用）: 不一致で生成を止めた記録と、外部で編集したファイルを照合した記録。
--    外部のファイルそのものは保存せず、sha256 と結果（不一致の明細は先頭 50 件）だけを持つ。
--
-- taxonomy_package_id の外部キーは、参照先の表を作る 0053 で足す。
-- ロールバック方針は docs/known-limitations.md §6。
-- ----------------------------------------------------------------------

alter table export_artifacts
  drop constraint export_artifacts_format_check;
alter table export_artifacts
  add constraint export_artifacts_format_check
    check (format in ('docx', 'xlsx', 'csv', 'xbrl_json', 'ixbrl_html'));

alter table export_artifacts
  add column reconciled_paragraphs integer check (reconciled_paragraphs is null or reconciled_paragraphs >= 0),
  add column reconciled_numbers integer check (reconciled_numbers is null or reconciled_numbers >= 0),
  add column reconciled_rows integer check (reconciled_rows is null or reconciled_rows >= 0),
  add column mismatch_count integer check (mismatch_count is null or mismatch_count >= 0),
  add column checker_version text,
  add column taxonomy_package_id uuid,
  add column mapping_set_hash text,
  add column validation_summary jsonb
    check (validation_summary is null or jsonb_typeof(validation_summary) = 'object');

comment on column export_artifacts.mismatch_count is
  '生成物を読み戻して承認版と照合した不一致の件数。null は未突合（この列を足す前の出力）。';

create table export_reconciliations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  snapshot_id uuid not null,
  source text not null check (source in ('generated_blocked', 'uploaded')),
  format text not null check (format in ('docx', 'xlsx', 'csv')),
  audience text not null default 'internal' check (audience in ('internal', 'external')),
  framework_version_id uuid references disclosure_framework_versions (id) on delete restrict,
  file_sha256 text not null,
  checker_version text not null,
  paragraphs_checked integer not null default 0 check (paragraphs_checked >= 0),
  numbers_checked integer not null default 0 check (numbers_checked >= 0),
  rows_checked integer not null default 0 check (rows_checked >= 0),
  mismatch_count integer not null default 0 check (mismatch_count >= 0),
  /** 不一致の明細（位置・期待値・実際の値）。先頭 50 件まで */
  mismatches jsonb not null default '[]'::jsonb
    check (jsonb_typeof(mismatches) = 'array' and jsonb_array_length(mismatches) <= 50),
  created_by uuid not null references profiles (id),
  created_at timestamptz not null default now(),

  constraint export_reconciliations_snapshot_matches
    foreign key (snapshot_id, organization_id)
    references report_snapshots (id, organization_id) on delete cascade
);

create index export_reconciliations_snapshot_idx
  on export_reconciliations (snapshot_id, created_at desc);

comment on table export_reconciliations is
  '出力の突合の記録（追記専用）。不一致で生成を止めた記録と、外部で編集したファイルの照合。ファイルは保存しない。';

create trigger export_reconciliations_immutable
  before update or delete on export_reconciliations
  for each row execute function t4d.forbid_mutation();

alter table export_reconciliations enable row level security;

create policy export_reconciliations_select on export_reconciliations for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy export_reconciliations_insert on export_reconciliations for insert to authenticated
  with check (
    created_by = auth.uid()
    and t4d.has_permission(organization_id, 'enterprise.export.run')
  );
