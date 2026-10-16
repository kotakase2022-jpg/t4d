import { describe, expect, it } from 'vitest';
import { extractFactorRows, suggestFactorMapping } from '@/lib/domain/ghg/factor-import';
import {
  PRESET_FUEL_CO2,
  PRESET_FUELS,
  presetDefaultParams,
  presetFormulaParams,
} from '@/lib/domain/ghg/tonkm-preset';
import { toCsv } from '@/lib/exports';
import {
  PRESET_FUEL_CO2_EDITIONS,
  presetFactorCode,
  presetFactorSetSheet,
} from '@/lib/exports/ghg-preset-factor-set';
import { parseCsv } from '@/lib/imports/parsers';
import { createFixtureDb } from '@/lib/fixtures/store';
import { compactRow } from '@/lib/repositories/demo-compact';
import { encodeDemoEditStream, type DemoEdit } from '@/lib/repositories/demo-edit-codec';
import { DEMO_GHG_LIMITS } from '@/lib/repositories/demo-ghg-checks';
import { MAX_BYTES_PER_COOKIE } from '@/lib/repositories/demo-persistence';
import type { TransportDefaultParams } from '@/lib/domain/ghg/tonkm';

/**
 * 公的参照プリセットを係数セットへ取り込む経路（plan CR-19・固定文 N10「組織が採用を決めたときだけ係数セットへ
 * 取り込みます」）。プリセットから作った取込のファイルを、排出係数の画面と同じ取込の関数で読むと、
 * プリセットと同じ値の係数（式・原単位表・燃料の 2 段係数）が誤りなく読めること。
 */

function importPreset(edition: (typeof PRESET_FUEL_CO2_EDITIONS)[number]) {
  const csv = toCsv(presetFactorSetSheet(edition));
  const table = parseCsv(new TextEncoder().encode(csv));
  const mapping = suggestFactorMapping(table.headers);
  return extractFactorRows(
    { headers: table.headers, rows: table.rows, rowNumbers: table.rowNumbers },
    mapping,
    { decimalSeparator: 'dot', defaultYear: 2025, defaultSource: '（未使用）' },
  );
}

/** 値が null の鍵を落とす（取込は「制限なし」の最大積載量を鍵ごと持たない。null と同じ意味） */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, withoutNulls(v)]),
    );
  }
  return value;
}

const sortTable = (t: TransportDefaultParams['table']) =>
  [...t].sort(
    (a, b) => a.vehicleUse.localeCompare(b.vehicleUse) || (a.minKg ?? -1) - (b.minKg ?? -1),
  );

describe('公的参照プリセットの取込のファイル', () => {
  it.each(PRESET_FUEL_CO2_EDITIONS)(
    '%s: 列の対応は見出しの語だけで決まり、エラー・警告なしで 6 つの係数（燃料ごとに 2 段係数・式・原単位表）になる',
    (edition) => {
      const result = importPreset(edition);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.factors.map((f) => f.code).sort()).toEqual(
        PRESET_FUELS.flatMap((fuel) => [
          presetFactorCode('default', fuel),
          presetFactorCode('formula', fuel),
          presetFactorCode('fuel', fuel),
        ]).sort(),
      );
      for (const fuel of PRESET_FUELS) {
        const byCode = (kind: 'fuel' | 'formula' | 'default') =>
          result.factors.find((f) => f.code === presetFactorCode(kind, fuel))!;
        // 式: 告示の A・B・S・最大積載量の範囲・対数式の定数（未確認の式だけ）がそのまま
        expect(byCode('formula')).toMatchObject({
          activityKind: 'transport_formula',
          activityCode: fuel,
        });
        expect(withoutNulls(byCode('formula').params)).toEqual(
          withoutNulls(presetFormulaParams(fuel)),
        );
        // 原単位表: 別表第3 の全セル（事業用・自家用 × 最大積載量の区分 × 燃費区分）がそのまま
        const table = (byCode('default').params as unknown as TransportDefaultParams).table;
        expect(sortTable(table)).toEqual(sortTable(presetDefaultParams(fuel).table));
        expect(byCode('default').activityKind).toBe('transport_default');
        // 燃料の 2 段係数: 算定省令の版の値（単位発熱量 GJ/kL・炭素排出係数 tC/GJ）
        const co2 = PRESET_FUEL_CO2.find((c) => c.fuel === fuel && c.source === edition)!;
        expect(byCode('fuel')).toMatchObject({
          activityKind: 'fuel',
          activityCode: fuel,
          activityUnit: 'kL',
          calorificValue: co2.calorific,
          calorificUnit: 'GJ/kL',
          carbonFactor: co2.carbon,
          carbonFactorUnit: 'tC/GJ',
          factorYear: 2025,
        });
        // 出典は行ごとに残る（告示・算定省令の版と確認日）
        expect(byCode('formula').factorSource).toContain('告示第66号');
        expect(byCode('fuel').factorSource).toContain('確認日 2026-10-16');
      }
    },
  );

  it('Demo でも取り込める大きさ（改良トンキロ法の表は Demo の上限の文字数・1 セットの係数の上限に収まる）', () => {
    const result = importPreset('shk_r5');
    expect(result.factors.length).toBeLessThanOrEqual(DEMO_GHG_LIMITS.factorsPerSet);
    for (const f of result.factors) {
      expect(JSON.stringify(f.params).length, f.code).toBeLessThanOrEqual(
        DEMO_GHG_LIMITS.factorParamsChars,
      );
    }
    // 軽油の原単位表（2,000 字を超える）が入ることを、上限の値の根拠として固定する
    const diesel = result.factors.find((f) => f.code === presetFactorCode('default', 'diesel'))!;
    expect(JSON.stringify(diesel.params).length).toBeGreaterThan(2000);
  });

  it('Demo の Cookie: 取り込んだセット（係数 6 件）は Cookie の 1 チャンクに収まる（別インスタンスでも戻る）', () => {
    const db = createFixtureDb();
    const setId = '0a000000-0000-4000-8000-0000000000aa';
    const set = {
      ...db.emissionFactorSets[0]!,
      id: setId,
      code: 'PUB-R5',
      origin: 'public_reference' as const,
      status: 'draft' as const,
    };
    const edits: DemoEdit[] = [
      { t: 'emissionFactorSets', id: setId, v: compactRow('emissionFactorSets', { ...set }, db)! },
      ...importPreset('shk_r5').factors.map((f, i) => {
        const { lines: _lines, ...rest } = f;
        const id = `0a000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`;
        const row = { ...rest, id, organizationId: set.organizationId, factorSetId: setId };
        return { t: 'emissionFactors', id, v: compactRow('emissionFactors', row, db)! };
      }),
    ];
    const bytes = encodeDemoEditStream(edits).length;
    // 実測 約 2,440B（known-limitations §13.7。長い実演の後に取り込むと古い操作が押し出されうる＝D-3）
    expect(bytes).toBeLessThanOrEqual(MAX_BYTES_PER_COOKIE);
  });

  it('小数点の記号を選ぶまでは値を読まない（取込の規則どおり。推測で埋めない）', () => {
    const csv = toCsv(presetFactorSetSheet('shk_r5'));
    const table = parseCsv(new TextEncoder().encode(csv));
    const result = extractFactorRows(
      { headers: table.headers, rows: table.rows, rowNumbers: table.rowNumbers },
      suggestFactorMapping(table.headers),
      { decimalSeparator: null, defaultYear: 2025, defaultSource: '（未使用）' },
    );
    expect(result.errors.some((e) => e.message.includes('小数点の記号を選ぶと読める'))).toBe(true);
  });
});
