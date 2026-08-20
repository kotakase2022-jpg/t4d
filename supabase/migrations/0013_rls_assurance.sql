-- ======================================================================
-- 0013 RLS（監査法人 / 契約 / 許諾 / Snapshot / 調書）
-- ----------------------------------------------------------------------
-- 指示書 11 章の必須ポリシー 6〜12 に対応する。
--
--  6. Assurance User は所属法人の Engagement Member である案件だけ閲覧可能
--  7. Engagement Member であっても Client Access Grant 外は閲覧不可
--  8. Assurance User は Client Source Data を更新不可
--     → data_points / evidence_links に監査法人向け UPDATE ポリシーを作らないことで担保
--  9. Assurance User は自法人の案件データだけ更新可能
-- 10. Client User は共有対象でない内部 Review Note を閲覧不可
-- 11. Snapshot Item は通常ユーザーが UPDATE / DELETE 不可
-- 12. Audit Event は通常ユーザーが UPDATE / DELETE 不可
-- ======================================================================

-- ----------------------------------------------------------------------
-- 契約・メンバー・許諾
-- ----------------------------------------------------------------------

alter table engagements enable row level security;

-- 監査法人側: メンバーである案件のみ。assurance_admin でも未アサインは不可視。
create policy engagements_select_firm on engagements for select to authenticated
  using (t4d.is_engagement_member(id));
-- 企業側: 自社がクライアントの案件は見える（監査の存在は企業も知っている）
create policy engagements_select_client on engagements for select to authenticated
  using (t4d.is_org_member(client_organization_id));

create policy engagements_insert on engagements for insert to authenticated
  with check (t4d.has_permission(assurance_firm_id, 'assurance.engagement.manage'));
create policy engagements_update on engagements for update to authenticated
  using (t4d.is_engagement_member(id)
     and t4d.has_permission(assurance_firm_id, 'assurance.engagement.manage'))
  with check (t4d.has_permission(assurance_firm_id, 'assurance.engagement.manage'));

alter table engagement_members enable row level security;
create policy engagement_members_select on engagement_members for select to authenticated
  using (user_id = auth.uid() or t4d.is_engagement_member(engagement_id));
create policy engagement_members_write on engagement_members for all to authenticated
  using (t4d.has_permission(assurance_firm_id, 'assurance.engagement.manage'))
  with check (t4d.has_permission(assurance_firm_id, 'assurance.engagement.manage'));

alter table client_access_grants enable row level security;
-- 企業側（許諾を出す側）と、当該案件のメンバーだけが参照できる
create policy client_access_grants_select on client_access_grants for select to authenticated
  using (
    t4d.is_org_member(client_organization_id)
    or t4d.is_engagement_member(engagement_id)
  );
-- 許諾の付与・取消は「企業側の権限」でのみ可能。監査法人は自分に権限を与えられない。
create policy client_access_grants_insert on client_access_grants for insert to authenticated
  with check (
    t4d.has_permission(client_organization_id, 'enterprise.grant.manage')
    and granted_by = auth.uid()
  );
create policy client_access_grants_update on client_access_grants for update to authenticated
  using (t4d.has_permission(client_organization_id, 'enterprise.grant.manage'))
  with check (t4d.has_permission(client_organization_id, 'enterprise.grant.manage'));

alter table engagement_scopes enable row level security;
create policy engagement_scopes_select on engagement_scopes for select to authenticated
  using (t4d.is_engagement_member(engagement_id) or t4d.is_engagement_client(engagement_id));
create policy engagement_scopes_write on engagement_scopes for all to authenticated
  using (t4d.can_write_engagement_workpaper(engagement_id, assurance_firm_id, 'assurance.scope.manage'))
  with check (t4d.can_write_engagement_workpaper(engagement_id, assurance_firm_id, 'assurance.scope.manage'));

alter table data_room_items enable row level security;
create policy data_room_items_select on data_room_items for select to authenticated
  using (t4d.is_engagement_member(engagement_id) or t4d.is_org_member(client_organization_id));
-- 共有するのは企業側の行為
create policy data_room_items_insert on data_room_items for insert to authenticated
  with check (t4d.has_permission(client_organization_id, 'enterprise.grant.manage')
              and shared_by = auth.uid());
create policy data_room_items_update on data_room_items for update to authenticated
  using (t4d.has_permission(client_organization_id, 'enterprise.grant.manage'))
  with check (t4d.has_permission(client_organization_id, 'enterprise.grant.manage'));

-- ----------------------------------------------------------------------
-- 7. Grant 外は閲覧不可 — 企業データへの監査法人 SELECT ポリシー
--    （UPDATE ポリシーは意図的に作らない = 8. Read-only by Default）
-- ----------------------------------------------------------------------

create policy data_points_select_assurance on data_points for select to authenticated
  using (t4d.assurance_can_read_data_point(id));

create policy data_point_versions_select_assurance on data_point_versions
  for select to authenticated
  using (t4d.assurance_can_read_data_point(data_point_id));

create policy data_point_calculations_select_assurance on data_point_calculations
  for select to authenticated
  using (t4d.assurance_can_read_data_point(data_point_id));

create policy evidence_links_select_assurance on evidence_links for select to authenticated
  using (
    target_type = 'data_point'
    and t4d.assurance_can_read_data_point(target_id)
    and t4d.assurance_can_read_file_version(file_version_id)
  );

create policy file_versions_select_assurance on file_versions for select to authenticated
  using (t4d.assurance_can_read_file_version(id));

create policy files_select_assurance on files for select to authenticated
  using (exists (
    select 1 from file_versions fv
    where fv.file_id = files.id and t4d.assurance_can_read_file_version(fv.id)
  ));

create policy extracted_fragments_select_assurance on extracted_fragments
  for select to authenticated
  using (t4d.assurance_can_read_file_version(file_version_id));

-- 組織階層・指標定義・報告期間は、許諾された案件の範囲で監査法人も参照できる
create policy organization_units_select_assurance on organization_units
  for select to authenticated
  using (exists (
    select 1 from engagement_members em
    join engagements e on e.id = em.engagement_id
    where em.user_id = auth.uid()
      and em.removed_at is null
      and e.client_organization_id = organization_units.organization_id
      and t4d.grant_exists(e.id, 'organization_unit', organization_units.id)
  ));

create policy metric_definitions_select_assurance on metric_definitions
  for select to authenticated
  using (exists (
    select 1 from engagement_members em
    join engagements e on e.id = em.engagement_id
    where em.user_id = auth.uid()
      and em.removed_at is null
      and e.client_organization_id = metric_definitions.organization_id
      and t4d.grant_exists(e.id, 'metric', metric_definitions.id)
  ));

create policy reporting_periods_select_assurance on reporting_periods
  for select to authenticated
  using (exists (
    select 1 from engagement_members em
    join engagements e on e.id = em.engagement_id
    where em.user_id = auth.uid()
      and em.removed_at is null
      and e.client_organization_id = reporting_periods.organization_id
      and t4d.grant_exists(e.id, 'reporting_period', reporting_periods.id)
  ));

-- ----------------------------------------------------------------------
-- Snapshot（11. Immutable）
-- ----------------------------------------------------------------------

alter table assurance_snapshots enable row level security;
create policy assurance_snapshots_select on assurance_snapshots for select to authenticated
  using (t4d.is_engagement_member(engagement_id));
create policy assurance_snapshots_insert on assurance_snapshots for insert to authenticated
  with check (
    t4d.can_write_engagement_workpaper(engagement_id, assurance_firm_id, 'assurance.snapshot.create')
    and frozen_by = auth.uid()
  );
-- UPDATE / DELETE ポリシーは作らない（追記専用）

alter table assurance_snapshot_items enable row level security;
create policy assurance_snapshot_items_select on assurance_snapshot_items
  for select to authenticated using (t4d.is_engagement_member(engagement_id));
create policy assurance_snapshot_items_insert on assurance_snapshot_items
  for insert to authenticated
  with check (t4d.can_write_engagement_workpaper(engagement_id, assurance_firm_id, 'assurance.snapshot.create'));
-- UPDATE / DELETE ポリシーは作らない

alter table snapshot_changes enable row level security;
create policy snapshot_changes_select on snapshot_changes for select to authenticated
  using (t4d.is_engagement_member(engagement_id));
create policy snapshot_changes_insert on snapshot_changes for insert to authenticated
  with check (t4d.is_engagement_member(engagement_id));
-- 影響評価（assessed_*）の記録だけは更新を許す
create policy snapshot_changes_update on snapshot_changes for update to authenticated
  using (t4d.can_write_engagement_workpaper(engagement_id, assurance_firm_id, 'assurance.testing.write'))
  with check (t4d.can_write_engagement_workpaper(engagement_id, assurance_firm_id, 'assurance.testing.write'));

-- ----------------------------------------------------------------------
-- 母集団 / サンプル
-- ----------------------------------------------------------------------

alter table populations enable row level security;
create policy populations_select on populations for select to authenticated
  using (t4d.is_engagement_member(engagement_id));
create policy populations_write on populations for all to authenticated
  using (t4d.can_write_engagement_workpaper(engagement_id, assurance_firm_id, 'assurance.population.manage'))
  with check (t4d.can_write_engagement_workpaper(engagement_id, assurance_firm_id, 'assurance.population.manage'));

alter table population_items enable row level security;
create policy population_items_select on population_items for select to authenticated
  using (t4d.is_engagement_member(engagement_id));
create policy population_items_write on population_items for all to authenticated
  using (t4d.can_write_engagement_workpaper(engagement_id, assurance_firm_id, 'assurance.population.manage'))
  with check (t4d.can_write_engagement_workpaper(engagement_id, assurance_firm_id, 'assurance.population.manage'));

alter table samples enable row level security;
create policy samples_select on samples for select to authenticated
  using (t4d.is_engagement_member(engagement_id));
create policy samples_insert on samples for insert to authenticated
  with check (
    t4d.can_write_engagement_workpaper(engagement_id, assurance_firm_id, 'assurance.sampling.run')
    and created_by = auth.uid()
  );
-- 抽出結果は変更しない（再抽出は新しい Sample を作る）

alter table sample_items enable row level security;
create policy sample_items_select on sample_items for select to authenticated
  using (t4d.is_engagement_member(engagement_id));
create policy sample_items_insert on sample_items for insert to authenticated
  with check (t4d.can_write_engagement_workpaper(engagement_id, assurance_firm_id, 'assurance.sampling.run'));

-- ----------------------------------------------------------------------
-- 手続 / 調書（9. 自法人の案件データのみ更新可能）
-- ----------------------------------------------------------------------

alter table assurance_procedures enable row level security;
create policy assurance_procedures_select on assurance_procedures for select to authenticated
  using (t4d.is_engagement_member(engagement_id));
create policy assurance_procedures_write on assurance_procedures for all to authenticated
  using (t4d.can_write_engagement_workpaper(engagement_id, assurance_firm_id, 'assurance.engagement.manage'))
  with check (t4d.can_write_engagement_workpaper(engagement_id, assurance_firm_id, 'assurance.engagement.manage'));

alter table assurance_tests enable row level security;
create policy assurance_tests_select on assurance_tests for select to authenticated
  using (t4d.is_engagement_member(engagement_id));
create policy assurance_tests_write on assurance_tests for all to authenticated
  using (t4d.can_write_engagement_workpaper(engagement_id, assurance_firm_id, 'assurance.testing.write'))
  with check (t4d.can_write_engagement_workpaper(engagement_id, assurance_firm_id, 'assurance.testing.write'));

alter table assurance_test_results enable row level security;
create policy assurance_test_results_select on assurance_test_results for select to authenticated
  using (t4d.is_engagement_member(engagement_id));
create policy assurance_test_results_write on assurance_test_results for all to authenticated
  using (t4d.can_write_engagement_workpaper(engagement_id, assurance_firm_id, 'assurance.testing.write'))
  with check (
    t4d.can_write_engagement_workpaper(engagement_id, assurance_firm_id, 'assurance.testing.write')
    and completed_by = auth.uid()
  );

alter table workpaper_references enable row level security;
create policy workpaper_references_select on workpaper_references for select to authenticated
  using (t4d.is_engagement_member(engagement_id));
create policy workpaper_references_insert on workpaper_references for insert to authenticated
  with check (t4d.can_write_engagement_workpaper(engagement_id, assurance_firm_id, 'assurance.testing.write'));

-- ----------------------------------------------------------------------
-- PBC（企業と監査法人が同じ Request を見るが、内部 Note は分離）
--
-- internal_note は列レベルで隠せないため、企業側には
-- `pbc_requests_client` ビュー（内部メモ列を含まない）経由でのみ見せる。
-- 行そのものへの企業側 SELECT は許可しない。
-- ----------------------------------------------------------------------

alter table pbc_requests enable row level security;
create policy pbc_requests_select_firm on pbc_requests for select to authenticated
  using (t4d.is_engagement_member(engagement_id));
create policy pbc_requests_write_firm on pbc_requests for all to authenticated
  using (t4d.can_write_engagement_workpaper(engagement_id, assurance_firm_id, 'assurance.pbc.manage'))
  with check (t4d.can_write_engagement_workpaper(engagement_id, assurance_firm_id, 'assurance.pbc.manage'));

create view pbc_requests_client
with (security_invoker = true)
as
select
  r.id, r.engagement_id, r.client_organization_id, r.code, r.title, r.description,
  r.target_type, r.target_id, r.due_date, r.priority, r.status,
  r.requested_by, r.sent_at, r.closed_at, r.created_at, r.updated_at
from pbc_requests r
where r.status <> 'draft';

comment on view pbc_requests_client is
  '企業側へ公開する PBC 依頼。internal_note（監査法人内部メモ）を含まず、draft も含まない。';

-- ビュー経由で企業側が読めるように、企業向けの SELECT ポリシーを別途追加する。
-- （security_invoker = true のため、ビューでも RLS が適用される）
create policy pbc_requests_select_client on pbc_requests for select to authenticated
  using (t4d.is_org_member(client_organization_id) and status <> 'draft');

alter table pbc_request_responses enable row level security;
create policy pbc_request_responses_select on pbc_request_responses for select to authenticated
  using (t4d.is_engagement_member(engagement_id) or t4d.is_org_member(client_organization_id));
-- 回答は企業側が作成
create policy pbc_request_responses_insert on pbc_request_responses for insert to authenticated
  with check (
    t4d.has_permission(client_organization_id, 'enterprise.pbc.respond')
    and submitted_by = auth.uid()
  );
-- 受領判定（decision）は監査法人側が更新
create policy pbc_request_responses_update_firm on pbc_request_responses
  for update to authenticated
  using (t4d.is_engagement_member(engagement_id))
  with check (t4d.is_engagement_member(engagement_id));

-- ----------------------------------------------------------------------
-- Issue / 経営者回答
-- ----------------------------------------------------------------------

alter table assurance_issues enable row level security;
create policy assurance_issues_select on assurance_issues for select to authenticated
  using (t4d.is_engagement_member(engagement_id) or t4d.is_org_member(client_organization_id));
create policy assurance_issues_write_firm on assurance_issues for all to authenticated
  using (t4d.can_write_engagement_workpaper(engagement_id, assurance_firm_id, 'assurance.issue.manage'))
  with check (t4d.can_write_engagement_workpaper(engagement_id, assurance_firm_id, 'assurance.issue.manage'));

alter table management_responses enable row level security;
create policy management_responses_select on management_responses for select to authenticated
  using (t4d.is_engagement_member(engagement_id) or t4d.is_org_member(client_organization_id));
create policy management_responses_insert on management_responses for insert to authenticated
  with check (
    t4d.is_org_member(client_organization_id)
    and responded_by = auth.uid()
  );

-- ----------------------------------------------------------------------
-- 10. Review Note（共有フラグが立っていなければ企業から不可視）
-- ----------------------------------------------------------------------

alter table review_notes enable row level security;
create policy review_notes_select_firm on review_notes for select to authenticated
  using (t4d.is_engagement_member(engagement_id));
create policy review_notes_select_client on review_notes for select to authenticated
  using (shared_with_client = true and t4d.is_engagement_client(engagement_id));
create policy review_notes_write_firm on review_notes for all to authenticated
  using (t4d.can_write_engagement_workpaper(engagement_id, assurance_firm_id, 'assurance.review.write'))
  with check (t4d.can_write_engagement_workpaper(engagement_id, assurance_firm_id, 'assurance.review.write'));

-- ----------------------------------------------------------------------
-- Sign-off（代理禁止・追記専用）
-- ----------------------------------------------------------------------

alter table signoffs enable row level security;
create policy signoffs_select on signoffs for select to authenticated
  using (t4d.is_engagement_member(engagement_id) or t4d.is_engagement_client(engagement_id));
create policy signoffs_insert on signoffs for insert to authenticated
  with check (
    t4d.is_engagement_member(engagement_id)
    -- 代理 Sign-off 禁止: 本人のみ
    and user_id = auth.uid()
    and (
      (signoff_stage = 'prepared'
        and t4d.has_permission(assurance_firm_id, 'assurance.signoff.prepared'))
      or (signoff_stage = 'reviewed'
        and t4d.has_permission(assurance_firm_id, 'assurance.signoff.reviewed'))
      or (signoff_stage = 'partner_approved'
        and t4d.has_permission(assurance_firm_id, 'assurance.signoff.partner'))
    )
  );
-- UPDATE / DELETE ポリシーは作らない（撤回は別レコードで表現する）

-- ----------------------------------------------------------------------
-- 12. Audit Event（追記専用）
-- ----------------------------------------------------------------------

alter table audit_events enable row level security;
create policy audit_events_select on audit_events for select to authenticated
  using (
    (actor_organization_id is not null
      and t4d.has_permission(actor_organization_id, 'common.audit.read'))
    or (engagement_id is not null and t4d.is_engagement_member(engagement_id))
  );
create policy audit_events_insert on audit_events for insert to authenticated
  with check (actor_user_id is null or actor_user_id = auth.uid());
-- UPDATE / DELETE ポリシーは作らない
