import { QUANTITATIVE_IMPORT_STATUS_LABELS } from '@/lib/domain/disclosure-status';
import type { QuantitativeImportStatus } from '@/types/domain';
import type { StatusEntry } from './types';

/** 標準 CSV の取込の状態。所有: Stage B1 */
export const quantitativeImport: Record<QuantitativeImportStatus, StatusEntry> = {
  validated: { label: QUANTITATIVE_IMPORT_STATUS_LABELS.validated, semantic: 'pending' },
  committed: { label: QUANTITATIVE_IMPORT_STATUS_LABELS.committed, semantic: 'done' },
  rejected: { label: QUANTITATIVE_IMPORT_STATUS_LABELS.rejected, semantic: 'excluded' },
};
