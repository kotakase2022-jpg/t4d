-- ----------------------------------------------------------------------
-- XBRL のタクソノミ・概念・要求事項との対応（テナント横断のマスター。トライアル対応 2026-10: NF-42 Stage 1）
--
-- Stage 1 は SAMPLE（架空）の概念リストだけを持つ（名前空間 urn:t4d:sample-taxonomy:2026・接頭辞 t4ds・
-- ラベル「（サンプル）…」）。公式タクソノミ（EDINET の jpsrd・ISSB の ifrs-sds）は同梱しない
-- （確定版の公表とライセンスの確認が先。公式らしい名前を作らない）。
-- 公式タクソノミも同じ形で持てるよう、版・法的位置付け・ライセンスの状態を列に持たせ、
-- サンプル・ライセンス未取得のパッケージは提出用（filing_ready）にできないことを CHECK で固定する。
--
-- 3 表とも参照は認証済みの全員（マスター）。書込ポリシーは作らない（seed・登録スクリプトで投入する）。
-- xbrl_concept_requirements は概念と要求事項の対応の「候補」（AI ではなく、マスターの参考）で、
-- 組織の対応付け（0054 の xbrl_tag_mappings）の確定とは別。
-- ロールバック方針は docs/known-limitations.md §6。
-- ----------------------------------------------------------------------

create table xbrl_taxonomy_packages (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (btrim(key) <> ''),
  framework_key text not null
    check (framework_key in ('cdp', 'ssbj', 'csrd', 'esrs_40a', 'msci', 'ftse')),
  profile text not null
    check (profile in ('sample', 'edinet_ssbj', 'edinet_non_ssbj', 'esrs', 'esrs_40a')),
  name text not null,
  version_label text not null,
  publisher text not null default '',
  legal_status text not null check (legal_status in ('sample', 'draft', 'final', 'superseded')),
  namespace_uri text not null,
  prefix text not null check (prefix ~ '^[a-z][a-z0-9-]*$'),
  entry_point text not null default '',
  source_url text,
  published_on date,
  verified_at date,
  license_status text not null default 'not_required'
    check (license_status in ('not_required', 'required_pending', 'granted')),
  license_note text not null default '',
  /** 提出用のファイルを作れる版か。サンプル・ライセンス未取得・草案は作れない */
  filing_ready boolean not null default false,
  is_fixture boolean not null default false,
  created_at timestamptz not null default now(),

  constraint xbrl_taxonomy_packages_filing_ready
    check (
      not filing_ready
      or (profile <> 'sample'
          and legal_status = 'final'
          and license_status <> 'required_pending'
          and not is_fixture)
    )
);

comment on table xbrl_taxonomy_packages is
  'XBRL タクソノミのパッケージ（テナント横断のマスター）。Stage 1 は SAMPLE（架空）だけで、提出用にはできない。';

create table xbrl_concepts (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references xbrl_taxonomy_packages (id) on delete cascade,
  prefix text not null,
  local_name text not null check (local_name ~ '^[A-Za-z_][A-Za-z0-9_.-]*$'),
  namespace_uri text not null,
  /** item＝数値・文字の事実、text_block＝テキストブロック、abstract＝見出し、axis・member＝次元 */
  kind text not null check (kind in ('item', 'text_block', 'abstract', 'axis', 'member')),
  data_type text not null default '',
  period_type text check (period_type in ('duration', 'instant')),
  balance text check (balance in ('debit', 'credit')),
  label_ja text not null,
  label_en text not null default '',
  /** 参照（基準の項番など）。SAMPLE では架空の参照だけ */
  concept_references jsonb not null default '[]'::jsonb
    check (jsonb_typeof(concept_references) = 'array'),
  parent_id uuid references xbrl_concepts (id) on delete set null,
  role_code text not null default '',
  sort_order integer not null default 0,
  supersedes_concept_id uuid references xbrl_concepts (id) on delete set null,
  deprecated boolean not null default false,
  created_at timestamptz not null default now(),

  constraint xbrl_concepts_unique unique (package_id, prefix, local_name),
  -- 値を持つ概念だけが期間型を持つ（抽象・軸・メンバーに値は付かない）
  constraint xbrl_concepts_period_shape
    check ((kind in ('item', 'text_block')) = (period_type is not null))
);

create index xbrl_concepts_package_idx on xbrl_concepts (package_id, sort_order);

comment on table xbrl_concepts is
  'XBRL の概念（テナント横断のマスター）。SAMPLE の概念は架空で、公式の要素名ではない。';

create table xbrl_concept_requirements (
  id uuid primary key default gen_random_uuid(),
  concept_id uuid not null references xbrl_concepts (id) on delete cascade,
  disclosure_item_id uuid not null references disclosure_items (id) on delete cascade,
  basis text not null check (basis in ('sample_fixture', 'reference_link', 'manual')),
  note text not null default '',
  created_at timestamptz not null default now(),
  constraint xbrl_concept_requirements_unique unique (concept_id, disclosure_item_id)
);

comment on table xbrl_concept_requirements is
  '概念と要求事項の対応の候補（マスターの参考）。組織の対応付けの確定は xbrl_tag_mappings で人が行う。';

-- 0051 で足した出力記録の列の参照先
alter table export_artifacts
  add constraint export_artifacts_taxonomy_package_fk
    foreign key (taxonomy_package_id) references xbrl_taxonomy_packages (id) on delete restrict;

alter table xbrl_taxonomy_packages enable row level security;
alter table xbrl_concepts enable row level security;
alter table xbrl_concept_requirements enable row level security;

create policy xbrl_taxonomy_packages_select on xbrl_taxonomy_packages
  for select to authenticated using (true);
create policy xbrl_concepts_select on xbrl_concepts
  for select to authenticated using (true);
create policy xbrl_concept_requirements_select on xbrl_concept_requirements
  for select to authenticated using (true);
