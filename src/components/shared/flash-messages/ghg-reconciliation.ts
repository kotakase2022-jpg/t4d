import type { FlashRegistry } from './types';

/**
 * 結果の通知の文言（既存の算定結果との照合。所有: Scope1・2 の算定と照合のスライス S4）。
 * 語は「整合性の確認」「差異の原因」に揃える（plan K8）。原因の確定は人が行う（AI は関与しない）
 */
export const GHG_RECONCILIATION_FLASH: FlashRegistry = {
  ghgBaselineImported: (params) =>
    `既存の算定結果を取り込みました（${params.get('rows') ?? '0'} 行）。照合するときは許容差を入れてください（既定値はありません）。`,
  ghgReconciled: (params) =>
    `照合を記録しました（項目 ${params.get('items') ?? '0'} 件・許容差の外 ${params.get('outside') ?? '0'} 件）。差の原因は項目ごとに確かめて記録してください。`,
  ghgCauseRecorded: () =>
    '差異の原因を記録しました（あなたの名義で追記しました。前の記録は履歴に残ります）。',
};
