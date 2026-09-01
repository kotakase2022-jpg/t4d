-- ----------------------------------------------------------------------
-- マテリアリティ評価を利用者管理（追加・編集・削除）にする
--
-- これまでマテリアリティの課題は固定の 7 件で、利用者は評価を付けることしか
-- できなかった。実際の企業のマテリアリティは自社の言葉で特定するものなので、
--   自由記述で課題を入力 → 当てはまりそうな区分の提示 → 利用者が選ぶ
-- という流れに変え、課題そのものを追加・編集・削除できるようにする。
--
-- 削除は論理削除（deleted_at）。評価の履歴は監査で問われるため、
-- 行を物理的に消さない（audit_events からも辿れるが、行自体も残す）。
--
-- 一意制約 (organization, period, topic_key) は「生きている行だけ」に変える。
-- 削除 → 同じ名前で作り直し、を塞がないため。
-- 制約の付け替えは非破壊（データは変えない）。ロールバックは
-- docs/known-limitations.md §6 のとおり打ち消し migration で行う。
-- RLS は materiality_topics の既存ポリシーがそのまま適用される（0020）。
-- ----------------------------------------------------------------------

alter table materiality_topics
  add column deleted_at timestamptz;

comment on column materiality_topics.deleted_at is
  '論理削除。課題を削除しても評価の記録は行として残す（監査で問われるため）。';

alter table materiality_topics
  drop constraint materiality_topics_unique;

-- 生きている行だけが (組織, 期間, キー) で一意。削除済みの行はキーを再利用できる
create unique index materiality_topics_unique
  on materiality_topics (organization_id, reporting_period_id, topic_key)
  where deleted_at is null;
