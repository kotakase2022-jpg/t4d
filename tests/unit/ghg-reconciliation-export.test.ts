import { describe, expect, it } from 'vitest';
import { GHG_FIXED_NOTICES } from '@/components/shared/ghg-notices';
import { toXlsx } from '@/lib/exports';
import {
  buildGhgReconciliationSheets,
  GHG_RECONCILIATION_SHEET_NAMES,
  ghgReconciliationNotes,
  mainCauseLabel,
} from '@/lib/exports/ghg-reconciliation';
import { ORG_IDS, userId } from '@/lib/fixtures/dataset';
import { GHG_FIXTURE_IDS } from '@/lib/fixtures/ghg-verification';
import { createFixtureDb } from '@/lib/fixtures/store';
import { DemoDbClient } from '@/lib/repositories/demo-client';
import { loadReconciliation } from '@/lib/services/ghg/reconciliation';
import { statusLabel } from '@/lib/ui/status/registry';
import { GHG_RECON_VERDICTS, type AuthorizationContext } from '@/types/domain';

/**
 * 照合の結果の XLSX（plan E19・CR-15・unit:ghg-reconciliation-export）。
 *  - シート: 項目・原因別の寄与・確認の記録・条件・注記
 *  - 判定の語は登録簿の語。注記は画面の固定文（N3・N4、Demo は N9）と同じ文
 *  - 条件に許容差・照合の規則の版・既存結果の sha256 を残す
 *  - 利用者の入力（コメント・名前）は数式として解釈されないよう無害化する
 */

const ctx: AuthorizationContext = {
  userId: userId('reviewer@demo.local'),
  email: 'reviewer@demo.local',
  displayName: 'reviewer',
  workspace: {
    organizationId: ORG_IDS.aomi,
    organizationType: 'enterprise',
    organizationName: 'テスト',
    roleKeys: ['reviewer'],
    unitScopeIds: [],
  },
  engagementIds: [],
  demo: true,
};

async function build(options: { demo: boolean; comment?: string; label?: string }) {
  const fixture = createFixtureDb();
  const db = new DemoDbClient(fixture);
  if (options.label) fixture.ghgBaselineResults[0]!.label = options.label;
  const recon = fixture.ghgReconciliations.find((r) => r.id === GHG_FIXTURE_IDS.reconciliation)!;
  const item = recon.result!.items.find((i) => i.unitId === GHG_FIXTURE_IDS.units.vn)!;
  if (options.comment !== undefined) {
    fixture.ghgReconciliationNotes.push({
      id: '66666666-6666-4666-8666-666666666666',
      organizationId: ORG_IDS.aomi,
      reconciliationId: recon.id,
      itemKey: item.key,
      confirmedCause: 'factor',
      comment: options.comment,
      decidedBy: userId('reviewer@demo.local'),
      decidedAt: '2026-10-15T01:00:00.000Z',
      supersedesId: null,
    });
  }
  const loaded = await loadReconciliation(db, ctx, recon.id);
  const units = new Map(fixture.units.map((u) => [u.id, { code: u.code, name: u.name }]));
  const sheets = buildGhgReconciliationSheets({
    loaded: { ...loaded, items: loaded.items! },
    units,
    userNames: new Map([[userId('reviewer@demo.local'), '検見川 涼']]),
    periodLabel: '2025年（暦年）',
    demo: options.demo,
    build: 'abc1234',
    generatedAt: '2026-10-16T03:00:00.000Z',
  });
  return { sheets, loaded };
}

function cells(sheet: { columns: Array<{ value: (row: never) => unknown }>; rows: unknown[] }) {
  return sheet.rows.map((row) => sheet.columns.map((c) => c.value(row as never)));
}

describe('buildGhgReconciliationSheets', () => {
  it('5 シート。項目は照合の項目ごとに 1 行、寄与は項目×原因の数', async () => {
    const { sheets, loaded } = await build({ demo: true });
    expect(sheets.map((s) => s.name)).toEqual([...GHG_RECONCILIATION_SHEET_NAMES]);
    const [items, steps] = sheets;
    expect(items!.columns.map((c) => c.header)).toEqual([
      '拠点コード',
      '拠点',
      '区分',
      '活動',
      '月',
      '出荷番号',
      'T4D（t-CO2e）',
      '既存（t-CO2e）',
      '差（既存−T4D・t-CO2e）',
      '差率（%）',
      '判定',
      '主な原因（寄与の最大）',
      '原因不明（残差）（t-CO2e）',
      '片側のみ',
      '確認者が記録した原因',
    ]);
    expect(items!.rows).toHaveLength(loaded.items!.length);
    expect(steps!.rows).toHaveLength(loaded.items!.length * 7);
    const verdictLabels = new Set(GHG_RECON_VERDICTS.map((v) => statusLabel('ghgReconItem', v)));
    const verdictIndex = items!.columns.findIndex((c) => c.header === '判定');
    for (const row of cells(items!))
      expect(verdictLabels.has(String(row[verdictIndex]))).toBe(true);
    // 値は保存した値のまま（表示で丸め直さない）
    const diffIndex = items!.columns.findIndex((c) => c.header.startsWith('差（'));
    expect(cells(items!).map((r) => r[diffIndex])).toEqual(loaded.items!.map((i) => i.diff));
  });

  it('条件に許容差・照合の規則の版・既存結果の sha256、注記に N3・N4（Demo は N9 を先頭）', async () => {
    const { sheets, loaded } = await build({ demo: true });
    const conditions = cells(sheets[3]!).map(([item, value]) => `${item}:${value}`);
    expect(conditions).toContain(`照合の規則の版:${loaded.reconciliation.checkerVersion}`);
    expect(conditions).toContain(`既存の算定結果のファイルの sha256:${loaded.baseline.fileSha256}`);
    expect(conditions.filter((c) => c.startsWith('許容差（'))).toHaveLength(4);
    expect(conditions.find((c) => c.startsWith('許容差（Scope1）'))).toBe(
      '許容差（Scope1）:絶対値 0.05 t または 相対 0.1%',
    );
    const notes = cells(sheets[4]!).map(([note]) => note);
    expect(notes[0]).toBe(GHG_FIXED_NOTICES.N9);
    expect(notes).toContain(GHG_FIXED_NOTICES.N3);
    expect(notes).toContain(GHG_FIXED_NOTICES.N4);
    const plain = ghgReconciliationNotes({
      demo: false,
      generatedAt: '2026-10-16T03:00:00Z',
      build: 'x',
    });
    expect(plain).not.toContain(GHG_FIXED_NOTICES.N9);
    expect(plain).toContain(GHG_FIXED_NOTICES.N3);
  });

  it('確認の記録のシートに確認者・原因・コメント。利用者の入力は数式として解釈されない', async () => {
    const { sheets } = await build({ demo: false, comment: '=HYPERLINK("x")', label: '+cmd' });
    const notes = cells(sheets[2]!);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('検見川 涼');
    expect(notes[0]).toContain(statusLabel('ghgCause', 'factor'));
    expect(notes[0]).toContain(`'=HYPERLINK("x")`);
    const conditions = cells(sheets[3]!).map(([item, value]) => `${item}:${value}`);
    expect(conditions).toContain(`既存の算定結果:'+cmd`);
    const items = cells(sheets[0]!);
    expect(items.some((row) => row.includes(statusLabel('ghgCause', 'factor')))).toBe(true);
  });

  it('主な原因の語（寄与が無く残差だけなら「原因不明（残差）」）', () => {
    expect(mainCauseLabel({ mainCause: 'rounding', residual: 0 })).toBe(
      statusLabel('ghgCause', 'rounding'),
    );
    expect(mainCauseLabel({ mainCause: null, residual: 0.8 })).toBe(
      statusLabel('ghgCause', 'residual'),
    );
    expect(mainCauseLabel({ mainCause: null, residual: 0 })).toBe('—');
  });

  it('XLSX として書き出せる', async () => {
    const { sheets } = await build({ demo: true });
    const buffer = await toXlsx(sheets, 'test');
    expect(buffer.byteLength).toBeGreaterThan(1000);
  });
});
