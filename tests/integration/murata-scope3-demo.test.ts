import { beforeEach, describe, expect, it } from 'vitest';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { EMISSION_FACTOR_SPECS, ORG_IDS, PERIOD_IDS, userId } from '@/lib/fixtures/dataset';
import { createFixtureDb, type FixtureDb } from '@/lib/fixtures/store';
import { supplierInputLabel } from '@/lib/domain/scope3-labels';
import { resolveDisplayConfidence } from '@/lib/domain/demo-confidence';
import {
  confirmSupplierImport,
  loadScope3SupplierBreakdown,
  previewSupplierImport,
  resetSupplierDemoData,
  type SupplierImportPreview,
  type SupplierRowDecision,
} from '@/lib/services/scope3-suppliers';
import {
  MURATA_DEMO_FACTORS,
  buildMurataExpectedRows,
  buildMurataExpectedTotals,
  buildMurataFileSpecs,
  buildMurataFiles,
} from '../../scripts/murata-dataset';
import type { AuthorizationContext, RoleKey } from '@/types/domain';

/**
 * 村田製作所向けデモ: 架空購買データ 20 ファイル（240 明細）の実投入検証。
 *
 * 取り込み迂回（ファイル名で完成済み結果を返す等）を作らないため、
 * ここでは生成した実バイト列を **実際のパーサーと保存処理**
 * （previewSupplierImport → confirmSupplierImport）へ通して検証する。
 *
 * 正解データは scripts/murata-dataset.ts の独立計算（アプリ出力のコピーではない）。
 * 行数の定義: 明細行 = skippedReason が null の取込対象行。合計行・注記行は含めない。
 */

let db: DemoDbClient;
let fixture: FixtureDb;

function ctxFor(email: string, roleKeys: RoleKey[]): AuthorizationContext {
  return {
    userId: userId(email),
    email,
    displayName: email,
    workspace: {
      organizationId: ORG_IDS.aomi,
      organizationType: 'enterprise',
      organizationName: '青海テクノロジー株式会社',
      roleKeys,
      unitScopeIds: [],
    },
    engagementIds: [],
    demo: true,
  };
}

const manager = () => ctxFor('sustainability@demo.local', ['sustainability_manager']);

beforeEach(() => {
  fixture = createFixtureDb();
  db = new DemoDbClient(fixture);
});

async function previewAll(): Promise<SupplierImportPreview[]> {
  const files = await buildMurataFiles();
  const previews: SupplierImportPreview[] = [];
  for (const file of files) {
    previews.push(
      await previewSupplierImport(db, manager(), PERIOD_IDS.fy2026, file.name, file.bytes),
    );
  }
  return previews;
}

/** プレビューから確定入力を作る（推薦候補は初期選択のまま・推薦なし行は EF-PUR-PACK を選択） */
function decisionsFrom(previews: SupplierImportPreview[]): SupplierRowDecision[] {
  return previews.flatMap((preview) =>
    preview.rows
      .filter((row) => row.skippedReason === null && row.errors.length === 0)
      .map((row) => {
        const factorCode =
          row.factor?.code ??
          row.recommendedFactorCode ??
          (row.needsFactorChoice ? 'EF-PUR-PACK' : null);
        return {
          supplierCode: row.supplierCode,
          item: row.item,
          dataType: row.dataType as SupplierRowDecision['dataType'],
          amount: row.amount as number,
          unit: row.unit as string,
          factorCode,
        };
      }),
  );
}

describe('村田デモ: 係数マスターとの整合', () => {
  it('独立計算に使う係数値・分母が Fixture の排出係数マスターと一致する', () => {
    const byCode = new Map(EMISSION_FACTOR_SPECS.map((f) => [f.code, f]));
    for (const [code, factor] of Object.entries(MURATA_DEMO_FACTORS)) {
      const spec = byCode.get(code);
      expect(spec, `係数 ${code} が Fixture に存在しない`).toBeDefined();
      expect(spec?.factorValue, `係数 ${code} の値`).toBe(factor.value);
      expect(spec?.activityUnit, `係数 ${code} の分母`).toBe(factor.activityUnit);
    }
  });
});

describe('村田デモ: 20 ファイルの実解析（実パーサー経由）', () => {
  it('20 ファイルすべてがエラーなく解析され、明細は過不足なく 240 行になる', async () => {
    const previews = await previewAll();
    expect(previews).toHaveLength(20);

    let detailTotal = 0;
    for (const preview of previews) {
      expect(preview.fileErrors, `${preview.fileName} のファイルエラー`).toEqual([]);
      const detail = preview.rows.filter((row) => row.skippedReason === null);
      for (const row of detail) {
        expect(row.errors, `${preview.fileName} / ${row.item}`).toEqual([]);
      }
      expect(detail, `${preview.fileName} の明細行数`).toHaveLength(12);
      detailTotal += detail.length;
    }
    expect(detailTotal).toBe(240);
  });

  it('合計行・注記行は明細として誤抽出されない（二重計上しない）', async () => {
    const files = await buildMurataFiles();
    const csv02 = files.find((f) => f.name.startsWith('02_'))!;
    const preview = await previewSupplierImport(
      db,
      manager(),
      PERIOD_IDS.fy2026,
      csv02.name,
      csv02.bytes,
    );
    const skipped = preview.rows.filter((row) => row.skippedReason !== null);
    expect(skipped.length).toBeGreaterThanOrEqual(1);
    expect(skipped[0]?.skippedReason).toContain('合計');
  });

  it('XLSX の前置き・注記の読み飛ばしは黙って落とさず、情報として返す', async () => {
    const files = await buildMurataFiles();
    const xlsx20 = files.find((f) => f.name.startsWith('20_'))!;
    const preview = await previewSupplierImport(
      db,
      manager(),
      PERIOD_IDS.fy2026,
      xlsx20.name,
      xlsx20.bytes,
    );
    expect(preview.fileErrors).toEqual([]);
    // 前置き 2 行の読み飛ばしと、末尾注記のフッター扱いが通知される
    expect(preview.fileNotes.some((note) => note.includes('読み飛ばし'))).toBe(true);
    expect(preview.fileNotes.some((note) => note.includes('フッター'))).toBe(true);
  });

  it('係数の解決: コード記載は照合、候補行は推薦つき、推薦なし行は人の選択待ちになる', async () => {
    const previews = await previewAll();
    const byFile = new Map(previews.map((p) => [p.fileName, p]));

    // 03: ニッケル（生産国一致 → NI-JP ／ 海外 → 世界平均 NI-GLB）
    const nickel = byFile.get('03_深山金属粉体_purchase_ledger_FY2025.xlsx')!;
    const npRow = nickel.rows.find((r) => r.item.includes('NP-20'))!;
    expect(npRow.needsFactorChoice).toBe(true);
    expect(npRow.recommendedFactorCode).toBe('DEMO-EF-NI-JP-KG');
    expect(npRow.factorCandidates.map((c) => c.code).sort()).toEqual([
      'DEMO-EF-NI-GLB-KG',
      'DEMO-EF-NI-JP-KG',
    ]);
    const npReason = npRow.factorCandidates.find((c) => c.recommended)?.reason ?? '';
    expect(npReason).toContain('生産国一致');
    const overseas = nickel.rows.find((r) => r.item.includes('NP-80'))!;
    expect(overseas.recommendedFactorCode).toBe('DEMO-EF-NI-GLB-KG');

    // 15: セラミック基板は 3 候補（CERSUB / PCB-CN / PCB-GLB）
    const pcb = byFile.get('15_深圳華聯電路板_納入実績_FY2025.xlsx')!;
    const ceramic = pcb.rows.find((r) => r.item.includes('セラミック基板'))!;
    expect(ceramic.factorCandidates).toHaveLength(3);
    expect(ceramic.recommendedFactorCode).toBe('DEMO-EF-CERSUB-CN-M2');

    // 19: 副資材（金額）は推薦なし → 人の選択待ち（default では確定に数えない）
    const box = byFile.get('19_みずほ紙器工業_納品実績_FY2025.xlsx')!;
    const misc = box.rows.find((r) => r.item.includes('副資材一式（上期）'))!;
    expect(misc.needsFactorChoice).toBe(true);
    expect(misc.recommendedFactorCode).toBeNull();
    expect(misc.factorCandidates.length).toBeGreaterThanOrEqual(2);

    // 20: 係数コード空欄でも品目・単位（外注加工 × 千円）から一意に決まる
    const machining = byFile.get('20_播磨精密加工サービス_加工費請求明細_2025年度.xlsx')!;
    const auto = machining.rows.find((r) => r.item.includes('追加試作'))!;
    expect(auto.factorResolution).toBe('unit');
    expect(auto.factor?.code).toBe('DEMO-EF-MACHINING-JP-KJPY');
  });

  it('実測スコアはデモ表示で 80〜97% に収まり、90〜96% 中心の分布になる', async () => {
    const previews = await previewAll();
    const displays: number[] = [];
    for (const preview of previews) {
      for (const row of preview.rows) {
        if (row.skippedReason !== null || row.errors.length > 0) continue;
        expect(row.rawConfidence, `${preview.fileName} / ${row.item}`).not.toBeNull();
        const key = `supplier|${preview.fileName}|${row.supplierCode}|${row.item}|${row.dataType ?? ''}|${row.amountRaw}|${row.unit ?? ''}`;
        const resolved = resolveDisplayConfidence('demo', row.rawConfidence, key);
        expect(resolved.source).toBe('demo_simulated');
        displays.push(resolved.display as number);
      }
    }
    expect(displays).toHaveLength(240);
    for (const value of displays) {
      expect(value).toBeGreaterThanOrEqual(0.8);
      expect(value).toBeLessThanOrEqual(0.97);
    }
    const pct = displays.map((v) => Math.round(v * 100));
    const core = pct.filter((v) => v >= 90 && v <= 96).length;
    expect(core / pct.length).toBeGreaterThan(0.6); // 90〜96 中心
    expect(pct.some((v) => v <= 89)).toBe(true); // 一部は 80 台
    expect(pct.some((v) => v >= 97)).toBe(true); // 一部は 97
    expect(new Set(pct).size).toBeGreaterThan(3); // 全件同一の固定値ではない
  });
});

describe('村田デモ: 確定と算定の照合（独立計算の正解データと一致）', () => {
  it('240 明細を確定すると、行別排出量・合計が独立計算と一致する', async () => {
    const ctx = manager();
    const previews = await previewAll();
    const decisions = decisionsFrom(previews);
    expect(decisions).toHaveLength(240);

    const result = await confirmSupplierImport(db, ctx, PERIOD_IDS.fy2026, decisions);
    const totals = buildMurataExpectedTotals();
    // 既存デモの提出済み 13 社（143.1 t-CO2e）は保持されたまま加算される
    expect(result.result).toBe(Math.round((143.1 + totals.grandTotal) * 10) / 10);
    expect(result.addedSuppliers).toHaveLength(20);
    expect(result.replacedSuppliers).toEqual([]);

    // 行別の照合（ラベル規約で引き当て）
    const breakdown = await loadScope3SupplierBreakdown(db, ctx, PERIOD_IDS.fy2026);
    const supplierByCode = new Map(breakdown.suppliers.map((s) => [s.code, s] as const));
    for (const expected of buildMurataExpectedRows()) {
      const supplier = supplierByCode.get(expected.supplierCode);
      const input = supplier?.inputs.find((i) => i.item === expected.item);
      expect(input, `${expected.supplierCode} / ${expected.item}`).toBeDefined();
      expect(input?.value, `${expected.supplierCode} / ${expected.item} の排出量`).toBe(
        expected.emissions,
      );
    }
  });

  it('同じ 20 ファイルの二重投入は置き換えになり、黙って二重計上しない', async () => {
    const ctx = manager();
    const decisions = decisionsFrom(await previewAll());
    const first = await confirmSupplierImport(db, ctx, PERIOD_IDS.fy2026, decisions);

    // 再投入前のプレビューは「既存の内訳を置き換え」と明示する
    const secondPreviews = await previewAll();
    const flagged = secondPreviews
      .flatMap((p) => p.rows)
      .filter((r) => r.skippedReason === null && r.replacesExisting);
    expect(flagged).toHaveLength(240);

    const second = await confirmSupplierImport(db, ctx, PERIOD_IDS.fy2026, decisions);
    expect(second.replacedSuppliers).toHaveLength(20);
    expect(second.addedSuppliers).toEqual([]);
    expect(second.result).toBe(first.result); // 合計は変わらない（二重計上なし）
  });

  it('候補の係数を変更して確定すると、その係数で再計算される', async () => {
    const ctx = manager();
    const previews = await previewAll();
    const decisions = decisionsFrom(previews).map((d) =>
      d.item === 'ニッケル超微粉 NP-20（試作グレード）'
        ? { ...d, factorCode: 'DEMO-EF-NI-GLB-KG' } // 推薦（NI-JP）から世界平均へ変更
        : d,
    );
    await confirmSupplierImport(db, ctx, PERIOD_IDS.fy2026, decisions);
    const breakdown = await loadScope3SupplierBreakdown(db, ctx, PERIOD_IDS.fy2026);
    const input = breakdown.suppliers
      .find((s) => s.code === 'SUP-33')
      ?.inputs.find((i) => i.item === 'ニッケル超微粉 NP-20（試作グレード）');
    expect(input?.value).toBe(Math.round(1450 * 0.0125 * 10) / 10); // 18.1
  });
});

describe('村田デモ: リセットと再現性', () => {
  it('リセットは取込で積んだ算定版だけを削除し、初期版と他データは残す', async () => {
    const ctx = manager();
    const decisions = decisionsFrom(await previewAll());
    await confirmSupplierImport(db, ctx, PERIOD_IDS.fy2026, decisions);
    expect(fixture.calculations).toHaveLength(2);
    const dataPointsBefore = fixture.dataPoints.length;
    const approvalsBefore = fixture.approvals.length;

    const result = await resetSupplierDemoData(db, ctx, PERIOD_IDS.fy2026);
    expect(result.removedCalculations).toBe(1);
    expect(fixture.calculations).toHaveLength(1); // 初期版（Fixture v1）は残る
    expect(fixture.dataPoints).toHaveLength(dataPointsBefore);
    expect(fixture.approvals).toHaveLength(approvalsBefore);

    const breakdown = await loadScope3SupplierBreakdown(db, ctx, PERIOD_IDS.fy2026);
    expect(breakdown.breakdownTotal).toBe(143.1); // 初期状態へ戻る（内訳合計）
  });

  it('リセット → 同じ 20 ファイルを再投入すると同じ結果になる', async () => {
    const ctx = manager();
    const first = await confirmSupplierImport(
      db,
      ctx,
      PERIOD_IDS.fy2026,
      decisionsFrom(await previewAll()),
    );
    await resetSupplierDemoData(db, ctx, PERIOD_IDS.fy2026);
    const second = await confirmSupplierImport(
      db,
      ctx,
      PERIOD_IDS.fy2026,
      decisionsFrom(await previewAll()),
    );
    expect(second.result).toBe(first.result);
    expect(second.inputCount).toBe(first.inputCount);
  });

  it('積んだ版が無いときのリセットは 0 件削除で安全に終わる', async () => {
    const result = await resetSupplierDemoData(db, manager(), PERIOD_IDS.fy2026);
    expect(result.removedCalculations).toBe(0);
    expect(fixture.calculations).toHaveLength(1);
  });

  it('リセットは Demo Mode 専用で、Supabase クライアントでは実行できない', async () => {
    // instanceof DemoDbClient のガードが唯一の防壁（追記専用テーブルの物理削除経路を
    // 実運用 DB へ開かない）。DbClient 契約だけ満たす偽クライアントで検証する
    const supabaseLike = { mode: 'supabase' } as unknown as Parameters<
      typeof resetSupplierDemoData
    >[0];
    await expect(resetSupplierDemoData(supabaseLike, manager(), PERIOD_IDS.fy2026)).rejects.toThrow(
      'Demo Mode 専用',
    );
  });
});

describe('村田デモ: ファイル仕様の妥当性', () => {
  it('形式は XLSX 14 / CSV 6、期間は 2025-04〜2026-03 に収まる', () => {
    const specs = buildMurataFileSpecs();
    expect(specs.filter((s) => s.format === 'xlsx')).toHaveLength(14);
    expect(specs.filter((s) => s.format === 'csv')).toHaveLength(6);
    for (const spec of specs) {
      for (const row of spec.rows) {
        expect(
          row.month >= '2025-04' && row.month <= '2026-03',
          `${spec.fileName} ${row.month}`,
        ).toBe(true);
      }
    }
  });

  it('品目ラベル（サプライヤー×品目）は 240 行すべて一意で、確定の重複ガードに当たらない', () => {
    const specs = buildMurataFileSpecs();
    const labels = new Set<string>();
    for (const spec of specs) {
      for (const row of spec.rows) {
        const label = supplierInputLabel(
          { code: spec.supplierCode, name: spec.supplierName } as never,
          row.item,
        );
        expect(labels.has(label), label).toBe(false);
        labels.add(label);
      }
    }
    expect(labels.size).toBe(240);
  });
});
