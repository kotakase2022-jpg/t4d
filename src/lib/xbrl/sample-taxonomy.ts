import type { UnitRules } from './taxonomy';

/**
 * SAMPLE（架空）のタクソノミ（トライアル対応 NF-42 Stage 1。plan §3.2）。
 *
 * - 名前空間 `urn:t4d:sample-taxonomy:2026`・接頭辞 `t4ds`。概念の名前は `Sample…`、ラベルは「（サンプル）…」で
 *   始める。公式タクソノミ（EDINET の jpsrd・ISSB の ifrs-sds）の要素名・ラベルは写さない（権利とライセンス
 *   の確認が先。公式らしい名前を作らない）
 * - 概念そのもの（約 40）はマスターの行（0053）で持つ。Fixture（src/lib/fixtures/trial-case.ts）と seed.sql が
 *   唯一の出所で、ここには名前空間と、SAMPLE に付けた単位の規則・注記の文言だけを置く
 * - SAMPLE のパッケージは提出用にできない（filing_ready=false。DB の CHECK と V16）
 */

export const SAMPLE_TAXONOMY_NAMESPACE = 'urn:t4d:sample-taxonomy:2026';
export const SAMPLE_TAXONOMY_PREFIX = 't4ds';

/** 架空の提出者の識別子の scheme（実在の識別子をデモ・Fixture に置かない） */
export const SAMPLE_ENTITY_SCHEME_URI = 'urn:t4d:sample-entity';

/**
 * SAMPLE の GHG 排出量の概念は utr:tCO2e だけを使う（EDINET の「GHG は tCO2e に限る」規則の先取り。
 * 千 t-CO2e は換算して tCO2e で出す）。原単位（t-CO2e/百万円）は対象外
 */
const GHG_EMISSION_CONCEPTS = [
  'SampleScope1GhgEmissions',
  'SampleScope2GhgEmissionsLocationBased',
  'SampleScope2GhgEmissionsMarketBased',
  'SampleScope3GhgEmissions',
  'SampleScope3Category1GhgEmissions',
  'SampleTotalGhgEmissions',
] as const;

export const SAMPLE_UNIT_RULES: UnitRules = Object.fromEntries(
  GHG_EMISSION_CONCEPTS.map((name) => [name, ['utr:tCO2e']]),
);

/** 画面・出力の先頭に出す注記（誠実さの注記。折りたたまない） */
export const NOT_FILING_READY_NOTICE =
  '提出用ではありません。XBRL の構造を確かめるための社内確認用の出力です。公式タクソノミ・公式の検証を通していないため、EDINET 等へ提出できません。';

export const SAMPLE_TAXONOMY_NOTICE =
  'タクソノミは SAMPLE（架空）です。概念の名前・ラベルは T4D が作った架空のもので、公式の要素ではありません。';

export const SIMPLE_CHECK_NOTICE =
  '検証は T4D の簡易検査（V01〜V16）です。EDINET・ESEF の公式の検証ではありません。';

/** 名前空間・接頭辞が SAMPLE のものか（公式のパッケージと取り違えない） */
export function isSampleNamespace(namespaceUri: string): boolean {
  return namespaceUri === SAMPLE_TAXONOMY_NAMESPACE || namespaceUri.startsWith('urn:t4d:');
}
