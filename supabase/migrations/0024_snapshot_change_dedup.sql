-- Snapshot 後の変更検知が、同じ項目について何行も積み上がる問題を直す。
--
-- data_point_versions への INSERT ごとに無条件で 1 行足していたため、
-- 企業側が同じ値を 3 回直すと同じ Snapshot 項目に 3 行できる。
-- 監査人が「影響なし」と評価しても、次の版で新しい行が増えて評価が埋もれ、
-- 変更の件数も実態より多く見える。
--
-- 対処: (snapshot_item_id, change_kind) を一意にし、
-- 同じ項目の同種の変更は**最新の状態で上書き**する。
-- 評価済み（assessed_at がある）の行は、内容が変わったので評価を解除して
-- 監査人へ再確認を促す。

-- 重複を先に畳む（最新の 1 行を残す）
delete from snapshot_changes a
using snapshot_changes b
where a.snapshot_item_id = b.snapshot_item_id
  and a.change_kind = b.change_kind
  and (a.detected_at, a.id) < (b.detected_at, b.id);

create unique index snapshot_changes_item_kind_unique
  on snapshot_changes (snapshot_item_id, change_kind);

create or replace function t4d.detect_snapshot_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  item record;
begin
  for item in
    select si.id, si.snapshot_id, si.engagement_id, si.assurance_firm_id, si.value_snapshot
    from assurance_snapshot_items si
    where si.source_type = 'data_point'
      and si.source_id = new.data_point_id
  loop
    insert into snapshot_changes (
      snapshot_id, engagement_id, assurance_firm_id, snapshot_item_id,
      change_kind, before_summary, after_summary
    ) values (
      item.snapshot_id, item.engagement_id, item.assurance_firm_id, item.id,
      'version_added',
      format('固定時点: %s %s (v%s)',
        item.value_snapshot ->> 'value',
        item.value_snapshot ->> 'unitOfMeasure',
        item.value_snapshot ->> 'versionNo'),
      format('現在: %s %s (v%s)', new.value, new.unit_of_measure, new.version_no)
    )
    on conflict (snapshot_item_id, change_kind) do update
      set after_summary = excluded.after_summary,
          detected_at = now(),
          -- 内容が変わったので、前の評価は無効にして再確認させる
          assessed_by = null,
          assessed_at = null,
          assessment = null;
  end loop;
  return new;
end;
$$;
