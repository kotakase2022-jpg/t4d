import type { FlashRegistry } from './types';

/**
 * 結果の通知の文言（Scope1・2 の算定の実行・Data Point への下書き反映。所有: 2026-10-16 の要望のスライス S3）
 */
export const GHG_CALCULATION_FLASH: FlashRegistry = {
  ghgRunCreated: (params) =>
    `算定を実行し、算定の記録を作りました（算定行 ${params.get('lines') ?? '0'} 行）。Data Point へはまだ反映していません。`,
  ghgRunPosted: (params) =>
    `Data Point に下書きの版を反映しました（新規 ${params.get('created') ?? '0'} 件・新しい版 ${params.get('updated') ?? '0'} 件・承認済みの上書き ${params.get('approved') ?? '0'} 件・変更なし ${params.get('unchanged') ?? '0'} 件・反映しない ${params.get('skipped') ?? '0'} 件）。承認はしていません。確定は承認フローで行います。`,
};
