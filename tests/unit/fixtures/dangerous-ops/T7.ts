import type { DangerousOp } from './types';

/**
 * トライアル対応（2026-10）のスライス T7 CDP オプション（担当の一括割当 など）。
 * 危険な操作（不可逆・一括／上書き・可逆）を足したら、ここに登録する（tests/unit/dangerous-ops.test.ts が確認の有無を見る）。
 * 機能 ID は docs/ui-redesign/inventory-features.md §3.14 の F185〜F193（T7 の機能）
 */
export const T7_DANGEROUS_OPS: DangerousOp[] = [
  {
    id: 'F188',
    label: 'CDP の質問の担当の一括割当',
    tier: 'bulk',
    action: 'src/app/enterprise/disclosures/cdp/actions.ts#bulkAssignResponsesAction',
    origins: ['src/app/enterprise/disclosures/cdp/_components/bulk-assign-bar.tsx'],
    status: 'done',
    note: '一覧で行を選ぶ →「担当を割り当てる…」→ 件数と状態の内訳の ConfirmDialog の中で作成担当・レビュー担当を選ぶ（既定は「変更しない」）。すべて検査してから書く',
  },
  {
    id: 'F191',
    label: '回答の指標の対応付けを外す',
    tier: 'irreversible',
    action: 'src/app/enterprise/disclosures/cdp/actions.ts#removeMetricMappingAction',
    origins: ['src/app/enterprise/disclosures/question-view.tsx'],
    status: 'done',
    note: '回答画面「対応する T4D の情報」の指標の「外す…」→ ConfirmDialog。行は消さずに確定を外す（確定者・確定日時が消えるため取り消せない扱い）',
  },
  {
    id: 'F192',
    label: '回答と T4D の情報（定性情報・原稿・要求事項）の対応付けを外す',
    tier: 'irreversible',
    action: 'src/app/enterprise/disclosures/cdp/actions.ts#removeResponseLinkAction',
    origins: ['src/app/enterprise/disclosures/question-view.tsx'],
    status: 'done',
    note: '「外す…」→ ConfirmDialog。deleted_at を入れる（物理削除しない）',
  },
  {
    id: 'F193',
    label: '回答に根拠を紐付ける',
    tier: 'irreversible',
    action: 'src/app/enterprise/disclosures/cdp/actions.ts#linkResponseEvidenceAction',
    origins: ['src/app/enterprise/disclosures/question-view.tsx'],
    status: 'done',
    note: '候補の「根拠にする…」→ ConfirmDialog。紐付けは追記だけで外せない（根拠の記録）',
  },
];
