import type { FlashRegistry } from './types';

/** 結果の通知の文言（CSRD）。所有: Stage B3。flash.tsx から機械的に分けた（文言は変えていない） */
export const CSRD_FLASH: FlashRegistry = {
  // CSRD（docs/disclosure-first.md §9.4）。DMA に関わる保存は確定を外すため、その旨を必ず伝える
  csrdBoundarySaved: () =>
    '報告範囲を保存しました。ダブル・マテリアリティ評価（DMA）を確定していた場合は、確定を取り消しました。',
  csrdMethodSaved: () =>
    '評価方法・閾値・ステークホルダー関与を保存しました（自社の評価方法・デモ既定）。DMA を確定していた場合は、確定を取り消しました。',
  csrdIroSaved: () =>
    'IRO を保存しました。算定結果は提案で、重要性は人が判断します。DMA を確定していた場合は、確定を取り消しました。',
  csrdIroDeleted: () =>
    'IRO を削除しました（論理削除。履歴は残ります）。DMA を確定していた場合は、確定を取り消しました。',
  csrdMatterDecided: () =>
    'サステナビリティ事項の判断を保存しました（判断者と日時を記録しました）。DMA を確定していた場合は、確定を取り消しました。重要と判断した観点が変わった事項は、その節の本文の確定も取り消しました。',
  // 両軸を「未評価」に戻したときは判断者・日時を消す（「記録しました」と言わない）
  csrdMatterCleared: () =>
    'サステナビリティ事項の判断を未評価に戻しました（判断者と日時は消去しました）。DMA を確定していた場合は、確定を取り消しました。',
  csrdDmaConfirmed: () =>
    'ダブル・マテリアリティ評価（DMA）を確定しました。要求事項の適用から「暫定」が外れました。',
  csrdAssessmentSaved: () => '要求事項の 3 観点を保存し、担当者の入力として確定しました。',
  // 実行した提供元（ai=mock|openai）で文言を分ける。Mock の出力だけを「デモ生成」と呼ぶ
  csrdGapAnalyzed: (params) =>
    `AI ギャップ分析を実行しました（${params.get('ai') === 'openai' ? 'AI 生成' : 'デモ生成'}）。結果は候補です。「候補を採用」か「修正して確定」で担当者が確定してください。`,
  csrdReviewSaved: (params) =>
    params.get('decision') === 'modified'
      ? '担当者が修正して確定しました（修正の理由を記録しました）。'
      : 'AI の候補を採用して確定しました（確認者と日時を記録しました）。',
  csrdPlanCreated: () => '対応計画を追加しました（未着手）。',
  csrdPlanUpdated: () => '対応計画を更新しました。',
  // 計画の状況が変わったか（plan=in_progress|unchanged）で、計画についての一文を分ける
  csrdCollectionCreated: (params) => {
    const code = params.get('code');
    return (
      `データ収集項目を作成しました${code ? `（${code}）` : ''}。` +
      (params.get('plan') === 'in_progress'
        ? '対応計画は「対応中」になりました。'
        : '対応計画に結び付けました（対応状況は変えていません）。')
    );
  },
  // 同じ指標 × 拠点 × 期間の割当が既にあった（担当者・期限は既存のまま）
  csrdCollectionLinked: (params) => {
    const code = params.get('code');
    return (
      `同じ拠点・期間の収集項目${code ? `（${code}）` : ''}が既にあったため、新しくは作らず対応計画に結び付けました。担当者・期限は既存の割当のままで、入力した値は使っていません。` +
      (params.get('plan') === 'in_progress' ? '対応計画は「対応中」になりました。' : '')
    );
  },
  csrdDraftGenerated: (params) =>
    `AI 草案を作成しました（${params.get('ai') === 'openai' ? 'AI 生成' : 'デモ生成'}）。本文には入っていません。「本文に採用」してから編集・確定してください。`,
  csrdDraftAdopted: () =>
    'AI 草案を本文に採用しました。内容を確認・編集して保存し、確定してください（確定はしていません）。',
  csrdDraftSaved: () => '本文を保存しました。確定していた場合は、確定を取り消しました。',
  csrdDraftConfirmed: () => '本文を確定しました（確定者と日時を記録しました）。',
};
