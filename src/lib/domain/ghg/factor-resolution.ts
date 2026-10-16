import type {
  EmissionBasis,
  EmissionFactor,
  EmissionFactorAssignment,
  EmissionFactorSet,
  FactorActivityKind,
  GhgActivityLine,
} from '@/types/domain';

/**
 * 係数の解決（plan §2.2 factor-resolution.ts・CR-02）。純関数。
 *
 * 期間の割当から、拠点の割当 ＞ 国の割当 ＞ 全社既定の割当 の順に探す。**代わりを使わない**（plan K6）:
 *  - 見つからない（not_assigned）・同じ優先度に 2 つ以上（ambiguous）・係数のセットが有効でない（set_not_active）・
 *    係数の国が拠点の国と違う（country_mismatch）・係数の種類が割当と違う（unit_dimension）・係数の活動か基準が
 *    活動量と違う（activity_mismatch。例: 軽油の割当が揮発油の係数を指す）はエラー。割当の保存（サービス）だけでなく
 *    解決でも確かめる（DB のトリガ・Demo の Cookie の戻しを通った行でも、合わない係数を黙って使わない）
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
  | 'not_assigned'
  | 'ambiguous'
  | 'set_not_active'
  | 'country_mismatch'
  | 'unit_dimension'
  | 'activity_mismatch';

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

/**
 * 基準（ロケーション・マーケット）を持つ活動の種類。購入した電力と熱（蒸気・温水を含む）は GHG プロトコルの
 * Scope2 の 2 基準で別々に算定する（片方の基準にだけ入れると、2 基準の Scope2 が違うエネルギーを数えてしまう）
 */
export function kindHasBasis(kind: FactorActivityKind): boolean {
  return kind === 'electricity' || kind === 'heat';
}

export interface LineFactorNeed {
  kind: FactorActivityKind;
  code: string;
  basis: EmissionBasis | null;
}

/**
 * 活動量の 1 行に要る係数の組（算定のエンジンが係数を解決する組。割当の一覧・概要の要対応の件数・入力ハッシュが
 * 同じ関数を使う）。電力はロケーション基準（系統 grid）とマーケット基準（契約のコード。無ければ grid）、
 * 熱はロケーション基準とマーケット基準（どちらも活動のコード）。輸送は t·km があれば改良トンキロ法の原単位と燃料、
 * 無ければ燃料法の燃料
 */
export function factorNeedsOfLine(
  line: Pick<
    GhgActivityLine,
    | 'activityKind'
    | 'activityCode'
    | 'contractCode'
    | 'fuelCode'
    | 'tonKm'
    | 'cargoWeightT'
    | 'distanceKm'
    | 'loadFactorPct'
  >,
): LineFactorNeed[] {
  switch (line.activityKind) {
    case 'electricity':
      return [
        { kind: 'electricity', code: 'grid', basis: 'location' },
        { kind: 'electricity', code: line.contractCode ?? 'grid', basis: 'market' },
      ];
    case 'heat':
      return [
        { kind: 'heat', code: line.activityCode, basis: 'location' },
        { kind: 'heat', code: line.activityCode, basis: 'market' },
      ];
    case 'transport': {
      const fuel = line.fuelCode ?? line.activityCode;
      const tonKm = line.tonKm !== null || (line.cargoWeightT !== null && line.distanceKm !== null);
      if (!tonKm) return [{ kind: 'fuel', code: fuel, basis: null }];
      return [
        {
          kind: line.loadFactorPct === null ? 'transport_default' : 'transport_formula',
          code: fuel,
          basis: null,
        },
        { kind: 'fuel', code: fuel, basis: null },
      ];
    }
    default:
      return [{ kind: line.activityKind, code: line.activityCode, basis: null }];
  }
}

/**
 * 係数がこの組（種類・活動・基準）に使えるか。電力のマーケット基準は契約の係数か組織の代替値（grid）。
 * 割当の保存・解決・Demo の Cookie の戻しが同じ規則を使う（DB のトリガ 0066 も同じ）
 */
export function factorFits(
  factor: Pick<EmissionFactor, 'activityKind' | 'activityCode' | 'basis'>,
  kind: FactorActivityKind,
  code: string,
  basis: EmissionBasis | null,
): boolean {
  if (factor.activityKind !== kind) return false;
  if ((factor.basis ?? null) !== (basis ?? null)) return false;
  if (kind === 'electricity' && basis === 'market') {
    return factor.activityCode === code || factor.activityCode === 'grid';
  }
  return factor.activityCode === code;
}

/**
 * 解決で選ばれる段の割当（拠点 ＞ 国 ＞ 全社既定のうち、候補がある最初の段の全部）。無ければ null。
 * 同じ段に 2 つ以上あれば解決は ambiguous（エラー）。入力ハッシュは、この段の割当だけを含める
 * （より低い段の割当・算定する拠点の国に関係しない国の割当は、結果を変えないため含めない）
 */
export function assignmentsAtResolvedLevel(
  need: Pick<
    FactorNeed,
    'reportingPeriodId' | 'unitId' | 'countryCode' | 'activityKind' | 'activityCode' | 'basis'
  >,
  assignments: readonly EmissionFactorAssignment[],
): { path: ResolutionPath; list: EmissionFactorAssignment[] } | null {
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
  return level ? { path: level[0], list: level[1] } : null;
}

export function resolveFactor(
  need: FactorNeed,
  assignments: readonly EmissionFactorAssignment[],
  factors: readonly EmissionFactor[],
  sets: readonly EmissionFactorSet[],
): FactorResolution | { error: ResolutionError } {
  const level = assignmentsAtResolvedLevel(need, assignments);
  if (!level) return { error: 'not_assigned' };
  const { path, list } = level;
  if (list.length > 1) return { error: 'ambiguous' };
  const assignment = list[0]!;
  const factor = factors.find((f) => f.id === assignment.factorId);
  if (!factor) return { error: 'not_assigned' };
  const set = factor.factorSetId ? sets.find((s) => s.id === factor.factorSetId) : undefined;
  if (!set || set.status !== 'active') return { error: 'set_not_active' };
  if (factor.activityKind !== need.activityKind) return { error: 'unit_dimension' };
  if (!factorFits(factor, need.activityKind, need.activityCode, need.basis)) {
    return { error: 'activity_mismatch' };
  }
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
  activity_mismatch: '割り当てた係数の活動か基準が活動量と合いません',
};
