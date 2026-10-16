import {
  FACTOR_SET_ORIGINS,
  type AggregationRule,
  type EmissionFactor,
  type EmissionFactorSet,
  type FactorSetOrigin,
  type MetricDefinition,
} from '@/types/domain';

/**
 * GHG 算定サマリーの表示の誠実さ（plan §2.4・CR-16・GE-15）。純関数。
 *
 *  - 連結集計に並べる指標は、指標マスターと集計ルールから決める（コードに固定しない）
 *  - 「内部取引控除は FYxxxx から」の文は、推移の各年度の控除の有無から導く（固定の年度を書かない）
 *  - 係数の「架空値」の印は、係数の出所（係数セットの origin、セットに属さない係数は出典の Fixture の印）で
 *    出し分ける（組織指定の係数を「架空」と書かない。plan K13）
 */

/**
 * 連結集計に並べる GHG の指標コード（指標マスターの順＝コード順）:
 *  - GHG の合計する数値の指標のうち、拠点で集める指標（本社だけで集める指標は拠点の連結にしない）
 *  - それ以外でも、集計ルール（連結の設定）を持つ指標
 */
export function consolidationMetricCodes(
  metrics: ReadonlyArray<
    Pick<MetricDefinition, 'id' | 'code' | 'category' | 'aggregationMethod' | 'dataType' | 'hqOnly'>
  >,
  rules: ReadonlyArray<Pick<AggregationRule, 'metricId'>>,
): string[] {
  const withRule = new Set(rules.map((r) => r.metricId));
  const ghg = metrics.filter(
    (m) => m.category === 'ghg' && m.aggregationMethod === 'sum' && m.dataType === 'number',
  );
  const sorted = [...ghg].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return [
    ...sorted.filter((m) => !m.hqOnly).map((m) => m.code),
    ...sorted.filter((m) => m.hqOnly && withRule.has(m.id)).map((m) => m.code),
  ];
}

/** 推移の年度ごとの内部取引控除の有無から、読み方の 1 行を作る（控除がどの年度にも無ければ null） */
export function intercompanyTrendNote(
  trend: ReadonlyArray<{
    period: { code: string };
    metrics: ReadonlyArray<{ intercompanyEliminated: number }>;
  }>,
): string | null {
  if (trend.length === 0) return null;
  const flags = trend.map((entry) => entry.metrics.some((m) => m.intercompanyEliminated > 0));
  if (!flags.some(Boolean)) return null;
  const codes = trend.map((entry) => entry.period.code);
  if (flags.every(Boolean)) {
    return `内部取引控除は表示した全年度（${codes.join('・')}）に適用しています。`;
  }
  const first = flags.indexOf(true);
  const fromFirst = flags.every((flag, index) => flag === index >= first);
  if (fromFirst) return `内部取引控除は ${codes[first]} から適用（過年度は控除前の値）。`;
  const applied = codes.filter((_, index) => flags[index]);
  const notApplied = codes.filter((_, index) => !flags[index]);
  return `内部取引控除は ${applied.join('・')} に適用（${notApplied.join('・')} は控除前の値）。`;
}

/** 出所の区分（セットに属さず、出典にも Fixture の印が無い係数は「区分なし」） */
export type FactorOriginKey = FactorSetOrigin | 'unclassified';

/** Fixture の係数の出典の印（src/lib/fixtures/store.ts の「FIXTURE（架空値・実係数ではありません）」） */
function isFixtureSource(source: string): boolean {
  return /^FIXTURE/i.test(source.normalize('NFKC').trim());
}

/** 係数の出所ごとの件数（0 件の区分も持つ） */
export function factorOriginCounts(
  factors: ReadonlyArray<Pick<EmissionFactor, 'factorSetId' | 'factorSource'>>,
  sets: ReadonlyArray<Pick<EmissionFactorSet, 'id' | 'origin'>>,
): Record<FactorOriginKey, number> {
  const counts = Object.fromEntries(
    [...FACTOR_SET_ORIGINS, 'unclassified'].map((key) => [key, 0]),
  ) as Record<FactorOriginKey, number>;
  const originOf = new Map(sets.map((s) => [s.id, s.origin]));
  for (const factor of factors) {
    const origin = factor.factorSetId ? originOf.get(factor.factorSetId) : undefined;
    if (origin) counts[origin] += 1;
    else counts[isFixtureSource(factor.factorSource) ? 'fixture' : 'unclassified'] += 1;
  }
  return counts;
}
