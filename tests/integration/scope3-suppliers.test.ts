import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import {
  confirmSupplierImport,
  loadScope3SupplierBreakdown,
  previewSupplierImport,
  relinkSupplierFactor,
} from '@/lib/services/scope3-suppliers';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * Scope3 Cat.1 のサプライヤー内訳と、一次データ（排出量・物理量・金額）取込の確定。
 *
 * 確かめたいこと:
 *  - 内訳は 30 社のサプライヤー Unit ごとに集計され、Fixture では 13 社が提出済み
 *    （金額 5 社・物理量 5 社・報告排出量 3 社）
 *  - 取込の確定は data_point_calculations へ**追記**する（追記専用 RLS と整合）
 *  - 同じ社の再提出は最新版の中でだけ置き換わる（履歴は旧版に残る）
 *  - 原単位（排出係数）は 単位から自動解決・過去実績から学習・複数候補は人が選ぶ
 *  - 原単位の再紐づけは対象行だけ再計算した新しい版を積む
 *  - Data Point の確定値そのものは変更しない／権限の門は取込と同じ
 */

let db: DemoDbClient;
let fixture: FixtureDb;

function ctxFor(
  email: string,
  roleKeys: RoleKey[],
  unitScopeIds: string[] = [],
): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds,
    },
    engagementIds: [],
    demo: true,
  };
}

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);
const reviewer = () => ctxFor('reviewer@demo.local', ['reviewer']);
// ロール判定は ctx の roleKeys だけを見るため、実在するデモユーザーの ID を借りる
const supplierContributor = () => ctxFor('site-user@demo.local', ['supplier_contributor']);
const eastScopedContributor = () =>
  ctxFor('site-user@demo.local', ['site_contributor'], [UNIT_IDS.east]);

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

describe('Scope3 サプライヤー内訳（50 社）', () => {
  it('提出済み 13 社（金額・物理量・報告排出量の混在）と未提出 37 社を区別して返す', async () => {
    const breakdown = await loadScope3SupplierBreakdown(db, manager(), PERIOD_IDS.fy2026);

    // 30 社デモ + 村田デモ用の架空サプライヤー SUP-31〜50
    expect(breakdown.suppliers).toHaveLength(50);
    const submitted = breakdown.suppliers.filter((s) => s.submitted);
    expect(submitted.map((s) => s.code)).toEqual([
      'SUP-01',
      'SUP-02',
      'SUP-03',
      'SUP-04',
      'SUP-05',
      'SUP-08',
      'SUP-09',
      'SUP-10',
      'SUP-11',
      'SUP-12',
      'SUP-13',
      'SUP-14',
      'SUP-15',
    ]);
    expect(breakdown.suppliers.filter((s) => !s.submitted)).toHaveLength(37);

    // 一次データ合計 = 金額 53.3 + 物理量 61.0 + 報告排出量 28.8
    expect(breakdown.primaryTotal).toBe(143.1);
    expect(breakdown.dataPoint?.value).toBe(50620.5);
    expect(breakdown.calculationCount).toBe(1);

    // 物理量の行は活動量が構造化されて残る（再紐づけの前提）
    const sup8 = breakdown.suppliers.find((s) => s.code === 'SUP-08');
    expect(sup8?.inputs[0]).toMatchObject({ activityAmount: 42000, activityUnit: 'kWh' });
    // 報告排出量の行は活動量を持たない
    const sup13 = breakdown.suppliers.find((s) => s.code === 'SUP-13');
    expect(sup13?.inputs[0]).toMatchObject({ activityAmount: null, factorId: null, value: 12.4 });
  });
});

describe('サプライヤーデータ取込の確定（3 種別）', () => {
  it('金額データ: 未提出サプライヤーの行を追記し、新しい算定版を作る', async () => {
    const ctx = manager();
    const result = await confirmSupplierImport(db, ctx, PERIOD_IDS.fy2026, [
      {
        supplierCode: 'SUP-06',
        item: '金属筐体',
        dataType: 'monetary',
        amount: 12400,
        unit: '千円',
        factorCode: 'EF-PUR-METAL',
      },
    ]);

    // 12,400 千円 × 0.00063 = 7.812 → 7.8 t-CO2e。143.1 + 7.8 = 150.9
    expect(result.addedSuppliers).toEqual(['SUP-06']);
    expect(result.result).toBe(150.9);

    const breakdown = await loadScope3SupplierBreakdown(db, ctx, PERIOD_IDS.fy2026);
    expect(breakdown.calculationCount).toBe(2);
    expect(fixture.calculations).toHaveLength(2);
    expect(breakdown.dataPoint?.value).toBe(50620.5);
  });

  it('物理データ: 活動量 × 物理量ベース原単位で排出量が計算される', async () => {
    const result = await confirmSupplierImport(db, manager(), PERIOD_IDS.fy2026, [
      {
        supplierCode: 'SUP-26',
        item: '購入電力',
        dataType: 'physical',
        amount: 1000,
        unit: 'kWh',
        factorCode: 'EF-ELEC-JP',
      },
    ]);
    // 1,000 kWh × 0.000434 = 0.434 → 0.4。143.1 + 0.4 = 143.5
    expect(result.result).toBe(143.5);
  });

  it('排出量データ: 係数なしで報告値をそのまま追記する', async () => {
    const ctx = manager();
    const result = await confirmSupplierImport(db, ctx, PERIOD_IDS.fy2026, [
      {
        supplierCode: 'SUP-30',
        item: '報告排出量',
        dataType: 'emissions',
        amount: 5.5,
        unit: 't-CO2e',
        factorCode: null,
      },
    ]);
    expect(result.result).toBe(148.6);

    const breakdown = await loadScope3SupplierBreakdown(db, ctx, PERIOD_IDS.fy2026);
    const sup30 = breakdown.suppliers.find((s) => s.code === 'SUP-30');
    expect(sup30?.inputs[0]).toMatchObject({ value: 5.5, activityAmount: null, factorId: null });
  });

  it('同じ社の再提出は最新版の中で置き換わる', async () => {
    const result = await confirmSupplierImport(db, manager(), PERIOD_IDS.fy2026, [
      {
        supplierCode: 'SUP-01',
        item: '精密加工部品',
        dataType: 'monetary',
        amount: 50000,
        unit: '千円',
        factorCode: 'EF-PUR-ELEC',
      },
    ]);
    // 旧 SUP-01（18.0）が 21.0 に置き換わり 143.1 − 18.0 + 21.0 = 146.1
    expect(result.replacedSuppliers).toEqual(['SUP-01']);
    expect(result.result).toBe(146.1);
  });

  it('単位と合わない係数コードは確定前にまとめて弾く', async () => {
    await expect(
      confirmSupplierImport(db, manager(), PERIOD_IDS.fy2026, [
        {
          supplierCode: 'SUP-06',
          item: '電力',
          dataType: 'monetary',
          amount: 12400,
          unit: '千円',
          factorCode: 'EF-ELEC-JP',
        },
      ]),
    ).rejects.toThrow(/EF-ELEC-JP/);

    await expect(
      confirmSupplierImport(db, manager(), PERIOD_IDS.fy2026, [
        {
          supplierCode: 'SUP-99',
          item: 'x',
          dataType: 'monetary',
          amount: 100,
          unit: '千円',
          factorCode: 'EF-LOGI',
        },
      ]),
    ).rejects.toThrow(/SUP-99/);

    // どの行も書かれていない（全件事前検証）
    expect(fixture.calculations).toHaveLength(1);
  });

  it('enterprise.data.write の無いロールでは確定できない', async () => {
    await expect(
      confirmSupplierImport(db, reviewer(), PERIOD_IDS.fy2026, [
        {
          supplierCode: 'SUP-06',
          item: '金属筐体',
          dataType: 'monetary',
          amount: 12400,
          unit: '千円',
          factorCode: 'EF-PUR-METAL',
        },
      ]),
    ).rejects.toThrow();
    expect(fixture.calculations).toHaveLength(1);
  });

  it('enterprise.import.run の無いロール（supplier_contributor）では確定できない', async () => {
    await expect(
      confirmSupplierImport(db, supplierContributor(), PERIOD_IDS.fy2026, [
        {
          supplierCode: 'SUP-06',
          item: '金属筐体',
          dataType: 'monetary',
          amount: 12400,
          unit: '千円',
          factorCode: 'EF-PUR-METAL',
        },
      ]),
    ).rejects.toThrow(/enterprise\.import\.run/);
    expect(fixture.calculations).toHaveLength(1);
  });

  it('担当 Unit スコープ外（東日本工場担当）は本社の算定根拠を書き換えられない', async () => {
    await expect(
      confirmSupplierImport(db, eastScopedContributor(), PERIOD_IDS.fy2026, [
        {
          supplierCode: 'SUP-06',
          item: '金属筐体',
          dataType: 'monetary',
          amount: 12400,
          unit: '千円',
          factorCode: 'EF-PUR-METAL',
        },
      ]),
    ).rejects.toThrow(/担当外/);
    expect(fixture.calculations).toHaveLength(1);
  });

  it('同じサプライヤー×品目の重複行は確定前に弾く（再紐づけの識別子が壊れるため）', async () => {
    await expect(
      confirmSupplierImport(db, manager(), PERIOD_IDS.fy2026, [
        {
          supplierCode: 'SUP-06',
          item: '金属筐体',
          dataType: 'monetary',
          amount: 8000,
          unit: '千円',
          factorCode: 'EF-PUR-METAL',
        },
        {
          supplierCode: 'SUP-06',
          item: '金属筐体',
          dataType: 'monetary',
          amount: 4400,
          unit: '千円',
          factorCode: 'EF-PUR-METAL',
        },
      ]),
    ).rejects.toThrow(/重複/);
    expect(fixture.calculations).toHaveLength(1);
  });

  it('サプライヤーを改名しても、再提出は置き換えになる（コードで突き合わせる）', async () => {
    const ctx = manager();
    const sup1 = fixture.units.find((u) => u.code === 'SUP-01');
    expect(sup1).toBeDefined();
    sup1!.name = '常盤精密ホールディングス';

    const result = await confirmSupplierImport(db, ctx, PERIOD_IDS.fy2026, [
      {
        supplierCode: 'SUP-01',
        item: '精密加工部品',
        dataType: 'monetary',
        amount: 50000,
        unit: '千円',
        factorCode: 'EF-PUR-ELEC',
      },
    ]);

    expect(result.replacedSuppliers).toEqual(['SUP-01']);
    expect(result.result).toBe(146.1);
  });
});

describe('原単位（排出係数）の自動解決と紐づけ', () => {
  it('プレビュー: 単位から一意なら自動解決、kg のように複数候補なら紐づけ待ちになる', async () => {
    const csv = [
      'サプライヤーコード,品目,データ種別,数値,単位,排出係数コード',
      'SUP-27,購入電力,物理量,28400,kWh,',
      'SUP-24,梱包材,物理量,1480,kg,',
    ].join('\n');
    const preview = await previewSupplierImport(
      db,
      manager(),
      PERIOD_IDS.fy2026,
      'activity.csv',
      new TextEncoder().encode(csv),
    );

    expect(preview.fileErrors).toEqual([]);
    // kWh は EF-ELEC-JP のみ → 自動解決
    expect(preview.rows[0]).toMatchObject({
      needsFactorChoice: false,
      factorResolution: 'unit',
    });
    expect(preview.rows[0]?.factor?.code).toBe('EF-ELEC-JP');
    expect(preview.rows[0]?.emissions).toBe(12.3);
    // kg は鋼材・アルミの 2 候補 → 人の紐づけ待ち
    expect(preview.rows[1]?.needsFactorChoice).toBe(true);
    expect(preview.rows[1]?.factorCandidates.map((c) => c.code).sort()).toEqual([
      'EF-ALU-KG',
      'EF-STEEL-KG',
    ]);
    expect(preview.needsMappingCount).toBe(1);
    expect(preview.validCount).toBe(1);
  });

  it('プレビュー: 過去に確定した同じ社×品目×単位の原単位を学習して自動適用する', async () => {
    const ctx = manager();
    await confirmSupplierImport(db, ctx, PERIOD_IDS.fy2026, [
      {
        supplierCode: 'SUP-24',
        item: '梱包材',
        dataType: 'physical',
        amount: 1480,
        unit: 'kg',
        factorCode: 'EF-STEEL-KG',
      },
    ]);

    const csv = [
      'サプライヤーコード,品目,データ種別,数値,単位,排出係数コード',
      'SUP-24,梱包材,物理量,2000,kg,',
    ].join('\n');
    const preview = await previewSupplierImport(
      db,
      ctx,
      PERIOD_IDS.fy2026,
      'again.csv',
      new TextEncoder().encode(csv),
    );

    expect(preview.rows[0]).toMatchObject({
      needsFactorChoice: false,
      factorResolution: 'learned',
    });
    expect(preview.rows[0]?.factor?.code).toBe('EF-STEEL-KG');
  });

  it('再紐づけ: 対象行だけ再計算した新しい版を積み、履歴は残る', async () => {
    const ctx = manager();
    // SUP-11 鋼材 5,200 kg は EF-STEEL-KG（10.9）。アルミ係数へ紐づけ直すと 46.8
    const result = await relinkSupplierFactor(db, ctx, PERIOD_IDS.fy2026, {
      supplierCode: 'SUP-11',
      item: '鋼材',
      factorCode: 'EF-ALU-KG',
    });

    expect(result.value).toBe(46.8);
    expect(result.relinkedCount).toBe(1);
    // 143.1 − 10.9 + 46.8 = 179.0
    expect(result.result).toBe(179);
    expect(fixture.calculations).toHaveLength(2);

    const breakdown = await loadScope3SupplierBreakdown(db, ctx, PERIOD_IDS.fy2026);
    expect(breakdown.calculationCount).toBe(2);
    const sup11 = breakdown.suppliers.find((s) => s.code === 'SUP-11');
    expect(sup11?.inputs[0]?.value).toBe(46.8);
  });

  it('再紐づけ: 報告排出量の行（活動量なし）は対象外', async () => {
    await expect(
      relinkSupplierFactor(db, manager(), PERIOD_IDS.fy2026, {
        supplierCode: 'SUP-13',
        item: '報告排出量（EcoVadis）',
        factorCode: 'EF-ALU-KG',
      }),
    ).rejects.toThrow(/再紐づけできません|対象外/);
    expect(fixture.calculations).toHaveLength(1);
  });

  it('再紐づけ: 単位の合わない係数は拒否する', async () => {
    await expect(
      relinkSupplierFactor(db, manager(), PERIOD_IDS.fy2026, {
        supplierCode: 'SUP-11',
        item: '鋼材',
        factorCode: 'EF-ELEC-JP',
      }),
    ).rejects.toThrow(/EF-ELEC-JP/);
    expect(fixture.calculations).toHaveLength(1);
  });
});

describe('サプライヤーデータ取込のプレビュー（旧形式との互換）', () => {
  it('旧形式 CSV をマスターと突き合わせて排出量を計算する', async () => {
    const csv = [
      'サプライヤーコード,品目,購買金額(千円),排出係数コード',
      'SUP-06,金属筐体,12400,EF-PUR-METAL',
      'SUP-01,精密加工部品,50000,EF-PUR-ELEC',
      'SUP-99,不明な社,100,EF-LOGI',
    ].join('\n');
    const preview = await previewSupplierImport(
      db,
      manager(),
      PERIOD_IDS.fy2026,
      'supplier.csv',
      new TextEncoder().encode(csv),
    );

    expect(preview.fileErrors).toEqual([]);
    expect(preview.rows).toHaveLength(3);

    const sup6 = preview.rows[0];
    expect(sup6?.supplierName).toBe('若草金属工業');
    expect(sup6?.dataType).toBe('monetary');
    expect(sup6?.emissions).toBe(7.8);
    expect(sup6?.factorResolution).toBe('row');
    expect(sup6?.replacesExisting).toBe(false);
    expect(sup6?.errors).toEqual([]);

    // 既に提出済みの社は「上書きになる」ことをプレビューで伝える
    expect(preview.rows[1]?.replacesExisting).toBe(true);

    // 見つからないコードは行エラー
    expect(preview.rows[2]?.errors.join('')).toContain('SUP-99');
    expect(preview.validCount).toBe(2);
  });
});
