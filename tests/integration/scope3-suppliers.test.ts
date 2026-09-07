import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { ORG_IDS, PERIOD_IDS, UNIT_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import {
  confirmSupplierImport,
  loadScope3SupplierBreakdown,
  previewSupplierImport,
} from '@/lib/services/scope3-suppliers';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * Scope3 Cat.1 のサプライヤー内訳と、サプライヤーデータ取込の確定。
 *
 * 確かめたいこと:
 *  - 内訳はサプライヤー Unit（unitType: 'supplier'）ごとに集計され、
 *    最新の算定内訳に載っていない社は「未提出」になる
 *  - 取込の確定は data_point_calculations へ**追記**する（既存版は書き換えない = 追記専用 RLS と整合）
 *  - 同じ社の再提出は最新版の中でだけ置き換わる（履歴は旧版に残る）
 *  - Data Point の確定値そのものは変更しない（確定は承認フローで行う）
 *  - enterprise.data.write の無いロールでは確定できない
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

describe('Scope3 サプライヤー内訳', () => {
  it('提出済み 5 社と未提出 2 社を区別して返す', async () => {
    const breakdown = await loadScope3SupplierBreakdown(db, manager(), PERIOD_IDS.fy2026);

    expect(breakdown.suppliers).toHaveLength(7);
    const submitted = breakdown.suppliers.filter((s) => s.submitted);
    expect(submitted.map((s) => s.code)).toEqual([
      'SUP-01',
      'SUP-02',
      'SUP-03',
      'SUP-04',
      'SUP-05',
    ]);
    expect(breakdown.suppliers.filter((s) => !s.submitted).map((s) => s.code)).toEqual([
      'SUP-06',
      'SUP-07',
    ]);
    // Fixture の算定内訳（上位 5 社）の合計
    expect(breakdown.primaryTotal).toBe(53.3);
    // 構成比は提出済みの社にだけ付き、合計はおおむね 100% になる
    const shareSum = submitted.reduce((sum, s) => sum + (s.sharePercent ?? 0), 0);
    expect(shareSum).toBeGreaterThan(99);
    expect(shareSum).toBeLessThan(101);
    // Data Point の確定値（金額ベース推計込み）と一次データは別物として返す
    expect(breakdown.dataPoint?.value).toBe(50620.5);
    expect(breakdown.calculationCount).toBe(1);
  });
});

describe('サプライヤーデータ取込の確定', () => {
  it('未提出サプライヤーの行を追記し、新しい算定版を作る', async () => {
    const ctx = manager();
    const result = await confirmSupplierImport(db, ctx, PERIOD_IDS.fy2026, [
      {
        supplierCode: 'SUP-06',
        item: '金属筐体',
        amountThousandJpy: 12400,
        factorCode: 'EF-PUR-METAL',
      },
    ]);

    // 12,400 千円 × 0.00063 = 7.812 → 7.8 t-CO2e
    expect(result.addedSuppliers).toEqual(['SUP-06']);
    expect(result.replacedSuppliers).toEqual([]);
    expect(result.result).toBe(61.1);

    const breakdown = await loadScope3SupplierBreakdown(db, ctx, PERIOD_IDS.fy2026);
    expect(breakdown.calculationCount).toBe(2);
    const sup6 = breakdown.suppliers.find((s) => s.code === 'SUP-06');
    expect(sup6?.submitted).toBe(true);
    expect(sup6?.total).toBe(7.8);
    // 旧版は書き換えず残る（追記専用）
    expect(fixture.calculations).toHaveLength(2);
    // Data Point の確定値は変えない
    expect(breakdown.dataPoint?.value).toBe(50620.5);
  });

  it('同じ社の再提出は最新版の中で置き換わる', async () => {
    const ctx = manager();
    const result = await confirmSupplierImport(db, ctx, PERIOD_IDS.fy2026, [
      {
        supplierCode: 'SUP-01',
        item: '精密加工部品',
        amountThousandJpy: 50000,
        factorCode: 'EF-PUR-ELEC',
      },
    ]);

    // 50,000 千円 × 0.00042 = 21.0。旧 SUP-01（18.0）が置き換わり 53.3 − 18.0 + 21.0 = 56.3
    expect(result.replacedSuppliers).toEqual(['SUP-01']);
    expect(result.result).toBe(56.3);

    const breakdown = await loadScope3SupplierBreakdown(db, ctx, PERIOD_IDS.fy2026);
    const sup1 = breakdown.suppliers.find((s) => s.code === 'SUP-01');
    expect(sup1?.total).toBe(21);
    expect(sup1?.inputs).toHaveLength(1);
  });

  it('存在しないコードや不正な金額は確定前にまとめて弾く', async () => {
    await expect(
      confirmSupplierImport(db, manager(), PERIOD_IDS.fy2026, [
        { supplierCode: 'SUP-99', item: 'x', amountThousandJpy: 100, factorCode: 'EF-LOGI' },
      ]),
    ).rejects.toThrow(/SUP-99/);

    await expect(
      confirmSupplierImport(db, manager(), PERIOD_IDS.fy2026, [
        { supplierCode: 'SUP-06', item: 'x', amountThousandJpy: -5, factorCode: 'EF-LOGI' },
      ]),
    ).rejects.toThrow(/金額/);

    await expect(
      confirmSupplierImport(db, manager(), PERIOD_IDS.fy2026, [
        { supplierCode: 'SUP-06', item: 'x', amountThousandJpy: 100, factorCode: 'EF-XXX' },
      ]),
    ).rejects.toThrow(/EF-XXX/);

    // どの行も書かれていない（全件事前検証）
    expect(fixture.calculations).toHaveLength(1);
  });

  it('enterprise.data.write の無いロールでは確定できない', async () => {
    await expect(
      confirmSupplierImport(db, reviewer(), PERIOD_IDS.fy2026, [
        {
          supplierCode: 'SUP-06',
          item: '金属筐体',
          amountThousandJpy: 12400,
          factorCode: 'EF-PUR-METAL',
        },
      ]),
    ).rejects.toThrow();
    expect(fixture.calculations).toHaveLength(1);
  });

  it('enterprise.import.run の無いロール（supplier_contributor）では確定できない', async () => {
    // data.write は持つが import.run を持たない。プレビュー・テンプレートと同じ門を確定にも掛ける
    await expect(
      confirmSupplierImport(db, supplierContributor(), PERIOD_IDS.fy2026, [
        {
          supplierCode: 'SUP-06',
          item: '金属筐体',
          amountThousandJpy: 12400,
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
          amountThousandJpy: 12400,
          factorCode: 'EF-PUR-METAL',
        },
      ]),
    ).rejects.toThrow(/担当外/);
    expect(fixture.calculations).toHaveLength(1);
  });

  it('金額（千円）ベースでない係数コード（EF-ELEC-JP）は確定できない', async () => {
    // 算定式 Σ(購買金額[千円] × 係数[t-CO2e/千円]) と次元の合わない係数を混ぜない
    await expect(
      confirmSupplierImport(db, manager(), PERIOD_IDS.fy2026, [
        {
          supplierCode: 'SUP-06',
          item: '電力',
          amountThousandJpy: 12400,
          factorCode: 'EF-ELEC-JP',
        },
      ]),
    ).rejects.toThrow(/EF-ELEC-JP/);
    expect(fixture.calculations).toHaveLength(1);
  });

  it('サプライヤーを改名しても、再提出は置き換えになる（コードで突き合わせる）', async () => {
    const ctx = manager();
    // 組織マスターでの改名を模す（コードは不変）
    const sup1 = fixture.units.find((u) => u.code === 'SUP-01');
    expect(sup1).toBeDefined();
    sup1!.name = '常盤精密ホールディングス';

    const result = await confirmSupplierImport(db, ctx, PERIOD_IDS.fy2026, [
      {
        supplierCode: 'SUP-01',
        item: '精密加工部品',
        amountThousandJpy: 50000,
        factorCode: 'EF-PUR-ELEC',
      },
    ]);

    // 旧名で書かれた旧ラベルの行も SUP-01 として置き換わり、二重計上にならない
    expect(result.replacedSuppliers).toEqual(['SUP-01']);
    expect(result.result).toBe(56.3);

    const breakdown = await loadScope3SupplierBreakdown(db, ctx, PERIOD_IDS.fy2026);
    const entry = breakdown.suppliers.find((s) => s.code === 'SUP-01');
    expect(entry?.name).toBe('常盤精密ホールディングス');
    expect(entry?.inputs).toHaveLength(1);
    expect(entry?.total).toBe(21);
  });
});

describe('サプライヤーデータ取込のプレビュー', () => {
  it('CSV をサプライヤー・係数マスターと突き合わせて排出量を計算する', async () => {
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
    expect(sup6?.emissions).toBe(7.8);
    expect(sup6?.replacesExisting).toBe(false);
    expect(sup6?.errors).toEqual([]);

    // 既に提出済みの社は「上書きになる」ことをプレビューで伝える
    expect(preview.rows[1]?.replacesExisting).toBe(true);

    // 見つからないコードは行エラー
    expect(preview.rows[2]?.errors.join('')).toContain('SUP-99');
    expect(preview.validCount).toBe(2);
  });
});
