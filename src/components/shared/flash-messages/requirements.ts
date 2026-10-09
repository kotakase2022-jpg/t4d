import type { FlashRegistry } from './types';

/**
 * 結果の通知の文言（トライアル対応 T1: 要求事項の判断・対象外の申請と承認・節の対応付け・横断対応の AI 候補）。
 * 所有: T1。AI の候補は「候補」と明示し、承認は社内の記録であることを書く
 */
export const REQUIREMENTS_FLASH: FlashRegistry = {
  requirementAssessed: () =>
    '要求事項の判断を記録しました（履歴に前後の値を残しました）。区分は保存した判断から導き直しています。',
  requirementAssessedExclusion: () =>
    '要求事項の判断を記録しました。対象外・非重要の区分か理由が変わったため、対象外として申請し、別の人の承認を受けるまでは「未判定」として数えます。',
  requirementAssessmentUnchanged: () => '変更された項目が無いため、判断の記録は増やしていません。',
  exclusionRequested: () =>
    '対象外・非重要として申請しました。別の人（承認者）が承認するまでは「未判定」として分母に残します。',
  exclusionApproved: () =>
    '対象外・非重要の判断を承認しました（社内の記録。取り消せません）。理由を変えると承認し直しになります。',
  exclusionReturned: () => '対象外・非重要の申請を差し戻しました（理由を記録しました）。',
  exclusionWithdrawn: () => '対象外・非重要の申請を取り下げました。',
  blockRequirementsSaved: () =>
    '節の要求事項の対応付けを保存しました（前後と理由を監査ログに残しました）。承認済みの版・スナップショットは変わりません。',
  blockRequirementsUnchanged: () => '対応付けに変更が無いため、保存していません。',
  mappingCandidatesReady: (params) =>
    params.get('ai') === 'mock'
      ? 'AI の候補を作りました（デモ生成（Mock）の候補です）。採用するまで対応付けは変わりません。'
      : 'AI の候補を作りました。採用するまで対応付けは変わりません。',
  mappingCandidatesAdopted: () =>
    '選んだ候補を節の対応付けに足しました（AI の候補の採否を記録しました）。',
  mappingCandidatesRejected: () =>
    'AI の候補を採用しないと記録しました。対応付けは変わっていません。',
  crosswalkCandidatesReady: (params) =>
    params.get('ai') === 'mock'
      ? '横断の対応の候補を作りました（デモ生成（Mock）の候補・表示のみ）。横断対応表には書いていません。'
      : '横断の対応の候補を作りました（表示のみ）。横断対応表には書いていません。',
  crosswalkCandidatesRejected: () =>
    '横断の対応の候補を採用しないと記録しました。横断対応表は変わっていません。',
};
