import { FACTOR_KIND_LABELS } from '@/lib/domain/ghg/factor-import';
import {
  PRESET_FUEL_CO2,
  PRESET_FUEL_LABELS,
  PRESET_FUELS,
  TONKM_PRESET_CONFIRMED_ON,
  TONKM_PRESET_FUELS,
  TONKM_PRESET_SOURCES,
  type PresetFuel,
} from '@/lib/domain/ghg/tonkm-preset';
import type { FuelEconomyClass } from '@/types/domain';
import type { ExportSheet } from './index';

/**
 * 公的参照プリセット（告示の 7 式・別表第3・算定省令の燃料の値。plan CR-19・固定文 N10）を、係数セットの取込の
 * ファイル（排出係数の画面の「係数セットを取り込む」がそのまま読める列）にする。
 *
 * 既定では算定に使わない: このファイルを組織が取り込むと「下書き」の係数セット（出所: 公的参照）になり、
 * 有効にして割り当てるまで算定に入らない。算定・サービス・Fixture・Demo の持ち回しはプリセットを読まない
 * （tests/unit/ghg-tonkm-preset.test.ts）。値は出典の表の転記をそのまま出す（計算し直さない）。
 */

/** 燃料の CO2 換算の値の版（算定省令。実績の年度で使い分ける） */
export const PRESET_FUEL_CO2_EDITIONS = ['shk_r5', 'shk_h21'] as const;
export type PresetFuelCo2Edition = (typeof PRESET_FUEL_CO2_EDITIONS)[number];

export function isPresetFuelCo2Edition(value: string | null): value is PresetFuelCo2Edition {
  return value !== null && (PRESET_FUEL_CO2_EDITIONS as readonly string[]).includes(value);
}

/** 画面のリンクの名前（版ごと） */
export const PRESET_FUEL_CO2_EDITION_LABELS: Record<PresetFuelCo2Edition, string> = {
  shk_r5: '燃料の値は令和5年度実績以降',
  shk_h21: '燃料の値は平成21年度〜令和4年度実績',
};

/** 列名（係数セットの取込の列の対応付けが見出しの語から選べる名前） */
export const PRESET_FACTOR_SET_HEADERS = [
  '係数コード',
  '名称',
  '種類',
  '活動',
  '活動量の単位',
  '単位発熱量',
  '単位発熱量の単位',
  '炭素排出係数',
  '炭素排出係数の単位',
  '燃費区分',
  '式の係数 A',
  '式の係数 B',
  '式の係数 S',
  '対数式の定数',
  '最大積載量の下限(kg)',
  '最大積載量の上限(kg)',
  '用途',
  '見なし積載率(%)',
  '原単位(L/t·km)',
  '出典',
] as const;
type Header = (typeof PRESET_FACTOR_SET_HEADERS)[number];
export type PresetFactorRow = Partial<Record<Header, string | number | null>>;

/** 取込が読める燃費区分の語（parseEconomyClass の語） */
const ECONOMY_WORD: Record<FuelEconomyClass, string> = {
  y2025: '2025 年度燃費基準',
  y2022: '2022 年度燃費基準',
  y2015: '2015 年度燃費基準',
  unverified: '燃費基準 未確認',
};

const USE_WORD = { commercial: '事業用', private: '自家用' } as const;

const NUMERIC: readonly Header[] = [
  '単位発熱量',
  '炭素排出係数',
  '式の係数 A',
  '式の係数 B',
  '式の係数 S',
  '対数式の定数',
  '最大積載量の下限(kg)',
  '最大積載量の上限(kg)',
  '見なし積載率(%)',
  '原単位(L/t·km)',
];

function sourceText(key: keyof typeof TONKM_PRESET_SOURCES): string {
  const s = TONKM_PRESET_SOURCES[key];
  return `${s.label}（${s.edition}・確認日 ${TONKM_PRESET_CONFIRMED_ON}）`;
}

/** 係数コード（燃料ごと。年度はセットの基準年で決まる） */
export function presetFactorCode(kind: 'fuel' | 'formula' | 'default', fuel: PresetFuel): string {
  const part = { fuel: 'FUEL', formula: 'TONKM-FORMULA', default: 'TONKM-DEFAULT' }[kind];
  return `PUB-${part}-${fuel.toUpperCase()}`;
}

/** 取込のファイルの行（燃料ごとに: 燃料の 2 段係数 1 行・式 燃費区分ごと・原単位表 区分 × 燃費区分ごと） */
export function presetFactorSetRows(edition: PresetFuelCo2Edition): PresetFactorRow[] {
  const rows: PresetFactorRow[] = [];
  for (const fuel of PRESET_FUELS) {
    const entry = TONKM_PRESET_FUELS[fuel];
    const word = PRESET_FUEL_LABELS[fuel];
    const co2 = PRESET_FUEL_CO2.find((c) => c.fuel === fuel && c.source === edition);
    if (!co2) throw new Error(`燃料の値が見つかりません（${fuel}・${edition}）`);
    rows.push({
      係数コード: presetFactorCode('fuel', fuel),
      名称: `${word}（算定省令・${co2.applies}）`,
      種類: FACTOR_KIND_LABELS.fuel,
      活動: word,
      活動量の単位: 'kL',
      単位発熱量: co2.calorific,
      単位発熱量の単位: 'GJ/kL',
      炭素排出係数: co2.carbon,
      炭素排出係数の単位: 'tC/GJ',
      出典: sourceText(edition),
    });
    for (const f of entry.formulas) {
      rows.push({
        係数コード: presetFactorCode('formula', fuel),
        名称: `改良トンキロ法の式（${word}・告示）`,
        種類: FACTOR_KIND_LABELS.transport_formula,
        活動: word,
        燃費区分: ECONOMY_WORD[f.economyClass],
        '式の係数 A': f.A,
        '式の係数 B': f.B,
        '式の係数 S': entry.S,
        // 対数式の定数は燃費基準未確認の式にだけ付ける（presetFormulaParams と同じ）
        対数式の定数: f.economyClass === 'unverified' ? entry.log.lnA : null,
        '最大積載量の下限(kg)': f.payloadMinKg,
        '最大積載量の上限(kg)': f.payloadMaxKg,
        出典: sourceText('kokuji'),
      });
    }
    for (const d of entry.defaults) {
      for (const [economyClass, value] of Object.entries(d.values) as Array<
        [FuelEconomyClass, number | undefined]
      >) {
        if (value === undefined) continue;
        rows.push({
          係数コード: presetFactorCode('default', fuel),
          名称: `見なし積載率の原単位表（${word}・告示 別表第3）`,
          種類: FACTOR_KIND_LABELS.transport_default,
          活動: word,
          燃費区分: ECONOMY_WORD[economyClass],
          '最大積載量の下限(kg)': d.minKg,
          '最大積載量の上限(kg)': d.maxKg,
          用途: USE_WORD[d.vehicleUse],
          '見なし積載率(%)': d.loadPct,
          '原単位(L/t·km)': value,
          出典: sourceText('kokuji'),
        });
      }
    }
  }
  return rows;
}

export function presetFactorSetSheet(edition: PresetFuelCo2Edition): ExportSheet<PresetFactorRow> {
  return {
    name: '公的参照プリセット',
    columns: PRESET_FACTOR_SET_HEADERS.map((header) => ({
      key: header,
      header,
      value: (row: PresetFactorRow) => row[header] ?? null,
      numeric: NUMERIC.includes(header),
    })),
    rows: presetFactorSetRows(edition),
  };
}

/** 取込のファイルの出力（E21）の行き先 */
export function presetFactorSetHref(edition: PresetFuelCo2Edition): string {
  return `/api/exports/ghg-preset-factor-set?fuelCo2=${edition}`;
}

export function presetFactorSetFileName(edition: PresetFuelCo2Edition): string {
  return `公的参照プリセット_改良トンキロ法_${edition === 'shk_r5' ? 'R5以降' : 'H21-R4'}_${TONKM_PRESET_CONFIRMED_ON}.csv`;
}
