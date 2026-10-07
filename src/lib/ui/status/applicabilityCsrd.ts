import { CSRD_APPLICABILITY_KIND_LABEL } from '@/lib/domain/csrd';
import type { CsrdApplicabilityKind } from '@/types/domain';
import type { StatusEntry } from './types';

/** CSRD 要求事項の適用。所有: Stage B3 */
export const applicabilityCsrd: Record<CsrdApplicabilityKind, StatusEntry> = {
  always: { label: CSRD_APPLICABILITY_KIND_LABEL.always, semantic: 'done' },
  material: { label: CSRD_APPLICABILITY_KIND_LABEL.material, semantic: 'done' },
  not_material: { label: CSRD_APPLICABILITY_KIND_LABEL.not_material, semantic: 'excluded' },
  undetermined: { label: CSRD_APPLICABILITY_KIND_LABEL.undetermined, semantic: 'todo' },
};
