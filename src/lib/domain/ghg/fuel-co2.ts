/**
 * 燃料使用量から CO2（plan §2.2 fuel-co2.ts）。純関数。
 *
 * 2 段係数: t-CO2 = kL × 単位発熱量（GJ/kL）× 炭素排出係数（tC/GJ）× 44/12。
 * 44/12（炭素から CO2 への質量比）だけがコードの定数で、単位発熱量・炭素排出係数は係数セットの行（年度付き）。
 * 1 段係数（t-CO2/kL など）は活動量 × 係数。どちらも数でない値は例外にする（黙って 0 にしない）。
 */

/** 炭素 1 t あたりの CO2（t）。分子量の比（44/12） */
export const CO2_PER_C = 44 / 12;

export interface TwoStageInput {
  /** 燃料使用量（kL。単位発熱量の分母に揃えた量） */
  amountKl: number;
  /** 単位発熱量（GJ/kL） */
  calorific: number;
  /** 炭素排出係数（tC/GJ） */
  carbon: number;
}

export interface DirectInput {
  /** 活動量（係数の分母の単位に揃えた量） */
  amount: number;
  /** 1 段係数（t-CO2 / 活動量の単位） */
  directFactor: number;
}

export interface FuelCo2Result {
  /** t-CO2 */
  tco2: number;
  /** 熱量（GJ）。1 段係数のときは null */
  gj: number | null;
  /** 炭素量（tC）。1 段係数のときは null */
  tc: number | null;
}

function assertNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label}が数ではありません。`);
}

export function fuelToCo2(input: TwoStageInput | DirectInput): FuelCo2Result {
  if ('directFactor' in input) {
    assertNumber(input.amount, '活動量');
    assertNumber(input.directFactor, '排出係数');
    return { tco2: input.amount * input.directFactor, gj: null, tc: null };
  }
  assertNumber(input.amountKl, '燃料使用量');
  assertNumber(input.calorific, '単位発熱量');
  assertNumber(input.carbon, '炭素排出係数');
  const gj = input.amountKl * input.calorific;
  const tc = gj * input.carbon;
  return { tco2: tc * CO2_PER_C, gj, tc };
}
