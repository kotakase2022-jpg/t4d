import { roundSignificant } from './rounding';
import type {
  TransportDefaultParams,
  TransportDefaultRow,
  TransportFormulaClass,
  TransportFormulaParams,
} from './tonkm';
import type { FuelEconomyClass, VehicleUse } from '@/types/domain';

/**
 * 改良トンキロ法の公的参照プリセット（plan CR-19・K5・D3）。純関数とデータだけ。
 *
 * 公的資料で値を確かめられたものだけを収録する（確認日 2026-10-16）:
 *  - 告示 4(1) の 7 式の係数 A・B と積載率の指数 S（平成18年経済産業省告示第66号。令和4年改正までを反映した版）
 *  - 燃費区分ごとに式を当てる最大積載量の組み合わせ（共同ガイドライン Ver.3.2 表 II-21）
 *  - 旧来の対数式の定数（同 p.57。告示式との差を「算定方法」の原因として説明するための比較用）
 *  - 見なし積載率に基づく原単位（告示 別表第3。区分の中央値・見なし積載率は同ガイドライン 表 II-23）
 *  - 燃料の単位発熱量・炭素排出係数（温対法の算定省令。適用する実績の年度ごとに 2 版）
 *
 * **既定では適用しない**。算定は係数セットの行と組織の算定方針だけを使う（このモジュールを算定から
 * import しない）。組織が採用を決めたときだけ、係数セットへ取り込む（固定文 N10）。
 * 公的資料で扱いを確かめられなかったもの（積載率 100% 超・式の範囲外・海外拠点・原単位の丸め）は
 * ここに置かず、組織の算定方針のパラメータにする（plan K5）。
 */

/** プリセットを確かめた日（固定文 N10 と同じ日付） */
export const TONKM_PRESET_CONFIRMED_ON = '2026-10-16';

export interface PresetSource {
  key: 'kokuji' | 'guideline' | 'shk_r5' | 'shk_h21';
  label: string;
  edition: string;
  url: string;
}

/** 出典（画面に出す名前・版・URL） */
export const TONKM_PRESET_SOURCES: Readonly<Record<PresetSource['key'], PresetSource>> = {
  kokuji: {
    key: 'kokuji',
    label:
      '貨物輸送事業者に行わせる貨物の輸送に係るエネルギーの使用量の算定の方法（平成18年経済産業省告示第66号）',
    edition: '令和4年3月31日 経済産業省告示第84号までの改正を反映した版',
    url: 'https://www.mlit.go.jp/sogoseisaku/environment/content/001611371.pdf',
  },
  guideline: {
    key: 'guideline',
    label:
      'ロジスティクス分野におけるCO2排出量算定方法 共同ガイドライン Ver.3.2（経済産業省・国土交通省）',
    edition: '令和5年6月',
    url: 'https://www.mlit.go.jp/seisakutokatsu/freight/content/001717859.pdf',
  },
  shk_r5: {
    key: 'shk_r5',
    label: '算定方法及び排出係数一覧（R5年度実績以降の排出量算定用。環境省）',
    edition: '令和5年12月12日更新',
    url: 'https://policies.env.go.jp/earth/ghg-santeikohyo/files/calc/itiran_2023_rev4.pdf',
  },
  shk_h21: {
    key: 'shk_h21',
    label: '算定方法及び排出係数一覧（H21年度実績以降の排出量算定用。環境省）',
    edition: '平成21年度実績以降（H27改正事項反映）',
    url: 'https://policies.env.go.jp/earth/ghg-santeikohyo/files/calc/itiran_2009.pdf',
  },
};

export const PRESET_FUELS = ['gasoline', 'diesel'] as const;
export type PresetFuel = (typeof PRESET_FUELS)[number];

export const PRESET_FUEL_LABELS: Readonly<Record<PresetFuel, string>> = {
  gasoline: '揮発油',
  diesel: '軽油',
};

/** 告示の 1 式（燃料 × 燃費区分） */
export interface PresetFormula {
  /** 告示 4(1) の号 */
  item: '①' | '②' | '③' | '④' | '⑤' | '⑥' | '⑦';
  economyClass: FuelEconomyClass;
  /** ガイドライン・算定マニュアルでの呼び名 */
  label: string;
  A: number;
  B: number;
  /** この区分の式を当てる最大積載量（kg。minKg 以上 maxKg 未満。null は制限なし） */
  payloadMinKg: number | null;
  payloadMaxKg: number | null;
}

/** 別表第3 の 1 行（事業用・自家用 × 最大積載量の区分） */
export interface PresetDefaultRow extends TransportDefaultRow {
  /** 区分の中央値（kg。表の値を式で検算するときの z） */
  medianKg: number;
}

export interface PresetFuelEntry {
  fuel: PresetFuel;
  /** 積載率の指数（告示） */
  S: number;
  formulas: readonly PresetFormula[];
  /** 旧来の対数式（ln x = lnA − S·ln(y/100) − B·ln z）。燃費基準未確認の式と同じ B・S */
  log: { lnA: number; B: number };
  defaults: readonly PresetDefaultRow[];
}

// 値は出典の表の転記（research-tonkm.md §2.1・§2.2・§2.6 で全セルを確かめたもの）。計算で作らない

const GASOLINE: PresetFuelEntry = {
  fuel: 'gasoline',
  S: 0.927,
  formulas: [
    {
      item: '①',
      economyClass: 'y2022',
      label: '2022年度基準達成車',
      A: 6.96,
      B: 0.612,
      payloadMinKg: null,
      payloadMaxKg: null,
    },
    {
      item: '②',
      economyClass: 'y2015',
      label: '2015年度基準達成車',
      A: 6.23,
      B: 0.565,
      payloadMinKg: null,
      payloadMaxKg: null,
    },
    {
      item: '③',
      economyClass: 'unverified',
      label: '燃費基準未確認',
      A: 14.4,
      B: 0.648,
      payloadMinKg: null,
      payloadMaxKg: null,
    },
  ],
  log: { lnA: 2.67, B: 0.648 },
  defaults: [
    {
      vehicleUse: 'commercial',
      minKg: null,
      maxKg: 500,
      medianKg: 350,
      loadPct: 24,
      values: { y2022: 0.725, y2015: 0.854, unverified: 1.21 },
    },
    {
      vehicleUse: 'commercial',
      minKg: 500,
      maxKg: 1500,
      medianKg: 1000,
      loadPct: 24,
      values: { y2022: 0.381, y2015: 0.472, unverified: 0.615 },
    },
    {
      vehicleUse: 'commercial',
      minKg: 1500,
      maxKg: null,
      medianKg: 1500,
      loadPct: 29,
      values: { y2022: 0.25, y2015: 0.315, unverified: 0.397 },
    },
    {
      vehicleUse: 'private',
      minKg: null,
      maxKg: 500,
      medianKg: 350,
      loadPct: 10,
      values: { y2022: 1.63, y2015: 1.92, unverified: 2.73 },
    },
    {
      vehicleUse: 'private',
      minKg: 500,
      maxKg: 1500,
      medianKg: 1000,
      loadPct: 10,
      values: { y2022: 0.858, y2015: 1.06, unverified: 1.38 },
    },
    {
      vehicleUse: 'private',
      minKg: 1500,
      maxKg: null,
      medianKg: 1500,
      loadPct: 15,
      values: { y2022: 0.46, y2015: 0.58, unverified: 0.731 },
    },
  ],
};

const DIESEL: PresetFuelEntry = {
  fuel: 'diesel',
  S: 0.812,
  formulas: [
    {
      item: '④',
      economyClass: 'y2025',
      label: '2025年度基準達成車',
      A: 8.83,
      B: 0.623,
      payloadMinKg: 1000,
      payloadMaxKg: null,
    },
    {
      item: '⑤',
      economyClass: 'y2022',
      label: '2022年度基準達成車',
      A: 10.8,
      B: 0.654,
      payloadMinKg: null,
      payloadMaxKg: 2000,
    },
    {
      item: '⑥',
      economyClass: 'y2015',
      label: '2015年度基準達成車',
      A: 14.0,
      B: 0.658,
      payloadMinKg: null,
      payloadMaxKg: null,
    },
    {
      item: '⑦',
      economyClass: 'unverified',
      label: '燃費基準未確認',
      A: 15.0,
      B: 0.654,
      payloadMinKg: null,
      payloadMaxKg: null,
    },
  ],
  log: { lnA: 2.71, B: 0.654 },
  defaults: [
    {
      vehicleUse: 'commercial',
      minKg: null,
      maxKg: 1000,
      medianKg: 500,
      loadPct: 19,
      values: { y2022: 0.714, y2015: 0.903, unverified: 0.992 },
    },
    {
      vehicleUse: 'commercial',
      minKg: 1000,
      maxKg: 2000,
      medianKg: 1500,
      loadPct: 25,
      values: { y2025: 0.286, y2022: 0.286, y2015: 0.351, unverified: 0.387 },
    },
    {
      vehicleUse: 'commercial',
      minKg: 2000,
      maxKg: 4000,
      medianKg: 3000,
      loadPct: 34,
      values: { y2025: 0.145, y2015: 0.173, unverified: 0.192 },
    },
    {
      vehicleUse: 'commercial',
      minKg: 4000,
      maxKg: 6000,
      medianKg: 5000,
      loadPct: 38,
      values: { y2025: 0.0961, y2015: 0.113, unverified: 0.125 },
    },
    {
      vehicleUse: 'commercial',
      minKg: 6000,
      maxKg: 8000,
      medianKg: 7000,
      loadPct: 38,
      values: { y2025: 0.0779, y2015: 0.0906, unverified: 0.101 },
    },
    {
      vehicleUse: 'commercial',
      minKg: 8000,
      maxKg: 10000,
      medianKg: 9000,
      loadPct: 51,
      values: { y2025: 0.0525, y2015: 0.0605, unverified: 0.0672 },
    },
    {
      vehicleUse: 'commercial',
      minKg: 10000,
      maxKg: 12000,
      medianKg: 11000,
      loadPct: 51,
      values: { y2025: 0.0463, y2015: 0.053, unverified: 0.0589 },
    },
    {
      vehicleUse: 'commercial',
      minKg: 12000,
      maxKg: 17000,
      medianKg: 14500,
      loadPct: 51,
      values: { y2025: 0.039, y2015: 0.0442, unverified: 0.0492 },
    },
    {
      vehicleUse: 'commercial',
      minKg: 17000,
      maxKg: null,
      medianKg: 20500,
      loadPct: 51,
      values: { y2025: 0.0314, y2015: 0.0352, unverified: 0.0392 },
    },
    {
      vehicleUse: 'private',
      minKg: null,
      maxKg: 1000,
      medianKg: 500,
      loadPct: 10,
      values: { y2022: 1.2, y2015: 1.52, unverified: 1.67 },
    },
    {
      vehicleUse: 'private',
      minKg: 1000,
      maxKg: 2000,
      medianKg: 1500,
      loadPct: 10,
      values: { y2025: 0.602, y2022: 0.602, y2015: 0.738, unverified: 0.815 },
    },
    {
      vehicleUse: 'private',
      minKg: 2000,
      maxKg: 4000,
      medianKg: 3000,
      loadPct: 23,
      values: { y2025: 0.199, y2015: 0.238, unverified: 0.263 },
    },
    {
      vehicleUse: 'private',
      minKg: 4000,
      maxKg: 6000,
      medianKg: 5000,
      loadPct: 29,
      values: { y2025: 0.12, y2015: 0.141, unverified: 0.156 },
    },
    {
      vehicleUse: 'private',
      minKg: 6000,
      maxKg: 8000,
      medianKg: 7000,
      loadPct: 30,
      values: { y2025: 0.0944, y2015: 0.11, unverified: 0.122 },
    },
    {
      vehicleUse: 'private',
      minKg: 8000,
      maxKg: 10000,
      medianKg: 9000,
      loadPct: 40,
      values: { y2025: 0.0639, y2015: 0.0737, unverified: 0.0819 },
    },
    {
      vehicleUse: 'private',
      minKg: 10000,
      maxKg: 12000,
      medianKg: 11000,
      loadPct: 40,
      values: { y2025: 0.0564, y2015: 0.0646, unverified: 0.0718 },
    },
    {
      vehicleUse: 'private',
      minKg: 12000,
      maxKg: 17000,
      medianKg: 14500,
      loadPct: 40,
      values: { y2025: 0.0475, y2015: 0.0538, unverified: 0.0599 },
    },
    {
      vehicleUse: 'private',
      minKg: 17000,
      maxKg: null,
      medianKg: 20500,
      loadPct: 40,
      values: { y2025: 0.0383, y2015: 0.0429, unverified: 0.0478 },
    },
  ],
};

export const TONKM_PRESET_FUELS: Readonly<Record<PresetFuel, PresetFuelEntry>> = {
  gasoline: GASOLINE,
  diesel: DIESEL,
};

/**
 * 別表第3 の値が式の値と一致しないことが出典に書かれているセル（共同ガイドライン 表 II-22 注3:
 * 軽油 1,000kg 以上 2,000kg 未満の 2022年度基準の欄は、関数式によらず 2025年度基準の値を記載）
 */
export const PRESET_TABLE_EXCEPTIONS: ReadonlyArray<{
  fuel: PresetFuel;
  vehicleUse: VehicleUse;
  minKg: number;
  economyClass: FuelEconomyClass;
  note: string;
}> = [
  {
    fuel: 'diesel',
    vehicleUse: 'commercial',
    minKg: 1000,
    economyClass: 'y2022',
    note: '共同ガイドライン 表 II-22 注3（表の値は 2025年度基準の値）',
  },
  {
    fuel: 'diesel',
    vehicleUse: 'private',
    minKg: 1000,
    economyClass: 'y2022',
    note: '共同ガイドライン 表 II-22 注3（表の値は 2025年度基準の値）',
  },
];

/** 燃料の CO2 換算の値（温対法の算定省令。tCO2 = kL × GJ/kL × tC/GJ × 44/12） */
export interface PresetFuelCo2 {
  fuel: PresetFuel;
  /** 単位発熱量（GJ/kL） */
  calorific: number;
  /** 炭素排出係数（tC/GJ） */
  carbon: number;
  /** 適用する実績の年度 */
  applies: string;
  source: PresetSource['key'];
}

export const PRESET_FUEL_CO2: readonly PresetFuelCo2[] = [
  {
    fuel: 'diesel',
    calorific: 38.0,
    carbon: 0.0188,
    applies: '令和5年度実績以降',
    source: 'shk_r5',
  },
  {
    fuel: 'gasoline',
    calorific: 33.4,
    carbon: 0.0187,
    applies: '令和5年度実績以降',
    source: 'shk_r5',
  },
  {
    fuel: 'diesel',
    calorific: 37.7,
    carbon: 0.0187,
    applies: '平成21年度実績〜令和4年度実績',
    source: 'shk_h21',
  },
  {
    fuel: 'gasoline',
    calorific: 34.6,
    carbon: 0.0183,
    applies: '平成21年度実績〜令和4年度実績',
    source: 'shk_h21',
  },
];

/** ガイドラインの積載率の下限（%）。算定に使う値は組織の算定方針（minLoadPct）が決める */
export const GUIDELINE_MIN_LOAD_PCT = 10;

/**
 * 係数セットの式の行（transport_formula の params）の形にする。
 * 対数式の定数は燃費基準未確認の式にだけ付ける（対数式は 2002 年の統計で作られた現行式と同じ B・S）
 */
export function presetFormulaParams(fuel: PresetFuel): TransportFormulaParams {
  const entry = TONKM_PRESET_FUELS[fuel];
  const classes: Partial<Record<FuelEconomyClass, TransportFormulaClass>> = {};
  for (const formula of entry.formulas) {
    classes[formula.economyClass] = {
      A: formula.A,
      B: formula.B,
      ...(formula.economyClass === 'unverified' ? { lnA: entry.log.lnA } : {}),
      payloadMinKg: formula.payloadMinKg,
      payloadMaxKg: formula.payloadMaxKg,
    };
  }
  return { S: entry.S, classes };
}

/** 係数セットの原単位表の行（transport_default の params）の形にする（中央値は外す） */
export function presetDefaultParams(fuel: PresetFuel): TransportDefaultParams {
  return {
    table: TONKM_PRESET_FUELS[fuel].defaults.map((row) => ({
      vehicleUse: row.vehicleUse,
      minKg: row.minKg,
      maxKg: row.maxKg,
      loadPct: row.loadPct,
      values: { ...row.values },
    })),
  };
}

export interface PresetTableCheck {
  fuel: PresetFuel;
  vehicleUse: VehicleUse;
  minKg: number | null;
  maxKg: number | null;
  economyClass: FuelEconomyClass;
  /** 別表第3 の値 */
  table: number;
  /** 区分の中央値・見なし積載率を告示式に入れて有効数字 3 桁にした値 */
  formula: number;
  matches: boolean;
  /** 出典の注記で一致しないと分かっているセル */
  knownException: boolean;
}

/**
 * 別表第3 の全セルを告示式で検算する（表の転記の誤りを見つけるため。画面にも件数を出す）。
 * 式: x = A ÷ (y/100)^S ÷ z^B（y＝見なし積載率、z＝区分の中央値）。有効数字 3 桁・四捨五入で比べる
 */
export function verifyPresetDefaultTable(): PresetTableCheck[] {
  const out: PresetTableCheck[] = [];
  for (const fuel of PRESET_FUELS) {
    const entry = TONKM_PRESET_FUELS[fuel];
    for (const row of entry.defaults) {
      for (const formula of entry.formulas) {
        const table = row.values[formula.economyClass];
        if (table === undefined) continue;
        const raw = formula.A / (row.loadPct / 100) ** entry.S / row.medianKg ** formula.B;
        const rounded = roundSignificant(raw, 3, 'half_up');
        out.push({
          fuel,
          vehicleUse: row.vehicleUse,
          minKg: row.minKg,
          maxKg: row.maxKg,
          economyClass: formula.economyClass,
          table,
          formula: rounded,
          matches: rounded === table,
          knownException: PRESET_TABLE_EXCEPTIONS.some(
            (e) =>
              e.fuel === fuel &&
              e.vehicleUse === row.vehicleUse &&
              e.minKg === row.minKg &&
              e.economyClass === formula.economyClass,
          ),
        });
      }
    }
  }
  return out;
}

/** 最大積載量の区分の語（例「2,000kg 以上 4,000kg 未満」） */
export function payloadRangeLabel(minKg: number | null, maxKg: number | null): string {
  const fmt = (n: number) => `${n.toLocaleString('ja-JP')}kg`;
  if (minKg === null && maxKg === null) return 'すべて';
  if (minKg === null) return `${fmt(maxKg!)} 未満`;
  if (maxKg === null) return `${fmt(minKg)} 以上`;
  return `${fmt(minKg)} 以上 ${fmt(maxKg)} 未満`;
}
