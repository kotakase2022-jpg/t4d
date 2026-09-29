import type { DataPoint, DataPointStatus, DataPointValidationResult } from '@/types/domain';

/**
 * Data Point の「表示上の状態」（W0 O3）。
 *
 * 承認済みの行に、承認後に証跡不足（missing_evidence）が見つかった場合は
 * 「承認済み・要再確認」と表示する。DB の status は承認済みのまま変えない
 * （承認の記録を消すと、いつ誰が承認したかが追えなくなる。再確認は人が行う）。
 *
 * 新規の承認は data-point-workflow が証跡の有無で止めている。ここで扱うのは
 * 承認より後に生じた不足（指標の証跡必須化・証跡の紐付け解除など）の見せ方だけ。
 */

export type DataPointDisplayStatus = DataPointStatus | 'approved_needs_recheck';

/** 承認済みの行を「要再確認」にする検証ルール */
export const RECHECK_RULE_KEYS = ['missing_evidence'] as const;

type ValidationLike = Pick<DataPointValidationResult, 'dataPointId' | 'ruleKey' | 'resolvedAt'>;

/** 承認済みだが、未解消の証跡不足がある（＝要再確認）か */
export function isApprovedNeedingRecheck(
  dataPoint: Pick<DataPoint, 'id' | 'status'>,
  validations: ValidationLike[],
): boolean {
  if (dataPoint.status !== 'approved') return false;
  return validations.some(
    (v) =>
      v.dataPointId === dataPoint.id &&
      v.resolvedAt === null &&
      (RECHECK_RULE_KEYS as readonly string[]).includes(v.ruleKey),
  );
}

export function deriveDataPointDisplayStatus(
  dataPoint: Pick<DataPoint, 'id' | 'status'>,
  validations: ValidationLike[],
): DataPointDisplayStatus {
  return isApprovedNeedingRecheck(dataPoint, validations)
    ? 'approved_needs_recheck'
    : dataPoint.status;
}
