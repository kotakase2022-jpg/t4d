import type { DangerousOp } from './types';

/**
 * トライアル対応（2026-10）のスライス T4 トライアル評価（評価者の判定〔不可逆〕 など）。
 * 危険な操作（不可逆・一括／上書き・可逆）を足したら、ここに登録する（tests/unit/dangerous-ops.test.ts が確認の有無を見る）。
 * 機能 ID は docs/ui-redesign/inventory-features.md §3.14 の F163〜F172（T4 の機能）
 */
export const T4_DANGEROUS_OPS: DangerousOp[] = [
  {
    id: 'F167',
    label: '評価者の判定を記録（追記専用・取り消せない）',
    tier: 'irreversible',
    action: 'src/app/enterprise/trial/actions.ts#judgeScenarioAction',
    // シナリオの行の「操作 ▾ > 判定を記録…」→ 確認ダイアログ（範囲 1 行・理由必須・取り消せない旨）
    origins: ['src/app/enterprise/trial/_components/scenarios-tab.tsx'],
    status: 'done',
  },
];
