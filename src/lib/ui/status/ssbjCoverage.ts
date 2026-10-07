import { COVERAGE_LABEL } from '@/lib/domain/ssbj';
import type { SsbjCoverageStatus } from '@/types/domain';
import type { StatusEntry } from './types';

/** SSBJ 要求事項の充足度。所有: Stage B2 */
export const ssbjCoverage: Record<SsbjCoverageStatus, StatusEntry> = {
  covered: { label: COVERAGE_LABEL.covered, semantic: 'done' },
  mostly_covered: { label: COVERAGE_LABEL.mostly_covered, semantic: 'in_review' },
  partial: { label: COVERAGE_LABEL.partial, semantic: 'blocked' },
  not_covered: { label: COVERAGE_LABEL.not_covered, semantic: 'error' },
  unconfirmed: { label: COVERAGE_LABEL.unconfirmed, semantic: 'todo' },
};
