import type { FlashRegistry } from './types';

/** 結果の通知の文言（データ・取込・資料・ホーム）。所有: Stage B1。flash.tsx から機械的に分けた（文言は変えていない） */
export const DATA_FLASH: FlashRegistry = {
  imported: () => '取込内容を確定し、非財務データへ反映しました。',
  carried: (params) => {
    const count = params.get('count');
    return count ? `前年度から ${count} 件を複製しました。` : '前年度から複製しました。';
  },
  disclosureDemoReset: (params) => {
    const removed = params.get('removed') ?? '0';
    const restored = params.get('restored') ?? '0';
    return (
      `開示デモのデータを初期状態に戻しました（デモ中に作成した行 ${removed} 件を削除・変更された行 ${restored} 件を復元）。` +
      '開示プロジェクト・原稿・レビュー・定性情報・スナップショット・出力記録・KPI 目標に加え、CSRD の設定・DMA・要求事項の評価・対応計画・開示ドラフト・CSRD の計画から作った収集項目と CSRD の AI 実行記録も戻しました。' +
      '資料・SSBJ の評価・Scope3 の算定などの他の領域には触れていません（数値データは選んだときだけ戻します）。'
    );
  },
  documentRegistered: (params) => {
    const extraction = params.get('extraction');
    const count = params.get('count') ?? '0';
    if (extraction === 'extracted')
      return `資料を登録しました（引用できる箇所を ${count} 件抽出）。`;
    if (extraction === 'needs_manual') {
      return '資料を登録しました。テキストは抽出できませんでした（抽出の成功としては扱っていません）。';
    }
    return '資料を登録しました。';
  },
  manualExcerptAdded: () =>
    '手動抜粋を登録しました。「手動の抜粋」として区別され、定性情報の根拠に引用できます。',
};
