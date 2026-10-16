import type { FlashRegistry } from './types';

/** 結果の通知の文言（Scope1・2 の算定の活動量の取込。所有: 2026-10-16 の要望のスライス S2） */
export const GHG_ACTIVITY_FLASH: FlashRegistry = {
  ghgActivityImported: (params) =>
    `活動量を取り込みました（${params.get('rows') ?? '0'} 行・確認中）。行と試算を確かめてから「確定する」を押すと、次の算定から使います。`,
  ghgActivityConfirmed: (params) =>
    params.get('superseded') === '1'
      ? `活動量を確定しました（${params.get('rows') ?? '0'} 行）。差し替えた元のバッチは算定に使いません。算定の概要で「算定を実行」すると結果に反映されます。`
      : `活動量を確定しました（${params.get('rows') ?? '0'} 行）。算定の概要で「算定を実行」すると結果に反映されます。`,
  ghgActivityDiscarded: () =>
    '活動量の取込を破棄しました。行は記録として残り、算定には使いません。',
};
