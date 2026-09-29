-- ----------------------------------------------------------------------
-- 開示基準の版メタデータ・根拠資料の利用目的（docs/disclosure-first.md §3 0034）
--
-- 1. ESRS-40a（EU 域外企業向け）を CSRD とは別フレームワークとして登録できるようにする。
--    CSRD（EU 法人向け ESRS）とは重要性の考え方（40a はインパクト重要性）も
--    適用条件も異なり、同じ key に混ぜると適用判断の根拠が崩れるため。
--    0018 と同じく CHECK 制約の付け替えのみ（既存ファイルは書き換えない）。
--
-- 2. 基準の版に「法的な位置付け（草案／採択／公布／発効…）」「収録範囲」「確認日」を持たせる。
--    これまでは label の文字列と is_fixture しか無く、草案段階の基準を正式な基準と
--    同じ見た目で扱ってしまう（例: ESRS-40a は 2026-07 時点で公開草案）。
--    すべて NULL 可。未確認のものを推測で埋めない。
--
-- 3. 根拠資料（files）に利用目的を持たせる。当年度の事実の根拠・前年度の記載・文体の参考を
--    区別しないと、前年の文章が当年の根拠として引用されてしまう。
--    版の区別（edition_label / issued_on）も同じ理由で持つ。
-- ----------------------------------------------------------------------

alter table disclosure_frameworks
  drop constraint disclosure_frameworks_key_check;

alter table disclosure_frameworks
  add constraint disclosure_frameworks_key_check
    check (key in ('cdp', 'ssbj', 'csrd', 'esrs_40a', 'msci', 'ftse'));

alter table disclosure_framework_versions
  add column version_code text,
  add column legal_status text
    check (legal_status in ('draft', 'adopted', 'promulgated', 'effective', 'superseded', 'sample')),
  add column issued_at date,
  add column effective_at date,
  add column jurisdiction text,
  add column materiality_basis text
    check (materiality_basis in ('financial', 'impact', 'double', 'not_specified')),
  add column source_url text,
  add column verified_at date,
  add column verified_by text,
  add column coverage_status text
    check (coverage_status in ('full_for_scope', 'partial', 'not_loaded', 'sample')),
  add column coverage_note text;

comment on column disclosure_framework_versions.legal_status is
  '法的な位置付け。NULL は未確認（推測で埋めない）。sample は架空の縮小マスター。';
comment on column disclosure_framework_versions.coverage_status is
  '要求事項の収録範囲。not_loaded は版だけ登録して要求事項を収録していない状態。';

alter table files
  add column usage_purpose text
    check (usage_purpose in ('current_fact', 'prior_year_text', 'style_reference')),
  add column edition_label text,
  add column issued_on date;

comment on column files.usage_purpose is
  '根拠資料の利用目的。current_fact（当年度の事実の根拠）以外は当年度の根拠として引用しない。NULL は未設定。';
