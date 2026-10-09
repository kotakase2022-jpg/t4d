import { describe, expect, it } from 'vitest';
import { createFixtureDb } from '@/lib/fixtures/store';
import { XBRL_SAMPLE_PACKAGE_ID } from '@/lib/fixtures/trial-ids';
import {
  SAMPLE_TAXONOMY_NAMESPACE,
  SAMPLE_TAXONOMY_PREFIX,
  SAMPLE_UNIT_RULES,
  isSampleNamespace,
} from '@/lib/xbrl/sample-taxonomy';
import {
  axesOf,
  buildTaxonomyPackage,
  conceptValueClass,
  isNumericConcept,
  isValueConcept,
  valueConceptsOf,
} from '@/lib/xbrl/taxonomy';

/**
 * SAMPLE（架空）のタクソノミの整合（plan §3.6 unit）。名前の一意・抽象に値なし・すべて提出用ではない・
 * 公式らしい名前を作らない（接頭辞 t4ds・ラベル「（サンプル）」・名前 Sample…）。
 */
function samplePackage() {
  const db = createFixtureDb();
  const row = db.xbrlTaxonomyPackages.find((p) => p.id === XBRL_SAMPLE_PACKAGE_ID)!;
  return { row, pkg: buildTaxonomyPackage(row, db.xbrlConcepts), db };
}

describe('SAMPLE のタクソノミ', () => {
  it('約 40 の概念を持ち、名前は一意で、すべて SAMPLE の名前空間・接頭辞・ラベル', () => {
    const { pkg } = samplePackage();
    expect(pkg.concepts.length).toBeGreaterThanOrEqual(30);
    expect(pkg.concepts.length).toBeLessThanOrEqual(45);
    const names = pkg.concepts.map((c) => c.localName);
    expect(new Set(names).size).toBe(names.length);
    for (const c of pkg.concepts) {
      expect(c.prefix).toBe(SAMPLE_TAXONOMY_PREFIX);
      expect(c.namespaceUri).toBe(SAMPLE_TAXONOMY_NAMESPACE);
      expect(c.localName.startsWith('Sample')).toBe(true);
      expect(c.labelJa.startsWith('（サンプル）')).toBe(true);
    }
    expect(isSampleNamespace(pkg.namespaceUri)).toBe(true);
  });

  it('抽象・軸・メンバーは値を持たない（期間型なし）。値の概念は期間型を持つ', () => {
    const { pkg } = samplePackage();
    for (const c of pkg.concepts) {
      if (c.kind === 'abstract' || c.kind === 'axis' || c.kind === 'member') {
        expect(isValueConcept(c), c.localName).toBe(false);
        expect(c.periodType, c.localName).toBeNull();
      } else {
        expect(c.periodType, c.localName).not.toBeNull();
      }
    }
  });

  it('提出用ではない: 行が filing_ready でも SAMPLE・Fixture は提出用にしない', () => {
    const { row, db, pkg } = samplePackage();
    expect(pkg.filingReady).toBe(false);
    expect(pkg.isSample).toBe(true);
    const forged = buildTaxonomyPackage({ ...row, filingReady: true }, db.xbrlConcepts);
    expect(forged.filingReady).toBe(false);
    // 公式の確定版でもライセンス未取得なら提出用にしない
    const licensed = buildTaxonomyPackage(
      {
        ...row,
        profile: 'edinet_ssbj',
        legalStatus: 'final',
        licenseStatus: 'required_pending',
        isFixture: false,
        filingReady: true,
      },
      [],
    );
    expect(licensed.filingReady).toBe(false);
  });

  it('GHG 排出量の概念は utr:tCO2e だけ（単位の規則は SAMPLE のパッケージにだけ付く）', () => {
    const { pkg, row, db } = samplePackage();
    expect(pkg.unitRules.SampleScope1GhgEmissions).toEqual(['utr:tCO2e']);
    for (const name of Object.keys(SAMPLE_UNIT_RULES)) {
      expect(
        pkg.concepts.some((c) => c.localName === name),
        name,
      ).toBe(true);
    }
    const official = buildTaxonomyPackage(
      { ...row, profile: 'edinet_ssbj', legalStatus: 'draft' },
      db.xbrlConcepts,
    );
    expect(official.unitRules).toEqual({});
  });

  it('データ型から値の種類を決める（金額・比率・整数・数量・テキストブロック）', () => {
    const { pkg } = samplePackage();
    const byName = (name: string) => pkg.concepts.find((c) => c.localName === name)!;
    expect(conceptValueClass(byName('SampleClimateRelatedCapitalExpenditure'))).toBe('monetary');
    expect(conceptValueClass(byName('SampleFemaleManagerRatio'))).toBe('percent');
    expect(conceptValueClass(byName('SampleNumberOfEmployees'))).toBe('integer');
    expect(conceptValueClass(byName('SampleScope1GhgEmissions'))).toBe('decimal');
    expect(conceptValueClass(byName('SampleGovernanceTextBlock'))).toBe('text_block');
    expect(conceptValueClass(byName('SampleGovernanceAbstract'))).toBe('none');
    expect(isNumericConcept(byName('SampleGovernanceTextBlock'))).toBe(false);
    const { numeric, textBlocks } = valueConceptsOf(pkg);
    expect(numeric.every((c) => isNumericConcept(c))).toBe(true);
    expect(textBlocks.length).toBeGreaterThan(0);
  });

  it('軸ごとのメンバー（親子関係から）', () => {
    const { pkg } = samplePackage();
    const axes = axesOf(pkg);
    const ghg = axes.find((a) => a.axis.localName === 'SampleGhgBoundaryAxis')!;
    expect(ghg.members.map((m) => m.localName).sort()).toEqual([
      'SampleFinancialControlMember',
      'SampleOperationalControlMember',
    ]);
    expect(axes.every((a) => a.members.length > 0)).toBe(true);
  });
});
