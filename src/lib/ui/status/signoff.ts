import type { SignoffStage } from '@/types/domain';
import type { StatusEntry } from './types';

/**
 * Sign-off の段階（prepared → reviewed → partner_approved。代理禁止）。
 * 「Sign-off」は CLAUDE.md §8 の用語として残し、段階名は業務の言葉を併記する。所有: Stage B6
 */
export const signoff: Record<SignoffStage, StatusEntry> = {
  prepared: { label: 'Prepared（作成）', semantic: 'in_review' },
  reviewed: { label: 'Reviewed（レビュー）', semantic: 'in_review' },
  partner_approved: { label: 'Partner Approved（契約責任者承認）', semantic: 'done' },
};
