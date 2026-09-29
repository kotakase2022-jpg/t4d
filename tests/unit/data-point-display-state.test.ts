import { describe, expect, it } from 'vitest';
import {
  deriveDataPointDisplayStatus,
  isApprovedNeedingRecheck,
} from '@/lib/validation/display-state';
import type { DataPointValidationResult } from '@/types/domain';

/**
 * 「承認済み・要再確認」の表示状態（W0 棚卸し O3、指示書 §2.3）。
 *
 * 承認後に証跡不足が見つかった行を、承認済みのまま見せない。DB の状態は変えず、
 * 表示だけを派生させる（承認の記録を消さない）。
 */

const validation = (
  patch: Partial<Pick<DataPointValidationResult, 'dataPointId' | 'ruleKey' | 'resolvedAt'>>,
) => ({
  dataPointId: 'dp-1',
  ruleKey: 'missing_evidence' as DataPointValidationResult['ruleKey'],
  resolvedAt: null as string | null,
  ...patch,
});

describe('deriveDataPointDisplayStatus', () => {
  it('承認済み＋未解消の証跡不足 → 承認済み・要再確認', () => {
    expect(deriveDataPointDisplayStatus({ id: 'dp-1', status: 'approved' }, [validation({})])).toBe(
      'approved_needs_recheck',
    );
    expect(isApprovedNeedingRecheck({ id: 'dp-1', status: 'approved' }, [validation({})])).toBe(
      true,
    );
  });

  it('解消済みの証跡不足・他の行の証跡不足・他のルールでは要再確認にしない', () => {
    const approved = { id: 'dp-1', status: 'approved' as const };
    expect(deriveDataPointDisplayStatus(approved, [validation({ resolvedAt: '2026-08-01' })])).toBe(
      'approved',
    );
    expect(deriveDataPointDisplayStatus(approved, [validation({ dataPointId: 'dp-2' })])).toBe(
      'approved',
    );
    expect(deriveDataPointDisplayStatus(approved, [validation({ ruleKey: 'yoy_deviation' })])).toBe(
      'approved',
    );
  });

  it('承認前の行は証跡不足があっても元の状態のまま（承認の門は data-point-workflow が持つ）', () => {
    for (const status of ['draft', 'submitted', 'in_review', 'returned'] as const) {
      expect(deriveDataPointDisplayStatus({ id: 'dp-1', status }, [validation({})])).toBe(status);
    }
  });
});
