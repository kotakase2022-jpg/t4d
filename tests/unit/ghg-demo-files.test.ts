import { describe, expect, it } from 'vitest';
import { extractActivityRows } from '@/lib/domain/ghg/activity-parse';
import { extractBaselineRows } from '@/lib/domain/ghg/baseline-parse';
import {
  GHG_DEMO_FILE_KINDS,
  buildGhgDemoFile,
  ghgDemoFileLinks,
  isGhgDemoFileKind,
  type GhgDemoFile,
} from '@/lib/fixtures/ghg-demo-files';
import { GHG_FIXTURE_IDS } from '@/lib/fixtures/ghg-verification';
import { createFixtureDb } from '@/lib/fixtures/store';
import { UNIT_IDS } from '@/lib/fixtures/dataset';

/**
 * Scope1・2 の算定と照合のサンプルファイル（plan §2.6・E20）。架空のファイルが Stage A の取込の純関数で
 * 読める（列名・語が取込の対応付けと噛み合う）こと、Fixture から決定論で作られることを確かめる
 */

/** ExportSheet → 取込の表（値を文字列にする。表計算から読んだときと同じ形） */
function tableOf(file: GhgDemoFile) {
  const headers = file.sheet.columns.map((c) => c.header);
  const rows = file.sheet.rows.map((row) =>
    Object.fromEntries(
      file.sheet.columns.map((c) => {
        const v = c.value(row);
        return [c.header, v === null ? '' : String(v)];
      }),
    ),
  );
  return { headers, rows, rowNumbers: rows.map((_, i) => i + 2) };
}

describe('GHG のサンプルファイル（架空）', () => {
  const db = createFixtureDb();

  it('4 種があり、名前・ファイル名に「架空」が入る', () => {
    expect(GHG_DEMO_FILE_KINDS).toEqual(['factor-set', 'energy', 'transport', 'baseline']);
    for (const kind of GHG_DEMO_FILE_KINDS) {
      const file = buildGhgDemoFile(kind, db);
      expect(file.label).toContain('架空');
      expect(file.fileName).toContain('（架空）');
      expect(file.fileName.endsWith(`.${file.format}`)).toBe(true);
    }
    expect(ghgDemoFileLinks().map((l) => l.href)).toEqual(
      GHG_DEMO_FILE_KINDS.map((k) => `/api/exports/ghg-demo-files?kind=${k}`),
    );
    expect(isGhgDemoFileKind('baseline')).toBe(true);
    expect(isGhgDemoFileKind('../etc')).toBe(false);
    expect(isGhgDemoFileKind(null)).toBe(false);
  });

  it('係数セットは 8 行（燃料・ガス 3＋電力のロケーション基準 5 か国）で、改訂の値が 2 つある', () => {
    const file = buildGhgDemoFile('factor-set', db);
    expect(file.sheet.rows).toHaveLength(8);
    const byCode = new Map(file.sheet.rows.map((r) => [r['係数コード'], r]));
    expect([...byCode.keys()].every((c) => String(c).startsWith('ORG-2025R-'))).toBe(true);
    expect(byCode.get('ORG-2025R-ELEC-LOC-VN')?.['排出係数']).toBe(0.671);
    expect(byCode.get('ORG-2025R-CITYGAS')?.['単位発熱量']).toBe(44.8);
    // 2 段の係数（燃料）は排出係数の列を空にして、単位発熱量と炭素排出係数で書く
    expect(byCode.get('ORG-2025R-DIESEL')?.['排出係数']).toBeNull();
    expect(byCode.get('ORG-2025R-DIESEL')?.['炭素排出係数']).not.toBeNull();
  });

  it('エネルギーは米国工場の 7 月の 3 行で、電力だけ訂正し、取込の純関数で読める', () => {
    const file = buildGhgDemoFile('energy', db);
    expect(file.sheet.rows).toHaveLength(3);
    const parsed = extractActivityRows(tableOf(file), 'energy', {
      month: '月',
      activity: '活動',
      amount: '量',
      unit: '単位',
      contractCode: '契約',
      note: '備考',
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map((r) => r.activityKind).sort()).toEqual(['electricity', 'fuel', 'fuel']);
    expect(parsed.rows.every((r) => r.month === '2025-07-01')).toBe(true);
    const original = db.ghgActivityLines.find(
      (l) =>
        l.batchId.length > 0 &&
        l.month === '2025-07-01' &&
        l.activityKind === 'electricity' &&
        db.ghgActivityBatches.find((b) => b.id === l.batchId)?.unitId === GHG_FIXTURE_IDS.units.us,
    )!;
    const corrected = parsed.rows.find((r) => r.activityKind === 'electricity')!;
    expect(corrected.amount).toBe(Math.round(original.amount! * 1.015));
  });

  it('輸送実績は東日本工場の追加 6 行で、積載率なし・5%・範囲外の最大積載量を含み、取込の純関数で読める', () => {
    const file = buildGhgDemoFile('transport', db);
    expect(file.sheet.rows).toHaveLength(6);
    const parsed = extractActivityRows(tableOf(file), 'transport', {
      month: '月',
      shipmentRef: '出荷番号',
      carrierKind: '輸送の区分',
      fuel: '燃料',
      cargoWeightT: '輸送重量(t)',
      distanceKm: '輸送距離(km)',
      maxPayloadKg: '最大積載量(kg)',
      loadFactorPct: '積載率(%)',
      vehicleUse: '用途',
      fuelEconomyClass: '燃費の区分',
      cargoKind: '貨物',
      note: '備考',
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(6);
    expect(
      parsed.rows.every((r) => r.carrierKind === 'contracted' && r.fuelCode === 'diesel'),
    ).toBe(true);
    expect(parsed.rows.filter((r) => r.loadFactorPct === null)).toHaveLength(1);
    expect(parsed.rows.filter((r) => r.loadFactorPct === 5)).toHaveLength(1);
    expect(parsed.rows.filter((r) => r.maxPayloadKg === 25000)).toHaveLength(1);
    // 出荷番号は Fixture の 24 行と重ならない（追加の行）
    const existing = new Set(
      db.ghgActivityLines.map((l) => l.shipmentRef).filter((v): v is string => v !== null),
    );
    expect(parsed.rows.every((r) => r.shipmentRef && !existing.has(r.shipmentRef))).toBe(true);
  });

  it('既存結果の変種は 80 行以下・拠点×活動の粒度で、丸めの記述が読める', () => {
    const file = buildGhgDemoFile('baseline', db);
    expect(file.sheet.rows.length).toBeGreaterThan(0);
    expect(file.sheet.rows.length).toBeLessThanOrEqual(80);
    const unitMapping = {
      EAST: UNIT_IDS.east,
      TH1: GHG_FIXTURE_IDS.units.th,
      VN1: GHG_FIXTURE_IDS.units.vn,
      MX1: GHG_FIXTURE_IDS.units.mx,
    };
    const parsed = extractBaselineRows(
      tableOf(file),
      {
        siteCode: '拠点コード',
        scope: '区分',
        activity: '活動',
        emissions: '排出量',
        emissionsUnit: '排出量の単位',
        rounding: '丸め',
        // 排出量は t・小数 3 桁（「3.741」）。小数点の記号を選ばないと曖昧で読めない（下の検査）
        decimalSeparator: 'dot',
      },
      unitMapping,
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.unmappedSiteCodes).toEqual([]);
    expect(parsed.granularity).toBe('site_activity');
    expect(parsed.rows.every((r) => r.rounding?.stage === 'site_activity')).toBe(true);
    // 合計だけの拠点（US1）は含めない
    expect(parsed.rows.some((r) => r.siteCode === 'US1')).toBe(false);
    // 委託物流は既存の算定の会社方針どおり Scope1
    expect(parsed.rows.find((r) => r.activityCode === 'contracted')?.scope).toBe('scope1');
  });

  it('同じ Fixture からは同じ内容（決定論）', () => {
    const again = createFixtureDb();
    for (const kind of GHG_DEMO_FILE_KINDS) {
      expect(buildGhgDemoFile(kind, again).sheet.rows).toEqual(
        buildGhgDemoFile(kind, db).sheet.rows,
      );
    }
  });
});
