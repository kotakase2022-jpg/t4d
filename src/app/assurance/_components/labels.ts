import type {
  AssuranceLevel,
  AuditEventType,
  ChangeKind,
  Engagement,
  GrantSubjectType,
  SnapshotChange,
  TestResultValue,
} from '@/types/domain';
import type { StatusSemantic } from '@/lib/ui/status/registry';

/**
 * 監査法人の画面で使う語の表（plan §1.17）。画面ごとに生の enum（`value_changed`・`no_impact`・`pass` など）を
 * そのまま出していたものを、業務の言葉に揃える。React 非依存（unit で網羅を確かめる）。
 *
 * 状態（PBC・調書・指摘・レビューNote・案件・Sign-off）は状態登録簿（src/lib/ui/status）にある。
 * ここは登録簿の「状態」ではない区分（変更の種類・影響評価・手続の結果・監査イベント）だけを持つ。
 */

export function assuranceLevelLabel(level: AssuranceLevel): string {
  return level === 'limited' ? '限定的保証' : '合理的保証';
}

const FRAMEWORK_LABEL: Record<Engagement['frameworkKey'], string> = {
  ssbj: 'SSBJ',
  csrd: 'CSRD',
  cdp: 'CDP',
  esrs_40a: 'ESRS（40a）',
  msci: 'MSCI',
  ftse: 'FTSE',
  issb: 'ISSB',
  other: 'その他',
};

export function frameworkLabel(key: Engagement['frameworkKey']): string {
  return FRAMEWORK_LABEL[key] ?? key.toUpperCase();
}

/** Snapshot 固定後の変更の種類 */
export const CHANGE_KIND_LABEL: Record<ChangeKind, string> = {
  value_changed: '値の変更',
  version_added: '版の追加',
  evidence_replaced: '資料の差し替え',
  grant_revoked: 'アクセス許諾の取消',
};

type Assessment = NonNullable<SnapshotChange['assessment']>;

/** 変更の影響評価（選択肢と表示で同じ語を使う） */
export const ASSESSMENT_OPTIONS: ReadonlyArray<{
  value: Assessment;
  label: string;
  semantic: StatusSemantic;
}> = [
  { value: 'no_impact', label: '影響なし', semantic: 'done' },
  { value: 'retest_required', label: '再検証が必要', semantic: 'pending' },
  { value: 'issue_raised', label: '指摘として起票', semantic: 'blocked' },
];

export function assessmentEntry(value: Assessment) {
  return ASSESSMENT_OPTIONS.find((option) => option.value === value) ?? ASSESSMENT_OPTIONS[0]!;
}

/** 手続の結果（選択肢と表示で同じ語を使う） */
export const TEST_RESULT_OPTIONS: ReadonlyArray<{
  value: TestResultValue;
  label: string;
  semantic: StatusSemantic;
}> = [
  { value: 'pass', label: '相違なし', semantic: 'done' },
  { value: 'exception', label: '例外あり', semantic: 'error' },
  { value: 'not_applicable', label: '該当なし', semantic: 'excluded' },
];

export function testResultEntry(value: string) {
  return (
    TEST_RESULT_OPTIONS.find((option) => option.value === value) ?? {
      value: value as TestResultValue,
      label: '結果不明',
      semantic: 'info' as const,
    }
  );
}

/** アクセス許諾の種別 */
export const GRANT_SUBJECT_LABEL: Record<GrantSubjectType, string> = {
  metric: '指標',
  organization_unit: '組織・拠点',
  reporting_period: '報告期間',
  evidence_category: '資料の区分',
  disclosure_item: '開示項目',
};

/** スコープのリスク区分 */
export const RISK_TAG_LABEL: Record<'high' | 'medium' | 'low', string> = {
  high: '高',
  medium: '中',
  low: '低',
};

/**
 * 監査イベントの名前。監査ログは追記専用の記録なので、画面には業務の言葉を主に出し、
 * イベントのコード（記録上の識別子）も併記する（監査人が出力・照合で使うため隠さない）。
 */
export const AUDIT_EVENT_LABEL: Record<AuditEventType, string> = {
  login_success: 'ログイン',
  login_failure: 'ログインの失敗',
  logout: 'ログアウト',
  workspace_selected: 'ワークスペースの選択',
  record_viewed: '記録の閲覧',
  file_uploaded: 'ファイルの登録',
  file_downloaded: 'ファイルのダウンロード',
  signed_url_created: '資料を開くリンクの発行',
  data_created: 'データの作成',
  data_updated: 'データの更新',
  data_submitted: 'データの提出',
  data_returned: 'データの差戻し',
  data_approved: 'データの承認',
  permission_changed: '権限の変更',
  access_grant_created: 'アクセス許諾の付与',
  access_grant_revoked: 'アクセス許諾の取消',
  snapshot_created: 'Snapshot の固定',
  snapshot_change_detected: 'Snapshot 後の変更の検知',
  sample_created: 'サンプルの抽出',
  procedure_completed: '手続の記録',
  pbc_created: '資料依頼の送付',
  pbc_submitted: '資料依頼への回答',
  issue_created: '指摘の起票',
  issue_resolved: '指摘の解消',
  review_note_created: 'レビューNote の追加',
  signoff_created: 'Sign-off の記録',
  ai_run_started: 'AI の実行開始',
  ai_run_completed: 'AI の実行完了',
  ai_output_accepted: 'AI の候補の採用',
  export_created: '出力',
  settings_changed: '設定の変更',
  project_created: 'プロジェクトの作成',
  project_updated: 'プロジェクトの更新',
  framework_decision_confirmed: '基準の判断の確定',
  narrative_version_created: '定性情報の版の作成',
  narrative_confirmed: '定性情報の確定',
  block_version_created: '原稿の版の作成',
  review_requested: 'レビューの依頼',
  review_returned: 'レビューの差戻し',
  review_completed: 'レビューの完了',
  review_approved: '最終承認',
  review_withdrawn: 'レビュー依頼の取り下げ',
  comment_created: 'コメント',
  comment_resolved: 'コメントの解決',
  recheck_decided: '再確認の判断',
  report_snapshot_created: 'レポートの確定',
  import_committed: '取込の確定',
};

export function auditEventLabel(eventType: string): string {
  return Object.prototype.hasOwnProperty.call(AUDIT_EVENT_LABEL, eventType)
    ? AUDIT_EVENT_LABEL[eventType as AuditEventType]
    : 'その他の記録';
}

/** Evidence（資料）へのアクセスの種類 */
export const STORAGE_ACTION_LABEL: Record<'signed_url_created' | 'downloaded' | 'viewed', string> =
  {
    signed_url_created: '開くリンクの発行',
    downloaded: 'ダウンロード',
    viewed: '閲覧',
  };
