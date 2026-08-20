-- ======================================================================
-- 0012 RLS（Identity / 企業データ / Evidence / Workflow / Disclosure / Import）
-- ----------------------------------------------------------------------
-- 指示書 11 章の必須ポリシー 1〜5, 10〜15 に対応する。
-- 監査法人側（6〜9）は 0013 で追加する。
--
-- 方針:
--  - すべての業務テーブルで RLS を有効化する（RLS 無効のテーブルを残さない）。
--  - SELECT できない行は「存在しない」ものとして扱う（404 相当）。
--  - Service Role は RLS をバイパスするため、Server / Edge Function からのみ使う。
-- ======================================================================

-- 同一組織に所属しているユーザーか（プロフィール表示用）
create or replace function t4d.shares_organization(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from organization_memberships mine
    join organization_memberships theirs
      on theirs.organization_id = mine.organization_id
    where mine.user_id = auth.uid()
      and mine.status = 'active'
      and theirs.user_id = p_user_id
      and theirs.status = 'active'
  );
$$;

-- ----------------------------------------------------------------------
-- Identity
-- ----------------------------------------------------------------------

alter table profiles enable row level security;
create policy profiles_select on profiles for select to authenticated
  using (id = auth.uid() or t4d.shares_organization(id));
create policy profiles_update_self on profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

alter table organizations enable row level security;
create policy organizations_select on organizations for select to authenticated
  using (t4d.is_org_member(id));
create policy organizations_update on organizations for update to authenticated
  using (t4d.has_permission(id, 'enterprise.org.manage'))
  with check (t4d.has_permission(id, 'enterprise.org.manage'));

-- ロール・権限マスターは全認証ユーザーが参照可（テナントデータではない）。更新は不可。
alter table roles enable row level security;
create policy roles_select on roles for select to authenticated using (true);

alter table permissions enable row level security;
create policy permissions_select on permissions for select to authenticated using (true);

alter table role_permissions enable row level security;
create policy role_permissions_select on role_permissions for select to authenticated using (true);

alter table organization_memberships enable row level security;
create policy organization_memberships_select on organization_memberships
  for select to authenticated
  using (user_id = auth.uid() or t4d.is_org_member(organization_id));
create policy organization_memberships_insert on organization_memberships
  for insert to authenticated
  with check (t4d.has_permission(organization_id, 'enterprise.member.manage')
           or t4d.has_permission(organization_id, 'assurance.firm.manage'));
create policy organization_memberships_update on organization_memberships
  for update to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.member.manage')
      or t4d.has_permission(organization_id, 'assurance.firm.manage'))
  with check (t4d.has_permission(organization_id, 'enterprise.member.manage')
           or t4d.has_permission(organization_id, 'assurance.firm.manage'));

alter table membership_roles enable row level security;
create policy membership_roles_select on membership_roles for select to authenticated
  using (exists (
    select 1 from organization_memberships m
    where m.id = membership_id
      and (m.user_id = auth.uid() or t4d.is_org_member(m.organization_id))
  ));
create policy membership_roles_write on membership_roles for all to authenticated
  using (exists (
    select 1 from organization_memberships m
    where m.id = membership_id
      and (t4d.has_permission(m.organization_id, 'enterprise.member.manage')
        or t4d.has_permission(m.organization_id, 'assurance.firm.manage'))
  ))
  with check (exists (
    select 1 from organization_memberships m
    where m.id = membership_id
      and (t4d.has_permission(m.organization_id, 'enterprise.member.manage')
        or t4d.has_permission(m.organization_id, 'assurance.firm.manage'))
  ));

alter table invitations enable row level security;
create policy invitations_select on invitations for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy invitations_write on invitations for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.member.manage')
      or t4d.has_permission(organization_id, 'assurance.firm.manage'))
  with check (t4d.has_permission(organization_id, 'enterprise.member.manage')
           or t4d.has_permission(organization_id, 'assurance.firm.manage'));

alter table organization_relationships enable row level security;
create policy organization_relationships_select on organization_relationships
  for select to authenticated
  using (t4d.is_org_member(client_organization_id) or t4d.is_org_member(provider_organization_id));
create policy organization_relationships_write on organization_relationships
  for all to authenticated
  using (t4d.has_permission(client_organization_id, 'enterprise.grant.manage'))
  with check (t4d.has_permission(client_organization_id, 'enterprise.grant.manage'));

alter table user_preferences enable row level security;
create policy user_preferences_all on user_preferences for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ----------------------------------------------------------------------
-- Organization / Period / Master
-- ----------------------------------------------------------------------

alter table organization_units enable row level security;
create policy organization_units_select on organization_units for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy organization_units_write on organization_units for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.org.manage'))
  with check (t4d.has_permission(organization_id, 'enterprise.org.manage'));

alter table reporting_periods enable row level security;
create policy reporting_periods_select on reporting_periods for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy reporting_periods_write on reporting_periods for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.period.manage'))
  with check (t4d.has_permission(organization_id, 'enterprise.period.manage'));

alter table collection_campaigns enable row level security;
create policy collection_campaigns_select on collection_campaigns for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy collection_campaigns_write on collection_campaigns for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.period.manage'))
  with check (t4d.has_permission(organization_id, 'enterprise.period.manage'));

alter table metric_definitions enable row level security;
create policy metric_definitions_select on metric_definitions for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy metric_definitions_write on metric_definitions for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.metric.manage'))
  with check (t4d.has_permission(organization_id, 'enterprise.metric.manage'));

alter table campaign_scopes enable row level security;
create policy campaign_scopes_all on campaign_scopes for all to authenticated
  using (exists (
    select 1 from collection_campaigns c
    where c.id = campaign_id and t4d.is_org_member(c.organization_id)
  ))
  with check (exists (
    select 1 from collection_campaigns c
    where c.id = campaign_id and t4d.has_permission(c.organization_id, 'enterprise.period.manage')
  ));

alter table metric_assignments enable row level security;
create policy metric_assignments_select on metric_assignments for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy metric_assignments_write on metric_assignments for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.period.manage'))
  with check (t4d.has_permission(organization_id, 'enterprise.period.manage'));

alter table emission_factors enable row level security;
create policy emission_factors_select on emission_factors for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy emission_factors_write on emission_factors for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.metric.manage'))
  with check (t4d.has_permission(organization_id, 'enterprise.metric.manage'));

-- ----------------------------------------------------------------------
-- Data Point
--
-- 11-1 自組織のみ閲覧 / 11-2 Role と Unit Scope 内のみ更新
-- 11-3 Site Contributor は担当 Unit のみ / 11-5 Approver だけが最終承認
-- ----------------------------------------------------------------------

alter table data_points enable row level security;

create policy data_points_select_enterprise on data_points for select to authenticated
  using (t4d.is_org_member(organization_id));

create policy data_points_insert on data_points for insert to authenticated
  with check (
    t4d.has_permission(organization_id, 'enterprise.data.write')
    and t4d.unit_in_scope(organization_id, unit_id)
  );

create policy data_points_update on data_points for update to authenticated
  using (
    t4d.is_org_member(organization_id)
    and deleted_at is null
    and (
      t4d.has_permission(organization_id, 'enterprise.data.write')
      or t4d.has_permission(organization_id, 'enterprise.data.review')
      or t4d.has_permission(organization_id, 'enterprise.data.approve')
    )
    and t4d.unit_in_scope(organization_id, unit_id)
  )
  with check (
    t4d.is_org_member(organization_id)
    and t4d.unit_in_scope(organization_id, unit_id)
    -- 最終承認は approver 権限を持つ者のみ（新しい行の状態で判定できる）
    and (status <> 'approved' or t4d.has_permission(organization_id, 'enterprise.data.approve'))
  );
-- 状態「遷移」の権限（OLD と NEW の比較が必要）は
-- 0014 の t4d.enforce_data_point_transition トリガで強制する。

alter table data_point_versions enable row level security;
create policy data_point_versions_select on data_point_versions for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy data_point_versions_insert on data_point_versions for insert to authenticated
  with check (
    t4d.is_org_member(organization_id)
    and (
      t4d.has_permission(organization_id, 'enterprise.data.write')
      or t4d.has_permission(organization_id, 'enterprise.data.review')
      or t4d.has_permission(organization_id, 'enterprise.data.approve')
    )
  );
-- Version は追記専用（UPDATE / DELETE ポリシーを作らない）

alter table data_point_calculations enable row level security;
create policy data_point_calculations_select on data_point_calculations for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy data_point_calculations_insert on data_point_calculations for insert to authenticated
  with check (t4d.has_permission(organization_id, 'enterprise.data.write'));

alter table data_point_validation_results enable row level security;
create policy data_point_validation_results_select on data_point_validation_results
  for select to authenticated using (t4d.is_org_member(organization_id));
create policy data_point_validation_results_write on data_point_validation_results
  for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.data.write'))
  with check (t4d.has_permission(organization_id, 'enterprise.data.write'));

alter table aggregation_rules enable row level security;
create policy aggregation_rules_select on aggregation_rules for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy aggregation_rules_write on aggregation_rules for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.metric.manage'))
  with check (t4d.has_permission(organization_id, 'enterprise.metric.manage'));

alter table aggregation_runs enable row level security;
create policy aggregation_runs_select on aggregation_runs for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy aggregation_runs_write on aggregation_runs for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.data.write'))
  with check (t4d.has_permission(organization_id, 'enterprise.data.write'));

-- ----------------------------------------------------------------------
-- File / Evidence
-- ----------------------------------------------------------------------

alter table files enable row level security;
create policy files_select on files for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy files_insert on files for insert to authenticated
  with check (t4d.has_permission(organization_id, 'enterprise.evidence.write'));
create policy files_update on files for update to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.evidence.write'))
  with check (t4d.has_permission(organization_id, 'enterprise.evidence.write'));

alter table file_versions enable row level security;
create policy file_versions_select_enterprise on file_versions for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy file_versions_insert on file_versions for insert to authenticated
  with check (t4d.has_permission(organization_id, 'enterprise.evidence.write'));
-- 置換ではなく新 Version 追加のみ（UPDATE / DELETE ポリシーなし）

alter table extracted_fragments enable row level security;
create policy extracted_fragments_select on extracted_fragments for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy extracted_fragments_insert on extracted_fragments for insert to authenticated
  with check (t4d.has_permission(organization_id, 'enterprise.evidence.write'));

alter table evidence_links enable row level security;
create policy evidence_links_select_enterprise on evidence_links for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy evidence_links_write on evidence_links for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.evidence.write'))
  with check (t4d.has_permission(organization_id, 'enterprise.evidence.write'));

alter table storage_access_events enable row level security;
create policy storage_access_events_select on storage_access_events for select to authenticated
  using (t4d.is_org_member(organization_id) and t4d.has_permission(organization_id, 'common.audit.read'));
create policy storage_access_events_insert on storage_access_events for insert to authenticated
  with check (actor_user_id = auth.uid());
-- 追記専用

-- ----------------------------------------------------------------------
-- Workflow / Task / Alert
-- ----------------------------------------------------------------------

alter table workflow_definitions enable row level security;
create policy workflow_definitions_select on workflow_definitions for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy workflow_definitions_write on workflow_definitions for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.org.manage'))
  with check (t4d.has_permission(organization_id, 'enterprise.org.manage'));

alter table workflow_instances enable row level security;
create policy workflow_instances_select on workflow_instances for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy workflow_instances_write on workflow_instances for all to authenticated
  using (
    t4d.has_permission(organization_id, 'enterprise.data.write')
    or t4d.has_permission(organization_id, 'enterprise.data.review')
    or t4d.has_permission(organization_id, 'enterprise.data.approve')
  )
  with check (
    t4d.has_permission(organization_id, 'enterprise.data.write')
    or t4d.has_permission(organization_id, 'enterprise.data.review')
    or t4d.has_permission(organization_id, 'enterprise.data.approve')
  );

-- 11-4 Reviewer は指定 Workflow Step だけ操作可能
alter table workflow_steps enable row level security;
create policy workflow_steps_select on workflow_steps for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy workflow_steps_update on workflow_steps for update to authenticated
  using (
    t4d.is_org_member(organization_id)
    and (
      (step_key = 'input' and t4d.has_permission(organization_id, 'enterprise.data.write'))
      or (step_key = 'review' and t4d.has_permission(organization_id, 'enterprise.data.review'))
      or (step_key = 'approval' and t4d.has_permission(organization_id, 'enterprise.data.approve'))
    )
  )
  with check (
    (step_key = 'input' and t4d.has_permission(organization_id, 'enterprise.data.write'))
    or (step_key = 'review' and t4d.has_permission(organization_id, 'enterprise.data.review'))
    or (step_key = 'approval' and t4d.has_permission(organization_id, 'enterprise.data.approve'))
  );
create policy workflow_steps_insert on workflow_steps for insert to authenticated
  with check (t4d.has_permission(organization_id, 'enterprise.data.write'));

alter table tasks enable row level security;
create policy tasks_select on tasks for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy tasks_write on tasks for all to authenticated
  using (t4d.is_org_member(organization_id))
  with check (t4d.is_org_member(organization_id));

-- 11-5 Approver だけが Final Approval
alter table approvals enable row level security;
create policy approvals_select on approvals for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy approvals_insert on approvals for insert to authenticated
  with check (
    actor_user_id = auth.uid()
    and (
      (stage = 'final' and t4d.has_permission(organization_id, 'enterprise.data.approve'))
      or (stage = 'review' and t4d.has_permission(organization_id, 'enterprise.data.review'))
    )
  );
-- 承認記録は追記専用

alter table comments enable row level security;
create policy comments_select on comments for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy comments_insert on comments for insert to authenticated
  with check (t4d.is_org_member(organization_id) and author_user_id = auth.uid());
create policy comments_update_own on comments for update to authenticated
  using (author_user_id = auth.uid())
  with check (author_user_id = auth.uid());

alter table notifications enable row level security;
create policy notifications_select on notifications for select to authenticated
  using (user_id = auth.uid());
create policy notifications_update on notifications for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
create policy notifications_insert on notifications for insert to authenticated
  with check (t4d.is_org_member(organization_id));

alter table alerts enable row level security;
create policy alerts_select on alerts for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy alerts_write on alerts for all to authenticated
  using (t4d.is_org_member(organization_id))
  with check (t4d.is_org_member(organization_id));

-- ----------------------------------------------------------------------
-- Disclosure
-- ----------------------------------------------------------------------

alter table disclosure_frameworks enable row level security;
create policy disclosure_frameworks_select on disclosure_frameworks for select to authenticated
  using (true);

alter table disclosure_framework_versions enable row level security;
create policy disclosure_framework_versions_select on disclosure_framework_versions
  for select to authenticated using (true);

alter table disclosure_items enable row level security;
create policy disclosure_items_select on disclosure_items for select to authenticated using (true);

alter table disclosure_item_conditions enable row level security;
create policy disclosure_item_conditions_select on disclosure_item_conditions
  for select to authenticated using (true);

alter table applicability_results enable row level security;
create policy applicability_results_select on applicability_results for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy applicability_results_write on applicability_results for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.disclosure.write'))
  with check (t4d.has_permission(organization_id, 'enterprise.disclosure.write'));

alter table disclosure_responses enable row level security;
create policy disclosure_responses_select on disclosure_responses for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy disclosure_responses_insert on disclosure_responses for insert to authenticated
  with check (t4d.has_permission(organization_id, 'enterprise.disclosure.write'));
create policy disclosure_responses_update on disclosure_responses for update to authenticated
  using (
    t4d.is_org_member(organization_id)
    and (
      t4d.has_permission(organization_id, 'enterprise.disclosure.write')
      or t4d.has_permission(organization_id, 'enterprise.disclosure.approve')
    )
  )
  with check (
    -- 開示回答の最終承認は approver のみ
    status <> 'approved' or t4d.has_permission(organization_id, 'enterprise.disclosure.approve')
  );

alter table disclosure_response_versions enable row level security;
create policy disclosure_response_versions_select on disclosure_response_versions
  for select to authenticated using (t4d.is_org_member(organization_id));
create policy disclosure_response_versions_insert on disclosure_response_versions
  for insert to authenticated
  with check (
    t4d.has_permission(organization_id, 'enterprise.disclosure.write')
    or t4d.has_permission(organization_id, 'enterprise.disclosure.approve')
  );

alter table disclosure_mappings enable row level security;
create policy disclosure_mappings_select on disclosure_mappings for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy disclosure_mappings_write on disclosure_mappings for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.disclosure.write'))
  with check (t4d.has_permission(organization_id, 'enterprise.disclosure.write'));

alter table response_evidence_links enable row level security;
create policy response_evidence_links_select on response_evidence_links for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy response_evidence_links_write on response_evidence_links for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.disclosure.write'))
  with check (t4d.has_permission(organization_id, 'enterprise.disclosure.write'));

-- ----------------------------------------------------------------------
-- Import / AI
-- ----------------------------------------------------------------------

alter table ingestion_jobs enable row level security;
create policy ingestion_jobs_select on ingestion_jobs for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy ingestion_jobs_write on ingestion_jobs for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.import.run'))
  with check (t4d.has_permission(organization_id, 'enterprise.import.run'));

alter table ingestion_job_files enable row level security;
create policy ingestion_job_files_select on ingestion_job_files for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy ingestion_job_files_write on ingestion_job_files for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.import.run'))
  with check (t4d.has_permission(organization_id, 'enterprise.import.run'));

alter table ingestion_rows enable row level security;
create policy ingestion_rows_select on ingestion_rows for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy ingestion_rows_write on ingestion_rows for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.import.run'))
  with check (t4d.has_permission(organization_id, 'enterprise.import.run'));

alter table ai_jobs enable row level security;
create policy ai_jobs_select on ai_jobs for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy ai_jobs_write on ai_jobs for all to authenticated
  using (t4d.has_permission(organization_id, 'enterprise.ai.run')
      or t4d.has_permission(organization_id, 'assurance.ai.run'))
  with check (t4d.has_permission(organization_id, 'enterprise.ai.run')
           or t4d.has_permission(organization_id, 'assurance.ai.run'));

alter table ai_runs enable row level security;
create policy ai_runs_select on ai_runs for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy ai_runs_insert on ai_runs for insert to authenticated
  with check (t4d.has_permission(organization_id, 'enterprise.ai.run')
           or t4d.has_permission(organization_id, 'assurance.ai.run'));
create policy ai_runs_update on ai_runs for update to authenticated
  using (t4d.is_org_member(organization_id))
  with check (t4d.is_org_member(organization_id));

alter table ai_sources enable row level security;
create policy ai_sources_select on ai_sources for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy ai_sources_insert on ai_sources for insert to authenticated
  with check (t4d.is_org_member(organization_id));

alter table ai_feedback enable row level security;
create policy ai_feedback_select on ai_feedback for select to authenticated
  using (t4d.is_org_member(organization_id));
create policy ai_feedback_insert on ai_feedback for insert to authenticated
  with check (t4d.is_org_member(organization_id) and user_id = auth.uid());
