import type { SamplingMethod } from '@/types/domain';
import type { StatusEntry } from './types';

/** サンプリングの方法（画面では random などの生の enum が出ていた。plan §1.17）。所有: Stage B6 */
export const samplingMethod: Record<SamplingMethod, StatusEntry> = {
  random: { label: '無作為抽出', semantic: 'info' },
  stratified: { label: '層化抽出（組織別）', semantic: 'info' },
  key_item: { label: '重要項目抽出（金額基準）', semantic: 'info' },
  judgmental: { label: '判断による抽出', semantic: 'info' },
};
