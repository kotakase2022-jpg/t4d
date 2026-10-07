import type { DangerousOp } from './types';

/** Stage B5（集計・分析・ESG経営・GHG・マスター） */
export const B5_DANGEROUS_OPS: DangerousOp[] = [
  {
    id: 'F028',
    label: 'サプライヤーデモのリセット',
    tier: 'irreversible',
    action: 'src/app/enterprise/actions.ts#resetSupplierDemoAction',
    // 見出しの「その他」→ 確認ダイアログ（範囲 1 行・必須チェック・取り消せません）
    origins: ['src/app/enterprise/ghg/suppliers/page.tsx'],
    status: 'done',
  },
  {
    id: 'F029',
    label: '排出原単位の変更（変更前後の原単位を確認）',
    tier: 'bulk',
    action: 'src/app/enterprise/actions.ts#relinkSupplierFactorAction',
    // 行の「原単位を変更…」→ 変更前後の原単位・排出量を並べた確認ダイアログ
    origins: ['src/app/enterprise/ghg/suppliers/factor-relink-dialog.tsx'],
    status: 'done',
  },
];
