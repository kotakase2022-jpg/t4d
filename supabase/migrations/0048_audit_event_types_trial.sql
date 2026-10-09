-- ----------------------------------------------------------------------
-- 監査ログの種類にトライアル対応（2026-10）の操作を追加
--
-- 保証側への承認済みレポートの共有・取り下げ、保証側コメントへの企業の回答、要求事項の対応付けの変更・
-- 要求事項の判断の記録、対象外の申請と承認、権限拒否、XBRL の対応付けの変更・確定は、
-- 「誰がいつ何をしたか」を種類で引けないと、トライアルの受入試験（権限・ログ）で示せないため専用の種類を足す。
-- トライアルの記録（計画・シナリオ・フィードバック・作業時間）は既存の data_created / data_updated /
-- settings_changed / export_created / permission_changed を resource_type で区別して使う（種類を増やしすぎない）。
--
-- 0040 の CHECK 制約の付け替えのみ（0018・0040 と同じ方式。既存ファイルは書き換えない）。
-- 既存の 47 種類はそのまま残す。src/types/domain.ts の AUDIT_EVENT_TYPES と一致させること
-- （tests/unit/disclosure-enum-parity.test.ts が最後の制約と突き合わせる）。
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
      'import_committed',
      -- トライアル対応（0049〜0054）
      'report_shared', 'report_share_withdrawn', 'review_note_responded',
      'requirement_mapping_changed', 'requirement_assessed',
      'exclusion_requested', 'exclusion_decided',
      'access_denied',
      'xbrl_mapping_changed', 'xbrl_mapping_confirmed'
    ));
