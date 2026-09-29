-- ----------------------------------------------------------------------
-- 監査ログの種類に開示業務の操作を追加（docs/disclosure-first.md §3 0040）
--
-- これまで開示業務の操作は data_created / data_approved などデータ入力用の種類で
-- 代用していた（例: SSBJ ドラフトの確定が data_approved として残る）。
-- 「誰がいつどの版をレビュー依頼・差戻し・承認したか」を種類で引けないと、
-- 保証対応で操作の経緯を示せないため、専用の種類を足す。
--
-- 0010 の CHECK 制約の付け替えのみ（0018 と同じ方式。既存ファイルは書き換えない）。
-- 既存の 30 種類はそのまま残す。src/types/domain.ts の AUDIT_EVENT_TYPES と一致させること。
-- ----------------------------------------------------------------------

alter table audit_events
  drop constraint audit_events_event_type_check;

alter table audit_events
  add constraint audit_events_event_type_check
    check (event_type in (
      'login_success', 'login_failure', 'logout', 'workspace_selected', 'record_viewed',
      'file_uploaded', 'file_downloaded', 'signed_url_created',
      'data_created', 'data_updated', 'data_submitted', 'data_returned', 'data_approved',
      'permission_changed', 'access_grant_created', 'access_grant_revoked',
      'snapshot_created', 'snapshot_change_detected', 'sample_created', 'procedure_completed',
      'pbc_created', 'pbc_submitted', 'issue_created', 'issue_resolved', 'review_note_created',
      'signoff_created', 'ai_run_started', 'ai_run_completed', 'ai_output_accepted',
      'export_created',
      -- 開示優先モード（0033〜0039）
      'settings_changed', 'project_created', 'project_updated',
      'framework_decision_confirmed', 'narrative_version_created', 'narrative_confirmed',
      'block_version_created',
      'review_requested', 'review_returned', 'review_completed', 'review_approved',
      'review_withdrawn',
      'comment_created', 'comment_resolved', 'recheck_decided', 'report_snapshot_created',
      'import_committed'
    ));
