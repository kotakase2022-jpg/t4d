import type { FlashRegistry } from './types';

/**
 * 結果の通知の文言（トライアル対応の管理・権限・データ取扱: 承認ルート・メンバー・データ取扱条件）。
 * 所有: トライアル対応のスライス T5。氏名・メールは URL に載せないので文言にも入れない
 */
export const ADMIN_FLASH: FlashRegistry = {
  approvalRouteSaved: (params) => {
    const stages = Number(params.get('stages') ?? '0');
    return `承認ルートを保存しました${stages > 0 ? `（${stages} 段階）` : ''}。進行中のデータは今の経路のまま進み、新しい提出から使います。`;
  },
  membershipUpdated: () =>
    'メンバーの役割・担当拠点を変更しました。次の操作から新しい範囲で動きます（監査ログに記録しました）。',
  membershipSuspended: () =>
    'メンバーの利用を停止しました。この人はこの組織のワークスペースに入れなくなります（記録は消えません）。',
  membershipResumed: () => 'メンバーの利用を再開しました。',
  dataTermsRecorded: (params) => {
    const version = Number(params.get('version') ?? '0');
    return `データ取扱条件${version > 0 ? `の第 ${version} 版` : ''}を記録しました。前の版は履歴に残ります。`;
  },
};
