import { SCAN_STATUS_LABELS, type ScanStatus } from '@/lib/domain/evidence-limits';
import type { StatusEntry } from './types';

/** 資料のウイルススキャンの状態。所有: Stage B1 */
export const scan: Record<ScanStatus, StatusEntry> = {
  pending: { label: SCAN_STATUS_LABELS.pending, semantic: 'todo' },
  clean: { label: SCAN_STATUS_LABELS.clean, semantic: 'done' },
  infected: { label: SCAN_STATUS_LABELS.infected, semantic: 'error' },
  skipped: { label: SCAN_STATUS_LABELS.skipped, semantic: 'excluded' },
};
