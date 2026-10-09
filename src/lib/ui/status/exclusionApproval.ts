import type { ExclusionState } from '@/lib/domain/requirement-coverage';
import type { StatusEntry } from './types';

/** 対象外・非重要の承認の状態（トライアル対応 NF-02）。所有: Stage A（表示は T1） */
export const exclusionApproval: Record<ExclusionState, StatusEntry> = {
  not_requested: { label: '未申請', semantic: 'todo' },
  requested: { label: '申請中', semantic: 'pending' },
  approved: { label: '承認済み', semantic: 'done' },
  returned: { label: '差戻し', semantic: 'returned' },
  reapproval_required: {
    label: '再承認が必要',
    semantic: 'blocked',
    description: '承認の後に区分・理由が変わったため、承認し直しが必要です。',
  },
};
