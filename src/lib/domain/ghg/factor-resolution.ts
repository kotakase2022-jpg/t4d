import type {
  EmissionBasis,
  EmissionFactor,
  EmissionFactorAssignment,
  EmissionFactorSet,
  FactorActivityKind,
} from '@/types/domain';

/**
 * 係数の解決（plan §2.2 factor-resolution.ts・CR-02）。純関数。
 *
 * 期間の割当から、拠点の割当 ＞ 国の割当 ＞ 全社既定の割当 の順に探す。**代わりを使わない**（plan K6）:
 *  - 見つからない（not_assigned）・同じ優先度に 2 つ以上（ambiguous）・係数のセットが有効でない（set_not_active）・
 *    係数の国が拠点の国と違う（country_mismatch）・係数の種類が割当と違う（unit_dimension）はエラー
 *  - 別の年度・別の基準・別の期間の割当で埋めない
 * 経路は文で返す（例「拠点の割当（タイ工場・電力・2025 年版）」）。算定行と画面に残す。
 */

export interface FactorNeed {
  reportingPeriodId: string;
  unitId: string;
  /** 経路の文に使う拠点名 */
  unitName: string;
  countryCode: string;
  activityKind: FactorActivityKind;
  activityCode: string;
  /** 経路の文に使う活動の名前（例「電力」） */
  activityLabel: string;
  basis: EmissionBasis | null;
}

export type ResolutionPath = 'unit' | 'country' | 'org_default';

export type ResolutionError =
  'not_assigned' | 'ambiguous' | 'set_not_active' | 'country_mismatch' | 'unit_dimension';

export interface FactorResolution {
  factor: EmissionFactor;
  set: EmissionFactorSet;
  assignmentId: string;
  path: ResolutionPath;
  description: string;
}

const PATH_LABELS: Record<ResolutionPath, string> = {
  unit: '拠点の割当',
  country: '国の割当',
  org_default: '全社既定の割当',
};

export function resolveFactor(
  need: FactorNeed,
  assignments: readonly EmissionFactorAssignment[],
  factors: readonly EmissionFactor[],
  sets: readonly EmissionFactorSet[],
): FactorResolution | { error: ResolutionError } {
  const candidates = assignments.filter(
    (a) =>
      a.reportingPeriodId === need.reportingPeriodId &&
      a.activityKind === need.activityKind &&
      a.activityCode === need.activityCode &&
      (a.basis ?? null) === (need.basis ?? null),
  );
  const levels: Array<[ResolutionPath, EmissionFactorAssignment[]]> = [
    ['unit', candidates.filter((a) => a.unitId === need.unitId)],
    ['country', candidates.filter((a) => a.unitId === null && a.countryCode === need.countryCode)],
    ['org_default', candidates.filter((a) => a.unitId === null && a.countryCode === null)],
  ];
  const level = levels.find(([, list]) => list.length > 0);
  if (!level) return { error: 'not_assigned' };
  const [path, list] = level;
  if (list.length > 1) return { error: 'ambiguous' };
  const assignment = list[0]!;
  const factor = factors.find((f) => f.id === assignment.factorId);
  if (!factor) return { error: 'not_assigned' };
  const set = factor.factorSetId ? sets.find((s) => s.id === factor.factorSetId) : undefined;
  if (!set || set.status !== 'active') return { error: 'set_not_active' };
  if (factor.activityKind !== need.activityKind) return { error: 'unit_dimension' };
  if (factor.countryCode !== null && factor.countryCode !== need.countryCode) {
    return { error: 'country_mismatch' };
  }
  const subject = path === 'unit' ? need.unitName : path === 'country' ? need.countryCode : null;
  const parts = [subject, need.activityLabel, set.versionLabel].filter(
    (p): p is string => typeof p === 'string' && p !== '',
  );
  return {
    factor,
    set,
    assignmentId: assignment.id,
    path,
    description: `${PATH_LABELS[path]}（${parts.join('・')}）`,
  };
}

/** 解決のエラーの文（画面・算定のエラーの一覧に出す） */
export const RESOLUTION_ERROR_LABELS: Record<ResolutionError, string> = {
  not_assigned: '係数が割り当てられていません',
  ambiguous: '同じ優先度に係数の割当が 2 つ以上あります',
  set_not_active: '割り当てた係数のセットが有効ではありません',
  country_mismatch: '割り当てた係数の国が拠点の国と違います',
  unit_dimension: '割り当てた係数の種類が活動量と合いません',
};
