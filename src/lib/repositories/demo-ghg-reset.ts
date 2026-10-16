import type { TableName } from './types';

/**
 * 「開示デモを初期状態に戻す」で戻す Scope1・2 の算定と照合の表（plan §2.7 GHG_DEMO_RESET_TABLES）。
 * demo-reset-sync.ts の DISCLOSURE_DEMO_RESET_TABLES に合成する（別インスタンスへの反映も同じ一覧）。
 * 係数（emissionFactors）は利用者が取り込んだセットの係数を消すために含める。算定行は持ち回さないが、
 * メモリの行を組織の範囲で Fixture の値へ戻す。
 * demo-ghg-checks.ts（Fixture・純関数を読み込む）とは分け、リセットの一覧だけを置く
 */
export const GHG_DEMO_RESET_TABLES = [
  'emissionFactorSets',
  'emissionFactors',
  'emissionFactorAssignments',
  'ghgCalculationPolicies',
  'ghgClassificationRules',
  'ghgActivityBatches',
  'ghgActivityLines',
  'ghgCalculationRuns',
  'ghgCalculationLines',
  'ghgBaselineResults',
  'ghgReconciliations',
  'ghgReconciliationNotes',
] as const satisfies readonly TableName[];
