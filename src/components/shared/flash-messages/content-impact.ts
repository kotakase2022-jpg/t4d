import type { FlashRegistry } from './types';

/**
 * 結果の通知の文言（トライアル対応 T8: 本文・インパクト・基準版）。所有: スライス T8。
 * 定性情報と要求事項の直接の対応付け・AI の候補の採否・ドラフトの原稿への取り込み・SSBJ の基準の版の切り替え
 */
export const CONTENT_IMPACT_FLASH: FlashRegistry = {
  narrativeLinkAdded: () =>
    '要求事項を定性情報に対応付けました。基準別の対応状況に反映しました（原稿の節が無い要求事項は「原稿なし」の不足として出ます）。',
  narrativeLinkRemoved: () =>
    '要求事項との直接の対応付けを外しました（外した記録は監査ログに残ります）。',
  narrativeLinksAdopted: () =>
    'AI の候補から選んだ要求事項を対応付けました（採用は人の操作として記録しました）。',
  narrativeLinksRejected: () =>
    'AI の候補を採用しませんでした。理由を書いた場合は、改善の検討に使います。',
  draftImported: (params) =>
    `ドラフトの確定本文を原稿の節の新しい版（下書き）として取り込みました${
      params.get('ai') && params.get('ai') !== '0'
        ? `（AI の草案に由来する段落 ${params.get('ai')} 件を含む）`
        : ''
    }。レビュー・承認は原稿で行います。`,
  ssbjVersionPinned: () =>
    'この年度の SSBJ の基準の版を切り替えました。評価対象の要求事項が変わるため、分析条件の確定を取り消しました。内容を確認して確定し直してください。',
};
