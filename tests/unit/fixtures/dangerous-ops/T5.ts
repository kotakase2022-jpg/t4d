import type { DangerousOp } from './types';

/**
 * トライアル対応（2026-10）のスライス T5 管理・権限・ログ・データ取扱・運用（役割・担当拠点の変更・利用停止・承認ルートの保存・全データの返却 など）。
 * 危険な操作（不可逆・一括／上書き・可逆）を足したら、ここに登録する（tests/unit/dangerous-ops.test.ts が確認の有無を見る）。
 * 機能 ID は docs/ui-redesign/inventory-features.md §3.14 の F173〜F176（T5 の機能）。
 *
 * 表に載せないもの（Server Action ではないため、このテストの対象外）:
 *  - 全データの書き出し（返却用）: GET の API（/api/exports/tenant）。確認は TenantExportDialog（ConfirmDialog の区分 2）
 *  - データ取扱条件の版の記録: 追記するだけで、前の版は残る（取り消す操作が要らない）
 */
export const T5_DANGEROUS_OPS: DangerousOp[] = [
  {
    id: 'F173',
    label: '承認ルートの保存（これからの提出の経路が変わる）',
    tier: 'bulk',
    action: 'src/app/enterprise/settings/actions.ts#saveApprovalRouteAction',
    origins: ['src/app/enterprise/settings/_tabs/approval.tsx'],
    status: 'done',
    note: '設定「承認ルート」の編集の欄の「保存…」→ 確認ダイアログ（進行中のデータは写しを持つため経路は変わらない旨）',
  },
  {
    id: 'F174',
    label: 'メンバーの役割・担当拠点の変更',
    tier: 'irreversible',
    action: 'src/app/enterprise/settings/actions.ts#updateMembershipAction',
    origins: ['src/app/enterprise/settings/_tabs/member-panels.tsx'],
    status: 'done',
    note: '設定「メンバー」の行の「操作 ▾ > 役割・担当拠点を変更…」→ 欄の「変更を保存…」→ 確認ダイアログ（範囲＝氏名）',
  },
  {
    id: 'F175',
    label: 'メンバーの利用の停止（元に戻す＝再開）',
    tier: 'reversible',
    action: 'src/app/enterprise/settings/actions.ts#setMembershipStatusAction',
    origins: ['src/app/enterprise/settings/page.tsx'],
    status: 'done',
    note: '設定「メンバー」の行の「操作 ▾ > 利用を停止…」→ 確認ダイアログ（範囲＝氏名とメール）。結果の通知に「元に戻す」（再開）',
  },
];
