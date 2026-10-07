import type { FlashRegistry } from './types';

/** 結果の通知の文言（開示プロジェクト・原稿・定性情報）。所有: Stage B4。flash.tsx から機械的に分けた（文言は変えていない） */
export const PROJECTS_FLASH: FlashRegistry = {
  // 開示プロジェクト・定性情報・資料（S-c）
  projectCreated: () =>
    '開示プロジェクトを作成しました（準備を開始）。適用判断は「設定」タブで確定します。未確定のままでも下書きの準備はできます。',
  projectUpdated: (params) => {
    const impacted = Number(params.get('impacted') ?? '0');
    return impacted > 0
      ? `プロジェクトを更新しました。影響する原稿 ${impacted} 節の本文・承認は自動では書き換えていません。必要に応じて見直してください。`
      : 'プロジェクトを更新しました。';
  },
  frameworkSaved: () =>
    '適用条件を保存しました（保存して準備を始める）。適用判断はまだ確定していません。',
  applicabilityConfirmed: (params) =>
    `適用判断を確定しました（判断 ${params.get('no') ?? ''}）。理由・参照規則・確認日・判断者を記録しました。`,
  frameworkVersionAttached: () =>
    '新しい版をプロジェクトに追加しました。旧版の原稿・判断はそのまま残っています。新しい版の適用判断を確定してください。',
  narrativeCreated: () =>
    '定性情報を登録しました（下書き）。内容を確かめて、人が確認してください。',
  narrativeSaved: (params) =>
    `定性情報を版 ${params.get('v') ?? ''} として保存しました（未確認）。引用している原稿の本文は書き換わっていません。`,
  narrativeConfirmed: () => '定性情報を確認済みにしました（確認者と日時を記録しました）。',
  narrativeCarried: () =>
    '前年の版から新しい年度の下書きを作りました。前年の確認と資料の引用は引き継いでいません。当年度の根拠を付けてください。',
  narrativeCandidate: (params) => {
    const warnings = Number(params.get('warnings') ?? '0');
    return (
      '資料の抜粋から候補（下書き）を作りました。テンプレート項目は人が記入してください。' +
      (warnings > 0
        ? ' 当年度の根拠ではない資料の抜粋が含まれています（本文に明示しました）。'
        : '')
    );
  },
  // 原稿編集・レビュー・再確認（S-d）
  blockCreated: () => '節を追加しました（下書き）。本文を書いて「版として保存」してください。',
  blockVersionSaved: (params) =>
    `本文を版 ${params.get('version') ?? ''} として保存しました。以前の版は履歴に残っています。`,
  // 通知できたかはサーバーが notified=1/0 で返す（担当が未定なら誰にも通知していない）
  reviewRequested: (params) =>
    params.get('notified') === '0'
      ? 'レビューを依頼しました。依頼した版・規則・引用した版を固定しました（レビュー担当が未設定のため、通知はしていません）。'
      : 'レビューを依頼しました。依頼した版・規則・引用した版を固定し、レビュー担当へ通知しました。',
  reviewReturned: () => '差し戻しました（理由と対象の段落を記録しました）。',
  reviewCompleted: (params) =>
    params.get('notified') === '0'
      ? 'レビューを完了しました（最終承認者が未設定のため、通知はしていません）。'
      : 'レビューを完了しました。最終承認者へ通知しました。',
  reviewApproved: () =>
    '最終承認しました（社内承認の記録。第三者保証ではありません）。承認した版は以後も変わりません。',
  reviewWithdrawn: () => 'レビュー依頼を取り下げました。節は下書きに戻り、編集できます。',
  recheckDecided: (params) => {
    const decision = params.get('decision');
    if (decision === 'keep_old') return '引用中の版を維持すると記録しました（理由付き）。';
    if (decision === 'return_to_owner')
      return '担当者へ差し戻しました（通知済み）。再確認は未了のままです。';
    return '新しい版を採用した次の版を作りました。承認済みの版はそのまま残っています。再レビューしてください。';
  },
};
