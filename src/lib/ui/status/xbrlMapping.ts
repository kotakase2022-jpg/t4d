import { XBRL_MAPPING_STATUSES, type XbrlMappingStatus } from '@/types/domain';
import type { StatusEntry } from './types';

/** XBRL の対応付けの状態（トライアル対応 NF-42）。対応付けの行が無い対象は未対応付け */
export const XBRL_MAPPING_STATES = ['unmapped', ...XBRL_MAPPING_STATUSES] as const;
export type XbrlMappingState = 'unmapped' | XbrlMappingStatus;

export const xbrlMapping: Record<XbrlMappingState, StatusEntry> = {
  unmapped: { label: '未対応付け', semantic: 'todo' },
  candidate: {
    label: '候補',
    semantic: 'draft',
    description: '確定は開示の承認権限を持つ、対応付けを作った人と別の人が行います。',
  },
  confirmed: { label: '確定', semantic: 'done' },
  excluded: { label: '対象外', semantic: 'excluded' },
};
