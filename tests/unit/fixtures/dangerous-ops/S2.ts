import type { DangerousOp } from './types';

/**
 * Scope1・2 の算定と照合（2026-10-16 の要望）のスライス S2 活動量・改良トンキロ法（活動量の確定・破棄）。
 * 危険な操作（不可逆・一括／上書き・可逆）を足したら、ここに登録する（tests/unit/dangerous-ops.test.ts が確認の有無を見る）。
 * 機能 ID は docs/ui-redesign/inventory-features.md §3.15 の F212〜F215（S2 の機能）のうち危険な操作。
 *
 * 表に載せないもの:
 *  - 取込の検証（previewActivityImportAction）: 書き込み 0
 *  - 取込（importActivityFileAction）: 確認中のバッチを作るだけで算定に使わない（確定は下の F214 で確認を通す）
 */
export const S2_DANGEROUS_OPS: DangerousOp[] = [
  {
    id: 'F214',
    label: '活動量の確定（確認中 → 確定。差し替えなら元のバッチを差し替え済みに）',
    tier: 'bulk',
    action: 'src/app/enterprise/ghg/calculation/activity/actions.ts#confirmActivityBatchAction',
    origins: ['src/app/enterprise/ghg/calculation/activity/[batchId]/page.tsx'],
    status: 'done',
    note: 'P95 見出しの「確定する」→ 確認ダイアログ（範囲＝拠点・種類・行数・ファイル、内訳＝試算できない行・見なし積載率・下限・範囲外・海外、差し替える元のバッチ）',
  },
  {
    id: 'F215',
    label: '活動量の取込の破棄（確認中 → 破棄。取り消せない）',
    tier: 'irreversible',
    action: 'src/app/enterprise/ghg/calculation/activity/actions.ts#discardActivityBatchAction',
    origins: ['src/app/enterprise/ghg/calculation/activity/[batchId]/page.tsx'],
    status: 'done',
    note: 'P95 見出しの「その他 ▾ > 破棄する」→ 確認ダイアログ（範囲＝拠点・種類・行数・ファイル）',
  },
];
