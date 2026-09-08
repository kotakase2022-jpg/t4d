import { describe, expect, it } from 'vitest';
import { extractSupplierCsvRows } from '@/lib/services/scope3-suppliers';
import { buildSupplierDemoFiles } from '@/lib/fixtures/supplier-demo-files';

/**
 * サプライヤー一次データ CSV の解釈と自動仕訳（決定論・AI 不使用）。
 *
 * 確かめたいこと:
 *  - 旧形式（購買金額(千円)＋係数コード）が金額データとして読める（後方互換）
 *  - 排出量／物理量／金額の 3 種別が、種別列・排出量列・単位から規則で仕訳される
 *  - 前置き行はヘッダー自動検出で読み飛ばし、合計行・注記行は取込対象から外れる
 *  - 円・百万円・MWh などの単位ゆらぎが正規化される
 *  - 判定できない行はエラーとして残る（黙って捨てない）
 */

describe('旧形式（金額のみ）の後方互換', () => {
  it('購買金額(千円) ヘッダーの CSV を金額データとして読む', () => {
    const text = [
      'サプライヤーコード,品目,購買金額(千円),排出係数コード',
      'SUP-06,金属筐体,"12,400",EF-PUR-METAL',
      'SUP-07,国内輸送,5300,EF-LOGI',
    ].join('\n');
    const parsed = extractSupplierCsvRows(text);

    expect(parsed.fileErrors).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      supplierCode: 'SUP-06',
      item: '金属筐体',
      dataType: 'monetary',
      amount: 12400,
      unit: '千円',
      factorCode: 'EF-PUR-METAL',
      skippedReason: null,
      errors: [],
    });
  });
});

describe('種別の自動仕訳', () => {
  const HEADER = 'サプライヤーコード,品目,データ種別,数値,単位,排出係数コード';

  it('テンプレート形式: 種別列と単位から排出量・物理量・金額を仕訳する', () => {
    const text = [
      HEADER,
      'SUP-16,報告排出量,排出量,8.4,t-CO2e,',
      'SUP-27,購入電力,物理量,28400,kWh,',
      'SUP-06,金属筐体,金額,12400,千円,EF-PUR-METAL',
    ].join('\n');
    const parsed = extractSupplierCsvRows(text);

    expect(parsed.rows.map((r) => r.dataType)).toEqual(['emissions', 'physical', 'monetary']);
    expect(parsed.rows[0]).toMatchObject({ amount: 8.4, unit: 't-CO2e' });
    expect(parsed.rows[1]).toMatchObject({ amount: 28400, unit: 'kWh' });
    expect(parsed.rows.every((r) => r.errors.length === 0)).toBe(true);
  });

  it('種別列が無くても、排出量列があれば排出量データになる（EcoVadis 風・品目は既定値）', () => {
    const text = [
      'Supplier code,Company name,Country,Scope 3 Cat.1 allocated emissions (tCO2e),Carbon score',
      'SUP-16,Verte Logistique SA,France,8.4,62',
    ].join('\n');
    const parsed = extractSupplierCsvRows(text);

    expect(parsed.rows[0]).toMatchObject({
      supplierCode: 'SUP-16',
      dataType: 'emissions',
      amount: 8.4,
      unit: 't-CO2e',
      item: '報告排出量',
      errors: [],
    });
  });

  it('単位から仕訳する: 円・百万円・MWh は正規形へ換算される', () => {
    const text = [
      HEADER,
      'SUP-06,加工費,,5200000,円,',
      'SUP-06,部材,,5.2,百万円,',
      'SUP-27,電力,,28.4,MWh,',
    ].join('\n');
    const parsed = extractSupplierCsvRows(text);

    expect(parsed.rows[0]).toMatchObject({ dataType: 'monetary', amount: 5200, unit: '千円' });
    expect(parsed.rows[1]).toMatchObject({ dataType: 'monetary', amount: 5200, unit: '千円' });
    expect(parsed.rows[2]).toMatchObject({ dataType: 'physical', amount: 28400, unit: 'kWh' });
  });

  it('種別と単位が矛盾する行はエラーになる', () => {
    const text = [HEADER, 'SUP-27,電力,金額,28400,kWh,'].join('\n');
    const parsed = extractSupplierCsvRows(text);
    expect(parsed.rows[0]?.errors.join('')).toContain('矛盾');
  });

  it('未対応の単位・判定不能な種別はエラーとして残る', () => {
    const text = [HEADER, 'SUP-06,調達,,100,EUR,', 'SUP-06,調達,その他,100,,'].join('\n');
    const parsed = extractSupplierCsvRows(text);
    expect(parsed.rows[0]?.errors.join('')).toContain('EUR');
    expect(parsed.rows[1]?.errors.length).toBeGreaterThan(0);
  });
});

describe('列役割の割り当て（同じ規則に複数列が一致するヘッダー）', () => {
  it('仕入先コード＋仕入金額(千円): 金額列が /仕入/ に先取りされず読める', () => {
    const text = [
      '仕入先コード,品目,仕入金額(千円),排出係数コード',
      'SUP-06,金属筐体,12400,EF-PUR-METAL',
    ].join('\n');
    const parsed = extractSupplierCsvRows(text);
    expect(parsed.fileErrors).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({ dataType: 'monetary', amount: 12400, unit: '千円' });
  });

  it('Menge＋Mengeneinheit: 単位列が /menge/ に先取りされず読める', () => {
    const text = ['Supplier code;Position;Menge;Mengeneinheit', 'SUP-27;Strom;28.400,0;kWh'].join(
      '\n',
    );
    const parsed = extractSupplierCsvRows(text);
    expect(parsed.fileErrors).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({ dataType: 'physical', amount: 28400, unit: 'kWh' });
  });

  it('数量＋数量単位: 単位列が /数量/ に先取りされず読める', () => {
    const text = ['サプライヤーコード,品目,数量,数量単位', 'SUP-27,購入電力,28400,kWh'].join('\n');
    const parsed = extractSupplierCsvRows(text);
    expect(parsed.fileErrors).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({ dataType: 'physical', amount: 28400, unit: 'kWh' });
  });
});

describe('前置き行・合計行・独式数値', () => {
  it('前置き行付きの手計算シートはヘッダーを自動検出し、合計・注記行を除外する', () => {
    const text = [
      'サプライヤー排出量 手計算ワークシート（調達部）',
      '作成日: 2027-04-05',
      'サプライヤーコード,品目,排出量(t-CO2e),算定方法,備考',
      'SUP-18,印刷物,3.2,燃料法,回収済み',
      '合計,,3.2,,',
      '※ 手計算のため再確認,,,,',
    ].join('\n');
    const parsed = extractSupplierCsvRows(text);

    const details = parsed.rows.filter((r) => r.skippedReason === null);
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      supplierCode: 'SUP-18',
      dataType: 'emissions',
      amount: 3.2,
    });
    expect(parsed.rows.filter((r) => r.skippedReason !== null)).toHaveLength(2);
  });

  it('セミコロン区切り・独式数値（1.234,5）の素データを読める', () => {
    const text = [
      'Supplier code;Position;Menge;Einheit;Betrag (JPY k);Zeitraum',
      'SUP-23;Diesel;3.120,0;L;;GJ2026',
      'SUP-29;Beschaffung;;;5.200,0;GJ2026',
    ].join('\n');
    const parsed = extractSupplierCsvRows(text);

    expect(parsed.rows[0]).toMatchObject({ dataType: 'physical', amount: 3120, unit: 'L' });
    // 数量が空で金額列に値がある行は、ヘッダーの通貨表記（JPY k）から金額データになる
    expect(parsed.rows[1]).toMatchObject({ dataType: 'monetary', amount: 5200, unit: '千円' });
  });
});

describe('デモ用サンプルファイル', () => {
  it('3 ファイルすべてがファイルエラーなしで解釈でき、期待どおり仕訳される', () => {
    const files = buildSupplierDemoFiles();
    expect(files.map((f) => f.key)).toEqual(['ecovadis', 'manual', 'activity']);

    const byKey = new Map(files.map((f) => [f.key, extractSupplierCsvRows(f.content)]));

    const eco = byKey.get('ecovadis')!;
    expect(eco.fileErrors).toEqual([]);
    expect(eco.rows.filter((r) => r.skippedReason === null)).toHaveLength(4);
    expect(eco.rows.every((r) => r.dataType === 'emissions' && r.errors.length === 0)).toBe(true);

    const manual = byKey.get('manual')!;
    expect(manual.fileErrors).toEqual([]);
    const manualDetails = manual.rows.filter((r) => r.skippedReason === null);
    expect(manualDetails).toHaveLength(4);
    expect(manualDetails.every((r) => r.dataType === 'emissions' && r.errors.length === 0)).toBe(
      true,
    );
    // 合計行と注記行は除外される
    expect(manual.rows.filter((r) => r.skippedReason !== null)).toHaveLength(2);

    const activity = byKey.get('activity')!;
    expect(activity.fileErrors).toEqual([]);
    expect(activity.rows.map((r) => [r.supplierCode, r.dataType, r.amount, r.unit])).toEqual([
      ['SUP-23', 'physical', 3120, 'L'],
      ['SUP-27', 'physical', 28400, 'kWh'],
      ['SUP-28', 'physical', 2150.5, 'm3'],
      ['SUP-24', 'physical', 1480, 'kg'],
      ['SUP-29', 'monetary', 5200, '千円'],
    ]);
    expect(activity.rows.every((r) => r.errors.length === 0)).toBe(true);
  });
});
