import { DMA_OUTCOME_LABEL } from '@/lib/domain/csrd';
import type { DmaOutcome } from '@/types/domain';
import type { StatusEntry } from './types';

/** ダブル・マテリアリティの評価結果。所有: Stage B3 */
export const dmaOutcome: Record<DmaOutcome, StatusEntry> = {
  both: { label: DMA_OUTCOME_LABEL.both, semantic: 'done' },
  impact_only: { label: DMA_OUTCOME_LABEL.impact_only, semantic: 'done' },
  financial_only: { label: DMA_OUTCOME_LABEL.financial_only, semantic: 'done' },
  not_material: { label: DMA_OUTCOME_LABEL.not_material, semantic: 'excluded' },
  not_assessed: { label: DMA_OUTCOME_LABEL.not_assessed, semantic: 'todo' },
};
