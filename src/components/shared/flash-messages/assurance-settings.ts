import type { FlashRegistry } from './types';

/** 結果の通知の文言（設定・監査法人）。所有: Stage B6。flash.tsx から機械的に分けた（文言は変えていない） */
export const ASSURANCE_SETTINGS_FLASH: FlashRegistry = {
  disclosureFirstChanged: (params) =>
    params.get('state') === 'on'
      ? '開示優先モードを有効にしました。左メニューとホームが開示業務の構成に切り替わりました（既存の画面の URL はそのまま使えます）。'
      : '開示優先モードを無効にしました。従来の左メニューとホームに戻りました。',
  grantRevoked: () =>
    '監査法人へのアクセス許諾を取り消しました。監査法人の Data Room からこの対象が見えなくなります。',
  grantRestored: () =>
    '監査法人へのアクセス許諾を再付与しました。監査法人の Data Room に再び表示されます。',
};
