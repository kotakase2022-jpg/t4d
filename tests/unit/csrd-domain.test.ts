import { describe, expect, it } from 'vitest';
import { CSRD_ITEM_SPECS } from '@/lib/fixtures/dataset';
import {
  CSRD_APPLICABILITY_KIND_LABEL,
  DMA_OUTCOME_LABEL,
  applicabilityLabel,
  csrdSectionOfItem,
  deriveCsrdApplicability,
  dmaOutcome,
  isCsrdInScope,
  perspectivesOf,
} from '@/lib/domain/csrd';
import type { CsrdDmaMatter, DmaAxisAssessment, EsrsTopic } from '@/types/domain';

/**
 * CSRD のダブル・マテリアリティと要求事項の適用（docs/disclosure-first.md §9.2）。
 * 適用は保存せず、要求事項コード → 節 → 事項の人の判断から毎回導出する。
 */

function matter(
  topic: EsrsTopic,
  impact: DmaAxisAssessment,
  financial: DmaAxisAssessment,
): Pick<CsrdDmaMatter, 'esrsTopic' | 'impactAssessment' | 'financialAssessment'> {
  return { esrsTopic: topic, impactAssessment: impact, financialAssessment: financial };
}

describe('要求事項コードから節を決める', () => {
  it('サンプル 12 項目の節', () => {
    const sections = Object.fromEntries(
      CSRD_ITEM_SPECS.map((spec) => [spec.code, csrdSectionOfItem({ code: spec.code })]),
    );
    expect(sections).toEqual({
      'ESRS2-GOV-1': 'ESRS2',
      'ESRS2-SBM-3': 'ESRS2',
      'ESRS-E1-1': 'E1',
      'ESRS-E1-4': 'E1',
      'ESRS-E1-5': 'E1',
      'ESRS-E1-6': 'E1',
      'ESRS-E3-4': 'E3',
      'ESRS-E5-5': 'E5',
      'ESRS-S1-6': 'S1',
      'ESRS-S1-9': 'S1',
      'ESRS-G1-1': 'G1',
      'ESRS-G1-4': 'G1',
    });
  });

  it('規則に当たらないコードは未判定（null）。存在しないテーマ・他基準のコードを推測しない', () => {
    expect(csrdSectionOfItem({ code: 'ESRS-E6-1' })).toBeNull();
    expect(csrdSectionOfItem({ code: 'ESRS-S5-1' })).toBeNull();
    expect(csrdSectionOfItem({ code: 'ESRS-G2-1' })).toBeNull();
    expect(csrdSectionOfItem({ code: '気候-10' })).toBeNull();
    expect(csrdSectionOfItem({ code: 'C6.1' })).toBeNull();
    expect(csrdSectionOfItem({ code: 'ESRS-E1' })).toBeNull();
  });
});

describe('2 軸の判断から結果を導く', () => {
  it('結果の表（どちらかが未評価なら未評価）', () => {
    expect(dmaOutcome('material', 'material')).toBe('both');
    expect(dmaOutcome('material', 'not_material')).toBe('impact_only');
    expect(dmaOutcome('not_material', 'material')).toBe('financial_only');
    expect(dmaOutcome('not_material', 'not_material')).toBe('not_material');
    expect(dmaOutcome('not_assessed', 'material')).toBe('not_assessed');
    expect(dmaOutcome('material', 'not_assessed')).toBe('not_assessed');
    expect(dmaOutcome('not_assessed', 'not_assessed')).toBe('not_assessed');
  });

  it('観点（どの観点で適用になったか）', () => {
    expect(perspectivesOf('both')).toEqual(['impact', 'financial']);
    expect(perspectivesOf('impact_only')).toEqual(['impact']);
    expect(perspectivesOf('financial_only')).toEqual(['financial']);
    expect(perspectivesOf('not_material')).toEqual([]);
    expect(perspectivesOf('not_assessed')).toEqual([]);
  });

  it('ラベルは日本語で、単一の総合点にしない', () => {
    expect(DMA_OUTCOME_LABEL).toEqual({
      both: '両面で重要',
      impact_only: 'インパクトのみ',
      financial_only: '財務のみ',
      not_material: '重要でない',
      not_assessed: '未評価',
    });
  });
});

describe('要求事項の適用', () => {
  it('ESRS 2 は事項の判断に関わらず常に適用（DMA 未確定でも暫定にしない）', () => {
    const app = deriveCsrdApplicability('ESRS2', null, false);
    expect(app).toMatchObject({ kind: 'always', perspectives: [], provisional: false });
    expect(applicabilityLabel(app)).toBe('ESRS 2（常に適用）');
    expect(isCsrdInScope(app)).toBe(true);
  });

  it('テーマ別の要求事項は、その事項が重要と人が判断したときだけ適用（観点付き）', () => {
    const both = deriveCsrdApplicability('E1', matter('E1', 'material', 'material'), true);
    expect(both).toMatchObject({
      kind: 'material',
      perspectives: ['impact', 'financial'],
      provisional: false,
    });
    expect(applicabilityLabel(both)).toBe('適用（インパクト・財務）');

    const impact = deriveCsrdApplicability('E3', matter('E3', 'material', 'not_material'), true);
    expect(applicabilityLabel(impact)).toBe('適用（インパクト）');
    const financial = deriveCsrdApplicability('G1', matter('G1', 'not_material', 'material'), true);
    expect(applicabilityLabel(financial)).toBe('適用（財務）');
    expect(isCsrdInScope(financial)).toBe(true);
  });

  it('重要でないと判断した事項の要求事項は対象外、未評価・行なしは未判定', () => {
    const notMaterial = deriveCsrdApplicability(
      'E5',
      matter('E5', 'not_material', 'not_material'),
      true,
    );
    expect(notMaterial).toMatchObject({ kind: 'not_material', perspectives: [] });
    expect(applicabilityLabel(notMaterial)).toBe('対象外（重要でない）');
    expect(isCsrdInScope(notMaterial)).toBe(false);

    const undetermined = deriveCsrdApplicability(
      'G1',
      matter('G1', 'not_assessed', 'material'),
      false,
    );
    expect(undetermined).toMatchObject({ kind: 'undetermined', provisional: true });
    expect(applicabilityLabel(undetermined)).toBe('未判定');
    expect(deriveCsrdApplicability('S4', null, false).kind).toBe('undetermined');
    expect(isCsrdInScope(undetermined)).toBe(false);
  });

  it('DMA が未確定の間は、テーマ別の適用はすべて暫定', () => {
    for (const assessment of ['material', 'not_material'] as const) {
      const app = deriveCsrdApplicability('S1', matter('S1', assessment, assessment), false);
      expect(app.provisional).toBe(true);
    }
    expect(
      deriveCsrdApplicability('S1', matter('S1', 'material', 'material'), true).provisional,
    ).toBe(false);
  });

  it('節を判定できない要求事項は未判定（適用にしない）', () => {
    const app = deriveCsrdApplicability(null, null, true);
    expect(app.kind).toBe('undetermined');
    expect(isCsrdInScope(app)).toBe(false);
  });

  it('事項が別のテーマの行なら使わない（取り違えで適用にしない）', () => {
    const app = deriveCsrdApplicability('E1', matter('E3', 'material', 'material'), true);
    expect(app.kind).toBe('undetermined');
  });

  it('理由は事項名と判断を含む', () => {
    expect(
      deriveCsrdApplicability('E1', matter('E1', 'material', 'material'), true).reason,
    ).toContain('気候変動');
    expect(deriveCsrdApplicability('ESRS2', null, true).reason).toContain('重要性に関わらず');
    expect(CSRD_APPLICABILITY_KIND_LABEL.not_material).toBe('対象外（重要でない）');
  });
});
