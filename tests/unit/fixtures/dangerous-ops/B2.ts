import type { DangerousOp } from './types';

/** Stage B2（SSBJ・CDP・回答・その他の開示） */
export const B2_DANGEROUS_OPS: DangerousOp[] = [
  {
    id: 'F032',
    label: 'SSBJ 設定の確定',
    tier: 'irreversible',
    action: 'src/app/enterprise/actions.ts#confirmSsbjSettingsAction',
    origins: ['src/app/enterprise/disclosures/ssbj/settings/page.tsx'],
    status: 'done',
    note: '「この内容で確定する」→ ConfirmDialog（範囲 1 行・結果の箇条）→「確定する」',
  },
  {
    id: 'F035',
    label: 'マテリアリティの削除',
    tier: 'irreversible',
    action: 'src/app/enterprise/actions.ts#deleteMaterialityTopicAction',
    origins: ['src/app/enterprise/disclosures/ssbj/settings/materiality-manager.tsx'],
    status: 'done',
    note: '行内の「削除しますか？」を ConfirmDialog へ（ボタン「…を削除」と確定「削除する」は保つ）',
  },
  {
    id: 'F074',
    label: '回答の差戻し（理由必須）',
    tier: 'bulk',
    action: 'src/app/enterprise/actions.ts#returnCdpResponseAction',
    origins: ['src/app/enterprise/disclosures/_components/return-response-dialog.tsx'],
    status: 'done',
    note: '「差戻し…」→ 理由必須の ConfirmDialog。理由は回答のコメントとして残す。状態の遷移と理由のコメントは 1 つの Action（returnCdpResponseAction → returnDisclosureResponse）で、理由を検証してから状態を変える（UI 再設計の検証 BIZ-2。以前は 2 つの Action を順に呼び、2 つ目が失敗すると理由が残らなかった）',
  },
  {
    id: 'F048',
    label: '前年度の評価を引き継ぐ（UI を新設）',
    tier: 'bulk',
    action: 'src/app/enterprise/actions.ts#carryOverSsbjAction',
    origins: ['src/app/enterprise/disclosures/ssbj/requirements/page.tsx'],
    status: 'done',
    note: 'SSBJ 要求事項の「その他」→「前年度の評価を引き継ぐ…」（kind: confirm・区分 2）',
  },
];
