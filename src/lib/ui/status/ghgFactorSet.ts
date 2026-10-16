import type { FactorSetStatus } from '@/types/domain';
import type { StatusEntry } from './types';

/** 排出係数のセットの状態（0061。有効にした後は係数を変えない） */
export const ghgFactorSet: Record<FactorSetStatus, StatusEntry> = {
  draft: { label: '下書き', semantic: 'draft' },
  active: {
    label: '有効',
    semantic: 'done',
    description: '有効にした係数のセットは変更できません（新しいセットを作ります）。',
  },
  retired: { label: '取り下げ', semantic: 'excluded' },
};
