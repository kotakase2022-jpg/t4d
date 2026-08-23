-- 案件配下の行が名乗る「監査法人」を、親の案件の監査法人と一致させる。
--
-- 背景:
--   案件配下のテーブルは engagement_id と assurance_firm_id の両方を持つ。
--   RLS の多くは行の assurance_firm_id を見て権限を判定していたが、この列は
--   **書き込む側が自由に指定できる**うえ、親の案件と一致する保証が無かった。
--
--   そのため、案件管理権限（assurance.engagement.manage）を持つ監査法人ユーザーは
--   「他法人の案件 ID」と「自分の法人 ID」を組み合わせた engagement_members 行を
--   作れてしまい、以後 t4d.is_engagement_member() が真になって、
--   その案件の調書・レビューメモ・Data Room（クライアントの非財務データ）まで
--   到達できた。実際に PGlite 上で再現している
--   （tests/rls/tenant-isolation.test.ts「くろべのマネージャーは…自己アサインできない」）。
--
-- 対処:
--   1. engagements (id, assurance_firm_id) を一意にし、複合外部キーの参照先にする。
--   2. 案件配下の全テーブルへ複合外部キーを張り、名乗れる法人を親の法人だけに固定する。
--      これで「行の assurance_firm_id を見る」既存ポリシーが安全になる。
--   3. engagement_members の書き込みポリシーは、行の列ではなく親の案件から法人を導く。
--
-- 破壊的変更ではない（列の追加・削除をしない）。既存データが不整合なら適用時に失敗する。

alter table engagements
  add constraint engagements_id_firm_unique unique (id, assurance_firm_id);

-- 案件配下のテーブル（engagement_id と assurance_firm_id を両方持つもの）
alter table engagement_members
  add constraint engagement_members_firm_matches
  foreign key (engagement_id, assurance_firm_id)
  references engagements (id, assurance_firm_id) on delete cascade;

alter table engagement_scopes
  add constraint engagement_scopes_firm_matches
  foreign key (engagement_id, assurance_firm_id)
  references engagements (id, assurance_firm_id) on delete cascade;

alter table client_access_grants
  add constraint client_access_grants_firm_matches
  foreign key (engagement_id, assurance_firm_id)
  references engagements (id, assurance_firm_id) on delete cascade;

alter table data_room_items
  add constraint data_room_items_firm_matches
  foreign key (engagement_id, assurance_firm_id)
  references engagements (id, assurance_firm_id) on delete cascade;

alter table assurance_snapshots
  add constraint assurance_snapshots_firm_matches
  foreign key (engagement_id, assurance_firm_id)
  references engagements (id, assurance_firm_id) on delete cascade;

alter table assurance_snapshot_items
  add constraint assurance_snapshot_items_firm_matches
  foreign key (engagement_id, assurance_firm_id)
  references engagements (id, assurance_firm_id) on delete cascade;

alter table snapshot_changes
  add constraint snapshot_changes_firm_matches
  foreign key (engagement_id, assurance_firm_id)
  references engagements (id, assurance_firm_id) on delete cascade;

alter table populations
  add constraint populations_firm_matches
  foreign key (engagement_id, assurance_firm_id)
  references engagements (id, assurance_firm_id) on delete cascade;

alter table population_items
  add constraint population_items_firm_matches
  foreign key (engagement_id, assurance_firm_id)
  references engagements (id, assurance_firm_id) on delete cascade;

alter table samples
  add constraint samples_firm_matches
  foreign key (engagement_id, assurance_firm_id)
  references engagements (id, assurance_firm_id) on delete cascade;

alter table sample_items
  add constraint sample_items_firm_matches
  foreign key (engagement_id, assurance_firm_id)
  references engagements (id, assurance_firm_id) on delete cascade;

alter table assurance_procedures
  add constraint assurance_procedures_firm_matches
  foreign key (engagement_id, assurance_firm_id)
  references engagements (id, assurance_firm_id) on delete cascade;

alter table assurance_tests
  add constraint assurance_tests_firm_matches
  foreign key (engagement_id, assurance_firm_id)
  references engagements (id, assurance_firm_id) on delete cascade;

alter table assurance_test_results
  add constraint assurance_test_results_firm_matches
  foreign key (engagement_id, assurance_firm_id)
  references engagements (id, assurance_firm_id) on delete cascade;

alter table assurance_issues
  add constraint assurance_issues_firm_matches
  foreign key (engagement_id, assurance_firm_id)
  references engagements (id, assurance_firm_id) on delete cascade;

alter table review_notes
  add constraint review_notes_firm_matches
  foreign key (engagement_id, assurance_firm_id)
  references engagements (id, assurance_firm_id) on delete cascade;

alter table pbc_requests
  add constraint pbc_requests_firm_matches
  foreign key (engagement_id, assurance_firm_id)
  references engagements (id, assurance_firm_id) on delete cascade;

alter table workpaper_references
  add constraint workpaper_references_firm_matches
  foreign key (engagement_id, assurance_firm_id)
  references engagements (id, assurance_firm_id) on delete cascade;

alter table signoffs
  add constraint signoffs_firm_matches
  foreign key (engagement_id, assurance_firm_id)
  references engagements (id, assurance_firm_id) on delete cascade;

-- 案件メンバーの書き込みは、行が名乗る法人ではなく**親の案件の法人**で判定する。
-- 複合外部キーだけでも越権は塞がるが、判定の根拠を親側に置いて二重で守る。
drop policy if exists engagement_members_write on engagement_members;
create policy engagement_members_write on engagement_members for all to authenticated
  using (
    exists (
      select 1
      from engagements e
      where e.id = engagement_members.engagement_id
        and t4d.has_permission(e.assurance_firm_id, 'assurance.engagement.manage')
    )
  )
  with check (
    exists (
      select 1
      from engagements e
      where e.id = engagement_members.engagement_id
        and t4d.has_permission(e.assurance_firm_id, 'assurance.engagement.manage')
    )
  );

-- ----------------------------------------------------------------------
-- クライアントの提出物（PBC 回答）を監査法人が書き換えられないようにする
--
-- CLAUDE.md §0.3「監査法人はクライアント原本を更新しない」。
-- 従来のポリシーは「案件メンバーなら UPDATE 可」だけで列を区別しておらず、
-- 回答本文・添付・提出者まで書き換えられた。列を限定できるのは
-- 行レベルポリシーではなくトリガなので、こちらで守る。
create or replace function t4d.pbc_response_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- クライアント側（提出者の組織）は自分の提出物を編集できる
  if t4d.is_org_member(old.client_organization_id) then
    return new;
  end if;

  -- ここから先は監査法人側の更新。受領判定に必要な列以外は変えさせない。
  if new.body is distinct from old.body
     or new.file_version_ids is distinct from old.file_version_ids
     or new.submitted_by is distinct from old.submitted_by
     or new.submitted_at is distinct from old.submitted_at
     or new.request_id is distinct from old.request_id
     or new.engagement_id is distinct from old.engagement_id
     or new.client_organization_id is distinct from old.client_organization_id then
    raise exception '監査法人はクライアントの提出内容を変更できません（受領判定のみ可）';
  end if;

  -- 受領判定は権限を持つロールだけ
  if (new.decision is distinct from old.decision
      or new.reject_reason is distinct from old.reject_reason)
     and not t4d.has_permission(
       (select e.assurance_firm_id from engagements e where e.id = old.engagement_id),
       'assurance.pbc.manage'
     ) then
    raise exception '受領判定には assurance.pbc.manage 権限が必要です';
  end if;

  return new;
end;
$$;

drop trigger if exists pbc_response_guard on pbc_request_responses;
create trigger pbc_response_guard
  before update on pbc_request_responses
  for each row execute function t4d.pbc_response_guard();
