import { emptyAssumptionValues, type AssumptionValues } from '@/lib/domain/financial-impact';

/**
 * 財務影響分析のデモ用の既定の仮定と財務ベースライン（docs/disclosure-first.md §10.3）。
 * **すべて架空**で、実在企業の数値ではない。
 *
 * - 静的なデータで、DB の表も organization_id も持たない（どのテナントにも属さない）。
 *   Demo Mode のときだけ使う。Supabase モードでは既定値もベースラインも持たず、
 *   「財務データ・単価の前提が登録されていません」と示して入力を待つ
 * - 画面ではすべて「仮定・デモ既定」と表示する。価格水準は法定でないため、炭素価格も仮定
 * - 他テナントの値を使わない（テナントのデータからベースラインを作らない）
 */

export type AssumptionSource = 'demo' | 'none';

/** デモの既定の仮定（P7〜P9 の入力は空 = 未定量） */
export const DEMO_ASSUMPTION_DEFAULTS: AssumptionValues = {
  ...emptyAssumptionValues(),
  carbonPriceStart: 1_000,
  carbonPriceStep: 500,
  fuelShare: 100,
  passThroughFuel: 100,
  passThroughPower: 50,
  passThroughSupplier: 0,
  energyPrice: 25_000,
  waterPrice: 300,
  wastePrice: 50_000,
  refillShare: 60,
  hiringCost: 1_000_000,
  hiringCostGrowth: 3,
  abatementCost: 50_000,
  discountRate: 5,
};

export interface DemoFinancialBaseline {
  /** 売上高（円/年、架空） */
  revenue: number;
  /** 営業利益（円/年、架空）。営業利益比の参考表示だけに使う */
  operatingProfit: number;
}

/** 架空の財務ベースライン（売上高 600 億円・営業利益 50 億円）。営業利益比の参考表示だけ */
export const DEMO_FINANCIAL_BASELINE: DemoFinancialBaseline = {
  revenue: 60_000_000_000,
  operatingProfit: 5_000_000_000,
};

/** 既定の仮定（デモは既定値あり、Supabase モードは時間差だけ） */
export function assumptionDefaultsFor(source: AssumptionSource): AssumptionValues {
  return source === 'demo' ? { ...DEMO_ASSUMPTION_DEFAULTS } : emptyAssumptionValues();
}

/** 財務ベースライン（デモだけ。Supabase モードは無い） */
export function financialBaselineFor(source: AssumptionSource): DemoFinancialBaseline | null {
  return source === 'demo' ? DEMO_FINANCIAL_BASELINE : null;
}
