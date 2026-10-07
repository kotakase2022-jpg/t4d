import type { DangerousOp } from './types';

/** Stage B4（開示プロジェクト・原稿・定性情報） */
export const B4_DANGEROUS_OPS: DangerousOp[] = [
  {
    id: 'F099',
    label: '最終承認（社内承認）',
    tier: 'irreversible',
    action:
      'src/app/enterprise/disclosure-projects/[projectId]/blocks/actions.ts#finalApproveAction',
    origins: [
      'src/app/enterprise/disclosure-projects/[projectId]/blocks/[blockId]/review-panel.tsx',
    ],
    status: 'done',
    note: 'レビューのパネルの primary（kind: confirm）。範囲「版 N を社内承認済みとして固定」を確認してから送る',
  },
  {
    id: 'F102',
    label: 'レポートを確定（承認済みの版を固定）',
    tier: 'irreversible',
    action:
      'src/app/enterprise/disclosure-projects/[projectId]/outputs/actions.ts#confirmReportAction',
    origins: ['src/app/enterprise/disclosure-projects/[projectId]/_tabs/outputs.tsx'],
    status: 'done',
    note: '出力タブの primary（kind: confirm）。範囲「承認済みの版を不変のスナップショットとして固定」を確認してから送る',
  },
];
