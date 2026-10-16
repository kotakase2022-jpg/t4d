import type { FlashRegistry } from './types';

/**
 * 結果の通知の文言（Scope1・2 の算定の排出係数・割当・算定方針・区分規則。所有: 2026-10-16 の要望のスライス S1）。
 * 文言は URL の引数（件数・コード）から作る。
 */
export const GHG_FACTORS_RULES_FLASH: FlashRegistry = {
  ghgFactorSetImported: (params) =>
    `係数のセットを下書きとして取り込みました（係数 ${params.get('count') ?? '0'} 件）。内容を確かめてから有効にしてください。`,
  ghgFactorSetActivated: () =>
    '係数のセットを有効にしました。係数は変更できません。「割当」で期間・拠点・国に割り当ててください。',
  ghgFactorSetRetired: () =>
    '係数のセットを取り下げました。このセットの係数を使う割当は算定でエラーになります（割当を別の係数に替えてください）。',
  ghgAssignmentSaved: (params) =>
    `係数を割り当てました（${params.get('target') ?? ''}・${params.get('activity') ?? ''}）。算定の入力が変わったため、算定の記録は「入力が変わった」になります。`,
  ghgAssignmentCleared: () => '割当を外しました。',
  ghgPolicySaved: (params) =>
    `算定方針の版 ${params.get('version') ?? ''} を保存しました（前の版は残ります）。`,
  ghgRuleProposed: (params) =>
    `区分規則「${params.get('code') ?? ''}」を提案しました（承認待ち）。承認されるまで、算定は既定区分のままです。`,
  ghgRuleApproved: (params) =>
    `区分規則「${params.get('code') ?? ''}」を承認しました。次の算定から報告区分が変わります（既定区分の値も並べて表示します）。`,
  ghgRuleWithdrawn: (params) => `区分規則「${params.get('code') ?? ''}」を取り下げました。`,
};
