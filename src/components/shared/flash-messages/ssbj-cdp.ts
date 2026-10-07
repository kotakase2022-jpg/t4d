import type { FlashRegistry } from './types';

/** 結果の通知の文言（SSBJ・CDP）。所有: Stage B2。flash.tsx から機械的に分けた（文言は変えていない） */
export const SSBJ_CDP_FLASH: FlashRegistry = {
  ssbjCarriedOver: (params) => {
    const copied = params.get('copied') ?? '0';
    const recheck = params.get('recheck') ?? '0';
    if (copied === '0') {
      return '引き継げる前年度の評価はありませんでした（今年度に確定済みの判定は上書きしません）。';
    }
    return (
      `前年度の評価を ${copied} 件引き継ぎました。` +
      (recheck !== '0'
        ? ` うち ${recheck} 件は再評価が必要です（基準の改正・前年度に未対応・重要性が未判定。理由は各要求事項に表示）。`
        : ' 担当者の確認で今年度の判定として確定してください。')
    );
  },
  bulkAnalyzed: (params) => {
    const analyzed = params.get('analyzed') ?? '0';
    const remaining = params.get('remaining') ?? '0';
    return (
      `${analyzed} 件を人工知能で分析しました。判定は候補です。担当者の確認で最終判定を入れてください。` +
      (remaining !== '0' ? ` 未分析が残り ${remaining} 件あります（もう一度実行できます）。` : '')
    );
  },
  secReport: (params) => {
    const file = params.get('file') ?? '有価証券報告書';
    const checked = params.get('checked') ?? '';
    const equity = params.get('equity');
    return (
      `「${file}」を読み込み、報告対象へ ${checked} を自動選択しました。` +
      (equity
        ? ` ${equity} は本文にありますが持分法適用のため自動選択していません（含める場合は手動でチェックしてください）。`
        : '')
    );
  },
};
