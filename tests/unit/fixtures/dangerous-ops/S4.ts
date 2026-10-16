import type { DangerousOp } from './types';

/**
 * Scope1・2 の算定と照合（2026-10-16 の要望）のスライス S4 既存結果との照合・差異原因（既存の算定結果の確定 など）。
 * 危険な操作（不可逆・一括／上書き・可逆）を足したら、ここに登録する（tests/unit/dangerous-ops.test.ts が確認の有無を見る）。
 * 機能 ID は docs/ui-redesign/inventory-features.md §3.15 の F218〜F221（S4 の機能）のうち危険な操作。
 *
 * 表に載せないもの（追記で残り、取り消す操作が要らない・上書きしない）:
 *  - 照合する（reconcileAction）: 照合の記録を 1 つ追記するだけ。前の照合はそのまま残る
 *  - 差異の原因を記録する（recordCauseAction）: 確認の記録を追記する。前の記録は差し替え済みとして残る
 *  - 照合の結果の XLSX（GET の API）・仮説の再計算（GET。保存しない）
 */
export const S4_DANGEROUS_OPS: DangerousOp[] = [
  {
    id: 'F219',
    label: '既存の算定結果の取込を確定する（追記。取り込んだ後は変更できない）',
    tier: 'bulk',
    action:
      'src/app/enterprise/ghg/calculation/reconciliation/actions.ts#confirmBaselineImportAction',
    origins: [
      'src/app/enterprise/ghg/calculation/reconciliation/_components/baseline-import-form.tsx',
    ],
    status: 'done',
    note: '照合の画面の「既存の算定結果を取り込む」→ 検証 →「確定する…」→ 確認ダイアログ（区分 2: 行数・粒度・拠点の対応付けの内訳）',
  },
];
