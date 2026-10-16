import type { DangerousOp } from './types';

/**
 * Scope1・2 の算定と照合（2026-10-16 の要望）のスライス S3 算定の実行・結果（Data Point への下書き反映 など）。
 * 危険な操作（不可逆・一括／上書き・可逆）を足したら、ここに登録する（tests/unit/dangerous-ops.test.ts が確認の有無を見る）。
 * 機能 ID は docs/ui-redesign/inventory-features.md §3.15 の F216〜F217（S3 の機能）のうち危険な操作。
 *
 * 表に載せないもの（追記で残り、既存の値・Data Point を変えない）:
 *  - 算定を実行する（runGhgCalculationAction）: 算定の記録と算定行を追記するだけ。前の記録はそのまま残る
 *  - 算定明細 CSV（GET の API。E18）
 */
export const S3_DANGEROUS_OPS: DangerousOp[] = [
  {
    id: 'F217',
    label:
      '算定の記録の報告区分の値を Data Point に下書きとして反映する（一括・承認済みの上書きを含む）',
    tier: 'bulk',
    action: 'src/app/enterprise/ghg/calculation/runs/actions.ts#postGhgRunToDataPointsAction',
    origins: ['src/app/enterprise/ghg/calculation/runs/[runId]/page.tsx'],
    status: 'done',
    note: '算定明細の見出しの「Data Point に下書き反映」→ 確認ダイアログ（区分 2: 新規・新しい版・承認済みの上書き・変更なし・反映しないの件数。承認済みの上書きがあれば必須の確認）',
  },
];
