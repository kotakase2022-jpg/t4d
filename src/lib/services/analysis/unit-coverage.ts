import 'server-only';

import {
  consolidationFactor,
  hasUsableValue,
  isActualValue,
  isCountedInTotals,
  valueKindOf,
} from '@/lib/services/aggregation';
import type {
  DataPoint,
  DataPointStatus,
  MetricDefinition,
  OrganizationUnit,
} from '@/types/domain';

/**
 * 指標 × 年度の「対象の拠点のうち何拠点が承認済みか」（現状診断・他社比較が共有する）。
 *
 * 判定は kpi.ts の metricPeriodState と同じ規則にそろえる（ESG 経営の「確定（全拠点承認済み）」と
 * 分析の画面が食い違わないため）:
 *  - 対象の拠点 = サプライヤー以外・連結係数 > 0（持分法・連結対象外は分母に入れない）・
 *    本社のみの指標は本社だけ
 *  - 承認済みでも、推計・目標値・値の無い行は実績の拠点に数えない
 *  - 「内部取引」の明細行は数えない
 */

export interface UnitCoverage {
  /** 対象の拠点（分母） */
  expected: OrganizationUnit[];
  /** 実績が承認済みの拠点 */
  approvedUnits: string[];
  /** 対象外と判断済みの拠点（承認済み） */
  notApplicableUnits: string[];
  /** 提出済み・レビュー中（確認待ち） */
  reviewUnits: string[];
  /** 未着手・入力中・差戻し（未提出） */
  unsubmittedUnits: string[];
  /** 行が無い拠点（未入力） */
  missingUnits: string[];
  /** 承認済みだが実績が無い（推計・目標値だけ・値なし）拠点 */
  noActualUnits: string[];
  /** 対象の全拠点が承認済み（または対象外と判断済み） */
  complete: boolean;
  /**
   * 承認済みの実績の行の範囲（境界）。連結係数 > 0 の拠点の行だけ。複数あれば「・」でつなぐ。
   * 承認済みの実績が無ければ null（推測しない）
   */
  boundary: string | null;
}

const REVIEW_STATUSES: readonly DataPointStatus[] = ['submitted', 'in_review'];

/** 対象の拠点（分母） */
export function expectedUnitsFor(
  metric: Pick<MetricDefinition, 'hqOnly'>,
  units: readonly OrganizationUnit[],
): OrganizationUnit[] {
  return units.filter(
    (u) =>
      u.unitType !== 'supplier' &&
      u.deletedAt === null &&
      consolidationFactor(u) > 0 &&
      (!metric.hqOnly || u.unitType === 'headquarters'),
  );
}

/**
 * @param rows その指標・その年度の Data Point（削除済みを除く）
 */
export function unitCoverageOf(
  metric: Pick<MetricDefinition, 'hqOnly'>,
  units: readonly OrganizationUnit[],
  rows: readonly DataPoint[],
): UnitCoverage {
  const expected = expectedUnitsFor(metric, units);
  const counted = rows.filter(isCountedInTotals);
  const coverage: UnitCoverage = {
    expected,
    approvedUnits: [],
    notApplicableUnits: [],
    reviewUnits: [],
    unsubmittedUnits: [],
    missingUnits: [],
    noActualUnits: [],
    complete: false,
    boundary: null,
  };
  for (const unit of expected) {
    const unitRows = counted.filter((d) => d.unitId === unit.id);
    if (unitRows.length === 0) {
      coverage.missingUnits.push(unit.name);
      continue;
    }
    const notApproved = unitRows.filter((d) => d.status !== 'approved');
    if (notApproved.length > 0) {
      // 1 拠点に提出前の行が 1 件でもあれば、その拠点は未提出として扱う（確認待ちより先に直す必要がある）
      if (notApproved.every((d) => REVIEW_STATUSES.includes(d.status))) {
        coverage.reviewUnits.push(unit.name);
      } else {
        coverage.unsubmittedUnits.push(unit.name);
      }
      continue;
    }
    if (unitRows.every((d) => d.availabilityStatus === 'not_applicable')) {
      coverage.notApplicableUnits.push(unit.name);
      continue;
    }
    const valueRows = unitRows.filter(
      (d) => d.availabilityStatus !== 'not_applicable' && valueKindOf(d) !== 'target',
    );
    if (valueRows.length > 0 && valueRows.every(isActualValue)) {
      coverage.approvedUnits.push(unit.name);
    } else {
      coverage.noActualUnits.push(unit.name);
    }
  }
  coverage.complete =
    expected.length > 0 &&
    coverage.approvedUnits.length + coverage.notApplicableUnits.length === expected.length;

  const factorById = new Map(units.map((u) => [u.id, consolidationFactor(u)]));
  const boundaries = [
    ...new Set(
      counted
        .filter(
          (d) =>
            d.status === 'approved' &&
            hasUsableValue(d) &&
            valueKindOf(d) === 'actual' &&
            (factorById.get(d.unitId) ?? 0) > 0,
        )
        .map((d) => d.boundary.trim()),
    ),
  ].sort();
  coverage.boundary = boundaries.length === 0 ? null : boundaries.join('・');
  return coverage;
}
