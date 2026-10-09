import type { DangerousOp } from './types';

/**
 * トライアル対応（2026-10）のスライス T6 XBRL（対応付けの確定・対象外・削除）。
 * 危険な操作（不可逆・一括／上書き・可逆）を足したら、ここに登録する（tests/unit/dangerous-ops.test.ts が確認の有無を見る）。
 * 機能 ID は docs/ui-redesign/inventory-features.md §3.14 の F177〜F184（T6 の機能）
 */
const ACTIONS = 'src/app/enterprise/disclosure-projects/[projectId]/xbrl/actions.ts';
const TAB = 'src/app/enterprise/disclosure-projects/[projectId]/_tabs/xbrl.tsx';
const BULK_BAR =
  'src/app/enterprise/disclosure-projects/[projectId]/xbrl/_components/confirm-bulk-bar.tsx';

export const T6_DANGEROUS_OPS: DangerousOp[] = [
  {
    id: 'F178',
    label: 'XBRL の対応付けの確定（行・一括）',
    tier: 'bulk',
    action: `${ACTIONS}#confirmXbrlMappingsAction`,
    origins: [TAB, BULK_BAR],
    status: 'done',
    note: '件数・状態の内訳と、確定した行だけが事実になること・職務分離を確認ダイアログに出す',
  },
  {
    id: 'F179',
    label: 'XBRL の対応付けを対象外にする',
    tier: 'bulk',
    action: `${ACTIONS}#excludeXbrlMappingAction`,
    origins: [TAB],
    status: 'done',
    note: '理由必須（確定が外れる上書き）',
  },
  {
    id: 'F181',
    label: 'XBRL の対応付けの削除',
    tier: 'irreversible',
    action: `${ACTIONS}#deleteXbrlMappingAction`,
    origins: [TAB],
    status: 'done',
    note: '論理削除（画面から戻せない）。履歴は追記専用の記録に残る',
  },
];
