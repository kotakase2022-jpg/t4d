import type { FlashRegistry } from './types';

/** 結果の通知の文言（トライアルの評価。所有: トライアル対応 T4） */
export const TRIAL_FLASH: FlashRegistry = {
  trialPlanCreated: () => 'トライアルの計画を作成しました。選定ケースと利用枠を確かめてください。',
  trialPlanSaved: () => 'トライアルの計画を保存しました。実績は記録から毎回数え直します。',
  trialCasesSaved: (params) =>
    `選定ケースを保存しました（要求事項 ${params.get('count') ?? '0'} 件・指標 ${params.get('metrics') ?? '0'} 件）。追跡率と評価の分母に使います。`,
  trialDecisionSaved: () =>
    '合意・終了時の扱い・導入判断を保存しました（人が入力した判断です。AI は関与していません）。',
  trialRunRecorded: (params) =>
    `シナリオ ${params.get('code') ?? ''} の実施を記録しました（あなたの名義・環境の版を添えました）。`,
  trialJudged: (params) =>
    `シナリオ ${params.get('code') ?? ''} の判定を記録しました。判定は追記で残り、取り消せません。`,
  trialFeedbackRecorded: () => '改善管理表に論点を登録しました。',
  trialFeedbackTriaged: () => '改善管理表の対応を更新しました（履歴は監査ログに残ります）。',
  trialReverified: (params) =>
    params.get('result') === 'pass'
      ? '再検証の結果（解消を確認）を記録し、「再検証済み」にしました。'
      : '再検証の結果（解消せず）を記録し、「対応中」に戻しました。',
  trialTimingRecorded: () =>
    '作業時間を記録しました。現行と T4D の両方が 3 件以上になると短縮率を出します。',
};
