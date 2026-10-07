import type { MetricDefinition, OrganizationUnit, ReportingPeriod } from '@/types/domain';

/**
 * 組織・拠点の一覧と指標マスターの検索・絞り込み・並べ替え（plan §1.12: サーバー側で行う）と、
 * 収集キャンペーンの既定値（S10・D1・D3）。React に依存しない純関数。
 */

export interface UnitRow {
  unit: OrganizationUnit;
  depth: number;
}

/** 階層の順（親の直後に子。兄弟は渡された順）に並べ、深さを持たせる */
export function orderedUnits(units: readonly OrganizationUnit[]): UnitRow[] {
  const ids = new Set(units.map((u) => u.id));
  const byParent = new Map<string | null, OrganizationUnit[]>();
  for (const unit of units) {
    // 親が一覧に無い（削除済みなど）拠点は最上位として並べる（行を落とさない）
    const key = unit.parentId && ids.has(unit.parentId) ? unit.parentId : null;
    byParent.set(key, [...(byParent.get(key) ?? []), unit]);
  }
  const out: UnitRow[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null, depth: number) => {
    for (const unit of byParent.get(parentId) ?? []) {
      if (seen.has(unit.id)) continue;
      seen.add(unit.id);
      out.push({ unit, depth });
      walk(unit.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function includesText(haystack: readonly string[], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return haystack.some((text) => text.toLowerCase().includes(q));
}

export interface UnitFilters {
  q?: string;
  type?: readonly string[];
  consolidation?: readonly string[];
}

export function filterUnits(rows: readonly UnitRow[], filters: UnitFilters): UnitRow[] {
  return rows.filter(({ unit }) => {
    if (filters.q && !includesText([unit.name, unit.code], filters.q)) return false;
    if (filters.type && filters.type.length > 0 && !filters.type.includes(unit.unitType)) {
      return false;
    }
    if (
      filters.consolidation &&
      filters.consolidation.length > 0 &&
      !filters.consolidation.includes(unit.consolidationMethod)
    ) {
      return false;
    }
    return true;
  });
}

/** 基準の絞り込みの「自社独自」（基準が求めていない指標） */
export const OWN_METRIC_FRAMEWORK = 'own';

export interface MetricFilters {
  q?: string;
  category?: readonly string[];
  framework?: readonly string[];
}

export function filterMetrics(
  metrics: readonly MetricDefinition[],
  filters: MetricFilters,
): MetricDefinition[] {
  return metrics.filter((metric) => {
    if (filters.q && !includesText([metric.code, metric.name], filters.q)) return false;
    if (
      filters.category &&
      filters.category.length > 0 &&
      !filters.category.includes(metric.category)
    ) {
      return false;
    }
    if (filters.framework && filters.framework.length > 0) {
      const keys = metric.frameworks.length === 0 ? [OWN_METRIC_FRAMEWORK] : metric.frameworks;
      if (!keys.some((key) => filters.framework!.includes(key))) return false;
    }
    return true;
  });
}

const METRIC_SORT_VALUE: Record<string, (m: MetricDefinition) => string | null> = {
  code: (m) => m.code,
  name: (m) => m.name,
  category: (m) => m.category,
  unit: (m) => m.unit,
  department: (m) => m.responsibleDepartment,
};

export const METRIC_SORT_KEYS = Object.keys(METRIC_SORT_VALUE);

/** 並べ替え（空の値は向きに関わらず最後）。知らない列は元の順 */
export function sortMetrics(
  metrics: readonly MetricDefinition[],
  sort: string | undefined,
  dir: string | undefined,
): MetricDefinition[] {
  const valueOf = sort ? METRIC_SORT_VALUE[sort] : undefined;
  if (!valueOf) return [...metrics];
  const sign = dir === 'desc' ? -1 : 1;
  return [...metrics].sort((a, b) => {
    const va = valueOf(a);
    const vb = valueOf(b);
    if (va === null || va === '') return vb === null || vb === '' ? 0 : 1;
    if (vb === null || vb === '') return -1;
    return va.localeCompare(vb, 'ja') * sign;
  });
}

export interface CampaignDefaults {
  name: string;
  reportingPeriodId: string;
  dueDate: string;
  unitIds: string[];
  metricIds: string[];
}

/**
 * 収集キャンペーンの既定値（S10）: 期間＝ヘッダーの期間（D1）、期限＝期間の提出期限（D3）、
 * 拠点＝連結対象（連結対象外・サプライヤーを除く）、指標＝前回のキャンペーンの指標
 * （前回が無ければ選ばない。全部を選ぶと、意図しない大量の収集スコープを作るため）
 */
export function campaignDefaults(input: {
  currentPeriod: ReportingPeriod;
  units: readonly OrganizationUnit[];
  metrics: readonly MetricDefinition[];
  lastCampaignMetricIds: readonly string[];
}): CampaignDefaults {
  const metricIds = new Set(input.metrics.map((m) => m.id));
  return {
    name: `${input.currentPeriod.code} 収集キャンペーン`,
    reportingPeriodId: input.currentPeriod.id,
    dueDate: input.currentPeriod.submissionDueDate ?? '',
    unitIds: input.units
      .filter((u) => u.unitType !== 'supplier' && u.consolidationMethod !== 'excluded')
      .map((u) => u.id),
    metricIds: input.lastCampaignMetricIds.filter((id) => metricIds.has(id)),
  };
}
