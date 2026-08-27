-- ----------------------------------------------------------------------
-- 指標マスターに「どの開示基準が要求している指標か」を持たせる
--
-- これまで指標マスターは自社の都合で作った一覧でしかなく、SSBJ・CDP・CSRD
-- のどれがその指標を求めているのかが、どこにも記録されていなかった。
-- そのため「基準が求めているのに社内に指標が無い」ことを機械的に検知できず、
-- ギャップ分析が要求事項の文章の突き合わせだけに頼っていた。
--
-- 出所を指標そのものへ持たせることで、
--   - 基準ごとの指標の充足状況を数えられる
--   - 取込時に「この列はどの基準の指標か」を根拠付きで示せる
--   - 基準改正で要求が増えたときに、追加すべき指標を差分として出せる
-- ようになる。
--
-- あわせて category に 'climate_transition' を追加する。SSBJ 気候関連開示基準
-- 第79項〜第84項が求める移行リスク・物理的リスクに脆弱な資産の金額や割合、
-- 気候関連への資本投下額、内部炭素価格、役員報酬への組込割合は、
-- 排出量でもエネルギーでもない財務寄りの指標で、既存の 6 分類に居場所が無い。
--
-- 既存行は frameworks = '{}'（どの基準にも紐づかない自社独自指標）を既定とする
-- 非破壊の列追加。ロールバックは列を無視するだけでよい（docs/known-limitations.md）。
-- RLS は metric_definitions の既存ポリシーがそのまま適用される（0012_rls_core.sql）。
-- ----------------------------------------------------------------------

alter table metric_definitions
  add column frameworks text[] not null default '{}';

comment on column metric_definitions.frameworks is
  'この指標を要求している開示基準のキー（ssbj / cdp / csrd）。空配列は自社独自の指標。';

-- 値の揺れを防ぐ。フレームワークを増やすときはこの制約も一緒に更新する。
alter table metric_definitions
  add constraint metric_definitions_frameworks_known
  check (frameworks <@ array['ssbj', 'cdp', 'csrd']::text[]);

-- 基準別の充足状況を数えるクエリが毎回全走査しないようにする
create index metric_definitions_frameworks_idx
  on metric_definitions using gin (frameworks);

-- 気候関連の財務影響指標（SSBJ 第2号 第79項〜第84項）の置き場所を作る
alter table metric_definitions
  drop constraint metric_definitions_category_check;

alter table metric_definitions
  add constraint metric_definitions_category_check
  check (
    category in (
      'ghg',
      'energy',
      'water',
      'waste',
      'human_capital',
      'governance',
      'climate_transition'
    )
  );
