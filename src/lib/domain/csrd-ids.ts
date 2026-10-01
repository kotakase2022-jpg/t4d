import { fid } from '@/lib/fixtures/ids';
import type { CsrdSection, EsrsTopic, Uuid } from '@/types/domain';

/**
 * CSRD の行 ID（docs/disclosure-first.md §9.3）。組織・期間・コードから決定的に作る。
 *
 * Fixture とサービスが同じ式を使う。行が無い期間は既定値の「仮想行」として読み、最初の保存で
 * この ID の行を作る（別インスタンスで同じ操作をしても同じ行になり、Cookie の持ち回りで重複しない）。
 */
export const csrdRowIds = {
  settings: (organizationId: Uuid, reportingPeriodId: Uuid): Uuid =>
    fid('csrd_analysis_settings', `${organizationId}/${reportingPeriodId}`),
  matter: (organizationId: Uuid, reportingPeriodId: Uuid, topic: EsrsTopic): Uuid =>
    fid('csrd_dma_matter', `${organizationId}/${reportingPeriodId}/${topic}`),
  assessment: (organizationId: Uuid, reportingPeriodId: Uuid, itemCode: string): Uuid =>
    fid('csrd_assessment', `${organizationId}/${reportingPeriodId}/${itemCode}`),
  draft: (organizationId: Uuid, reportingPeriodId: Uuid, section: CsrdSection): Uuid =>
    fid('csrd_disclosure_draft', `${organizationId}/${reportingPeriodId}/${section}`),
} as const;
