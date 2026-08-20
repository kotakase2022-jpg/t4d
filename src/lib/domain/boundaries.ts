import type { DataPoint, OrganizationUnit } from '@/types/domain';

/**
 * 報告境界（boundary）の扱い。
 *
 * 「内部取引」boundary の行はグループ内取引由来の二重計上分の**明細**であり、
 * 通常の合計・共有・母集団には入れず、連結集計でだけ控除額として使う。
 *
 * server-only を付けない純粋モジュールにしてあるのは、Fixture 生成（Node CLI の
 * seed:generate）とサーバー側サービスの両方が同じ判定を使うため。
 */

export const INTERCOMPANY_BOUNDARY = '内部取引';

/** 通常の画面合計・保証への共有に含めてよい行か（内部取引の明細行は除外する）。 */
export function isCountedInTotals(dp: Pick<DataPoint, 'boundary'>): boolean {
  return dp.boundary !== INTERCOMPANY_BOUNDARY;
}

/** 組織タグ「連結対象のみ」で使う仮想の値。実際の Unit ID と衝突しない固定文字列。 */
export const CONSOLIDATED_UNIT_TAG = 'consolidated';

/**
 * 連結財務諸表の対象に含まれる組織か。
 *
 * 全部連結（full）と比例連結（proportionate）を対象とし、
 * 持分法適用（equity）と対象外（excluded）は含めない。
 * 集計係数（`consolidationFactor`）が 0 になる組織＝連結値に足さない組織、
 * という考え方と揃えてある。
 */
export function isConsolidatedUnit(unit: Pick<OrganizationUnit, 'consolidationMethod'>): boolean {
  return unit.consolidationMethod === 'full' || unit.consolidationMethod === 'proportionate';
}

/**
 * 「該当なし」を明示するための番兵 ID。
 * 絞り込みの交差が空になったとき、空配列を渡すと「未指定」と区別できず
 * 条件が外れてしまうため、実在しない ID を 1 件だけ渡して 0 件にする。
 */
export const NO_MATCH_UNIT_ID = '__no_match__';
