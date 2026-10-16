import type { FactorSetOrigin } from '@/types/domain';
import type { StatusEntry } from './types';

/**
 * 係数のセットの出所。「架空」の表示は fixture のときだけ（組織指定の係数を「架空」と書かない。plan K13）
 */
export const factorOrigin: Record<FactorSetOrigin, StatusEntry> = {
  customer_specified: { label: '組織指定', semantic: 'info' },
  public_reference: {
    label: '公的参照',
    semantic: 'info',
    description: '公的資料の値を収録したものです。組織が採用を決めたときだけ使います。',
  },
  fixture: {
    label: '架空（デモ）',
    semantic: 'blocked',
    description: '架空値です（実係数ではありません）。',
  },
};
