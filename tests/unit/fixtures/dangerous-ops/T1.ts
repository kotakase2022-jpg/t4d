import type { DangerousOp } from './types';

/**
 * トライアル対応（2026-10）のスライス T1 要求事項・判断・対応表（対象外の承認〔不可逆〕・差戻し など）。
 * 危険な操作（不可逆・一括／上書き・可逆）を足したら、ここに登録する（tests/unit/dangerous-ops.test.ts が確認の有無を見る）。
 * 機能 ID は docs/ui-redesign/inventory-features.md §3.14 の F145〜F156（T1 の機能）
 */
const SPECS =
  'src/app/enterprise/disclosure-projects/[projectId]/requirements/_components/exclusion-action-specs.tsx';
const ACTIONS = 'src/app/enterprise/disclosure-projects/[projectId]/requirements/actions.ts';

export const T1_DANGEROUS_OPS: DangerousOp[] = [
  {
    id: 'F147',
    label: '対象外・非重要の判断を承認（要求事項の詳細・要求事項タブの行・SSBJ 要求事項の詳細）',
    tier: 'irreversible',
    action: `${ACTIONS}#approveExclusionAction`,
    origins: [SPECS],
    status: 'done',
    note: '承認は追記専用で取り消せない。範囲＝基準・要求事項コード・理由の先頭 60 字を確認ダイアログに出す',
  },
  {
    id: 'F148',
    label: '対象外・非重要の申請を差し戻す（理由必須）',
    tier: 'bulk',
    action: `${ACTIONS}#returnExclusionAction`,
    origins: [SPECS],
    status: 'done',
  },
];
